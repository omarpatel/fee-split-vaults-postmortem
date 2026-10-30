/**
 * SQL-shaped store.
 *
 * It talks to a NARROW driver interface rather than to any real client, so the
 * same code runs against Postgres, SQLite or the statement-keyed fake in
 * fakeDriver.ts. The schema is src/store/schema.sql.
 *
 * TWO RULES THIS FILE DOES NOT BREAK.
 *
 * 1. NO ARITHMETIC IN SQL. Amounts cross the wire as base-10 strings and every
 *    sum happens in bigint here. A NUMERIC column plus a driver that maps it to
 *    a JS number loses the low digits of a large balance and does it silently,
 *    which is the exact failure mode this package exists to prevent.
 *
 * 2. ONE TRANSACTION PER WRITE. Entries, the observation record, the recognition
 *    record and the materialized balances commit together or not at all, and the
 *    balance legality check is re-run INSIDE that transaction because the
 *    balances may have moved since the caller checked them.
 *
 * Statements are exported constants and the driver receives them by identity,
 * which is what lets the fake dispatch on them without parsing SQL.
 */

import type { Address, AssetAddress, LedgerAccount, LedgerEntry } from '@fee-split-vaults/core'
import { assertLedgerAccount, classifyPair, type PostingKind } from '../accounts.js'
import {
  assertWriteIsLegal,
  type AccountBalance,
  type FlowTotal,
  type LedgerScope,
} from '../balances.js'
import { EntryIdCollisionError, InvalidInputError } from '../errors.js'
import type { IncomeSource, PerSourceTotals } from '../precedence.js'
import { isIncomeSource } from '../precedence.js'
import type { FreezeRecord, FreezeScope, Severity } from '../variance.js'
import {
  matchesScope,
  type AppendResult,
  type EntryFilter,
  type EntryPage,
  type LedgerStore,
  type LedgerWrite,
  type ObservationRecord,
  type RecognitionRecord,
  type StoredVariance,
  DEFAULT_PAGE_SIZE,
} from './types.js'

export type SqlValue = string | number | null

export interface SqlDriver {
  query<R extends Record<string, SqlValue>>(
    sql: string,
    params: readonly SqlValue[],
  ): Promise<R[]>
  execute(sql: string, params: readonly SqlValue[]): Promise<{ rowsAffected: number }>
  /** Must roll back everything if `fn` rejects. */
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>
}

export const SEQUENCE_NAME = 'ledger_entry_seq'

