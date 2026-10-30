import { describe, expect, it } from 'vitest'

import { coinDifferences } from '../analysis.js'
import { generateAssignment, makePilotConfig } from '../assignment.js'
import {
  applyRegisteredExclusions,
  assertNoContaminatedBlockSurvived,
  exclusionPolicyHash,
  ExclusionError,
} from '../exclusions.js'
import { defaultAnalysisPlan, type AnalysisPlan } from '../prereg.js'
import { DEFAULT_SYNTHETIC, synthesizeDataset, syntheticCoins } from '../testing/synthetic.js'
import type { BlockOutcome, ExclusionRuleId, PilotCoin } from '../types.js'

const PILOT = 'pilot-2026-q4'
const START = Date.UTC(2026, 9, 1) / 1_000
const DAY = 86_400
const PLAN = defaultAnalysisPlan(PILOT, 'bootstrap-seed-771c')

interface Built {
  plan: AnalysisPlan
  outcomes: BlockOutcome[]
  coins: PilotCoin[]
}

function build(options: {
  coins?: number
  coinOverrides?: Partial<PilotCoin>
  contamination?: Parameters<typeof synthesizeDataset>[2]['contamination']
  staffedMultiplier?: number
  seed?: string
}): Built {
  const config = makePilotConfig(PILOT, 'published-seed-a3f9', START)
  const coins = syntheticCoins(options.coins ?? 6, START - DAY, options.coinOverrides ?? {})
  const assignment = generateAssignment(config, coins, START - 3_600)
  const dataset = synthesizeDataset(assignment, coins, {
    ...DEFAULT_SYNTHETIC,
    seed: options.seed ?? 'exclusion-fixture',
    staffedMultiplier: options.staffedMultiplier ?? 1,
    collectedAtUnix: START + 30 * DAY,
    ...(options.contamination ? { contamination: options.contamination } : {}),
  })
  return { plan: PLAN, outcomes: dataset.outcomes, coins }
}

function blocksExcludedUnder(
  outcomes: readonly BlockOutcome[],
  plan: AnalysisPlan,
  ruleId: ExclusionRuleId,
): number[] {
  const { report } = applyRegisteredExclusions(outcomes, plan)
  return [
    ...new Set(report.excluded.filter((e) => e.ruleId === ruleId).map((e) => e.blockIndex)),
  ].sort((a, b) => a - b)
}

function standardDeviation(values: readonly number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length)
}

describe('a clean cohort loses nothing', () => {
  const { outcomes, plan } = build({})

  it('keeps every randomized block when no mechanism fired', () => {
    const { kept, report } = applyRegisteredExclusions(outcomes, plan)
    expect(report.excluded).toHaveLength(0)
    expect(kept).toHaveLength(outcomes.length)
    expect(report.keptBlocks).toBe(report.observedBlocks)
    expect(report.deliveryCeilingBreached).toBe(false)
  })

  it('still names every registered rule in the counts, at zero', () => {
    const { report } = applyRegisteredExclusions(outcomes, plan)
    expect(report.countsByRule.map((c) => c.ruleId)).toEqual([
      'non_randomized_phase',
      'unvalued_window',
      'launch_window_anti_snipe',
      'graduation_mechanism_change',
      'recipient_change',
    ])
    for (const count of report.countsByRule) expect(count.blocks).toBe(0)
  })
})

