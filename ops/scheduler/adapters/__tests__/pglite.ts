/**
 * A real Postgres for the ops adapter specs: pglite with every repository
 * migration applied, behind the SqlDriver the adapters are written against.
 */

import { PGlite, type Transaction } from '@electric-sql/pglite'
import { fileURLToPath } from 'node:url'
import type { SqlDriver, SqlRow, SqlValue } from '../../../migrations/driver.js'
import { migrate, NoOpLock } from '../../../migrations/runner.js'

const MIGRATIONS = fileURLToPath(new URL('../../../migrations/', import.meta.url))

type Queryable = Pick<PGlite | Transaction, 'query' | 'exec'>

export class PgliteDriver implements SqlDriver {
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

export interface MigratedDb {
  db: PGlite
  driver: SqlDriver
}

/** A fresh database with the whole migration set applied. Close `db` when done. */
export async function openMigratedDb(nowUnix = 1_757_000_000): Promise<MigratedDb> {
  const db = new PGlite()
  await db.waitReady
  const driver = new PgliteDriver(db, db)
  await migrate({ driver, directory: MIGRATIONS, nowUnix: () => nowUnix, lock: new NoOpLock() })
  return { db, driver }
}
