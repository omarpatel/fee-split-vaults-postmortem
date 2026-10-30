/**
 * The scheduler process. This is what the orchestrator container runs.
 *
 * It refuses to start in three situations, all of them deliberate:
 *
 *   NO DATABASE URL. There is no in-memory production mode.
 *   PENDING MIGRATIONS. Starting against a schema this build does not match is
 *     how a job writes to a column that is not there, at 3am, once.
 *   NO PORT ADAPTER. The jobs need real implementations of OpsPorts - a chain
 *     reader, a sweeper, a ledger. ops/ deliberately does not contain them; the
 *     adapter module is named by OPS_PORTS_MODULE and loaded at startup. Running
 *     the fakes in production would mean a scheduler that reports healthy while
 *     doing nothing, which is the worst possible failure for this component.
 *
 * Environment:
 *   DATABASE_URL          required
 *   OPS_PORTS_MODULE      required unless OPS_ALLOW_FAKE_PORTS=1
 *   OPS_ALLOW_FAKE_PORTS  '1' to run against the in-memory fakes (development)
 *   OPS_WORKER_ID         defaults to hostname:pid
 *   OPS_TICK_SECONDS      defaults to 30. The LONGEST the loop sleeps between
 *                         ticks; it wakes earlier when a fleet coin is due
 *                         sooner (see sleepSecondsUntilDue).
 *   OPS_LOG_LEVEL         debug | info | warn | error, defaults to info
 *
 * The ports module reads its own inputs from the same environment (see
 * packages/fleet/src/ports.ts and .env.example, OPS section): OPERATOR_SIGNER_KEY,
 * OPS_ALERT_WEBHOOK_URL, OPS_REPORT_TELEGRAM_BOT_TOKEN, SCREENING_LEXICON_FILE,
 * OFAC_SDN_URL / OFAC_SDN_FILE.
 */

import { hostname } from 'node:os'
import { StructuredLogger, jsonLineSink, type LogLevel } from '../lib/logging.js'
import { connectPg, connectionStringFrom } from '../lib/pg.js'
import { SystemClock } from '../lib/time.js'
import { PgDriver, type SqlDriver } from '../migrations/driver.js'
import { migrate } from '../migrations/runner.js'
import { migrationsDirectory } from '../migrations/cli.js'
import { makeFakePorts } from './fakes.js'
import { SqlLockBackend } from './lock.js'
import type { OpsPorts } from './ports.js'
import { assertJobConfigSane, assertRegistryComplete, buildJobs } from './registry.js'
import { Scheduler } from './scheduler.js'
import { SqlDeadLetterQueue, SqlFreezeGate, SqlRunStore } from './store/sql.js'

export class StartupRefused extends Error {
  constructor(message: string) {
    super(`scheduler refusing to start: ${message}`)
    this.name = 'StartupRefused'
  }
}

/** The shape an adapter module must export. */
export interface PortsModule {
  createPorts(context: {
    driver: SqlDriver
    nowUnix: () => number
    /** The environment the ports module resolves its own inputs from. */
    env: Record<string, string | undefined>
  }): Promise<OpsPorts> | OpsPorts
}

export async function loadPorts(context: { driver: SqlDriver; nowUnix: () => number; env: Record<string, string | undefined> }): Promise<OpsPorts> {
  const specifier = process.env.OPS_PORTS_MODULE
  if (specifier === undefined || specifier.length === 0) {
    if (process.env.OPS_ALLOW_FAKE_PORTS === '1') {
      return makeFakePorts({ nowUnix: context.nowUnix })
    }
    throw new StartupRefused(
      'OPS_PORTS_MODULE is not set. The scheduler has no adapters and would tick without doing anything. ' +
        'Set OPS_ALLOW_FAKE_PORTS=1 only for local development.',
    )
  }
  const module = (await import(specifier)) as Partial<PortsModule>
  if (typeof module.createPorts !== 'function') {
    throw new StartupRefused(`${specifier} does not export createPorts()`)
  }
  return module.createPorts(context)
}