export const SQL = {
  selectEntryById: 'SELECT * FROM ledger_entry WHERE id = ?',
  insertEntry:
    'INSERT INTO ledger_entry (id, seq, vault, asset, debit_account, credit_account, ' +
    'amount_minor, occurred_at_unix, block_hash, tx_hash, log_index, source, memo) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
  selectEntriesPage:
    'SELECT * FROM ledger_entry WHERE seq > ? ORDER BY seq ASC LIMIT ?',
  selectMaxSeq: 'SELECT MAX(seq) AS max_seq FROM ledger_entry',

  selectSequence: 'SELECT next_value FROM ledger_sequence WHERE name = ?',
  insertSequence: 'INSERT INTO ledger_sequence (name, next_value) VALUES (?, ?)',
  updateSequence: 'UPDATE ledger_sequence SET next_value = ? WHERE name = ?',

  selectObservation: 'SELECT * FROM ledger_observation WHERE id = ?',
  insertObservation:
    'INSERT INTO ledger_observation (id, vault, asset, accrual_key, source, amount_minor, ' +
    'occurred_at_unix, block_hash, tx_hash, log_index, outcome, entry_ids) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',

  selectRecognition:
    'SELECT * FROM ledger_recognition WHERE vault = ? AND asset = ? AND accrual_key = ?',
  selectRecognitions: 'SELECT * FROM ledger_recognition',
  insertRecognition:
    'INSERT INTO ledger_recognition (vault, asset, accrual_key, per_source_json, ' +
    'recognized_source, recognized_minor, first_recognized_at_unix, last_observed_at_unix, ' +
    'supersessions) VALUES (?,?,?,?,?,?,?,?,?)',
  updateRecognition:
    'UPDATE ledger_recognition SET per_source_json = ?, recognized_source = ?, ' +
    'recognized_minor = ?, last_observed_at_unix = ?, supersessions = ? ' +
    'WHERE vault = ? AND asset = ? AND accrual_key = ?',

  selectBalance:
    'SELECT * FROM ledger_balance WHERE vault = ? AND asset = ? AND account = ?',
  selectBalances: 'SELECT * FROM ledger_balance',
  insertBalance:
    'INSERT INTO ledger_balance (vault, asset, account, debits_minor, credits_minor, ' +
    'balance_minor, entry_count) VALUES (?,?,?,?,?,?,?)',
  updateBalance:
    'UPDATE ledger_balance SET debits_minor = ?, credits_minor = ?, balance_minor = ?, ' +
    'entry_count = ? WHERE vault = ? AND asset = ? AND account = ?',

  selectFlow:
    'SELECT * FROM ledger_flow WHERE vault = ? AND asset = ? AND posting_kind = ?',
  selectFlows: 'SELECT * FROM ledger_flow',
  insertFlow:
    'INSERT INTO ledger_flow (vault, asset, posting_kind, amount_minor, entry_count) ' +
    'VALUES (?,?,?,?,?)',
  updateFlow:
    'UPDATE ledger_flow SET amount_minor = ?, entry_count = ? ' +
    'WHERE vault = ? AND asset = ? AND posting_kind = ?',

  selectVariances: 'SELECT * FROM ledger_variance',
  insertVariance:
    'INSERT INTO ledger_variance (id, vault, asset, ledger_balance_minor, ' +
    'chain_balance_minor, delta_minor, severity, detected_at_unix, block_hash, note) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?)',
  deleteVariance: 'DELETE FROM ledger_variance WHERE id = ?',

  selectFreezes: 'SELECT * FROM ledger_freeze',
  selectFreezeById: 'SELECT * FROM ledger_freeze WHERE id = ?',
  insertFreeze:
    'INSERT INTO ledger_freeze (id, scope_kind, scope_vault, scope_asset, reason, ' +
    'variance_id, frozen_at_unix, cleared_at_unix, cleared_by) VALUES (?,?,?,?,?,?,?,?,?)',
  updateFreezeCleared:
    'UPDATE ledger_freeze SET cleared_at_unix = ?, cleared_by = ? WHERE id = ?',
} as const

// ---------------------------------------------------------------------------
// Row mapping. Every amount is a base-10 string on the wire.
// ---------------------------------------------------------------------------

type Cell = SqlValue | undefined

function big(value: Cell, field: string): bigint {
  if (typeof value !== 'string') {
    throw new InvalidInputError(`${field} must arrive as a base-10 string, got ${typeof value}`, field)
  }
  try {
    return BigInt(value)
  } catch {
    throw new InvalidInputError(`${field} is not a base-10 integer: ${value}`, field)
  }
}

function str(value: Cell, field: string): string {
  if (typeof value !== 'string') throw new InvalidInputError(`${field} must be a string`, field)
  return value
}

function int(value: Cell, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new InvalidInputError(`${field} must be an integer`, field)
  }
  return value
}

function optStr(value: Cell): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optInt(value: Cell): number | undefined {
  return typeof value === 'number' ? value : undefined
}

type Row = Record<string, SqlValue>

