/**
 * Local scheduler harness.
 *
 *   npm --prefix ops run build && npm --prefix ops run scheduler:local
 *
 * Wires every job to the in-memory ports, seeds one vault with an escrow credit
 * over the sweep threshold, and ticks. It exists so the operations plane can be
 * exercised end to end - due-scope computation, locking, idempotency, the split,
 * the three-way match, the dead-letter path - without a chain, a database, or a
 * vendor, and so a change to the pipeline can be seen working in ten seconds
 * rather than in a staging environment.
 */

import { StructuredLogger, jsonLineSink } from '../lib/logging.js'
import { TERMS } from '../lib/protocol.js'
import { FixedClock, HOUR } from '../lib/time.js'
import { InMemoryDeadLetterQueue } from './deadletter.js'
import { makeFakePorts } from './fakes.js'
import { InMemoryRunStore } from './idempotency.js'
import { InMemoryLockBackend } from './lock.js'
import { assertJobConfigSane, assertRegistryComplete, buildJobs } from './registry.js'
import { InMemoryFreezeGate, Scheduler } from './scheduler.js'

const VAULT = '0x1111111111111111111111111111111111111111'
const TOKEN = '0x2222222222222222222222222222222222222222'
const USDG = '0x3333333333333333333333333333333333333333'

export async function runLocal(ticks = 3): Promise<void> {
  const clock = new FixedClock(Math.floor(Date.UTC(2026, 8, 7, 8, 0, 0) / 1000))
  const log = new StructuredLogger({
    sink: jsonLineSink(),
    nowUnix: () => clock.nowUnix(),
    minLevel: 'debug',
    base: { component: 'scheduler', env: 'local' },
  })

  const ports = makeFakePorts(clock)

  ports.vaults.add({
    address: VAULT,
    token: TOKEN,
    state: 'ACTIVE',
    tier: 'T1',
    // The published terms, read from config. The literals that used to stand
    // here were the pre-repricing rate and dial, so the local harness modelled
    // a vault the onboarding service would now refuse to sign.
    budgetBps: TERMS.budgetBpsDefault,
    operatorBps: TERMS.operatorBps,
    buybackEnabled: false,
    creatorTaxBps: 0,
    devPayout: '0x4444444444444444444444444444444444444444',
    activatedAtUnix: clock.nowUnix() - 30 * 24 * 3600,
  })
  // The local vault was last touched by its operator at activation, so the
  // heartbeat job has a liveness reading to decide against.
  ports.heartbeat.set(VAULT, clock.nowUnix() - 30 * 24 * 3600)
  ports.assets.add({
    address: USDG,
    symbol: 'USDG',
    decimals: 6,
    isPausableProxy: true,
    enabled: true,
    maxTransferMinor: 500_000_000n,
  })
  ports.escrow.credit({
    vault: VAULT,
    asset: USDG,
    creditedMinor: 1_250_000_000n,
    usd: { usd: 1250, priceSource: 'local-fake', pricedAtUnix: clock.nowUnix() },
    blockHash: '0xseedblock',
  })
  ports.ledger.vaultList = [VAULT]
  // One coin in the fleet, so the tick that runs its agent team is dispatched
  // here too. The runner behind this port is a fake; the REAL one lives in
  // @fee-split-vaults/fleet and is what OPS_PORTS_MODULE loads.
  ports.fleet.add({ coinRef: 'coin_local', vault: VAULT, nextDueUnix: 0 })

  const jobs = buildJobs(ports)
  assertRegistryComplete(jobs)
  assertJobConfigSane(jobs)

  const scheduler = new Scheduler({
    clock,
    runs: new InMemoryRunStore(),
    locks: new InMemoryLockBackend(clock),
    deadLetters: new InMemoryDeadLetterQueue(),
    freeze: new InMemoryFreezeGate(),
    log,
    workerId: 'local-1',
  }).registerAll(jobs)

  for (let i = 0; i < ticks; i += 1) {
    const report = await scheduler.tick()
    log.info('local.tick_done', {
      tick: i + 1,
      considered: report.considered,
      dispatched: report.results.length,
      dispositions: report.results.map((r) => `${r.run.jobId}=${r.disposition}`).join(' '),
    })
    clock.advance(HOUR)
  }

  log.info('local.summary', {
    fleet_ticks: ports.fleet.ticks.length,
    sweeps: ports.sweeper.calls.length,
    settlements: ports.settlement.devLegCredits.length,
    dev_leg_credited_minor: ports.settlement.devLegCredits.reduce((sum, c) => sum + c.amountMinor, 0n),
    alerts: ports.alerts.raised.length,
  })
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('run-local.js')

if (invokedDirectly) {
  runLocal().catch((error: unknown) => {
    process.stderr.write(`run-local failed: ${String(error)}\n`)
    process.exitCode = 1
  })
}