export async function start(): Promise<() => Promise<void>> {
  const clock = new SystemClock()
  const level = (process.env.OPS_LOG_LEVEL ?? 'info') as LogLevel
  const workerId = process.env.OPS_WORKER_ID ?? `${hostname()}:${process.pid}`
  const log = new StructuredLogger({
    sink: jsonLineSink(),
    nowUnix: () => clock.nowUnix(),
    minLevel: level,
    base: { component: 'scheduler', worker_id: workerId },
  })

  const connectionString = connectionStringFrom(process.argv.slice(2))
  if (!connectionString) throw new StartupRefused('DATABASE_URL is required')

  const { client, close } = await connectPg(connectionString)
  const driver = new PgDriver(client)

  // Pending migrations mean this build and this schema disagree. Refuse.
  const status = await migrate({
    driver,
    directory: migrationsDirectory(),
    nowUnix: () => clock.nowUnix(),
    log,
    dryRun: true,
  })
  if (status.pending.length > 0) {
    await close()
    throw new StartupRefused(
      `${status.pending.length} pending migration(s): ${status.pending.map((m) => m.fileName).join(', ')}. ` +
        'Run `node ops/migrations/cli.js up` first.',
    )
  }

  const ports = await loadPorts({ driver, nowUnix: () => clock.nowUnix(), env: process.env })
  const jobs = buildJobs(ports)
  assertRegistryComplete(jobs)
  assertJobConfigSane(jobs)

  const scheduler = new Scheduler({
    clock,
    runs: new SqlRunStore(driver),
    locks: new SqlLockBackend(driver, clock),
    deadLetters: new SqlDeadLetterQueue(driver),
    freeze: new SqlFreezeGate(driver),
    log,
    workerId,
  }).registerAll(jobs)

  const tickSeconds = Number(process.env.OPS_TICK_SECONDS ?? 30)
  if (!Number.isFinite(tickSeconds) || tickSeconds < 1) {
    await close()
    throw new StartupRefused(`OPS_TICK_SECONDS must be a number >= 1, got ${String(process.env.OPS_TICK_SECONDS)}`)
  }
  let stopping = false
  let inFlight: Promise<unknown> = Promise.resolve()

  log.info('scheduler.started', { jobs: jobs.length, tick_seconds: tickSeconds })

  const loop = async (): Promise<void> => {
    while (!stopping) {
      inFlight = scheduler.tick().catch((error: unknown) => {
        // A tick that throws must not kill the process: the next tick is the
        // recovery path, and a crash loop would take reconciliation down too.
        log.error('scheduler.tick_failed', { error: String(error) })
      })
      await inFlight
      if (stopping) break
      const sleepSeconds = sleepSecondsUntilDue(tickSeconds, ports.fleet.earliestDueUnix(), clock.nowUnix())
      // lib is ES2023: Promise.withResolvers is not available to this build.
      await new Promise((resolve) => setTimeout(resolve, sleepSeconds * 1000))
    }
  }

  const running = loop()

  const stop = async (): Promise<void> => {
    stopping = true
    // Let the current tick finish rather than abandoning a lease mid-run.
    await inFlight
    await running
    await close()
    log.info('scheduler.stopped')
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      log.info('scheduler.signal', { signal })
      void stop().then(() => {
        process.exit(0)
      })
    })
  }

  return stop
}

/**
 * How long the loop sleeps after a tick: the configured tick, or less when a
 * coin's team is due sooner. Never below one second - a coin that is already
 * overdue is picked up on the next tick, not spun on - and never above the
 * configured tick, so the non-fleet jobs keep their cadence regardless of what
 * the fleet reports. Undefined (no coin has reported yet) sleeps the full tick.
 */
export function sleepSecondsUntilDue(tickSeconds: number, earliestDueUnix: number | undefined, nowUnix: number): number {
  if (earliestDueUnix === undefined) return tickSeconds
  return Math.min(tickSeconds, Math.max(1, earliestDueUnix - nowUnix))
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('main.js')

if (invokedDirectly) {
  start().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