function rowToEntry(row: Row): LedgerEntry {
  const source = str(row.source, 'source')
  if (!isEntrySource(source)) {
    throw new InvalidInputError(`unknown entry source ${source}`, 'source')
  }
  const entry: LedgerEntry = {
    id: str(row.id, 'id'),
    vault: str(row.vault, 'vault'),
    asset: str(row.asset, 'asset'),
    debit: assertLedgerAccount(row.debit_account, 'debit_account'),
    credit: assertLedgerAccount(row.credit_account, 'credit_account'),
    amountMinor: big(row.amount_minor, 'amount_minor'),
    occurredAtUnix: int(row.occurred_at_unix, 'occurred_at_unix'),
    source,
  }
  const blockHash = optStr(row.block_hash)
  if (blockHash !== undefined) entry.blockHash = blockHash
  const txHash = optStr(row.tx_hash)
  if (txHash !== undefined) entry.txHash = txHash
  const logIndex = optInt(row.log_index)
  if (logIndex !== undefined) entry.logIndex = logIndex
  const memo = optStr(row.memo)
  if (memo !== undefined) entry.memo = memo
  return entry
}

const ENTRY_SOURCES: readonly string[] = [
  'curve_event',
  'pool_fees_swept',
  'escrow_credit',
  'erc20_transfer',
  'manual',
]

function isEntrySource(value: string): value is LedgerEntry['source'] {
  return ENTRY_SOURCES.includes(value)
}

function entryToParams(entry: LedgerEntry, seq: number): SqlValue[] {
  return [
    entry.id,
    seq,
    entry.vault,
    entry.asset,
    entry.debit,
    entry.credit,
    entry.amountMinor.toString(10),
    entry.occurredAtUnix,
    entry.blockHash ?? null,
    entry.txHash ?? null,
    entry.logIndex ?? null,
    entry.source,
    entry.memo ?? null,
  ]
}

function parsePerSource(json: string): PerSourceTotals {
  const parsed: unknown = JSON.parse(json)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new InvalidInputError('per_source_json is not an object', 'per_source_json')
  }
  const out: PerSourceTotals = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isIncomeSource(key)) {
      throw new InvalidInputError(`per_source_json holds unknown source ${key}`, 'per_source_json')
    }
    if (typeof value !== 'string') {
      throw new InvalidInputError('per_source_json amounts must be strings', 'per_source_json')
    }
    out[key] = BigInt(value)
  }
  return out
}

function serializePerSource(totals: PerSourceTotals): string {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(totals)) {
    if (value !== undefined) out[key] = value.toString(10)
  }
  return JSON.stringify(out)
}

// ---------------------------------------------------------------------------

export class SqlLedgerStore implements LedgerStore {
  constructor(private readonly driver: SqlDriver) {}

