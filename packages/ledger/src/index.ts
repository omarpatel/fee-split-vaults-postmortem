/**
 * The double-entry attribution ledger.
 *
 * Money is bigint minor units everywhere. USD appears only in usd.ts, only as a
 * derived reporting or gating figure, and always with its price provenance.
 */

export * from './accounts.js'
export * from './balances.js'
export * from './errors.js'
export * from './ids.js'
export * from './ledger.js'
export * from './postings.js'
export * from './precedence.js'
export * from './reconcile.js'
export * from './usd.js'
export * from './variance.js'

export * from './store/types.js'
export { InMemoryLedgerStore } from './store/memory.js'
export { SqlLedgerStore, SQL, SEQUENCE_NAME, type SqlDriver, type SqlValue } from './store/sql.js'
export { InMemorySqlDriver, UnhandledStatementError } from './store/fakeDriver.js'
export {
  NodeSqliteDriver,
  type SqliteDatabaseLike,
  type SqliteStatementLike,
} from './store/sqliteDriver.js'