describe('the anti-snipe windfall, which is why this file exists', () => {
  it('drops the launch day when the coin launched inside the pilot window', () => {
    const { outcomes, plan } = build({ coinOverrides: { launchedAtUnix: START } })
    // The first follow-window starts 12h after launch, inside the 24-hour rule.
    // The day-pair widening takes its sibling with it, so the exact hour-of-day
    // balance the assignment guarantees survives.
    expect(blocksExcludedUnder(outcomes, plan, 'launch_window_anti_snipe')).toEqual([0, 1])
  })

  it('drops a window carrying attributed anti-snipe money even outside the time rule', () => {
    // Launched a week before enrolment, so the 24-hour rule is silent - but a
    // batched sweep still credited the windfall inside a measured window.
    const { outcomes, plan } = build({ contamination: { antiSnipeWindfallUsd: 20_000 } })
    const first = outcomes.find((o) => o.blockIndex === 0)!
    expect(first.integrity.secondsSinceLaunch).toBeGreaterThan(24 * 3_600)
    expect(first.integrity.antiSnipeUsd).toBe(20_000)
    expect(blocksExcludedUnder(outcomes, plan, 'launch_window_anti_snipe')).toEqual([0, 1])
  })

  const spread = (outcomes: readonly BlockOutcome[]): number =>
    standardDeviation(
      coinDifferences(outcomes, (o) => o.primaryLog1pFeesUsd, 1).map((c) => c.difference),
    )

  it('is large enough to wreck the coin-level comparison if it is not excluded', () => {
    const cleanSpread = spread(build({ coins: 40, seed: 'windfall' }).outcomes)
    // One contaminated window per coin, out of sixty.
    for (const [windfallUsd, minimumRatio] of [
      [5_000, 1.3],
      [20_000, 1.5],
      [100_000, 1.8],
    ] as const) {
      const dirty = build({
        coins: 40,
        seed: 'windfall',
        contamination: { antiSnipeWindfallUsd: windfallUsd },
      })
      expect(spread(dirty.outcomes) / cleanSpread).toBeGreaterThan(minimumRatio)
    }
  })

  it('is removed completely by the registered exclusion, at any windfall size', () => {
    const excluded = [5_000, 20_000, 100_000, 5_000_000].map((antiSnipeWindfallUsd) =>
      spread(
        applyRegisteredExclusions(
          build({ coins: 40, seed: 'windfall', contamination: { antiSnipeWindfallUsd } }).outcomes,
          PLAN,
        ).kept,
      ),
    )
    // The surviving statistic does not move at all with the size of the money
    // that was removed. That is what "excluded by mechanism" has to mean.
    for (const value of excluded) expect(value).toBeCloseTo(excluded[0]!, 12)
    expect(excluded[0]!).toBeLessThan(spread(build({ coins: 40, seed: 'windfall' }).outcomes) * 1.05)
  })
})

describe('graduation changes the measurement underneath the coin', () => {
  const { outcomes, plan } = build({ coinOverrides: { graduatedAtUnix: START + 10 * DAY } })

  it('drops the sweep-cycle windows around the change, and only those', () => {
    // Windows starting in [graduation, graduation + 48h), widened to whole days.
    expect(blocksExcludedUnder(outcomes, plan, 'graduation_mechanism_change')).toEqual([
      18, 19, 20, 21, 22, 23,
    ])
  })

  it('keeps the coin, because graduating is not a reason to be unrepresentative', () => {
    const { kept } = applyRegisteredExclusions(outcomes, plan)
    const coinRefs = new Set(kept.map((o) => o.coinRef))
    expect(coinRefs.size).toBe(6)
  })

  it('drops a window in which both fee rails were observed at once', () => {
    const mixed = outcomes.map((o, i) =>
      i === 0 ? { ...o, integrity: { ...o.integrity, feeMechanism: 'MIXED' as const } } : o,
    )
    const { report } = applyRegisteredExclusions(mixed, plan)
    expect(report.excluded.some((e) => e.ruleId === 'graduation_mechanism_change')).toBe(true)
  })
})

describe('a recipient change censors the coin rather than adjusting it', () => {
  const { outcomes, plan } = build({ coinOverrides: { recipientChangedAtUnix: START + 20 * DAY } })

  it('drops every window from the change onward and keeps every window before', () => {
    const excluded = blocksExcludedUnder(outcomes, plan, 'recipient_change')
    expect(Math.min(...excluded)).toBe(39)
    expect(Math.max(...excluded)).toBe(59)
    expect(excluded).toHaveLength(21)
  })

  it('does not widen to the day-pair: the censoring point is exact', () => {
    const { report } = applyRegisteredExclusions(outcomes, plan)
    // 39 is odd, so a day-pair widening would have pulled 38 in with it.
    expect(report.excluded.some((e) => e.blockIndex === 38)).toBe(false)
  })
})

describe('an unmeasured window is excluded, never imputed as zero', () => {
  const { outcomes, plan } = build({ contamination: { unvaluedBlockIndexes: [5, 6] } })

  it('records the endpoint as NaN so a missed exclusion is loud', () => {
    const unvalued = outcomes.filter((o) => o.blockIndex === 5)
    expect(unvalued.every((o) => Number.isNaN(o.primaryLog1pFeesUsd))).toBe(true)
    expect(unvalued.every((o) => o.integrity.valuationComplete === false)).toBe(true)
  })

  it('drops exactly those windows, under their own rule', () => {
    expect(blocksExcludedUnder(outcomes, plan, 'unvalued_window')).toEqual([5, 6])
  })

  it('is checked BEFORE any rule that would have to read the endpoint value', () => {
    const { report } = applyRegisteredExclusions(outcomes, plan)
    expect(report.excluded.filter((e) => e.blockIndex === 5).every((e) => e.ruleId === 'unvalued_window')).toBe(
      true,
    )
  })
})