  async appendWrite(write: LedgerWrite): Promise<AppendResult> {
    return this.driver.transaction(async (tx) => {
      const fresh: LedgerEntry[] = []
      let duplicates = 0

      for (const entry of write.entries) {
        const rows = await tx.query<Row>(SQL.selectEntryById, [entry.id])
        const existing = rows[0]
        if (existing === undefined) {
          fresh.push(entry)
          continue
        }
        const stored = rowToEntry(existing)
        if (
          stored.vault !== entry.vault ||
          stored.asset !== entry.asset ||
          stored.debit !== entry.debit ||
          stored.credit !== entry.credit ||
          stored.amountMinor !== entry.amountMinor ||
          stored.occurredAtUnix !== entry.occurredAtUnix ||
          stored.source !== entry.source
        ) {
          throw new EntryIdCollisionError(entry.id)
        }
        duplicates += 1
      }

      if (fresh.length > 0) {
        const cache = new Map<string, bigint>()
        for (const entry of fresh) {
          for (const account of [entry.debit, entry.credit]) {
            const key = `${entry.vault}|${entry.asset}|${account}`
            if (cache.has(key)) continue
            const rows = await tx.query<Row>(SQL.selectBalance, [
              entry.vault,
              entry.asset,
              account,
            ])
            const row = rows[0]
            cache.set(key, row === undefined ? 0n : big(row.balance_minor, 'balance_minor'))
          }
        }
        assertWriteIsLegal(fresh, (vault, asset, account) => cache.get(`${vault}|${asset}|${account}`) ?? 0n)

        let seq = await this.nextSequence(tx, fresh.length)
        for (const entry of fresh) {
          await tx.execute(SQL.insertEntry, entryToParams(entry, seq))
          seq += 1
          await this.applyBalance(tx, entry, entry.debit, entry.amountMinor, 0n)
          await this.applyBalance(tx, entry, entry.credit, 0n, entry.amountMinor)
          await this.applyFlow(tx, entry)
        }
      }

      if (write.observation !== undefined) {
        const o = write.observation
        const existing = await tx.query<Row>(SQL.selectObservation, [o.id])
        if (existing.length === 0) {
          await tx.execute(SQL.insertObservation, [
            o.id,
            o.vault,
            o.asset,
            o.accrualKey,
            o.source,
            o.amountMinor.toString(10),
            o.occurredAtUnix,
            o.blockHash ?? null,
            o.txHash ?? null,
            o.logIndex ?? null,
            o.outcome,
            JSON.stringify(o.entryIds),
          ])
        }
      }

      if (write.recognition !== undefined) {
        const r = write.recognition
        const existing = await tx.query<Row>(SQL.selectRecognition, [
          r.vault,
          r.asset,
          r.accrualKey,
        ])
        if (existing.length === 0) {
          await tx.execute(SQL.insertRecognition, [
            r.vault,
            r.asset,
            r.accrualKey,
            serializePerSource(r.perSource),
            r.recognizedSource,
            r.recognizedMinor.toString(10),
            r.firstRecognizedAtUnix,
            r.lastObservedAtUnix,
            r.supersessions,
          ])
        } else {
          await tx.execute(SQL.updateRecognition, [
            serializePerSource(r.perSource),
            r.recognizedSource,
            r.recognizedMinor.toString(10),
            r.lastObservedAtUnix,
            r.supersessions,
            r.vault,
            r.asset,
            r.accrualKey,
          ])
        }
      }

      return {
        inserted: fresh.length,
        duplicates,
        entryIds: write.entries.map((e) => e.id),
      }
    })
  }

  /** Reserved inside the write transaction so cursor paging stays monotonic. */
  private async nextSequence(tx: SqlDriver, count: number): Promise<number> {
    const rows = await tx.query<Row>(SQL.selectSequence, [SEQUENCE_NAME])
    const row = rows[0]
    if (row === undefined) {
      await tx.execute(SQL.insertSequence, [SEQUENCE_NAME, count])
      return 0
    }
    const current = int(row.next_value, 'next_value')
    await tx.execute(SQL.updateSequence, [current + count, SEQUENCE_NAME])
    return current
  }

  private async applyBalance(
    tx: SqlDriver,
    entry: LedgerEntry,
    account: LedgerAccount,
    debit: bigint,
    credit: bigint,
  ): Promise<void> {
    const rows = await tx.query<Row>(SQL.selectBalance, [entry.vault, entry.asset, account])
    const row = rows[0]
    if (row === undefined) {
      await tx.execute(SQL.insertBalance, [
        entry.vault,
        entry.asset,
        account,
        debit.toString(10),
        credit.toString(10),
        (debit - credit).toString(10),
        1,
      ])
      return
    }
    const debits = big(row.debits_minor, 'debits_minor') + debit
    const credits = big(row.credits_minor, 'credits_minor') + credit
    await tx.execute(SQL.updateBalance, [
      debits.toString(10),
      credits.toString(10),
      (debits - credits).toString(10),
      int(row.entry_count, 'entry_count') + 1,
      entry.vault,
      entry.asset,
      account,
    ])
  }

