/**
 * Test doubles shared by the adapter specs.
 *
 * The SQL driver here is NOT a SQL engine and does not pretend to be one. It
 * records every statement and serves programmed rows, which is exactly what the
 * Postgres adapters need to be tested for: that the parameters they bind are
 * the right ones (a lowercased vault, a UTC day key, cents as an exact string),
 * and - the part that actually matters - that a driver failure becomes a throw
 * rather than a zero.
 */

import type { SqlDriver, SqlRow, SqlValue } from '../pg/sql.js'

export interface RecordedStatement {
  sql: string
  params: readonly SqlValue[]
}

export class RecordingSqlDriver implements SqlDriver {
  readonly statements: RecordedStatement[] = []
  /** Rows the next query returns, in order. Falls back to `defaultRows`. */
  readonly queued: SqlRow[][] = []
  defaultRows: SqlRow[] = []
  rowsAffected = 1
  /** Set to make every call throw, modelling an unreachable database. */
  unavailable = false

  queue(...rows: SqlRow[][]): void {
    this.queued.push(...rows)
  }

  async execute(sql: string, params: readonly SqlValue[] = []): Promise<{ rowsAffected: number }> {
    if (this.unavailable) throw new Error('connection terminated unexpectedly')
    this.statements.push({ sql, params })
    return { rowsAffected: this.rowsAffected }
  }

  async query<T = SqlRow>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    if (this.unavailable) throw new Error('connection terminated unexpectedly')
    this.statements.push({ sql, params })
    const next = this.queued.shift()
    return (next ?? this.defaultRows) as T[]
  }

  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    return fn(this)
  }

  last(): RecordedStatement {
    const statement = this.statements[this.statements.length - 1]
    if (statement === undefined) throw new Error('no statement was issued')
    return statement
  }

  /** Whitespace-collapsed, so an assertion does not depend on SQL indentation. */
  lastSql(): string {
    return this.last().sql.replace(/\s+/g, ' ').trim()
  }
}

// ---------------------------------------------------------------------------
// ABI word encoding, for building fake logs
// ---------------------------------------------------------------------------

export function word(value: bigint): string {
  if (value < 0n) throw new Error('negative word')
  return value.toString(16).padStart(64, '0')
}

export function addressWord(address: string): string {
  return address.toLowerCase().replace(/^0x/, '').padStart(64, '0')
}

export function encodeData(...words: bigint[]): `0x${string}` {
  return `0x${words.map(word).join('')}`
}
