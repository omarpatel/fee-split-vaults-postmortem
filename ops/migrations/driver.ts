/**
 * The narrow SQL surface the migration runner and the SQL lock backend need.
 *
 * Deliberately not a database client. `pg` is not a dependency of this package:
 * the adapter below is written against a structural type that the real client
 * happens to satisfy, so ops can be built, typechecked and unit-tested with no
 * database and no native module, and production wires the real client in one
 * place.
 */

export type SqlValue = string | number | boolean | null
export type SqlRow = Record<string, unknown>

export interface SqlDriver {
  /** DDL or DML. Returns how many rows changed, which the lock backend relies on. */
  execute(sql: string, params?: readonly SqlValue[]): Promise<{ rowsAffected: number }>
  query<T = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<T[]>
  /** Runs fn inside a transaction. Rolls back on any throw, including a rethrow. */
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>
}

export class SqlDriverError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'SqlDriverError'
  }
}

// ---------------------------------------------------------------------------
// Postgres adapter
// ---------------------------------------------------------------------------

export interface PgQueryResult {
  rows: unknown[]
  rowCount: number | null
}

/** The subset of `pg`'s Client/PoolClient this adapter uses. */
export interface PgClientLike {
  query(text: string, values?: readonly unknown[]): Promise<PgQueryResult>
}

export class PgDriver implements SqlDriver {
  readonly #client: PgClientLike
  #inTransaction: boolean

  constructor(client: PgClientLike, inTransaction = false) {
    this.#client = client
    this.#inTransaction = inTransaction
  }

  async execute(sql: string, params: readonly SqlValue[] = []): Promise<{ rowsAffected: number }> {
    try {
      // No params means the simple query protocol, which is what allows a whole
      // migration file - many statements - to run as one call.
      const result = params.length === 0 ? await this.#client.query(sql) : await this.#client.query(sql, params)
      return { rowsAffected: result.rowCount ?? 0 }
    } catch (error) {
      throw new SqlDriverError('execute failed', error)
    }
  }

  async query<T = SqlRow>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    try {
      const result = params.length === 0 ? await this.#client.query(sql) : await this.#client.query(sql, params)
      return result.rows as T[]
    } catch (error) {
      throw new SqlDriverError('query failed', error)
    }
  }

  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    if (this.#inTransaction) return fn(this)
    await this.execute('BEGIN')
    this.#inTransaction = true
    try {
      const value = await fn(this)
      await this.execute('COMMIT')
      return value
    } catch (error) {
      try {
        await this.execute('ROLLBACK')
      } catch {
        // The connection is probably gone. The original error is the useful one.
      }
      throw error
    } finally {
      this.#inTransaction = false
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory fake
// ---------------------------------------------------------------------------

export interface RecordedStatement {
  sql: string
  params: readonly SqlValue[]
}

/**
 * A fake that understands exactly the statements the migration runner issues and
 * records everything else verbatim.
 *
 * It is NOT a SQL engine and does not pretend to be: it holds the migration
 * ledger as a list of objects so the runner's ordering, checksum and
 * idempotency logic can be tested without a database. Anything the runner would
 * send to Postgres is captured in `statements`, which is where a test asserts
 * that migration 0003 actually ran.
 */
export class InMemoryMigrationDriver implements SqlDriver {
  readonly statements: RecordedStatement[] = []
  readonly applied: Array<{ version: number; name: string; checksum: string; applied_at_unix: number }> = []
  #tableCreated = false
  #depth = 0
  /** Set to a version to make its migration throw, so rollback can be tested. */
  failOnVersion?: number
  /** Set to make every call throw. */
  unavailable = false

  async execute(sql: string, params: readonly SqlValue[] = []): Promise<{ rowsAffected: number }> {
    if (this.unavailable) throw new SqlDriverError('injected fault')
    this.statements.push({ sql, params })
    const trimmed = sql.trim()

    if (/^BEGIN\b/i.test(trimmed)) {
      this.#depth += 1
      return { rowsAffected: 0 }
    }
    if (/^COMMIT\b/i.test(trimmed)) {
      this.#depth = Math.max(0, this.#depth - 1)
      return { rowsAffected: 0 }
    }
    if (/^ROLLBACK\b/i.test(trimmed)) {
      this.#depth = Math.max(0, this.#depth - 1)
      return { rowsAffected: 0 }
    }
    if (/CREATE TABLE IF NOT EXISTS ops_migration\b/i.test(trimmed)) {
      this.#tableCreated = true
      return { rowsAffected: 0 }
    }
    if (/^INSERT INTO ops_migration\b/i.test(trimmed)) {
      const [version, name, checksum, appliedAt] = params
      this.applied.push({
        version: Number(version),
        name: String(name),
        checksum: String(checksum),
        applied_at_unix: Number(appliedAt),
      })
      return { rowsAffected: 1 }
    }
    if (this.failOnVersion !== undefined && sql.includes(`__fail_marker_${this.failOnVersion}__`)) {
      throw new SqlDriverError(`injected failure for version ${this.failOnVersion}`)
    }
    return { rowsAffected: 0 }
  }

  async query<T = SqlRow>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    if (this.unavailable) throw new SqlDriverError('injected fault')
    this.statements.push({ sql, params })
    if (/FROM ops_migration\b/i.test(sql)) {
      if (!this.#tableCreated) throw new SqlDriverError('ops_migration does not exist')
      return [...this.applied].sort((a, b) => a.version - b.version) as unknown as T[]
    }
    return []
  }

  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    const snapshot = this.applied.length
    await this.execute('BEGIN')
    try {
      const value = await fn(this)
      await this.execute('COMMIT')
      return value
    } catch (error) {
      await this.execute('ROLLBACK')
      // Undo the in-memory effect the same way the database would.
      this.applied.length = snapshot
      throw error
    }
  }
}