  private async applyFlow(tx: SqlDriver, entry: LedgerEntry): Promise<void> {
    const kind = classifyPair(entry.debit, entry.credit)
    const rows = await tx.query<Row>(SQL.selectFlow, [entry.vault, entry.asset, kind])
    const row = rows[0]
    if (row === undefined) {
      await tx.execute(SQL.insertFlow, [
        entry.vault,
        entry.asset,
        kind,
        entry.amountMinor.toString(10),
        1,
      ])
      return
    }
    const amount = big(row.amount_minor, 'amount_minor') + entry.amountMinor
    await tx.execute(SQL.updateFlow, [
      amount.toString(10),
      int(row.entry_count, 'entry_count') + 1,
      entry.vault,
      entry.asset,
      kind,
    ])
  }

  async getEntry(id: string): Promise<LedgerEntry | undefined> {
    const rows = await this.driver.query<Row>(SQL.selectEntryById, [id])
    const row = rows[0]
    return row === undefined ? undefined : rowToEntry(row)
  }

  /**
   * Filtering happens here rather than in the WHERE clause so that one prepared
   * statement covers every filter shape. It costs a wider scan and buys a store
   * that does not build SQL by string concatenation.
   */
  async listEntries(
    filter?: EntryFilter,
    cursor?: string,
    limit: number = DEFAULT_PAGE_SIZE,
  ): Promise<EntryPage> {
    let after = cursor === undefined ? -1 : Number.parseInt(cursor, 10)
    if (Number.isNaN(after)) throw new InvalidInputError('malformed cursor', 'cursor')

    const maxRows = await this.driver.query<Row>(SQL.selectMaxSeq, [])
    const maxSeq = optInt(maxRows[0]?.max_seq ?? null) ?? -1

    const out: LedgerEntry[] = []
    while (out.length < limit && after < maxSeq) {
      const rows = await this.driver.query<Row>(SQL.selectEntriesPage, [after, limit])
      if (rows.length === 0) break
      for (const row of rows) {
        after = int(row.seq, 'seq')
        const entry = rowToEntry(row)
        if (entryMatches(entry, filter)) out.push(entry)
        if (out.length >= limit) break
      }
    }

    const page: EntryPage = { entries: out }
    if (after < maxSeq) page.cursor = String(after)
    return page
  }

  async getObservation(id: string): Promise<ObservationRecord | undefined> {
    const rows = await this.driver.query<Row>(SQL.selectObservation, [id])
    const row = rows[0]
    if (row === undefined) return undefined
    const source = str(row.source, 'source')
    if (!isIncomeSource(source)) {
      throw new InvalidInputError(`observation holds non-income source ${source}`, 'source')
    }
    const record: ObservationRecord = {
      id: str(row.id, 'id'),
      vault: str(row.vault, 'vault'),
      asset: str(row.asset, 'asset'),
      accrualKey: str(row.accrual_key, 'accrual_key'),
      source,
      amountMinor: big(row.amount_minor, 'amount_minor'),
      occurredAtUnix: int(row.occurred_at_unix, 'occurred_at_unix'),
      outcome: str(row.outcome, 'outcome'),
      entryIds: JSON.parse(str(row.entry_ids, 'entry_ids')) as string[],
    }
    const blockHash = optStr(row.block_hash)
    if (blockHash !== undefined) record.blockHash = blockHash
    const txHash = optStr(row.tx_hash)
    if (txHash !== undefined) record.txHash = txHash
    const logIndex = optInt(row.log_index)
    if (logIndex !== undefined) record.logIndex = logIndex
    return record
  }

  async getRecognition(
    vault: Address,
    asset: AssetAddress,
    accrualKey: string,
  ): Promise<RecognitionRecord | undefined> {
    const rows = await this.driver.query<Row>(SQL.selectRecognition, [vault, asset, accrualKey])
    const row = rows[0]
    return row === undefined ? undefined : rowToRecognition(row)
  }

  async listRecognitions(scope?: LedgerScope): Promise<RecognitionRecord[]> {
    const rows = await this.driver.query<Row>(SQL.selectRecognitions, [])
    return rows.map(rowToRecognition).filter((r) => matchesScope(r, scope))
  }