describe('what is deliberately NOT excluded', () => {
  it('flags a whale-dominated window and keeps it', () => {
    const { outcomes, plan } = build({ contamination: { whaleBlockIndexes: [7] } })
    const { kept, report } = applyRegisteredExclusions(outcomes, plan)
    expect(report.excluded).toHaveLength(0)
    expect(report.whaleFlaggedBlocks).toBe(6)
    expect(kept.some((o) => o.blockIndex === 7)).toBe(true)
  })

  it('keeps an undelivered block, counts it, and does not breach below the ceiling', () => {
    const { outcomes, plan } = build({ contamination: { undeliveredBlockIndexes: [3, 4] } })
    const { report } = applyRegisteredExclusions(outcomes, plan)
    expect(report.excluded).toHaveLength(0)
    expect(report.undeliveredStaffedBlocks + report.undeliveredUnstaffedBlocks).toBe(12)
    expect(report.undeliveredStaffedShare).toBeLessThan(0.1)
    expect(report.deliveryCeilingBreached).toBe(false)
  })

  it('breaches the ceiling when the desk missed more than a tenth of its staffed blocks', () => {
    const many = Array.from({ length: 20 }, (_, i) => i)
    const { outcomes, plan } = build({ contamination: { undeliveredBlockIndexes: many } })
    const { report } = applyRegisteredExclusions(outcomes, plan)
    expect(report.undeliveredStaffedShare).toBeGreaterThan(0.1)
    expect(report.deliveryCeilingBreached).toBe(true)
    // Still not excluded. The primary stays intention-to-treat.
    expect(report.excluded).toHaveLength(0)
  })
})

describe('the non-randomized phase', () => {
  it('is excluded under its own rule rather than silently filtered', () => {
    const { outcomes, plan } = build({})
    const fullCoverage = outcomes.map((o) => ({ ...o, phase: 'FULL_COVERAGE' as const }))
    const { kept, report } = applyRegisteredExclusions(fullCoverage, plan)
    expect(kept).toHaveLength(0)
    expect(report.countsByRule.find((c) => c.ruleId === 'non_randomized_phase')!.blocks).toBe(
      fullCoverage.length,
    )
  })
})

describe('the report is a commitment, not a log line', () => {
  const { outcomes, plan } = build({ coinOverrides: { launchedAtUnix: START } })

  it('is deterministic', () => {
    const a = applyRegisteredExclusions(outcomes, plan).report
    const b = applyRegisteredExclusions(outcomes, plan).report
    expect(b.reportHash).toBe(a.reportHash)
    expect(b.planExclusionHash).toBe(a.planExclusionHash)
  })

  it('changes its hash when the excluded set changes', () => {
    const clean = applyRegisteredExclusions(build({}).outcomes, plan).report
    expect(applyRegisteredExclusions(outcomes, plan).report.reportHash).not.toBe(clean.reportHash)
  })

  it('binds the policy hash to the parameters, so a retuned rule is visible', () => {
    const retuned: AnalysisPlan = {
      ...plan,
      exclusionParameters: { ...plan.exclusionParameters, launchExclusionHours: 48 },
    }
    expect(exclusionPolicyHash(retuned)).not.toBe(exclusionPolicyHash(plan))
  })

  it('binds the policy hash to the justification text, not only to the numbers', () => {
    const reworded: AnalysisPlan = {
      ...plan,
      exclusionRules: plan.exclusionRules.map((r) =>
        r.id === 'launch_window_anti_snipe' ? { ...r, justification: 'because we felt like it' } : r,
      ),
    }
    expect(exclusionPolicyHash(reworded)).not.toBe(exclusionPolicyHash(plan))
  })
})

describe('the post-condition', () => {
  it('refuses a kept set that still trips a registered rule', () => {
    const { outcomes, plan } = build({ coinOverrides: { launchedAtUnix: START } })
    expect(() => assertNoContaminatedBlockSurvived(outcomes, plan)).toThrow(ExclusionError)
    expect(() => assertNoContaminatedBlockSurvived(outcomes, plan)).toThrow(
      /launch_window_anti_snipe/,
    )
  })

  it('passes on the set the engine actually produced', () => {
    const { outcomes, plan } = build({ coinOverrides: { launchedAtUnix: START } })
    const { kept } = applyRegisteredExclusions(outcomes, plan)
    expect(() => assertNoContaminatedBlockSurvived(kept, plan)).not.toThrow()
  })

  it('refuses an outcome with no integrity record at all', () => {
    const { outcomes, plan } = build({})
    const stripped = outcomes.map((o, i) =>
      i === 0 ? ({ ...o, integrity: undefined } as unknown as BlockOutcome) : o,
    )
    expect(() => applyRegisteredExclusions(stripped, plan)).toThrow(/cannot be screened/)
  })
})
