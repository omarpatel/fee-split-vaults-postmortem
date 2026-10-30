/**
 * Job behaviour, driven through the real scheduler against the in-memory ports.
 *
 * The tests that matter most here are the ones about doing something TWICE: a
 * second escrow claim, a second settlement, a second vendor dispute. Those are
 * the failures that cost money rather than time.
 */

import type { PredicateResult, QfMeasurement, QualificationSignals } from '@fee-split-vaults/core'
import { describe, expect, it } from 'vitest'
import { MemoryLogSink, StructuredLogger } from '../../lib/logging.js'
import { QUALIFICATION_FLOOR_MONTHLY_USD, TERMS, TIERS } from '../../lib/protocol.js'
import { DAY, FixedClock, HOUR } from '../../lib/time.js'
import { SWEEP } from '../config.js'
import { InMemoryDeadLetterQueue } from '../deadletter.js'
import { makeFakePorts, type FakePorts } from '../fakes.js'
import { InMemoryRunStore } from '../idempotency.js'
import { InMemoryLockBackend } from '../lock.js'
import {
  MONEY_MOVING_JOB_IDS,
  assertJobConfigSane,
  assertRegistryComplete,
  buildJobs,
} from '../registry.js'
import type { FleetRunner } from '../ports.js'
import { InMemoryFreezeGate, Scheduler } from '../scheduler.js'
import { escrowSweepJob, exceedsTolerance, planChunks } from '../jobs/escrow-sweep.js'
import { fleetTickJob, summaryFacts } from '../jobs/fleet-tick.js'
import { settleJob, splitAmount, SplitError } from '../jobs/settle.js'
import { deterministicSample, reconciliationJobs } from '../jobs/reconciliation.js'
import { decideTier, highestClearedTier, monthlyBudgetUsd, tierReevaluateJob } from '../jobs/tier-reevaluate.js'
import { deliveryPredicatesJob, kolOffsetsIncomplete, offsetLabel } from '../jobs/delivery-predicates.js'
import { applyPublicationRules, ReportRejected, weeklyReportJob } from '../jobs/weekly-report.js'
import { rescreenJob, verdictWorsened, worstVerdict } from '../jobs/rescreen.js'
import { assetScope, parseAssetScope } from '../jobs/scope.js'
import type { JobDefinition } from '../types.js'

const VAULT = '0x1111111111111111111111111111111111111111'
const TOKEN = '0x2222222222222222222222222222222222222222'
const USDG = '0x3333333333333333333333333333333333333333'
const START = Math.floor(Date.UTC(2026, 8, 7, 12, 0, 0) / 1000)

function harness(jobs: (ports: FakePorts) => JobDefinition[]) {
  const clock = new FixedClock(START)
  const sink = new MemoryLogSink()
  const log = new StructuredLogger({ sink: sink.sink, nowUnix: () => clock.nowUnix(), minLevel: 'debug' })
  const ports = makeFakePorts(clock)
  const deadLetters = new InMemoryDeadLetterQueue()
  const freeze = new InMemoryFreezeGate()
  const scheduler = new Scheduler({
    clock,
    runs: new InMemoryRunStore(),
    locks: new InMemoryLockBackend(clock),
    deadLetters,
    freeze,
    log,
    workerId: 'test',
  }).registerAll(jobs(ports))

  ports.vaults.add({
    address: VAULT,
    token: TOKEN,
    state: 'ACTIVE',
    tier: 'T1',
    budgetBps: 2000,
    operatorBps: 1000,
    buybackEnabled: false,
    creatorTaxBps: 0,
    devPayout: '0x4444444444444444444444444444444444444444',
    activatedAtUnix: START - 30 * DAY,
  })
  ports.assets.add({
    address: USDG,
    symbol: 'USDG',
    decimals: 6,
    isPausableProxy: true,
    enabled: true,
  })
  ports.ledger.vaultList = [VAULT]

  return { clock, sink, ports, scheduler, deadLetters, freeze, log }
}

function credit(ports: FakePorts, usd: number, minor: bigint, atUnix: number): void {
  ports.escrow.credit({
    vault: VAULT,
    asset: USDG,
    creditedMinor: minor,
    usd: { usd, priceSource: 'test', pricedAtUnix: atUnix },
    blockHash: '0xblockseed',
  })
}

// ---------------------------------------------------------------------------

