import { describe, expect, it } from 'vitest'

import { analyzeDesk, AnalysisError, coinDifferences } from '../analysis.js'
import { generateAssignment, makePilotConfig } from '../assignment.js'
import { applyRegisteredExclusions } from '../exclusions.js'
import {
  commitPlan,
  defaultAnalysisPlan,
  PlanTamperedError,
  UnregisteredCovariateError,
  type AnalysisPlan,
  type PreRegistration,
} from '../prereg.js'
import {
  DEFAULT_SYNTHETIC,
  synthesizeDataset,
  syntheticCoins,
  type SyntheticContamination,
} from '../testing/synthetic.js'
import type { PilotAssignment, PilotCoin, PilotDataset } from '../types.js'

const PILOT = 'pilot-2026-q4'
const START = Date.UTC(2026, 9, 1) / 1_000
const COMMITTED_AT = START - 7 * 86_400

interface Fixture {
  coins: PilotCoin[]
  assignment: PilotAssignment
  dataset: PilotDataset
  registration: PreRegistration
  plan: AnalysisPlan
}

interface FixtureOptions {
  coinOverrides?: Partial<PilotCoin>
  contamination?: SyntheticContamination
}

function fixture(
  coinCount: number,
  staffedMultiplier: number,
  seed = 'synth-a',
  options: FixtureOptions = {},
): Fixture {
  const config = makePilotConfig(PILOT, 'published-seed-a3f9', START)
  const coins = syntheticCoins(coinCount, START - 86_400, options.coinOverrides ?? {})
  const assignment = generateAssignment(config, coins, START - 3_600)
  const dataset = synthesizeDataset(assignment, coins, {
    ...DEFAULT_SYNTHETIC,
    seed,
    staffedMultiplier,
    collectedAtUnix: START + 30 * 86_400,
    ...(options.contamination ? { contamination: options.contamination } : {}),
  })
  // 2000 draws keeps the suite quick; the registered plan commits to 10000.
  const plan = defaultAnalysisPlan(PILOT, 'bootstrap-seed-771c')
  plan.estimator.ci.iterations = 2_000
  plan.etiSubStudy.iterations = 2_000
  const registration = commitPlan(plan, COMMITTED_AT, 'anchor:pre-registration-tx')
  return { coins, assignment, dataset, registration, plan }
}

describe('paired within-coin differencing', () => {
  const { dataset } = fixture(44, 1.3)

  it('pairs every coin and uses hour-of-day and day-of-week as strata', () => {
    const differences = coinDifferences(dataset.outcomes, (o) => o.primaryLog1pFeesUsd, 1)
    expect(differences).toHaveLength(44)
    for (const coin of differences) {
      expect(coin.staffedBlocks).toBe(30)
      expect(coin.unstaffedBlocks).toBe(30)
      // Seven weekdays x two half-days, every cell observed in both arms.
      expect(coin.pairedStrata).toBe(14)
    }
  })

  it('ignores the full-coverage phase, which was never randomized', () => {
    const withFullCoverage = dataset.outcomes.map((o) => ({ ...o, phase: 'FULL_COVERAGE' as const }))
    expect(coinDifferences(withFullCoverage, (o) => o.primaryLog1pFeesUsd, 1)).toHaveLength(0)
  })
})

