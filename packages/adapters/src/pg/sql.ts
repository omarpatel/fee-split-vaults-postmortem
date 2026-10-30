/**
 * The narrow SQL surface this package writes against.
 *
 * DELIBERATELY A STRUCTURAL COPY, NOT AN IMPORT. `ops/migrations/driver.ts`
 * declares the same three methods for the same reason, and `@fee-split-vaults/ops`
 * cannot be imported from a package: the workspace test configs alias
 * `@fee-split-vaults/x` to `packages/x/src/index.ts`, and ops lives at the repo root
 * rather than under packages/. Importing it would resolve to a path that does
 * not exist and every test in this package would fail to load.
 *
 * The consequence is the good one anyway: `pg` is not a dependency of this
 * package either. Everything here builds, typechecks and unit-tests with no
 * database driver and no native module present, and production passes in
 * ops's `PgDriver`, which satisfies this type structurally.
 */

export type SqlValue = string | number | boolean | null
export type SqlRow = Record<string, unknown>

export interface SqlDriver {
  execute(sql: string, params?: readonly SqlValue[]): Promise<{ rowsAffected: number }>
  query<T = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<T[]>
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>
}

/**
 * Reads a Postgres integer-ish column as a bigint.
 *
 * `pg` returns BIGINT and NUMERIC as STRINGS precisely because they do not fit
 * in a double, and `sum(bigint)` comes back as NUMERIC. Passing either through
 * Number() would silently round a cent total above 2^53. Every amount in this
 * package therefore travels as a string at the driver boundary and becomes a
 * bigint here.
 */
export function bigIntFromSql(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`${field} arrived as the unsafe number ${value}; refusing to round it`)
    }
    return BigInt(value)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!/^-?\d+$/.test(trimmed)) {
      throw new TypeError(`${field} is not an integer literal: ${value}`)
    }
    return BigInt(trimmed)
  }
  throw new TypeError(`${field} is ${value === null ? 'null' : typeof value}, not an integer`)
}

/** Reads a count column. Counts are small, but they arrive as strings too. */
export function countFromSql(value: unknown, field: string): number {
  const asBigInt = bigIntFromSql(value, field)
  if (asBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`${field} is ${asBigInt}, larger than a safe integer`)
  }
  return Number(asBigInt)
}
