/**
 * The migration runner's refusals.
 *
 * Every test here is a way a production schema quietly stops matching the
 * repository. The applied path is one test; the four refusals are the rest,
 * because a runner that applies correctly but fails to refuse is the one that
 * lets a database drift without anyone noticing.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemoryMigrationDriver } from '../driver.js'
import {
  MIGRATION_TABLE,
  MigrationError,
  NoOpLock,
  checksumOf,
  formatPlan,
  loadMigrations,
  migrate,
  plan,
  type AppliedMigration,
  type MigrationFile,
} from '../runner.js'
import { openMigratedDb } from '../../scheduler/adapters/__tests__/pglite.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REAL_MIGRATIONS = resolve(HERE, '..')
const NOW = () => 1_757_000_000

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'migrations-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(name: string, sql: string): void {
  writeFileSync(join(dir, name), sql, 'utf8')
}

function file(version: number, name: string, sql: string): MigrationFile {
  return { version, name, fileName: `${String(version).padStart(4, '0')}_${name}.sql`, sql, checksum: checksumOf(sql) }
}

function applied(version: number, name: string, sql: string): AppliedMigration {
  return { version, name, checksum: checksumOf(sql), applied_at_unix: 1 }
}

describe('loading', () => {
  it('orders by numeric version, not lexically', () => {
    write('0002_b.sql', 'SELECT 2;')
    write('0010_c.sql', 'SELECT 10;')
    write('0001_a.sql', 'SELECT 1;')
    expect(loadMigrations(dir).map((m) => m.version)).toEqual([1, 2, 10])
  })

  it('refuses a file that does not follow the naming convention', () => {
    write('not-a-migration.sql', 'SELECT 1;')
    expect(() => loadMigrations(dir)).toThrow(MigrationError)
  })

  it('refuses two files claiming the same version', () => {
    write('0001_a.sql', 'SELECT 1;')
    // Same numeric version, different name.
    writeFileSync(join(dir, '0001_b.sql'), 'SELECT 2;', 'utf8')
    expect(() => loadMigrations(dir)).toThrow(/version 1 claimed by both/)
  })

  it('normalises line endings so a Windows checkout is not a rewritten migration', () => {
    expect(checksumOf('a\r\nb\r\n')).toBe(checksumOf('a\nb\n'))
  })
})

describe('planning', () => {
  it('returns everything on an empty database', () => {
    const files = [file(1, 'a', 'A'), file(2, 'b', 'B')]
    expect(plan(files, []).map((f) => f.version)).toEqual([1, 2])
  })

  it('returns only what is new', () => {
    const files = [file(1, 'a', 'A'), file(2, 'b', 'B')]
    expect(plan(files, [applied(1, 'a', 'A')]).map((f) => f.version)).toEqual([2])
  })

  it('refuses when an applied migration was edited afterwards', () => {
    const files = [file(1, 'a', 'A CHANGED')]
    expect(() => plan(files, [applied(1, 'a', 'A')])).toThrow(/changed after it was applied/)
  })

  it('refuses when an applied migration’s file is gone', () => {
    expect(() => plan([file(2, 'b', 'B')], [applied(1, 'a', 'A')])).toThrow(/recorded as applied but its file is gone/)
  })

  it('refuses a new migration numbered behind the head', () => {
    const files = [file(1, 'a', 'A'), file(2, 'b', 'B'), file(3, 'c', 'C')]
    // 2 was never applied but 3 was: applying 2 now would give a fresh database
    // a different order than production got.
    expect(() => plan(files, [applied(1, 'a', 'A'), applied(3, 'c', 'C')])).toThrow(/numbered below the highest applied/)
  })
})

describe('applying', () => {
  it('applies pending migrations in order and records each one', async () => {
    write('0001_a.sql', 'CREATE TABLE a (x int);')
    write('0002_b.sql', 'CREATE TABLE b (x int);')
    const driver = new InMemoryMigrationDriver()

    const result = await migrate({ driver, directory: dir, nowUnix: NOW, lock: new NoOpLock() })

    expect(result.applied.map((f) => f.version)).toEqual([1, 2])
    expect(driver.applied.map((a) => a.version)).toEqual([1, 2])
    expect(driver.statements.some((s) => s.sql.includes('CREATE TABLE a'))).toBe(true)
  })

  it('is a no-op the second time', async () => {
    write('0001_a.sql', 'CREATE TABLE a (x int);')
    const driver = new InMemoryMigrationDriver()

    await migrate({ driver, directory: dir, nowUnix: NOW, lock: new NoOpLock() })
    const second = await migrate({ driver, directory: dir, nowUnix: NOW, lock: new NoOpLock() })

    expect(second.applied).toEqual([])
    expect(second.alreadyApplied).toBe(1)
  })

  it('records the migration inside the SAME transaction as the DDL', async () => {
    write('0001_a.sql', 'CREATE TABLE a (x int);')
    const driver = new InMemoryMigrationDriver()
    await migrate({ driver, directory: dir, nowUnix: NOW, lock: new NoOpLock() })

    const sequence = driver.statements.map((s) => s.sql.trim().split(/\s+/).slice(0, 3).join(' '))
    const begin = sequence.findIndex((s) => s.startsWith('BEGIN'))
    const ddl = sequence.findIndex((s) => s.startsWith('CREATE TABLE a'))
    const insert = sequence.findIndex((s) => s.startsWith(`INSERT INTO ${MIGRATION_TABLE}`))
    const commit = sequence.findIndex((s) => s.startsWith('COMMIT'))

    expect(begin).toBeLessThan(ddl)
    expect(ddl).toBeLessThan(insert)
    expect(insert).toBeLessThan(commit)
  })

  it('rolls back, and records nothing, when a migration fails', async () => {
    write('0001_a.sql', 'CREATE TABLE a (x int);')
    write('0002_b.sql', 'CREATE TABLE __fail_marker_2__ (x int);')
    const driver = new InMemoryMigrationDriver()
    driver.failOnVersion = 2

    await expect(migrate({ driver, directory: dir, nowUnix: NOW, lock: new NoOpLock() })).rejects.toThrow()

    expect(driver.applied.map((a) => a.version)).toEqual([1])
    expect(driver.statements.some((s) => s.sql.trim().startsWith('ROLLBACK'))).toBe(true)
  })

  it('changes nothing on a dry run', async () => {
    write('0001_a.sql', 'CREATE TABLE a (x int);')
    const driver = new InMemoryMigrationDriver()

    const result = await migrate({ driver, directory: dir, nowUnix: NOW, lock: new NoOpLock(), dryRun: true })

    expect(result.dryRun).toBe(true)
    expect(result.pending).toHaveLength(1)
    expect(driver.applied).toEqual([])
    expect(formatPlan(result)).toContain('dry run')
  })

  it('refuses to run when another migration holds the lock', async () => {
    write('0001_a.sql', 'CREATE TABLE a (x int);')
    const driver = new InMemoryMigrationDriver()
    const busy = { acquire: async () => false, release: async () => {} }

    await expect(migrate({ driver, directory: dir, nowUnix: NOW, lock: busy })).rejects.toThrow(/holds the lock/)
    expect(driver.applied).toEqual([])
  })

  it('releases the lock even when the run fails', async () => {
    write('0001_a.sql', 'CREATE TABLE __fail_marker_1__ (x int);')
    const driver = new InMemoryMigrationDriver()
    driver.failOnVersion = 1
    let released = false
    const lock = {
      acquire: async () => true,
      release: async () => {
        released = true
      },
    }

    await expect(migrate({ driver, directory: dir, nowUnix: NOW, lock })).rejects.toThrow()
    expect(released).toBe(true)
  })
})

describe('the real migration set', () => {
  it('loads cleanly, in order, with no gaps in the numbering', () => {
    const files = loadMigrations(REAL_MIGRATIONS)
    expect(files.length).toBeGreaterThanOrEqual(8)
    files.forEach((f, index) => {
      expect(f.version).toBe(index + 1)
    })
  })

  it('applies end to end against the fake driver', async () => {
    const driver = new InMemoryMigrationDriver()
    const result = await migrate({ driver, directory: REAL_MIGRATIONS, nowUnix: NOW, lock: new NoOpLock() })
    expect(result.applied.map((f) => f.name)).toEqual([
      'ledger',
      'vaults',
      'vendors',
      'receipts',
      'screening',
      'pilot',
      'ops',
      'fleet',
      'agent_runs',
      'category_spend',
      'persistent_stores',
      'onboarding',
      'predicate_queue',
      'pending_purchase',
      'ops_ports',
      'holders',
      'api_attestations',
      'x_mentions',
      'vault_ops',
      'referrer_leg',
      'publisher_health',
      'dev_sessions',
    ])
  })

  it('creates every table the scheduler and the lock backend need', () => {
    const sql = loadMigrations(REAL_MIGRATIONS)
      .map((f) => f.sql)
      .join('\n')
    for (const name of [
      'ops_job_run',
      'ops_job_lock',
      'ops_dead_letter',
      'ops_alert_firing',
      'ops_cursor',
      'ops_inference_cost',
      'vault',
      'vault_consent',
      'quote_asset',
      'escrow_sweep',
      'vault_settlement',
      'vendor',
      'sku',
      'disbursement',
      'predicate_check',
      'receipt',
      'weekly_report',
      'publication',
      'screening_result',
      'token_metadata_observation',
      'pilot_assignment',
      'pilot_measurement',
      // 0008: what packages/adapters needs to run the real ports.
      'fleet_disbursement',
      'fleet_proposal',
      'ops_escalation',
      'chain_scan_cursor',
      'chain_halt_notice',
      'vault_claim_observation',
      'vault_allocation_observation',
      'inbound_message',
      'inbound_poll_offset',
      // 0011: every store that used to be in-memory only.
      'indexer_binding',
      'indexer_fee_posting',
      'indexer_block',
      'indexer_cursor',
      'indexer_pending_override',
      'indexer_recipient_observation',
      'vault_record',
      'human_approval',
      'vendor_invoice',
      'publisher_account_binding',
      'publisher_roster',
      'publisher_account_credential',
      'publisher_label_attestation',
      'image_asset',
      // 0012: the onboarding flow.
      'onboarding',
      // 0013: the delivery-predicate queue the tick loop feeds.
      'ops_predicate_check',
      'ops_predicate_withhold',
      'ops_vendor_penalty',
      // 0014: approved purchases awaiting an invoice, read by the API.
      'pending_purchase',
      // 0015: the operations plane's own ports, made durable.
      'ops_tier_history',
      'ops_qf_observation',
      'ops_sweep_match',
      'ops_settlement_record',
      'ops_report_delivery',
      'ops_screening_hash',
      // 0016: the holder replay behind the concentration signals.
      'token_holder_balance',
      'token_holder_cursor',
      // 0017: dev identity attestations recorded by the API.
      'kyb_attestation',
      // 0018: the X mentions cursor and the desk's persisted refusal log.
      'x_mention_cursor',
      'desk_refusal',
      // 0019: the on-chain sweep and settlement executors' outboxes.
      'ops_sweep_outbox',
      'ops_settlement_outbox',
      // 0021: the publishing account health log the suspension alert reads.
      'publisher_account_health',
      // 0022: the dev dashboard's wallet-signed sign-in.
      'dev_auth_challenge',
      'dev_session',
      'onboarding_quote',
    ]) {
      expect(sql, `missing table ${name}`).toContain(`CREATE TABLE IF NOT EXISTS ${name} `)
    }
  })

  it('carries no hardcoded creator rate, which the CI gate also enforces', () => {
    for (const f of loadMigrations(REAL_MIGRATIONS)) {
      expect(f.sql).not.toMatch(/0\.00(70?|35)/)
    }
  })

  it('0020 admits the referrer account in the balance table and still refuses an unknown one', async () => {
    const { db } = await openMigratedDb()
    try {
      const insert = (account: string) =>
        db.query(
          `INSERT INTO ledger_balance (vault, asset, account, debits_minor, credits_minor, balance_minor, entry_count)
           VALUES ('0xv', '0xa', $1, '0', '20000', '-20000', 1)`,
          [account],
        )
      await insert('liability:referrer_claimable')
      await expect(insert('liability:vendor_payable')).rejects.toThrow(/ledger_balance_account_known/)
      // The widened observation and outbox rows accept a referrer leg too.
      await db.query(
        `INSERT INTO vault_allocation_observation
           (id, vault, asset, dev_minor, budget_minor, operator_minor, referrer_minor, occurred_at_unix, tx_hash, log_index, block_number)
         VALUES ('0xt:0', '0xv', '0xa', 700000, 200000, 80000, 20000, 1, '0xt', 0, 1)`,
      )
      await expect(
        db.query(
          `INSERT INTO vault_allocation_observation
             (id, vault, asset, dev_minor, budget_minor, operator_minor, referrer_minor, occurred_at_unix, tx_hash, log_index, block_number)
           VALUES ('0xt:1', '0xv', '0xa', 1, 0, 0, -1, 1, '0xt', 1, 1)`,
        ),
      ).rejects.toThrow(/vault_allocation_legs_nonnegative/)
    } finally {
      await db.close()
    }
  })
})

describe('schema drift against the ledger package', () => {
  // The ledger package owns its schema; ops owns the migration that applies it.
  // If the package grows a table with no migration, a fresh deployment is missing
  // it and the failure surfaces as a runtime SQL error in production. This test
  // is the signal to add a NEW migration - never to edit 0001.
  it('every table the ledger package defines is created by some migration', () => {
    const packageSchema = readFileSync(
      resolve(HERE, '..', '..', '..', 'packages', 'ledger', 'src', 'store', 'schema.sql'),
      'utf8',
    )
    const migrationSql = readdirSync(REAL_MIGRATIONS)
      .filter((n) => n.endsWith('.sql'))
      .map((n) => readFileSync(join(REAL_MIGRATIONS, n), 'utf8'))
      .join('\n')

    const tables = [...packageSchema.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)].map((m) => m[1])
    expect(tables.length).toBeGreaterThan(0)
    for (const table of tables) {
      expect(
        migrationSql,
        `packages/ledger defines "${table}" but no ops/migrations file creates it. Add a NEW migration.`,
      ).toContain(`CREATE TABLE IF NOT EXISTS ${table} `)
    }
  })

  it('the balance table account list matches the latest migration that constrains it', () => {
    const accountsOf = (sql: string): string[] | undefined => {
      const matches = [...sql.matchAll(/CONSTRAINT ledger_balance_account_known\s+CHECK \(account IN \(([^)]*)\)\)/g)]
      const last = matches[matches.length - 1]?.[1]
      return last === undefined ? undefined : [...last.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '').sort()
    }
    const packageAccounts = accountsOf(
      readFileSync(resolve(HERE, '..', '..', '..', 'packages', 'ledger', 'src', 'store', 'schema.sql'), 'utf8'),
    )
    const migrationAccounts = accountsOf(
      loadMigrations(REAL_MIGRATIONS)
        .map((f) => f.sql)
        .join('\n'),
    )
    expect(packageAccounts).toBeDefined()
    expect(migrationAccounts, 'schema.sql grew an account no migration admits. Add a NEW migration.').toEqual(
      packageAccounts,
    )
  })
})