describe('decision rule on synthetic data', () => {
  it('says DO NOT PROCEED on a synthetic null', () => {
    const { dataset, assignment, registration } = fixture(48, 1.0, 'synth-null')
    const analysis = analyzeDesk(dataset, registration, assignment.assignmentHash)

    expect(analysis.decision.verdict).toBe('DO_NOT_PROCEED')
    expect(analysis.decision.proceed).toBe(false)
    expect(analysis.decision.ciExcludesZero).toBe(false)
    expect(Math.abs(analysis.decision.pointEstimatePct)).toBeLessThan(10)
    expect(analysis.decision.statement).toBe(registration.plan.decisionRule.failureStatement)
    expect(analysis.reportText).toContain('45%')
    expect(analysis.reportText).toContain('DO NOT PROCEED')
  })

  it('says PROCEED on a synthetic positive that clears the committed threshold', () => {
    const { dataset, assignment, registration } = fixture(48, 1.3, 'synth-positive')
    const analysis = analyzeDesk(dataset, registration, assignment.assignmentHash)

    expect(analysis.decision.verdict).toBe('PROCEED_TO_PHASE_1')
    expect(analysis.decision.proceed).toBe(true)
    expect(analysis.decision.ciExcludesZero).toBe(true)
    expect(analysis.decision.pointEstimatePct).toBeGreaterThanOrEqual(10)
    // The generator injected a 30% lift; the estimator should land near it.
    expect(analysis.decision.pointEstimatePct).toBeGreaterThan(22)
    expect(analysis.decision.pointEstimatePct).toBeLessThan(38)
    expect(analysis.decision.statement).toBe(registration.plan.decisionRule.successStatement)
  })

  it('says DO NOT PROCEED on a real but too-small effect, even with a significant interval', () => {
    const { dataset, assignment, registration } = fixture(56, 1.05, 'synth-small')
    const analysis = analyzeDesk(dataset, registration, assignment.assignmentHash)

    expect(analysis.decision.ciExcludesZero).toBe(true)
    expect(analysis.decision.pointEstimatePct).toBeGreaterThan(0)
    expect(analysis.decision.pointEstimatePct).toBeLessThan(10)
    expect(analysis.decision.verdict).toBe('DO_NOT_PROCEED')
    expect(analysis.decision.proceed).toBe(false)
  })

  it('refuses to call an underpowered study either way', () => {
    const { dataset, assignment, registration } = fixture(20, 1.3, 'synth-underpowered')
    const analysis = analyzeDesk(dataset, registration, assignment.assignmentHash)

    expect(analysis.decision.verdict).toBe('INCONCLUSIVE_UNDERPOWERED')
    expect(analysis.decision.proceed).toBe(false)
    expect(analysis.decision.coins).toBe(20)
    expect(analysis.decision.minCoins).toBe(40)
    expect(analysis.decision.statement).toBe(registration.plan.decisionRule.underpoweredStatement)
  })
})

describe('reporting obligations', () => {
  const { dataset, assignment, registration } = fixture(44, 1.25, 'synth-report')
  const analysis = analyzeDesk(dataset, registration, assignment.assignmentHash)

  it('reports BOTH the median and the mean of the paired differences', () => {
    expect(analysis.primary.medianDifference).toBeGreaterThan(0)
    expect(analysis.primary.meanDifference).toBeGreaterThan(0)
    expect(analysis.primary.medianDifference).not.toBe(analysis.primary.meanDifference)
    expect(analysis.reportText).toContain('median difference')
    expect(analysis.reportText).toContain('mean difference')
  })

  it('reports the Hodges-Lehmann estimate with a bootstrapped interval', () => {
    expect(analysis.primary.ci.method).toBe('bootstrap_percentile')
    expect(analysis.primary.ci.level).toBe(0.95)
    expect(analysis.primary.ci.lo).toBeLessThan(analysis.primary.hodgesLehmann)
    expect(analysis.primary.ci.hi).toBeGreaterThan(analysis.primary.hodgesLehmann)
  })

  it('runs the Wilcoxon signed-rank test on the coin-level differences', () => {
    expect(analysis.primary.wilcoxon.n).toBe(44)
    expect(analysis.primary.wilcoxon.pValue).toBeLessThan(0.001)
  })

  it('carries the secondaries but marks them as unable to support the decision', () => {
    expect(analysis.secondaries.map((s) => s.endpointId).sort()).toEqual([
      'telegram_net_join_rate',
      'unanswered_backlog',
      'unique_new_buyers',
    ])
    for (const secondary of analysis.secondaries) {
      expect(secondary.alphaControlled).toBe(false)
    }
    expect(analysis.primary.alphaControlled).toBe(true)
    expect(analysis.reportText).toContain('no multiplicity control')
  })

  it('shows the backlog moving the way an unstaffed desk would move it', () => {
    const backlog = analysis.secondaries.find((s) => s.endpointId === 'unanswered_backlog')!
    expect(backlog.hodgesLehmann).toBeLessThan(0)
  })

  it('is reproducible', () => {
    const again = analyzeDesk(dataset, registration, assignment.assignmentHash)
    expect(again.primary.ci).toEqual(analysis.primary.ci)
    expect(again.decision).toEqual(analysis.decision)
  })
})

