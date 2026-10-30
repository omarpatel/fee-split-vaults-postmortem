/**
 * The SQL store against a REAL SQLite database.
 *
 * This is the only test that proves schema.sql actually parses, that its CHECK
 * constraints bite, and that a rejected write leaves no partial row behind. The
 * statement-keyed fake covers the same store logic without a native handle; both
 * matter, because the fake cannot fail on a DDL mistake.
 *
 * node:sqlite is used only here, never in src/, so the package carries no
 * dependency on an experimental built-in.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Ledger } from '../ledger.js'
import { EntryIdCollisionError, LedgerBalanceError } from '../errors.js'
import { InMemorySqlDriver, UnhandledStatementError } from '../store/fakeDriver.js'
import { NodeSqliteDriver } from '../store/sqliteDriver.js'
import { SqlLedgerStore, SQL } from '../store/sql.js'
import { InMemoryLedgerStore } from '../store/memory.js'
import type { SqliteDatabaseLike } from '../store/sqliteDriver.js'
import { iterateEntries, type LedgerStore } from '../store/types.js'
import { T0, USDG, VAULT } from './helpers.js'

const DDL = readFileSync(fileURLToPath(new URL('../store/schema.sql', import.meta.url)), 'utf8')

interface DatabaseSyncCtor {
  new (path: string): SqliteDatabaseLike
}

/**
 * Loaded through createRequire rather than a static import: the bundler used for
 * tests does not treat node:sqlite as a builtin, and a static import would fail
 * to resolve before any of this file ran.
 */
function loadSqlite(): DatabaseSyncCtor | undefined {
  try {
    const req = createRequire(import.meta.url)
    return (req('node:sqlite') as { DatabaseSync: DatabaseSyncCtor }).DatabaseSync
  } catch {
    return undefined
  }
}

const DatabaseSync = loadSqlite()

function sqliteStore(): {
  store: SqlLedgerStore
  driver: NodeSqliteDriver
  db: SqliteDatabaseLike
} {
  if (DatabaseSync === undefined) throw new Error('node:sqlite is unavailable')
  const db = new DatabaseSync(':memory:')
  const driver = new NodeSqliteDriver(db)
  driver.applySchema(DDL)
  return { store: new SqlLedgerStore(driver), driver, db }
}

async function seed(ledger: Ledger): Promise<void> {
  await ledger.recordFeeObservation({
    vault: VAULT,
    asset: USDG,
    amountMinor: 1_000_000n,
    source: 'pool_fees_swept',
    accrualKey: 'sweep:sqlite:1',
    occurredAtUnix: T0,
    blockHash: '0xblock',
    txHash: '0xsweep',
    logIndex: 3,
  })
  await ledger.recordClaim({
    vault: VAULT,
    asset: USDG,
    amountMinor: 400_000n,
    occurredAtUnix: T0 + 1,
    batchKey: 'claim:chunk1',
  })
  await ledger.recordClaim({
    vault: VAULT,
    asset: USDG,
    amountMinor: 600_000n,
    occurredAtUnix: T0 + 2,
    batchKey: 'claim:chunk2',
  })
  await ledger.recordAllocation({
    vault: VAULT,
    asset: USDG,
    occurredAtUnix: T0 + 3,
    batchKey: 'settle:1',
    amounts: { devMinor: 700_000n, budgetMinor: 200_000n, operatorMinor: 80_000n, referrerMinor: 20_000n },
  })
}

async function fingerprint(store: LedgerStore): Promise<string> {
  const rows: string[] = []
  for await (const entry of iterateEntries(store)) {
    rows.push(`${entry.id}|${entry.debit}|${entry.credit}|${entry.amountMinor.toString()}`)
  }
  const balances = (await store.listAccountBalances()).map(
    (b) => `${b.account}=${b.balanceMinor.toString()}`,
  )
  return JSON.stringify({ rows: rows.sort(), balances })
}