describe('escrow sweep', () => {
  it('claims when the escrow value crosses the threshold', async () => {
    const { ports, scheduler, clock } = harness((p) => [escrowSweepJob(p)])
    credit(ports, SWEEP.valueThresholdUsd + 1, 1_000_000n, clock.nowUnix())

    await scheduler.tick()

    expect(ports.sweeper.calls).toHaveLength(1)
    expect(ports.sweeper.calls[0]?.vault).toBe(VAULT)
    expect(ports.ledger.sweeps.size).toBe(1)
  })

  it('does not claim a sub-threshold balance until the forced 24h interval', async () => {
    const { ports, scheduler, clock } = harness((p) => [escrowSweepJob(p)])
    credit(ports, 1, 1_000n, clock.nowUnix())

    // First tick: never run before, so the forced interval treats it as due.
    await scheduler.tick()
    expect(ports.sweeper.calls).toHaveLength(1)

    credit(ports, 1, 1_000n, clock.nowUnix())
    clock.advance(6 * HOUR)
    await scheduler.tick()
    expect(ports.sweeper.calls).toHaveLength(1)

    clock.advance(19 * HOUR)
    await scheduler.tick()
    expect(ports.sweeper.calls).toHaveLength(2)
  })

  it('never claims twice for one period, even across many ticks', async () => {
    const { ports, scheduler, clock } = harness((p) => [escrowSweepJob(p)])
    credit(ports, 500, 5_000_000n, clock.nowUnix())

    await scheduler.tick()
    credit(ports, 500, 5_000_000n, clock.nowUnix())
    await scheduler.tick()
    await scheduler.tick()

    expect(ports.sweeper.calls).toHaveLength(1)
  })

  it('posts a claim that was broadcast but never recorded, without claiming again', async () => {
    const { ports, scheduler, clock } = harness((p) => [escrowSweepJob(p)])
    credit(ports, 500, 5_000_000n, clock.nowUnix())

    // The crash: the claim went out, drained the escrow, and died before the
    // ledger write. Neither the value trigger nor the forced interval can see
    // this - the outbox is the only thing that can.
    const runKey = `escrow.sweep:${assetScope(VAULT, USDG)}:v${Math.floor(clock.nowUnix() / SWEEP.evaluateEverySeconds)}`
    await ports.sweeper.sweep({ vault: VAULT, asset: USDG, expectedMinor: 5_000_000n, runKey })
    const callsBefore = ports.sweeper.calls.length
    expect(await ports.escrow.listPending(VAULT)).toHaveLength(0)
    expect(ports.ledger.sweeps.size).toBe(0)

    const report = await scheduler.tick()

    expect(ports.sweeper.calls).toHaveLength(callsBefore)
    expect(report.results[0]?.outcome?.code).toBe('recovered_prior_sweep')
    expect(ports.ledger.sweeps.size).toBe(1)
    expect(await ports.sweeper.unrecorded(10)).toHaveLength(0)
  })

  it('drains the outbox exactly once', async () => {
    const { ports, scheduler, clock } = harness((p) => [escrowSweepJob(p)])
    const runKey = `escrow.sweep:${assetScope(VAULT, USDG)}:v${Math.floor(clock.nowUnix() / SWEEP.evaluateEverySeconds)}`
    await ports.sweeper.sweep({ vault: VAULT, asset: USDG, expectedMinor: 5_000_000n, runKey })

    await scheduler.tick()
    clock.advance(SWEEP.evaluateEverySeconds)
    await scheduler.tick()

    expect(ports.sweeper.calls).toHaveLength(1)
    expect(ports.ledger.sweeps.size).toBe(1)
  })

  it('treats a disabled quote asset as a deliberate no-op, not a retry', async () => {
    const { ports, scheduler, clock } = harness((p) => [escrowSweepJob(p)])
    credit(ports, 500, 5_000_000n, clock.nowUnix())
    ports.assets.add({ address: USDG, symbol: 'USDG', decimals: 6, isPausableProxy: true, enabled: false })

    const report = await scheduler.tick()

    expect(ports.sweeper.calls).toHaveLength(0)
    expect(report.results[0]?.disposition).toBe('completed')
    expect(report.results[0]?.outcome?.code).toBe('asset_disabled')
  })

  it('raises a ticket when the claim lands materially short', async () => {
    const { ports, scheduler, clock } = harness((p) => [escrowSweepJob(p)])
    credit(ports, 500, 1_000_000n, clock.nowUnix())
    ports.sweeper.shortfallMinor = 100_000n

    await scheduler.tick()

    expect(ports.alerts.byId('sweep_shortfall')).toHaveLength(1)
  })

  it('one unreadable vault does not blind the sweep for the rest of the book', async () => {
    const { ports, scheduler, clock } = harness((p) => [escrowSweepJob(p)])
    const other = '0x9999999999999999999999999999999999999999'
    ports.vaults.add({
      address: other,
      token: '0x8888888888888888888888888888888888888888',
      state: 'ACTIVE',
      tier: 'T0',
      budgetBps: 0,
      operatorBps: 1000,
      buybackEnabled: true,
      creatorTaxBps: 0,
      devPayout: '0x7777777777777777777777777777777777777777',
    })
    ports.escrow.failFor.add(other)
    credit(ports, 500, 1_000_000n, clock.nowUnix())

    await scheduler.tick()
    expect(ports.sweeper.calls).toHaveLength(1)
  })
})

