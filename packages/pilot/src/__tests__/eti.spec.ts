import { describe, expect, it } from 'vitest'

import { generateAssignment, makePilotConfig } from '../assignment.js'
import { analyzeEtiDid, assignEtiOrder, EtiError } from '../eti.js'
import { commitPlan, defaultAnalysisPlan } from '../prereg.js'
import { DEFAULT_SYNTHETIC, synthesizeDataset, syntheticCoins } from '../testing/synthetic.js'
import type { EtiTrialAssignment, PilotDataset } from '../types.js'

const PILOT = 'pilot-2026-q4'
const START = Date.UTC(2026, 9, 1) / 1_000
const DAY = 86_400
const EARLY_PURCHASE = START + 14 * DAY
const COMMITTED_AT = START - 7 * DAY

const coins = syntheticCoins(40, START - DAY)
const config = makePilotConfig(PILOT, 'published-seed-a3f9', START)
const assignment = generateAssignment(config, coins, START - 3_600)

function trial(seed = 'published-seed-a3f9'): EtiTrialAssignment {
  return assignEtiOrder(
    { pilotId: PILOT, seed, earlyPurchaseUnix: EARLY_PURCHASE, lagDays: 14 },
    coins,
  )
}

function registration(iterations = 2_000) {
  const plan = defaultAnalysisPlan(PILOT, 'bootstrap-seed-771c')
  plan.estimator.ci.iterations = iterations
  plan.etiSubStudy.iterations = iterations
  return commitPlan(plan, COMMITTED_AT)
}

function dataset(seed: string): PilotDataset {
  return synthesizeDataset(assignment, coins, {
    ...DEFAULT_SYNTHETIC,
    seed,
    staffedMultiplier: 1.15,
    collectedAtUnix: START + 30 * DAY,
  })
}

/** Apply a known listing effect to the treated cohort's post window only. */
function applyEtiEffect(
  base: PilotDataset,
  etiTrial: EtiTrialAssignment,
  multiplier: number,
): PilotDataset {
  const early = new Set(
    etiTrial.entries.filter((e) => e.cohort === 'EARLY').map((e) => e.coinRef),
  )
  return {
    ...base,
    outcomes: base.outcomes.map((outcome) => {
      const treated =
        early.has(outcome.coinRef) &&
        outcome.followWindowStartUnix >= etiTrial.earlyPurchaseUnix &&
        outcome.followWindowStartUnix < etiTrial.latePurchaseUnix
      if (!treated) return outcome
      const lifted = outcome.feesUsd.usd * multiplier
      return {
        ...outcome,
        feesUsd: { ...outcome.feesUsd, usd: lifted },
        primaryLog1pFeesUsd: Math.log1p(lifted),
      }
    }),
  }
}

describe('ETI order randomization', () => {
  const t = trial()

  it('splits the cohorts evenly and gives every coin the listing', () => {
    expect(t.entries).toHaveLength(40)
    expect(t.entries.filter((e) => e.cohort === 'EARLY')).toHaveLength(20)
    expect(t.entries.filter((e) => e.cohort === 'LATE')).toHaveLength(20)
    expect(t.latePurchaseUnix - t.earlyPurchaseUnix).toBe(14 * DAY)
    for (const entry of t.entries) {
      expect(entry.purchaseAtUnix).toBe(
        entry.cohort === 'EARLY' ? t.earlyPurchaseUnix : t.latePurchaseUnix,
      )
    }
  })

  it('balances within the pre-registered baseline stratum', () => {
    for (const stratum of ['low', 'high']) {
      const inStratum = t.entries.filter((e) => e.stratum === stratum)
      const early = inStratum.filter((e) => e.cohort === 'EARLY').length
      expect(Math.abs(early - (inStratum.length - early))).toBeLessThanOrEqual(1)
    }
  })

  it('is reproducible from the published seed and moves when the seed moves', () => {
    expect(trial().assignmentHash).toBe(t.assignmentHash)
    const other = trial('a-different-seed')
    expect(other.assignmentHash).not.toBe(t.assignmentHash)
    const flipped = other.entries.filter((e, i) => e.cohort !== t.entries[i]!.cohort)
    expect(flipped.length).toBeGreaterThan(5)
  })

  it('refuses a degenerate trial rather than producing an unrandomized one', () => {
    expect(() =>
      assignEtiOrder({ pilotId: PILOT, seed: 's', earlyPurchaseUnix: EARLY_PURCHASE, lagDays: 14 }, [
        coins[0]!,
      ]),
    ).toThrow(EtiError)
    expect(() =>
      assignEtiOrder({ pilotId: PILOT, seed: 's', earlyPurchaseUnix: EARLY_PURCHASE, lagDays: 0 }, coins),
    ).toThrow(/control lag/)
  })
})

describe('difference in differences', () => {
  const t = trial()

  it('finds nothing when the listing does nothing', () => {
    const analysis = analyzeEtiDid(dataset('eti-null'), t, registration())

    expect(analysis.early + analysis.late).toBe(40)
    expect(analysis.droppedCoins).toHaveLength(0)
    expect(analysis.ciHodgesLehmann.lo).toBeLessThan(0)
    expect(analysis.ciHodgesLehmann.hi).toBeGreaterThan(0)
    expect(analysis.permutation.pValue).toBeGreaterThan(0.05)
  })

  it('recovers a known listing effect', () => {
    const lifted = applyEtiEffect(dataset('eti-effect'), t, 1.4)
    const analysis = analyzeEtiDid(lifted, t, registration())

    expect(analysis.effectPct.point).toBeGreaterThan(25)
    expect(analysis.effectPct.point).toBeLessThan(58)
    expect(analysis.ciHodgesLehmann.lo).toBeGreaterThan(0)
    expect(analysis.permutation.pValue).toBeLessThan(0.01)
    expect(analysis.didMean).toBeGreaterThan(0)
    expect(analysis.didMedian).toBeGreaterThan(0)
  })

  it('checks that desk coverage did not land differently on the two cohorts', () => {
    const analysis = analyzeEtiDid(dataset('eti-balance'), t, registration())
    for (const share of Object.values(analysis.balance)) {
      expect(share).toBeGreaterThan(0.35)
      expect(share).toBeLessThan(0.65)
    }
  })

  it('states in its own output that it does not gate Phase 1', () => {
    const analysis = analyzeEtiDid(dataset('eti-scope'), t, registration())
    expect(analysis.gatesPhase1).toBe(false)
    expect(analysis.reportText).toContain('does not gate Phase 1')
  })

  it('refuses a trial run at a lag the plan did not register', () => {
    const offPlan = assignEtiOrder(
      { pilotId: PILOT, seed: 'published-seed-a3f9', earlyPurchaseUnix: EARLY_PURCHASE, lagDays: 7 },
      coins,
    )
    expect(() => analyzeEtiDid(dataset('eti-lag'), offPlan, registration())).toThrow(
      /registered control lag/,
    )
  })

  it('refuses a trial from another pilot', () => {
    const foreign = { ...trial(), pilotId: 'pilot-elsewhere' }
    expect(() => analyzeEtiDid(dataset('eti-foreign'), foreign, registration())).toThrow(
      /pilot id mismatch/,
    )
  })
})