  async listAccountBalances(scope?: LedgerScope): Promise<AccountBalance[]> {
    const rows = await this.driver.query<Row>(SQL.selectBalances, [])
    return rows
      .map(
        (row): AccountBalance => ({
          vault: str(row.vault, 'vault'),
          asset: str(row.asset, 'asset'),
          account: assertLedgerAccount(row.account, 'account'),
          debitsMinor: big(row.debits_minor, 'debits_minor'),
          creditsMinor: big(row.credits_minor, 'credits_minor'),
          balanceMinor: big(row.balance_minor, 'balance_minor'),
          entryCount: int(row.entry_count, 'entry_count'),
        }),
      )
      .filter((r) => matchesScope(r, scope))
      .sort(
        (a, b) =>
          a.vault.localeCompare(b.vault) ||
          a.asset.localeCompare(b.asset) ||
          a.account.localeCompare(b.account),
      )
  }

  async listFlowTotals(scope?: LedgerScope): Promise<FlowTotal[]> {
    const rows = await this.driver.query<Row>(SQL.selectFlows, [])
    return rows
      .map(
        (row): FlowTotal => ({
          vault: str(row.vault, 'vault'),
          asset: str(row.asset, 'asset'),
          kind: str(row.posting_kind, 'posting_kind') as PostingKind,
          amountMinor: big(row.amount_minor, 'amount_minor'),
          entryCount: int(row.entry_count, 'entry_count'),
        }),
      )
      .filter((r) => matchesScope(r, scope))
      .sort(
        (a, b) =>
          a.vault.localeCompare(b.vault) ||
          a.asset.localeCompare(b.asset) ||
          a.kind.localeCompare(b.kind),
      )
  }

  async putVariance(variance: StoredVariance): Promise<void> {
    await this.driver.transaction(async (tx) => {
      await tx.execute(SQL.deleteVariance, [variance.id])
      await tx.execute(SQL.insertVariance, [
        variance.id,
        variance.vault,
        variance.asset,
        variance.ledgerBalanceMinor.toString(10),
        variance.chainBalanceMinor.toString(10),
        variance.deltaMinor.toString(10),
        variance.severity,
        variance.detectedAtUnix,
        variance.blockHash ?? null,
        variance.note ?? null,
      ])
    })
  }

  async listVariances(scope?: LedgerScope): Promise<StoredVariance[]> {
    const rows = await this.driver.query<Row>(SQL.selectVariances, [])
    return rows
      .map((row): StoredVariance => {
        const severity = str(row.severity, 'severity') as Severity
        const record: StoredVariance = {
          id: str(row.id, 'id'),
          vault: str(row.vault, 'vault'),
          asset: str(row.asset, 'asset'),
          ledgerBalanceMinor: big(row.ledger_balance_minor, 'ledger_balance_minor'),
          chainBalanceMinor: big(row.chain_balance_minor, 'chain_balance_minor'),
          deltaMinor: big(row.delta_minor, 'delta_minor'),
          severity,
          detectedAtUnix: int(row.detected_at_unix, 'detected_at_unix'),
        }
        const blockHash = optStr(row.block_hash)
        if (blockHash !== undefined) record.blockHash = blockHash
        const note = optStr(row.note)
        if (note !== undefined) record.note = note
        return record
      })
      .filter((r) => matchesScope(r, scope))
  }

  async putFreeze(freeze: FreezeRecord): Promise<void> {
    await this.driver.transaction(async (tx) => {
      const existing = await tx.query<Row>(SQL.selectFreezeById, [freeze.id])
      if (existing.length > 0) return
      const scope = freeze.scope
      await tx.execute(SQL.insertFreeze, [
        freeze.id,
        scope.kind,
        'vault' in scope ? scope.vault : null,
        'asset' in scope ? scope.asset : null,
        freeze.reason,
        freeze.varianceId ?? null,
        freeze.frozenAtUnix,
        freeze.clearedAtUnix ?? null,
        freeze.clearedBy ?? null,
      ])
    })
  }