describe('chunk planning', () => {
  it('claims everything when there is no per-transfer cap', () => {
    expect(planChunks(1_000n, undefined, 8)).toEqual({ claimMinor: 1_000n, deferredMinor: 0n, chunks: 1 })
  })

  it('splits into whole chunks under the cap', () => {
    expect(planChunks(2_500n, 1_000n, 8)).toEqual({ claimMinor: 2_500n, deferredMinor: 0n, chunks: 3 })
  })

  it('defers the remainder rather than rounding it away', () => {
    const plan = planChunks(10_000n, 1_000n, 3)
    expect(plan.claimMinor).toBe(3_000n)
    expect(plan.deferredMinor).toBe(7_000n)
    expect(plan.claimMinor + plan.deferredMinor).toBe(10_000n)
  })

  it('tolerance is integer arithmetic on minor units', () => {
    expect(exceedsTolerance(1n, 100_000n, 5)).toBe(false)
    expect(exceedsTolerance(51n, 100_000n, 5)).toBe(true)
    expect(exceedsTolerance(1n, 0n, 5)).toBe(true)
  })
})

// ---------------------------------------------------------------------------

describe('the split', () => {
  it('floors the operator and budget legs and gives the dust to the dev', () => {
    const split = splitAmount(1_000_001n, 1_000, 2_000)
    expect(split.operatorMinor).toBe(100_000n)
    expect(split.budgetMinor).toBe(200_000n)
    expect(split.devLegMinor).toBe(700_001n)
    expect(split.operatorMinor + split.budgetMinor + split.devLegMinor).toBe(1_000_001n)
  })

  it('never loses a minor unit, for any amount', () => {
    for (const amount of [0n, 1n, 7n, 999n, 123_456_789n, 10n ** 30n]) {
      const split = splitAmount(amount, 1_000, 2_000)
      expect(split.operatorMinor + split.budgetMinor + split.devLegMinor).toBe(amount)
    }
  })

  it('refuses a configuration that does not fit inside 100%', () => {
    expect(() => splitAmount(100n, 6_000, 5_000)).toThrow(SplitError)
    expect(() => splitAmount(-1n, 1_000, 2_000)).toThrow(SplitError)
  })

  it('uses the VAULT’s operator bps, not the current config default', async () => {
    const { ports, scheduler } = harness((p) => [settleJob(p)])
    // This vault signed at 5%, not at the current TERMS placeholder.
    const ref = await ports.vaults.get(VAULT)
    ports.vaults.add({ ...ref!, operatorBps: 500 })
    ports.settlement.seedUnsettled(VAULT, USDG, 1_000_000n)

    await scheduler.tick()

    const receipt = [...ports.settlement.byRunKey.values()][0]
    expect(receipt?.operatorMinor).toBe(50_000n)
    expect(receipt?.devLegMinor).toBe(750_000n)
  })
})

