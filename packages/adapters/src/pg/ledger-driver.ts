/**
 * Runs the ledger package's `SqlLedgerStore` on Postgres.
 *
 * `SqlLedgerStore` writes portable SQL with `?` placeholders (its driver
 * interface serves SQLite and the statement-keyed fake too); Postgres wants
 * `$n`. This adapter rewrites the placeholders and forwards everything else.
 * The ledger's statements contain no `?` inside a string literal - every
 * statement is an exported constant in `SQL` and is checked at import below -
 * so the rewrite is a plain positional substitution.
 *
 * Type shapes line up without conversion: the ledger's INTEGER columns come
 * back from `pg` as numbers and its TEXT amounts as strings, which is what
 * the store's row decoders demand. Transactions are the driver's own.
 */

import { SQL, type SqlDriver as LedgerSqlDriver, type SqlValue as LedgerSqlValue } from '@fee-split-vaults/ledger'
import type { SqlDriver } from './sql.js'

export function toPositionalParams(sql: string): string {
  let n = 0
  return sql.replace(/\?/g, () => `$${++n}`)
}

for (const [name, statement] of Object.entries(SQL)) {
  if (/'[^']*\?[^']*'/.test(statement)) {
    throw new Error(`ledger statement ${name} has a ? inside a string literal; the Pg rewrite cannot serve it`)
  }
}

export function pgLedgerDriver(driver: SqlDriver): LedgerSqlDriver {
  return {
    query<R extends Record<string, LedgerSqlValue>>(sql: string, params: readonly LedgerSqlValue[]): Promise<R[]> {
      return driver.query<R>(toPositionalParams(sql), params)
    },
    execute(sql: string, params: readonly LedgerSqlValue[]): Promise<{ rowsAffected: number }> {
      return driver.execute(toPositionalParams(sql), params)
    },
    transaction<T>(fn: (tx: LedgerSqlDriver) => Promise<T>): Promise<T> {
      return driver.transaction((tx) => fn(pgLedgerDriver(tx)))
    },
  }
}