  async listFreezes(activeOnly = true): Promise<FreezeRecord[]> {
    const rows = await this.driver.query<Row>(SQL.selectFreezes, [])
    return rows
      .map((row): FreezeRecord => {
        const record: FreezeRecord = {
          id: str(row.id, 'id'),
          scope: rowToFreezeScope(row),
          reason: str(row.reason, 'reason'),
          frozenAtUnix: int(row.frozen_at_unix, 'frozen_at_unix'),
        }
        const varianceId = optStr(row.variance_id)
        if (varianceId !== undefined) record.varianceId = varianceId
        const clearedAtUnix = optInt(row.cleared_at_unix)
        if (clearedAtUnix !== undefined) record.clearedAtUnix = clearedAtUnix
        const clearedBy = optStr(row.cleared_by)
        if (clearedBy !== undefined) record.clearedBy = clearedBy
        return record
      })
      .filter((f) => !activeOnly || f.clearedAtUnix === undefined)
  }

  async clearFreeze(id: string, clearedAtUnix: number, clearedBy: string): Promise<void> {
    const result = await this.driver.execute(SQL.updateFreezeCleared, [
      clearedAtUnix,
      clearedBy,
      id,
    ])
    if (result.rowsAffected === 0) {
      throw new InvalidInputError(`unknown freeze ${id}`, 'id')
    }
  }
}

function rowToRecognition(row: Row): RecognitionRecord {
  const source = str(row.recognized_source, 'recognized_source')
  if (!isIncomeSource(source)) {
    throw new InvalidInputError(`recognition holds non-income source ${source}`, 'recognized_source')
  }
  return {
    vault: str(row.vault, 'vault'),
    asset: str(row.asset, 'asset'),
    accrualKey: str(row.accrual_key, 'accrual_key'),
    perSource: parsePerSource(str(row.per_source_json, 'per_source_json')),
    recognizedSource: source as IncomeSource,
    recognizedMinor: big(row.recognized_minor, 'recognized_minor'),
    firstRecognizedAtUnix: int(row.first_recognized_at_unix, 'first_recognized_at_unix'),
    lastObservedAtUnix: int(row.last_observed_at_unix, 'last_observed_at_unix'),
    supersessions: int(row.supersessions, 'supersessions'),
  }
}

function rowToFreezeScope(row: Row): FreezeScope {
  const kind = str(row.scope_kind, 'scope_kind')
  const vault = optStr(row.scope_vault)
  const asset = optStr(row.scope_asset)
  switch (kind) {
    case 'global':
      return { kind: 'global' }
    case 'vault':
      if (vault === undefined) throw new InvalidInputError('vault freeze without vault', 'scope_vault')
      return { kind: 'vault', vault }
    case 'asset':
      if (asset === undefined) throw new InvalidInputError('asset freeze without asset', 'scope_asset')
      return { kind: 'asset', asset }
    case 'vault_asset':
      if (vault === undefined || asset === undefined) {
        throw new InvalidInputError('vault_asset freeze missing a field', 'scope_kind')
      }
      return { kind: 'vault_asset', vault, asset }
    default:
      throw new InvalidInputError(`unknown freeze scope ${kind}`, 'scope_kind')
  }
}

function entryMatches(entry: LedgerEntry, filter?: EntryFilter): boolean {
  if (filter === undefined) return true
  if (!matchesScope(entry, filter)) return false
  if (filter.fromUnix !== undefined && entry.occurredAtUnix < filter.fromUnix) return false
  if (filter.toUnix !== undefined && entry.occurredAtUnix > filter.toUnix) return false
  if (
    filter.accountAnySide !== undefined &&
    entry.debit !== filter.accountAnySide &&
    entry.credit !== filter.accountAnySide
  ) {
    return false
  }
  return true
}