describe('settle', () => {
  it('credits the dev leg and never transfers it', async () => {
    const { ports, scheduler } = harness((p) => [settleJob(p)])
    ports.settlement.seedUnsettled(VAULT, USDG, 1_000_000n)

    await scheduler.tick()

    expect(ports.settlement.devLegCredits).toEqual([{ vault: VAULT, asset: USDG, amountMinor: 700_000n }])
    expect(ports.ledger.settlements.size).toBe(1)
  })

  it('is idempotent across ticks', async () => {
    const { ports, scheduler, clock } = harness((p) => [settleJob(p)])
    ports.settlement.seedUnsettled(VAULT, USDG, 1_000_000n)

    await scheduler.tick()
    ports.settlement.seedUnsettled(VAULT, USDG, 1_000_000n)
    clock.advance(30)
    await scheduler.tick()

    expect(ports.settlement.devLegCredits).toHaveLength(1)
  })

  it('refuses a vault whose dials do not fit inside 100%', async () => {
    const { ports, scheduler } = harness((p) => [settleJob(p)])
    const ref = await ports.vaults.get(VAULT)
    ports.vaults.add({ ...ref!, operatorBps: 7_000, budgetBps: 5_000 })
    ports.settlement.seedUnsettled(VAULT, USDG, 1_000_000n)

    const report = await scheduler.tick()
    expect(report.results[0]?.errorCode).toBe('invalid_bps_configuration')
    expect(ports.settlement.devLegCredits).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------

describe('reconciliation', () => {
  it('freezes authorizations and pages on a structural breach', async () => {
    const { ports, scheduler } = harness((p) => reconciliationJobs(p))
    ports.ledger.structuralFailures = [
      { invariant: 'income_recognised_once', vault: VAULT, detail: 'two sources recognised the same accrual' },
    ]

    await scheduler.tick()

    expect(ports.ledger.freezes.map((f) => f.scope)).toContain(VAULT)
    expect(ports.alerts.byId('ledger_variance_critical').length).toBeGreaterThanOrEqual(1)
  })

  it('treats a MISSING three-way leg as critical, not as unknown', async () => {
    const { ports, scheduler, clock } = harness((p) => reconciliationJobs(p))
    await ports.ledger.recordSweep({
      sweepId: 'sweep-1',
      runKey: `escrow.sweep:${assetScope(VAULT, USDG)}:v1`,
      vault: VAULT,
      asset: USDG,
      claimedMinor: 1_000n,
      chunks: 1,
      txHashes: ['0xtx'],
      blockHash: '0xb',
      completedAtUnix: clock.nowUnix(),
    })
    ports.ledger.matchOverrides.set('sweep-1', {
      matched: false,
      missingLegs: ['escrow_credited'],
      worstSeverity: 'warn',
    })

    await scheduler.tick()

    expect(ports.ledger.freezes.some((f) => f.reason.includes('three-way match'))).toBe(true)
    expect(ports.alerts.byId('ledger_variance_critical').length).toBeGreaterThanOrEqual(1)
  })

  it('the daily trial balance freezes each mismatching vault', async () => {
    const { ports, scheduler, clock } = harness((p) => reconciliationJobs(p))
    ports.ledger.trialBalanceMismatches = [
      { vault: VAULT, asset: USDG, account: 'asset:vault', materializedMinor: 10n, recomputedMinor: 11n },
    ]
    // Advance to just after the 02:00 UTC slot on the following day.
    clock.set(Math.floor(Date.UTC(2026, 8, 8, 2, 5, 0) / 1000))

    await scheduler.tick()

    expect(ports.ledger.freezes.some((f) => f.scope === VAULT && f.reason.includes('trial balance'))).toBe(true)
  })

  it('the weekly clean room checks a sample PLUS every top-tier coin', async () => {
    const { ports, scheduler, clock } = harness((p) => reconciliationJobs(p))
    const many = Array.from({ length: 100 }, (_, i) => `0x${String(i).padStart(40, '0')}`)
    ports.ledger.vaultList = many
    const topTier = many[42]
    if (topTier === undefined) throw new Error('fixture')
    ports.vaults.add({
      address: topTier,
      token: TOKEN,
      state: 'ACTIVE',
      tier: 'T3',
      budgetBps: 2000,
      operatorBps: 1000,
      buybackEnabled: false,
      creatorTaxBps: 0,
      devPayout: '0x4',
    })
    // Sunday 03:05 UTC.
    clock.set(Math.floor(Date.UTC(2026, 8, 13, 3, 5, 0) / 1000))

    const report = await scheduler.tick()
    const cleanRoom = report.results.find((r) => r.run.jobId === 'recon.clean_room')

    expect(cleanRoom?.outcome?.facts?.top_tier).toBe(1)
    expect(Number(cleanRoom?.outcome?.facts?.vaults_checked)).toBeGreaterThanOrEqual(5)
  })

  it('the sample is stable within a period and rotates between periods', () => {
    const items = Array.from({ length: 200 }, (_, i) => `v${i}`)
    const a = deterministicSample(items, 5, '2026-W37')
    const b = deterministicSample(items, 5, '2026-W37')
    const c = deterministicSample(items, 5, '2026-W38')
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
    expect(a).toHaveLength(10)
  })
})

// ---------------------------------------------------------------------------

function qf(overrides: Partial<QfMeasurement> = {}): QfMeasurement {
  return {
    vault: VAULT,
    qfPerDay: 0,
    observedDays: 14,
    sustainedDays: 14,
    measuredAtUnix: START,
    perAsset: [],
    ...overrides,
  }
}

function goodSignals(overrides: Partial<QualificationSignals> = {}): QualificationSignals {
  return {
    uniqueBuyers7d: 500,
    top10HolderSharePct: 30,
    deployerSupplySharePct: 5,
    selfTradeSharePct: 5,
    venuePoolVolumeSharePct: 80,
    coinAgeDays: 20,
    ...overrides,
  }
}

describe('tier decisions', () => {
  it('promotes one step when the gate is cleared and sustained', () => {
    const decision = decideTier({
      vault: VAULT,
      current: 'T0',
      budgetBps: 2000,
      qf: qf({ qfPerDay: 3000 }),
      signals: goodSignals(),
      daysBelowGate: 0,
      atUnix: START,
    })
    expect(decision.direction).toBe('up')
    // Cleared T2 but promotion is one step at a time.
    expect(decision.to).toBe('T1')
  })

  it('refuses a promotion the procurement budget cannot fund', () => {
    // The client sits EXACTLY on the T1 gate, so the gate cannot be what refuses
    // it, and the dial is one basis point below the smallest dial that funds the
    // floor. Both derived: with the QF written down as a literal this test kept
    // passing after the gate moved, but off the GATE rather than off the floor -
    // the reason string it asserted was no longer the reason it was getting.
    const gate = TIERS.T1.gateQfPerDay
    const dialAtFloor = Math.ceil((QUALIFICATION_FLOOR_MONTHLY_USD * 10_000) / (gate * 30))
    const base = {
      vault: VAULT,
      current: 'T0' as const,
      qf: qf({ qfPerDay: gate }),
      signals: goodSignals(),
      daysBelowGate: 0,
      atUnix: START,
    }

    const starved = decideTier({ ...base, budgetBps: dialAtFloor - 1 })
    expect(monthlyBudgetUsd(gate, dialAtFloor - 1)).toBeLessThan(QUALIFICATION_FLOOR_MONTHLY_USD)
    expect(starved.direction).toBe('hold')
    expect(starved.reason).toContain('below_qualification_floor')

    // One basis point more and the same client is promoted, which is what proves
    // the refusal above came from the floor and from nothing else.
    const funded = decideTier({ ...base, budgetBps: dialAtFloor })
    expect(monthlyBudgetUsd(gate, dialAtFloor)).toBeGreaterThanOrEqual(QUALIFICATION_FLOOR_MONTHLY_USD)
    expect(funded.direction).toBe('up')
    expect(funded.to).toBe('T1')
  })

  it('refuses a promotion when the wash-trading conjuncts fail', () => {
    const decision = decideTier({
      vault: VAULT,
      current: 'T0',
      budgetBps: 2000,
      qf: qf({ qfPerDay: 3000 }),
      signals: goodSignals({ selfTradeSharePct: 90, uniqueBuyers7d: 3 }),
      daysBelowGate: 0,
      atUnix: START,
    })
    expect(decision.direction).toBe('hold')
    expect(decision.reason).toContain('self_trade_share')
  })

  it('will not grant a paid tier on fewer than seven observed days', () => {
    expect(highestClearedTier(qf({ qfPerDay: 100_000, observedDays: 3, sustainedDays: 3 }))).toBe('T0')
  })

  it('holds a downgrade during the grace period and applies it afterwards', () => {
    const base = {
      vault: VAULT,
      current: 'T2' as const,
      budgetBps: 2000,
      qf: qf({ qfPerDay: 10, sustainedDays: 0 }),
      signals: goodSignals(),
      atUnix: START,
    }
    expect(decideTier({ ...base, daysBelowGate: 1 }).direction).toBe('hold')
    expect(decideTier({ ...base, daysBelowGate: 5 }).direction).toBe('down')
    expect(decideTier({ ...base, daysBelowGate: 5 }).to).toBe('T1')
  })

  it('monthlyBudgetUsd is the arithmetic the floor is stated in', () => {
    // The floor is a monthly figure and the gates are daily, so the only claim
    // worth pinning is the conversion between them. Derived from config: the
    // literal that used to stand here (250 x 2,000 bps x 30 = 1,500) was the old
    // T1 gate landing exactly on the floor, and that coincidence is gone.
    const gate = TIERS.T1.gateQfPerDay
    expect(monthlyBudgetUsd(gate, TERMS.budgetBpsDefault)).toBe(
      (gate * TERMS.budgetBpsDefault * 30) / 10_000,
    )
    // A paid tier at the published default dial has to clear its own floor, or
    // the gate is set below the point where the tier can buy anything.
    expect(monthlyBudgetUsd(gate, TERMS.budgetBpsDefault)).toBeGreaterThanOrEqual(
      QUALIFICATION_FLOOR_MONTHLY_USD,
    )
  })

  it('the job applies the decision and raises a ticket on a downgrade', async () => {
    const { ports, scheduler } = harness((p) => [tierReevaluateJob(p)])
    ports.tiers.set(VAULT, 'T2', 5)
    ports.qf.set(VAULT, qf({ qfPerDay: 1, sustainedDays: 0 }), goodSignals())

    await scheduler.tick()

    expect(ports.tiers.applied[0]?.direction).toBe('down')
    expect(ports.alerts.byId('tier_gate_crossed_downward')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------

describe('delivery predicates', () => {
  const kolSpec = {
    kind: 'kol_post' as const,
    verifyAtOffsetsSeconds: [24 * HOUR, 7 * DAY],
    params: {},
  }

  function dueCheck(offsetSeconds: number, atUnix: number) {
    return {
      disbursementId: 'd-1',
      vault: VAULT,
      token: TOKEN,
      skuId: 'kol-a',
      vendorId: 'vendor-a',
      spec: kolSpec,
      offsetSeconds,
      fundedAtUnix: atUnix - offsetSeconds,
      dueAtUnix: atUnix,
      costUsd: 250,
    }
  }

  it('records a pass and pays nothing out of band', async () => {
    const { ports, scheduler, clock } = harness((p) => [deliveryPredicatesJob(p)])
    ports.predicates.due = [dueCheck(24 * HOUR, clock.nowUnix())]
    ports.predicateVerifier.pass('d-1', 24 * HOUR)

    await scheduler.tick()

    expect(ports.predicates.recorded).toHaveLength(1)
    expect(ports.predicates.withheld).toHaveLength(0)
  })

  it('withholds payment and penalises the vendor on a failure', async () => {
    const { ports, scheduler, clock } = harness((p) => [deliveryPredicatesJob(p)])
    ports.predicates.due = [dueCheck(24 * HOUR, clock.nowUnix())]

    await scheduler.tick()

    expect(ports.predicates.withheld).toHaveLength(1)
    expect(ports.predicates.penalties).toHaveLength(1)
    expect(ports.alerts.byId('delivery_predicate_failed')).toHaveLength(1)
  })

  it('pages when a KOL post that passed at T+24h is gone at T+7d', async () => {
    const { ports, scheduler, clock } = harness((p) => [deliveryPredicatesJob(p)])
    ports.predicates.due = [dueCheck(7 * DAY, clock.nowUnix())]

    await scheduler.tick()

    const alerts = ports.alerts.byId('kol_post_deleted_or_undisclosed')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.severity).toBe('page')
  })

  it('refuses to verify a KOL SKU that is missing a mandatory offset', async () => {
    const { ports, scheduler, clock } = harness((p) => [deliveryPredicatesJob(p)])
    const check = dueCheck(24 * HOUR, clock.nowUnix())
    ports.predicates.due = [{ ...check, spec: { ...kolSpec, verifyAtOffsetsSeconds: [24 * HOUR] } }]

    await scheduler.tick()

    expect(ports.predicateVerifier.passing.size).toBe(0)
    expect(ports.predicates.recorded).toHaveLength(0)
    expect(ports.predicates.withheld).toHaveLength(1)
    expect(ports.alerts.byId('sku_predicate_misconfigured')).toHaveLength(1)
  })

  it('kolOffsetsIncomplete only judges kol_post specs', () => {
    expect(kolOffsetsIncomplete(kolSpec)).toBe(false)
    expect(kolOffsetsIncomplete({ ...kolSpec, verifyAtOffsetsSeconds: [7 * DAY] })).toBe(true)
    expect(kolOffsetsIncomplete({ kind: 'eti_listing', verifyAtOffsetsSeconds: [3600], params: {} })).toBe(false)
  })

  it('offsetLabel renders the two mandatory checkpoints readably', () => {
    expect(offsetLabel(24 * HOUR)).toBe('T+1d')
    expect(offsetLabel(7 * DAY)).toBe('T+7d')
    expect(offsetLabel(90)).toBe('T+90s')
  })

  it('a failing verifier that returns rather than throws is still a non-delivery', async () => {
    const { ports, scheduler, clock } = harness((p) => [deliveryPredicatesJob(p)])
    ports.predicates.due = [dueCheck(24 * HOUR, clock.nowUnix())]
    await scheduler.tick()
    const recorded: PredicateResult | undefined = ports.predicates.recorded[0]?.result
    expect(recorded?.passed).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe('the weekly dev report', () => {
  const baseReport = {
    vault: VAULT,
    periodStartUnix: START - 7 * DAY,
    periodEndUnix: START,
    qfReceivedUsd: 100,
    devLegUsd: 70,
    budgetSpentUsd: 20,
    operatorFeeUsd: 10,
    referrerFeeUsd: 0,
    lineItems: [],
    verifiedReachSummary: 'x',
    withheldPayments: [],
    whatWeDidNotDo: ['No paid promotion was purchased.'],
  }

  it('rejects a report with no "what we did not do" section', () => {
    expect(() => applyPublicationRules({ ...baseReport, whatWeDidNotDo: [] }, START)).toThrow(ReportRejected)
  })

  it('holds embargoed line items and tells the dev how many are held', () => {
    const result = applyPublicationRules(
      {
        ...baseReport,
        lineItems: [
          {
            id: 'r1',
            vault: VAULT,
            kind: 'procurement',
            amountUsd: 299,
            description: 'listing',
            publishAfterUnix: START + 3600,
            occurredAtUnix: START,
          },
        ],
      },
      START,
    )
    expect(result.lineItems).toHaveLength(0)
    expect(result.whatWeDidNotDo.join(' ')).toContain('1 committed line item')
  })

  it('publishes a line item once its embargo has expired', () => {
    const result = applyPublicationRules(
      {
        ...baseReport,
        lineItems: [
          {
            id: 'r1',
            vault: VAULT,
            kind: 'procurement',
            amountUsd: 299,
            description: 'listing',
            publishAfterUnix: START - 1,
            occurredAtUnix: START - 100,
          },
        ],
      },
      START,
    )
    expect(result.lineItems).toHaveLength(1)
  })

  it('sends exactly one report per ISO week', async () => {
    const { ports, scheduler, clock } = harness((p) => [weeklyReportJob(p)])
    // Monday 09:05 UTC.
    clock.set(Math.floor(Date.UTC(2026, 8, 7, 9, 5, 0) / 1000))

    await scheduler.tick()
    clock.advance(2 * DAY)
    await scheduler.tick()
    expect(ports.reportDelivery.delivered).toHaveLength(1)

    // The following Monday.
    clock.set(Math.floor(Date.UTC(2026, 8, 14, 9, 5, 0) / 1000))
    await scheduler.tick()
    expect(ports.reportDelivery.delivered).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------

describe('re-screening', () => {
  function change(hash: string, atUnix: number) {
    return {
      token: TOKEN,
      vault: VAULT,
      metadataRef: 'ref-1',
      metadataHash: hash,
      changedFields: ['name' as const],
      observedAtUnix: atUnix,
      blockHash: '0xb',
    }
  }

  it('suspends the vault and pages when a change produces BLOCKED', async () => {
    const { ports, scheduler, clock } = harness((p) => [rescreenJob(p)])
    ports.metadata.changes = [change('h1', clock.nowUnix() - 10)]
    ports.screening.nextVerdict = 'BLOCKED'
    ports.screening.nextFlags = ['trademark_hit']

    await scheduler.tick()

    expect(ports.enforcement.vaultSuspensions).toHaveLength(1)
    expect(ports.enforcement.escalations[0]?.severity).toBe('critical')
    expect(ports.alerts.byId('screening_blocked_after_metadata_change')).toHaveLength(1)
  })

  it('suspends only paid media on RESTRICTED', async () => {
    const { ports, scheduler, clock } = harness((p) => [rescreenJob(p)])
    ports.metadata.changes = [change('h1', clock.nowUnix() - 10)]
    ports.screening.nextVerdict = 'RESTRICTED'

    await scheduler.tick()

    expect(ports.enforcement.paidMediaSuspensions).toHaveLength(1)
    expect(ports.enforcement.vaultSuspensions).toHaveLength(0)
  })

  it('a re-screen NEVER un-blocks: the verdict is sticky', async () => {
    const { ports, scheduler, clock, sink } = harness((p) => [rescreenJob(p)])
    ports.screening.seed(TOKEN, {
      token: TOKEN,
      verdict: 'BLOCKED',
      flags: ['trademark_hit'],
      stagesRun: ['lexicon'],
      screenedAtUnix: clock.nowUnix() - DAY,
      paidMediaPermitted: false,
      metadataHash: 'old',
    })
    ports.metadata.changes = [change('h2', clock.nowUnix() - 10)]
    ports.screening.nextVerdict = 'CLEAR'

    await scheduler.tick()

    const recorded = await ports.screening.lastResult(TOKEN)
    expect(recorded?.verdict).toBe('BLOCKED')
    expect(recorded?.paidMediaPermitted).toBe(false)
    expect(sink.events()).toContain('screening.rescreen.verdict_improved_but_sticky')
  })

  it('skips a change whose metadata hash it has already screened', async () => {
    const { ports, scheduler, clock } = harness((p) => [rescreenJob(p)])
    ports.screening.seed(TOKEN, {
      token: TOKEN,
      verdict: 'CLEAR',
      flags: [],
      stagesRun: ['lexicon'],
      screenedAtUnix: clock.nowUnix() - DAY,
      paidMediaPermitted: true,
      metadataHash: 'same',
    })
    ports.metadata.changes = [change('same', clock.nowUnix() - 10)]

    const report = await scheduler.tick()
    expect(report.results[0]?.outcome?.facts?.unchanged).toBe(1)
    expect(report.results[0]?.outcome?.facts?.screened).toBe(0)
  })

  it('verdict monotonicity helpers', () => {
    expect(worstVerdict('CLEAR', 'RESTRICTED')).toBe('RESTRICTED')
    expect(worstVerdict('BLOCKED', 'CLEAR')).toBe('BLOCKED')
    expect(verdictWorsened(undefined, 'CLEAR')).toBe(false)
    expect(verdictWorsened(undefined, 'RESTRICTED')).toBe(true)
    expect(verdictWorsened('BLOCKED', 'RESTRICTED')).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe('the fleet tick', () => {
  const ALPHA = { coinRef: 'coin_alpha', vault: VAULT, nextDueUnix: START }
  const BRAVO = {
    coinRef: 'coin_bravo',
    vault: '0xbbbb111111111111111111111111111111111111',
    nextDueUnix: START,
  }
  const CERES = {
    coinRef: 'coin_ceres',
    vault: '0xcccc111111111111111111111111111111111111',
    nextDueUnix: START,
  }

  function fleetHarness() {
    const h = harness((p) => [fleetTickJob(p)])
    h.ports.fleet.add(ALPHA).add(BRAVO).add(CERES)
    return h
  }

  it('gives every coin its own scope, so the book runs as three runs and not one', async () => {
    const { ports, scheduler } = fleetHarness()

    await scheduler.tick()

    // Three ticks, one per coin, each under its own scope. A fleet-wide scope
    // would show up here as a single run doing all three.
    expect(ports.fleet.ticks.map((t) => t.coinRef).sort()).toEqual([
      'coin_alpha',
      'coin_bravo',
      'coin_ceres',
    ])
    expect(new Set(ports.fleet.ticks.map((t) => t.runKey)).size).toBe(3)
  })

  it('dead-letters only the coin that failed; the rest of the book still ticks', async () => {
    const { ports, scheduler, deadLetters } = fleetHarness()
    ports.fleet.failFor.add('coin_bravo')

    await scheduler.tick()

    // THE ISOLATION CLAIM, MEASURED. One coin's team threw and the other two
    // still ran - which is the entire reason this job scopes per coin.
    expect(ports.fleet.ticks.map((t) => t.coinRef).sort()).toEqual(['coin_alpha', 'coin_ceres'])

    const letters = await deadLetters.list()
    expect(letters).toHaveLength(1)
    expect(letters[0]?.scope).toBe('coin_bravo')
  })

  it('is blocked by a freeze, because a tick can authorize a reimbursement', async () => {
    const { ports, scheduler, freeze } = fleetHarness()
    freeze.freezeGlobal()

    await scheduler.tick()

    // Not "fewer ticks" - NO ticks. A critical ledger variance means the fleet
    // stops authorizing, and the only way that holds is movesMoney being true
    // on this job.
    expect(ports.fleet.ticks).toHaveLength(0)
  })

  it('does not tick again for a run key that already ticked, even after losing its own bookkeeping', async () => {
    const { clock, ports, scheduler, log } = fleetHarness()

    await scheduler.tick()
    expect(ports.fleet.ticks).toHaveLength(3)

    // COUNT THE CALLS, not the effects. The fleet runner is itself idempotent
    // per run key, so asserting on what it recorded would pass whether or not
    // this job ever checked - the fake would absorb the second call silently.
    // What is under test is that the JOB does not make the call at all.
    let tickCalls = 0
    // Typed as the PORT, not as the fake's class. `typeof ports.fleet` would
    // demand the fake's private bookkeeping too, and the point of this stand-in
    // is that it has none - it only has to be something the job can call.
    const counting: FleetRunner = {
      dueCoins: (nowUnix) => ports.fleet.dueCoins(nowUnix),
      findByRunKey: (runKey) => ports.fleet.findByRunKey(runKey),
      earliestDueUnix: () => ports.fleet.earliestDueUnix(),
      tick: (input) => {
        tickCalls += 1
        return ports.fleet.tick(input)
      },
    }

    // A scheduler that crashed after the tick and came back with an empty run
    // store: same clock, same period, same run keys, no memory of having run
    // them. Without the job's own re-entry check this is where a coin gets
    // ticked - and reimbursed - a second time.
    const recovered = new Scheduler({
      clock,
      runs: new InMemoryRunStore(),
      locks: new InMemoryLockBackend(clock),
      deadLetters: new InMemoryDeadLetterQueue(),
      freeze: new InMemoryFreezeGate(),
      log,
      workerId: 'test-recovered',
    }).registerAll([fleetTickJob({ ...ports, fleet: counting })])

    await recovered.tick()

    expect(tickCalls).toBe(0)
    expect(ports.fleet.ticks).toHaveLength(3)
  })

  it('declares itself a money job with no retry budget', () => {
    const clock = new FixedClock(START)
    const job = fleetTickJob(makeFakePorts(clock))

    expect(job.movesMoney).toBe(true)
    // One attempt. A retried tick is a repeated claim, and the next window is a
    // fresh run key that picks the coin up anyway.
    expect(job.maxAttempts).toBe(1)
    expect(job.leaseSeconds).toBeGreaterThan(job.timeoutSeconds)
    expect(MONEY_MOVING_JOB_IDS).toContain('fleet.tick')
  })

  it('projects a summary into counts and codes, and leaves an unmeasured count OUT', () => {
    const base = {
      coinRef: 'coin_alpha',
      vault: VAULT,
      tier: 'T1' as const,
      atUnix: START,
      replayed: false,
      ranChainPoll: true,
      ranCognition: true,
      proposals: 1,
      suppressed: 1,
      refusals: ['spend:rolling_cap'],
      disbursed: 0,
      spendsRefused: 1,
      published: 0,
      publishRejected: 0,
      inferenceMicroUsd: 2_666,
      degradeLevel: 'full',
      modelProvenance: 'fake' as const,
      nextDueUnix: START + 1_800,
    }

    // A window that was never opened has no admitted-message count. Writing it
    // as 0 would read as "a window with nothing in it", which is a different
    // and false fact - so the key is absent instead.
    const unmeasured = summaryFacts(base)
    expect(unmeasured).not.toHaveProperty('admitted_messages')
    expect(unmeasured).not.toHaveProperty('window_id')

    const measured = summaryFacts({ ...base, admittedMessages: 0, windowId: 'coin_alpha:1' })
    expect(measured.admitted_messages).toBe(0)

    // Provenance rides on every run, not only the fake ones, and the refusal
    // vocabulary is codes rather than anything a model or a holder wrote.
    expect(unmeasured.model_provenance).toBe('fake')
    expect(unmeasured.refusal_codes).toBe('spend:rolling_cap')
  })
})

// ---------------------------------------------------------------------------

describe('the registry', () => {
  it('registers every declared job and no others', () => {
    const clock = new FixedClock(START)
    const jobs = buildJobs(makeFakePorts(clock))
    expect(() => assertRegistryComplete(jobs)).not.toThrow()
  })

  it('every job has a lease longer than its timeout and a sane retry budget', () => {
    const clock = new FixedClock(START)
    expect(() => assertJobConfigSane(buildJobs(makeFakePorts(clock)))).not.toThrow()
  })

  it('rejects a money-moving job with a generous retry budget', () => {
    const clock = new FixedClock(START)
    const jobs = buildJobs(makeFakePorts(clock))
    const sweep = jobs.find((j) => j.id === 'escrow.sweep')
    if (!sweep) throw new Error('fixture')
    expect(() =>
      assertJobConfigSane([{ ...sweep, maxAttempts: 10 }]),
    ).toThrow(/may not retry more than 3 times/)
  })
})

describe('scope encoding', () => {
  it('round-trips a vault and asset', () => {
    expect(parseAssetScope(assetScope(VAULT, USDG))).toEqual({ vault: VAULT, asset: USDG })
  })

  it('refuses an ambiguous scope rather than producing a colliding key', () => {
    expect(() => assetScope('0xaa#bb', USDG)).toThrow()
    expect(() => parseAssetScope('novault')).toThrow()
  })
})