describe('analysis refusals', () => {
  const { dataset, assignment, registration } = fixture(44, 1.3, 'synth-refuse')

  it('refuses an unregistered covariate', () => {
    expect(() =>
      analyzeDesk(dataset, registration, assignment.assignmentHash, {
        covariates: ['hour_of_day', 'market_cap'],
      }),
    ).toThrow(UnregisteredCovariateError)
  })

  it('accepts the registered stratification variables named explicitly', () => {
    expect(() =>
      analyzeDesk(dataset, registration, assignment.assignmentHash, {
        covariates: ['hour_of_day', 'day_of_week'],
      }),
    ).not.toThrow()
  })

  it('refuses a plan that moved after commitment', () => {
    const tampered = commitPlan(defaultAnalysisPlan(PILOT, 'bootstrap-seed-771c'), COMMITTED_AT)
    tampered.plan.decisionRule = { ...tampered.plan.decisionRule, minFeeEffectPct: 11 }
    expect(() => analyzeDesk(dataset, tampered, assignment.assignmentHash)).toThrow(
      PlanTamperedError,
    )
  })

  it('refuses a dataset whose assignment does not match the committed one', () => {
    expect(() => analyzeDesk(dataset, registration, 'a-different-assignment-hash')).toThrow(
      /arms may have moved/,
    )
  })

  it('refuses a dataset from another pilot', () => {
    const foreign = { ...dataset, pilotId: 'pilot-someone-else' }
    expect(() => analyzeDesk(foreign, registration, assignment.assignmentHash)).toThrow(
      AnalysisError,
    )
  })

  it('refuses to silently drop a registered secondary it cannot compute', () => {
    const plan = defaultAnalysisPlan(PILOT, 'bootstrap-seed-771c')
    plan.estimator.ci.iterations = 2_000
    plan.endpoints.push({
      id: 'x_impressions',
      role: 'secondary',
      description: 'not implemented anywhere',
      transform: 'identity',
      window: 'following_block_span',
    })
    const registered = commitPlan(plan, COMMITTED_AT)
    expect(() => analyzeDesk(dataset, registered, assignment.assignmentHash)).toThrow(
      /no extractor/,
    )
  })
})

describe('the exclusions are applied by the analysis, not trusted to the caller', () => {
  it('applies them itself and publishes what it removed', () => {
    const { dataset, assignment, registration } = fixture(44, 1.25, 'exc-applied', {
      coinOverrides: { launchedAtUnix: START },
    })
    const analysis = analyzeDesk(dataset, registration, assignment.assignmentHash)

    // Two blocks per coin: the launch window and its day-pair sibling.
    expect(analysis.exclusions.excluded).toHaveLength(88)
    expect(
      analysis.exclusions.countsByRule.find((c) => c.ruleId === 'launch_window_anti_snipe')!.blocks,
    ).toBe(88)
    expect(analysis.exclusions.keptBlocks).toBe(dataset.outcomes.length - 88)
    expect(analysis.reportText).toContain('REGISTERED EXCLUSIONS')
    expect(analysis.reportText).toContain('launch_window_anti_snipe')
  })

  it('ACCEPTS a dataset carrying the report the committed plan produces', () => {
    const { dataset, assignment, registration, plan } = fixture(44, 1.25, 'exc-match')
    const { report } = applyRegisteredExclusions(dataset.outcomes, plan)
    expect(() =>
      analyzeDesk({ ...dataset, exclusionReport: report }, registration, assignment.assignmentHash),
    ).not.toThrow()
  })

  it('REFUSES a dataset filtered under a different exclusion set', () => {
    const { dataset, assignment, registration, plan } = fixture(44, 1.25, 'exc-mismatch')
    const { report } = applyRegisteredExclusions(dataset.outcomes, plan)
    const tampered = {
      ...report,
      excluded: [{ coinRef: 'coin-001', blockIndex: 4, ruleId: 'unvalued_window' as const }],
      reportHash: `${report.reportHash.slice(0, -1)}0`,
    }
    expect(() =>
      analyzeDesk({ ...dataset, exclusionReport: tampered }, registration, assignment.assignmentHash),
    ).toThrow(/do not match the exclusions the committed plan produces/)
  })

  it('REFUSES a dataset filtered under a different exclusion POLICY', () => {
    const { dataset, assignment, registration, plan } = fixture(44, 1.25, 'exc-policy')
    const looser = {
      ...plan,
      exclusionParameters: { ...plan.exclusionParameters, launchExclusionHours: 72 },
    }
    const { report } = applyRegisteredExclusions(dataset.outcomes, looser)
    expect(() =>
      analyzeDesk({ ...dataset, exclusionReport: report }, registration, assignment.assignmentHash),
    ).toThrow(/different exclusion policy/)
  })

  it('removes the unmeasured windows rather than averaging in a false zero', () => {
    const { dataset, assignment, registration } = fixture(44, 1.25, 'exc-unvalued', {
      contamination: { unvaluedBlockIndexes: [11] },
    })
    const analysis = analyzeDesk(dataset, registration, assignment.assignmentHash)
    expect(
      analysis.exclusions.countsByRule.find((c) => c.ruleId === 'unvalued_window')!.blocks,
    ).toBe(44)
    expect(Number.isFinite(analysis.primary.hodgesLehmann)).toBe(true)
  })

  it('fails LOUDLY if an unmeasured window is ever dressed up as measured', () => {
    const { dataset, assignment, registration } = fixture(44, 1.25, 'exc-loud', {
      contamination: { unvaluedBlockIndexes: [11] },
    })
    // The NaN endpoint survives because the integrity flag was flipped, which is
    // the only way an unmeasured window can reach the estimator. It throws.
    const lying = {
      ...dataset,
      outcomes: dataset.outcomes.map((o) =>
        o.integrity.valuationComplete
          ? o
          : { ...o, integrity: { ...o.integrity, valuationComplete: true } },
      ),
    }
    expect(() => analyzeDesk(lying, registration, assignment.assignmentHash)).toThrow(
      /non-finite endpoint value/,
    )
  })
})

