/**
 * A real Postgres for the store specs.
 *
 * pglite is Postgres compiled to WebAssembly, so these tests exercise the real
 * DDL in ops/migrations, the real constraints, real ON CONFLICT semantics and
 * real transactions - the things a recording driver cannot check. The
 * migrations are applied through the runner itself, so a migration file that
 * would fail on a deployment fails here first.
 */

import { PGlite, type Transaction } from '@electric-sql/pglite'
import { fileURLToPath } from 'node:url'
import { migrate, NoOpLock } from '../../../../ops/migrations/runner.js'
import type { SqlDriver, SqlRow, SqlValue } from '../pg/sql.js'

const MIGRATIONS = fileURLToPath(new URL('../../../../ops/migrations/', import.meta.url))

type Queryable = Pick<PGlite | Transaction, 'query' | 'exec'>

class PgliteDriver implements SqlDriver {
  constructor(
    private readonly db: Queryable,
    private readonly root: PGlite | undefined,
  ) {}

  async execute(sql: string, params: readonly SqlValue[] = []): Promise<{ rowsAffected: number }> {
    if (params.length === 0) {
      const results = await this.db.exec(sql)
      return { rowsAffected: results.reduce((n, r) => n + (r.affectedRows ?? 0), 0) }
    }
    const result = await this.db.query(sql, [...params])
    return { rowsAffected: result.affectedRows ?? 0 }
  }

  async query<T = SqlRow>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    const result = await this.db.query<T>(sql, [...params])
    return result.rows
  }

  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    if (this.root === undefined) return fn(this)
    return this.root.transaction((tx) => fn(new PgliteDriver(tx, undefined)))
  }
}

export interface MigratedPglite {
  driver: SqlDriver
  db: PGlite
  close(): Promise<void>
}

export async function migratedPglite(): Promise<MigratedPglite> {
  const db = new PGlite()
  await db.waitReady
  const driver = new PgliteDriver(db, db)
  await migrate({ driver, directory: MIGRATIONS, nowUnix: () => 1_700_000_000, lock: new NoOpLock() })
  return { driver, db, close: () => db.close() }
}
