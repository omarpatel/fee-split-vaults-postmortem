/**
 * Dynamic Postgres connection.
 *
 * `pg` is deliberately not a build-time dependency of this package: ops must
 * build, typecheck and unit-test with no database driver and no native module
 * present. The container images install it, and the two operator CLIs load it
 * here at the point of use.
 */

import type { PgClientLike } from '../migrations/driver.js'

export interface Connection {
  client: PgClientLike
  close: () => Promise<void>
}

interface PgModuleLike {
  Client: new (config: { connectionString: string }) => PgClientLike & {
    connect(): Promise<void>
    end(): Promise<void>
  }
}

export async function connectPg(connectionString: string): Promise<Connection> {
  let module: unknown
  try {
    const specifier = 'pg'
    module = (await import(specifier)) as unknown
  } catch (error) {
    throw new Error(
      'the "pg" client is not installed in this environment. Install it (npm install pg) or run from the ' +
        `container image, which bundles it. (${String(error)})`,
    )
  }
  const candidate = (module as { default?: unknown }).default ?? module
  const pg = candidate as PgModuleLike
  if (typeof pg.Client !== 'function') throw new Error('the "pg" module did not export a Client constructor')
  const client = new pg.Client({ connectionString })
  await client.connect()
  return { client, close: () => client.end() }
}

/** Reads the connection string the same way every ops entry point does. */
export function connectionStringFrom(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--database-url')
  if (index !== -1 && argv[index + 1] !== undefined) return argv[index + 1]
  return process.env.DATABASE_URL
}