describe('delivery failure voids the trial rather than being quietly dropped', () => {
  it('returns COMPROMISED_DELIVERY past the committed ceiling, on data that would otherwise PROCEED', () => {
    const clean = fixture(48, 1.3, 'delivery')
    const cleanAnalysis = analyzeDesk(clean.dataset, clean.registration, clean.assignment.assignmentHash)
    expect(cleanAnalysis.decision.verdict).toBe('PROCEED_TO_PHASE_1')

    const broken = fixture(48, 1.3, 'delivery', {
      contamination: { undeliveredBlockIndexes: Array.from({ length: 20 }, (_, i) => i) },
    })
    const analysis = analyzeDesk(broken.dataset, broken.registration, broken.assignment.assignmentHash)

    expect(analysis.exclusions.deliveryCeilingBreached).toBe(true)
    expect(analysis.decision.verdict).toBe('COMPROMISED_DELIVERY')
    expect(analysis.decision.proceed).toBe(false)
    expect(analysis.decision.statement).toBe(
      broken.registration.plan.decisionRule.deliveryCompromisedStatement,
    )
    // The blocks are still in the primary: it is intention-to-treat.
    expect(analysis.exclusions.excluded).toHaveLength(0)
  })

  it('leaves the verdict alone below the ceiling', () => {
    const { dataset, assignment, registration } = fixture(48, 1.3, 'delivery', {
      contamination: { undeliveredBlockIndexes: [2, 3] },
    })
    const analysis = analyzeDesk(dataset, registration, assignment.assignmentHash)
    expect(analysis.exclusions.deliveryCeilingBreached).toBe(false)
    expect(analysis.decision.verdict).toBe('PROCEED_TO_PHASE_1')
  })
})

describe('the sensitivity analyses', () => {
  const { dataset, assignment, registration } = fixture(44, 1.25, 'sensitivity', {
    contamination: { whaleBlockIndexes: [9, 21], undeliveredBlockIndexes: [4] },
  })
  const analysis = analyzeDesk(dataset, registration, assignment.assignmentHash)

  it('runs every registered one and marks it non-decisive', () => {
    expect(analysis.sensitivity.map((s) => s.id).sort()).toEqual([
      'per_protocol_delivery',
      'whale_dominated_window',
    ])
    for (const result of analysis.sensitivity) {
      expect(result.gatesDecision).toBe(false)
      expect(result.result).toBeDefined()
      expect(result.blocksRemoved).toBeGreaterThan(0)
    }
  })

  it('reports them next to the primary, saying they cannot move the verdict', () => {
    expect(analysis.reportText).toContain('SENSITIVITY (registered, reported, and unable to change the verdict)')
    expect(analysis.reportText).toContain('whale_dominated_window')
  })

  it('does not let them touch the decision', () => {
    const withoutWhales = analysis.sensitivity.find((s) => s.id === 'whale_dominated_window')!
    // Different estimate, same verdict: the primary is the only input to decide().
    expect(withoutWhales.result!.hodgesLehmann).not.toBe(analysis.primary.hodgesLehmann)
    expect(analysis.decision.pointEstimatePct).toBe(analysis.primary.effectPct!.point)
  })
})

describe('the report carries the registered power finding', () => {
  const { dataset, assignment, registration } = fixture(48, 1.0, 'power-report')
  const analysis = analyzeDesk(dataset, registration, assignment.assignmentHash)

  it('prints the MDE and the adequacy statement next to a null result', () => {
    expect(analysis.decision.verdict).toBe('DO_NOT_PROCEED')
    expect(analysis.reportText).toContain('POWER, as registered before collection')
    expect(analysis.reportText).toContain('MDE at 40 coins')
    expect(analysis.reportText).toContain('CANNOT DETECT +10% AT ANY SAMPLE SIZE')
  })

  it('carries the document hash so the published plan is identifiable', () => {
    expect(analysis.documentHash).toBe(registration.documentHash)
    expect(analysis.reportText).toContain(registration.documentHash)
  })
})