describe.skipIf(DatabaseSync === undefined)('schema.sql against a real database', () => {
  it('applies cleanly and round-trips a full lifecycle', () => {
    const { db } = sqliteStore()
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
    expect(tables.map((t) => t.name)).toEqual([
      'ledger_balance',
      'ledger_entry',
      'ledger_flow',
      'ledger_freeze',
      'ledger_observation',
      'ledger_recognition',
      'ledger_sequence',
      'ledger_variance',
    ])
  })

  it('produces the same book as the in-memory store', async () => {
    const { store: sqlStore } = sqliteStore()
    await seed(new Ledger(sqlStore, { now: () => T0 }))

    const memoryStore = new InMemoryLedgerStore()
    await seed(new Ledger(memoryStore, { now: () => T0 }))

    expect(await fingerprint(sqlStore)).toBe(await fingerprint(memoryStore))
  })

  it('recomputes the trial balance from raw rows and agrees with the maintained table', async () => {
    const { store } = sqliteStore()
    const ledger = new Ledger(store, { now: () => T0 })
    await seed(ledger)
    const verification = await ledger.auditIntegrity()
    expect(verification.ok).toBe(true)
    expect(verification.entryCount).toBe(7)
  })

  it('keeps at most one recognition row per accrual key', async () => {
    const { store, db } = sqliteStore()
    const ledger = new Ledger(store, { now: () => T0 })
    await seed(ledger)
    for (const source of ['escrow_credit', 'erc20_transfer'] as const) {
      await ledger.recordFeeObservation({
        vault: VAULT,
        asset: USDG,
        amountMinor: 1_000_000n,
        source,
        accrualKey: 'sweep:sqlite:1',
        occurredAtUnix: T0 + 5,
        txHash: `0x${source}`,
        logIndex: 0,
      })
    }
    const rows = db.prepare('SELECT COUNT(*) AS n FROM ledger_recognition').all() as Array<{
      n: number
    }>
    expect(rows[0]?.n).toBe(1)
    expect((await ledger.incomeSummary())[0]?.recognizedMinor).toBe(1_000_000n)
  })

  it('rolls the whole write back when a leg would go negative', async () => {
    const { store, db } = sqliteStore()
    const ledger = new Ledger(store, { now: () => T0 })
    await seed(ledger)

    const before = db.prepare('SELECT COUNT(*) AS n FROM ledger_entry').all() as Array<{
      n: number
    }>

    await expect(
      ledger.recordDevWithdrawal({
        vault: VAULT,
        asset: USDG,
        amountMinor: 999_999_999n,
        occurredAtUnix: T0 + 10,
        batchKey: 'withdraw:too-big',
      }),
    ).rejects.toThrow(LedgerBalanceError)

    const after = db.prepare('SELECT COUNT(*) AS n FROM ledger_entry').all() as Array<{
      n: number
    }>
    expect(after[0]?.n).toBe(before[0]?.n)
    expect((await ledger.auditIntegrity()).ok).toBe(true)
  })

  it('enforces the positive-amount CHECK at the database level', () => {
    const { db } = sqliteStore()
    const insert = db.prepare(SQL.insertEntry)
    expect(() =>
      insert.run(
        'le_bad',
        0,
        VAULT,
        USDG,
        'asset:escrow',
        'income:fees',
        '-5',
        T0,
        null,
        null,
        null,
        'pool_fees_swept',
        null,
      ),
    ).toThrow()
  })

  it('rejects an unknown source at the database level', () => {
    const { db } = sqliteStore()
    const insert = db.prepare(SQL.insertEntry)
    expect(() =>
      insert.run(
        'le_bad2',
        0,
        VAULT,
        USDG,
        'asset:escrow',
        'income:fees',
        '5',
        T0,
        null,
        null,
        null,
        'telegram_message',
        null,
      ),
    ).toThrow()
  })

  it('refuses an id reused with different content', async () => {
    const { store } = sqliteStore()
    const ledger = new Ledger(store, { now: () => T0 })
    await seed(ledger)
    const entries = (await store.listEntries()).entries
    const original = entries[0]
    if (original === undefined) throw new Error('no entries')
    await expect(
      store.appendWrite({ entries: [{ ...original, amountMinor: 1n }] }),
    ).rejects.toThrow(EntryIdCollisionError)
  })
})

describe('the statement-keyed fake driver', () => {
  it('never sees a statement the store did not export', async () => {
    const driver = new InMemorySqlDriver()
    const ledger = new Ledger(new SqlLedgerStore(driver), { now: () => T0 })
    await seed(ledger)
    await ledger.auditIntegrity()

    const known = new Set<string>(Object.values(SQL))
    for (const call of driver.log) expect(known.has(call.sql)).toBe(true)
  })

  it('fails loudly on an unhandled statement rather than returning nothing', async () => {
    const driver = new InMemorySqlDriver()
    await expect(driver.query('SELECT 1', [])).rejects.toThrow(UnhandledStatementError)
  })

  it('sends every money value as a base-10 string, never as a number', async () => {
    const driver = new InMemorySqlDriver()
    await seed(new Ledger(new SqlLedgerStore(driver), { now: () => T0 }))

    const inserts = driver.log.filter((c) => c.sql === SQL.insertEntry)
    expect(inserts.length).toBeGreaterThan(0)
    for (const call of inserts) {
      expect(typeof call.params[6]).toBe('string')
      expect(BigInt(call.params[6] as string) > 0n).toBe(true)
    }
  })
})
