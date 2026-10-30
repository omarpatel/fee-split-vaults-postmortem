/**
 * Migration CLI.
 *
 *   node ops/migrations/cli.js status   --database-url postgres://...
 *   node ops/migrations/cli.js plan     --database-url postgres://...
 *   node ops/migrations/cli.js up       --database-url postgres://...
 *
 * There is no `down`. Rollback of a schema change that has already been written
 * to by production traffic is a data-loss operation dressed up as a convenience;
 * the recovery path is a new forward migration, which is reviewable.
 *
 * The Postgres client is imported dynamically so that this package builds,
 * typechecks and unit-tests with no database driver installed. The container
 * images install it.
 */

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StructuredLogger, jsonLineSink } from '../lib/logging.js'
import { SystemClock } from '../lib/time.js'
import type { PgClientLike } from './driver.js'
import { PgDriver } from './driver.js'
import { PgAdvisoryLock, formatPlan, loadMigrations, migrate } from './runner.js'

/** Find migrations/ whether we are running from dist/ or from source. */
export function migrationsDirectory(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [here, resolve(here, '..', '..', 'migrations'), resolve(here, '..', 'migrations')]
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, '0001_ledger.sql'))) return candidate
  }
  throw new Error(`could not locate the migrations directory; looked in ${candidates.join(', ')}`)
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  return argv[index + 1]
}

interface PgModuleLike {
  Client: new (config: { connectionString: string }) => PgClientLike & {
    connect(): Promise<void>
    end(): Promise<void>
  }
}

async function connect(connectionString: string): Promise<{
  client: PgClientLike
  close: () => Promise<void>
}> {
  let module: unknown
  try {
    // Indirect specifier: `pg` is intentionally NOT a build-time dependency, so
    // a literal import would fail to typecheck in an environment that does not
    // have it. The container images install it.
    const specifier = 'pg'
    module = (await import(specifier)) as unknown
  } catch (error) {
    throw new Error(
      `the "pg" client is not installed in this environment, so the migration CLI cannot connect. ` +
        `Install it (npm install pg) or run the migration from the container image, which bundles it. (${String(error)})`,
    )
  }
  const candidate = (module as { default?: unknown }).default ?? module
  const pg = candidate as PgModuleLike
  if (typeof pg.Client !== 'function') throw new Error('the "pg" module did not export a Client constructor')
  const client = new pg.Client({ connectionString })
  await client.connect()
  return { client, close: () => client.end() }
}

export async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? 'status'
  const directory = migrationsDirectory()
  const clock = new SystemClock()
  const log = new StructuredLogger({ sink: jsonLineSink(), nowUnix: () => clock.nowUnix(), base: { component: 'migrate' } })

  if (command === 'list') {
    // Offline: the only command that does not need a database.
    for (const file of loadMigrations(directory)) {
      process.stdout.write(`${String(file.version).padStart(4, '0')}  ${file.name}  ${file.checksum}\n`)
    }
    return 0
  }

  const connectionString = flag(argv, 'database-url') ?? process.env.DATABASE_URL
  if (!connectionString) {
    process.stderr.write('migrate: --database-url or DATABASE_URL is required\n')
    return 2
  }

  const { client, close } = await connect(connectionString)
  try {
    const driver = new PgDriver(client)
    const lock = new PgAdvisoryLock(driver)
    const dryRun = command === 'plan' || command === 'status'
    const result = await migrate({ driver, directory, nowUnix: () => clock.nowUnix(), log, lock, dryRun })
    process.stdout.write(`${formatPlan(result)}\n`)
    // `status` is a health check: pending migrations mean this deployment is
    // behind its schema, which is a failure, not information.
    if (command === 'status' && result.pending.length > 0) return 1
    return 0
  } finally {
    await close()
  }
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      process.stderr.write(`migrate: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 2
    })
}
