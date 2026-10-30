/**
 * A real Postgres for the store tests, in-process. pglite runs the actual
 * engine, so the migration SQL and the store's statements are exercised as
 * written rather than against a fake that agrees with them by construction.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import type { SqlDriver, SqlRow, SqlValue } from '@fee-split-vaults/adapters'
import { migrate, NoOpLock } from '../../../../ops/migrations/runner.js'

const MIGRATIONS = fileURLToPath(new URL('../../../../ops/migrations/', import.meta.url))
const MIGRATION = fileURLToPath(new URL('../../../../ops/migrations/0012_onboarding.sql', import.meta.url))

type Queryable = Pick<PGlite, 'query' | 'exec'> | Pick<Transaction, 'query' | 'exec'>

function driverOver(db: Queryable, transaction: SqlDriver['transaction']): SqlDriver {
  return {
    async execute(sql: string, params: readonly SqlValue[] = []): Promise<{ rowsAffected: number }> {
      if (params.length === 0) {
        // A migration file is many statements; a prepared statement takes one.
        const results = await db.exec(sql)
        return { rowsAffected: results.reduce((n, r) => n + (r.affectedRows ?? 0), 0) }
      }
      const result = await db.query(sql, [...params])
      return { rowsAffected: result.affectedRows ?? 0 }
    },
    async query<T = SqlRow>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
      const result = await db.query<T>(sql, [...params])
      return result.rows
    },
    transaction,
  }
}

export interface PgliteHarness {
  driver: SqlDriver
  close(): Promise<void>
}

/** A fresh database with the onboarding migration applied. */
export async function pgliteWithOnboarding(): Promise<PgliteHarness> {
  const db = new PGlite()
  await db.exec(readFileSync(MIGRATION, 'utf8'))
  const driver = driverOver(db, (fn) =>
    db.transaction((tx) =>
      fn(
        driverOver(tx, () => {
          throw new Error('nested transactions are not supported by this harness')
        }),
      ),
    ),
  )
  return { driver, close: () => db.close() }
}

/**
 * A fresh database with EVERY migration applied through the runner, for the
 * tests that cross into the runner's tables (vault_record, screening_result)
 * and the API's own kyb_attestation.
 */
export async function pgliteMigrated(): Promise<PgliteHarness> {
  const db = new PGlite()
  await db.waitReady
  const driver = driverOver(db, (fn) =>
    db.transaction((tx) =>
      fn(
        driverOver(tx, () => {
          throw new Error('nested transactions are not supported by this harness')
        }),
      ),
    ),
  )
  await migrate({ driver, directory: MIGRATIONS, nowUnix: () => 1_700_000_000, lock: new NoOpLock() })
  return { driver, close: () => db.close() }
}
