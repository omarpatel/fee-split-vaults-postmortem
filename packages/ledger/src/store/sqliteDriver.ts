/**
 * A real SqlDriver over a synchronous SQLite handle.
 *
 * The database is passed IN rather than imported, against a structural type that
 * `node:sqlite`'s DatabaseSync and better-sqlite3 both already satisfy. That
 * keeps this package free of a hard dependency on an experimental built-in and
 * free of a native module, while still being a real implementation rather than a
 * description of one.
 *
 * Nesting uses SAVEPOINT so an inner transaction rolls back to its own entry
 * point instead of aborting the outer one.
 */

import { InvalidInputError } from '../errors.js'
import type { SqlDriver, SqlValue } from './sql.js'

export interface SqliteStatementLike {
  all(...params: SqlValue[]): unknown[]
  run(...params: SqlValue[]): { changes: number | bigint }
}

export interface SqliteDatabaseLike {
  prepare(sql: string): SqliteStatementLike
  exec(sql: string): void
}

export class NodeSqliteDriver implements SqlDriver {
  private readonly cache = new Map<string, SqliteStatementLike>()
  private depth = 0

  constructor(private readonly db: SqliteDatabaseLike) {}

  /** Apply schema.sql. The caller reads the file; this package ships no fs code. */
  applySchema(ddl: string): void {
    this.db.exec(ddl)
  }

  private statement(sql: string): SqliteStatementLike {
    let stmt = this.cache.get(sql)
    if (stmt === undefined) {
      stmt = this.db.prepare(sql)
      this.cache.set(sql, stmt)
    }
    return stmt
  }

  async query<R extends Record<string, SqlValue>>(
    sql: string,
    params: readonly SqlValue[],
  ): Promise<R[]> {
    return this.statement(sql).all(...params) as R[]
  }

  async execute(sql: string, params: readonly SqlValue[]): Promise<{ rowsAffected: number }> {
    const result = this.statement(sql).run(...params)
    return { rowsAffected: Number(result.changes) }
  }

  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    const name = `sp_${this.depth}`
    this.db.exec(this.depth === 0 ? 'BEGIN' : `SAVEPOINT ${name}`)
    this.depth += 1
    try {
      const result = await fn(this)
      this.depth -= 1
      this.db.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${name}`)
      return result
    } catch (error) {
      this.depth -= 1
      this.db.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}`)
      throw error
    }
  }

  close(): void {
    this.cache.clear()
    if (this.depth !== 0) {
      throw new InvalidInputError('closed with a transaction still open', 'depth')
    }
  }
}
