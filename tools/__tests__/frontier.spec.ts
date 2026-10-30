/**
 * frontier.ts - the viability solver.
 *
 * Everything here runs against a RECORDED fixture: the 125 T1 coins of the
 * 2026-09-08 live capture read, each with its class and its trailing-7-day
 * median QF. That makes these tests a regression harness on the measurement as
 * well as on the arithmetic - if the tool ever stops reproducing the 0.68
 * feasibility ratio and the 109 flip point that VERDICT.md was issued on, one
 * of the two has moved and someone has to say which.
 *
 * The tests that matter most are the ones about REFUSING: a gate below the
 * measured support must produce an UNKNOWN population rather than a small one,
 * and a row with no QF must be dropped rather than zero-filled. Both of those
 * failure modes look like a shrinking market rather than like a bug.
 */

import { describe, expect, it } from 'vitest'
import {
  MEASURED_MARKET_TAKE_BPS_MAX,
  QfDistributionError,
  cogsForGate,
  evaluateCell,
  parseQfDistribution,
  populationAtGate,
  solveFrontier,
  tierForGate,
  type CellInputs,
  type FrontierParams,
  type QfDistribution,
} from '../frontier.ts'
import { QUALIFICATION_FLOOR_MONTHLY_USD, TERMS, TIERS } from '../../config/protocol.ts'
import { loadFixture } from './helpers.ts'

const PARSE_DEFAULTS = {
  qfField: 'median7',
  winnableClasses: ['EOA', 'EOA_7702'],
  extraWinnableCoins: [] as string[],
}

function recorded(supportFloorUsd = 1000): QfDistribution {
  return parseQfDistribution(loadFixture('qf-distribution-t1.json'), {
    ...PARSE_DEFAULTS,
    supportFloorUsd,
  })
}

// ---------------------------------------------------------------------------
// Reading the measured distribution
// ---------------------------------------------------------------------------

describe('parseQfDistribution', () => {
  it('reads the recorded T1 capture read and reproduces its measured shape', () => {
    const distribution = recorded()
    expect(distribution.coins).toHaveLength(125)
    expect(distribution.coins.filter((c) => c.winnable)).toHaveLength(70)
    expect(distribution.observedFloorUsd).toBeCloseTo(1040.6547, 4)
    expect(distribution.observedCeilingUsd).toBeCloseTo(82_654.4811, 4)
    expect(distribution.droppedRows).toBe(0)
  })

  it('reads the incumbent-capture.json envelope as well as a bare array', () => {
    const rows = [
      { coin: '0xaa', cls: 'EOA', median7: 2000 },
      { coin: '0xbb', cls: 'INCUMBENT_DISTRIBUTOR', median7: 3000 },
    ]
    expect(parseQfDistribution(rows, PARSE_DEFAULTS).coins).toHaveLength(2)
    expect(parseQfDistribution({ rows }, PARSE_DEFAULTS).coins).toHaveLength(2)
  })

  it('DROPS a row with no usable QF rather than zero-filling it', () => {
    // A zero would sit below every gate and quietly shrink the population,
    // which reads as a smaller market instead of as a missing input.
    const distribution = parseQfDistribution(
      [
        { coin: '0xaa', cls: 'EOA', median7: 2000 },
        { coin: '0xbb', cls: 'EOA' },
        { coin: '0xcc', cls: 'EOA', median7: null },
        { cls: 'EOA', median7: 5000 },
      ],
      PARSE_DEFAULTS,
    )
    expect(distribution.coins).toHaveLength(1)
    expect(distribution.droppedRows).toBe(3)
    expect(populationAtGate(distribution, 0).total).toBe(1)
  })

  it('lets an explicit winnable flag beat the class, and honours extra winnable coins', () => {
    const rows = [
      { coin: '0xaa', cls: 'INCUMBENT_DISTRIBUTOR', median7: 2000, winnable: true },
      { coin: '0xbb', cls: 'EOA', median7: 2000, winnable: false },
      { coin: '0xCC', cls: 'CLONE_1167', median7: 2000 },
    ]
    const distribution = parseQfDistribution(rows, {
      ...PARSE_DEFAULTS,
      extraWinnableCoins: ['0xcc'],
    })
    expect(distribution.coins.map((c) => c.winnable)).toEqual([true, false, true])
  })

  it('refuses a file with no rows, and one whose QF field is misnamed', () => {
    expect(() => parseQfDistribution([], PARSE_DEFAULTS)).toThrow(QfDistributionError)
    expect(() =>
      parseQfDistribution([{ coin: '0xaa', qf: 100 }], PARSE_DEFAULTS),
    ).toThrow(/qf-field/)
  })
})

// ---------------------------------------------------------------------------
// Population as a FUNCTION of the gate - the coupling reprice.ts cannot model
// ---------------------------------------------------------------------------

describe('populationAtGate', () => {
  it('reproduces the measured standing counts at each gate', () => {
    const distribution = recorded()
    const at = (gate: number): { total: number; winnable: number } => {
      const p = populationAtGate(distribution, gate)
      return { total: p.total, winnable: p.winnable }
    }
    expect(at(1000)).toEqual({ total: 125, winnable: 70 })
    expect(at(1500)).toEqual({ total: 98, winnable: 54 })
    expect(at(2500)).toEqual({ total: 70, winnable: 39 })
    expect(at(5000)).toEqual({ total: 32, winnable: 18 })
    expect(at(20_000)).toEqual({ total: 6, winnable: 3 })
  })

  it('measures the winnable SHARE at each gate instead of carrying one ratio across', () => {
    const distribution = recorded()
    // VERDICT.md's headline share is 56.0% at the T1 gate. It is not constant,
    // and a tool that scaled 56.0% across every gate would report 61.5% coins
    // at $10k/day as 8 when the measured answer is also 8 only by luck.
    expect(populationAtGate(distribution, 1000).winnableShare).toBeCloseTo(0.56, 3)
    expect(populationAtGate(distribution, 10_000).winnableShare).toBeCloseTo(8 / 13, 3)
  })

  it('marks a gate below the measured support as UNKNOWN, not as a small population', () => {
    const distribution = recorded(1000)
    const below = populationAtGate(distribution, 500)
    expect(below.belowMeasuredSupport).toBe(true)
    const above = populationAtGate(distribution, 1000)
    expect(above.belowMeasuredSupport).toBe(false)
  })

  it('defaults the support floor to the smallest observed QF, which is all the file proves', () => {
    const distribution = parseQfDistribution(loadFixture('qf-distribution-t1.json'), PARSE_DEFAULTS)
    expect(distribution.supportFloorUsd).toBe(distribution.observedFloorUsd)
    expect(populationAtGate(distribution, 1000).belowMeasuredSupport).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// COGS follows the gate
// ---------------------------------------------------------------------------

describe('cogsForGate', () => {
  it('charges the COGS of the tier the gate actually lands in', () => {
    expect(cogsForGate(1000, 'tier', 'T1', 13).cogsPerDayUsd).toBe(TIERS.T1.cogsPerDay)
    expect(cogsForGate(2500, 'tier', 'T1', 13).cogsPerDayUsd).toBe(TIERS.T2.cogsPerDay)
    expect(cogsForGate(20_000, 'tier', 'T1', 13).cogsPerDayUsd).toBe(TIERS.T3.cogsPerDay)
  })

  it('flags a gate raised into a higher tier, because that is invented margin otherwise', () => {
    expect(cogsForGate(2500, 'tier', 'T1', 13).tierRaised).toBe(true)
    expect(cogsForGate(1200, 'tier', 'T1', 13).tierRaised).toBe(false)
  })

  it('holds COGS flat under fixed mode', () => {
    const resolved = cogsForGate(20_000, 'fixed', 'T1', 13)
    expect(resolved.cogsPerDayUsd).toBe(13)
    expect(resolved.tier).toBeUndefined()
  })

  it('agrees with tierForGate on which tier a gate belongs to', () => {
    expect(tierForGate(0)).toBe('T0')
    expect(tierForGate(1000)).toBe('T1')
    expect(tierForGate(2499)).toBe('T1')
    expect(tierForGate(2500)).toBe('T2')
  })
})

// ---------------------------------------------------------------------------
// One cell
// ---------------------------------------------------------------------------

function cell(overrides: Partial<CellInputs> = {}): CellInputs {
  return {
    operatorBps: TERMS.operatorBps,
    gateQfPerDay: TIERS.T1.gateQfPerDay,
    winRate: 0.1,
    fixedCostMonthlyUsd: 12_000,
    cogsPerDayUsd: TIERS.T1.cogsPerDay,
    budgetBps: TERMS.budgetBpsDefault,
    winnablePopulation: 73,
    stopThreshold: 40,
    maxMarketBps: MEASURED_MARKET_TAKE_BPS_MAX,
    minPopulation: 10,
    baselineWinRate: 0.1,
    belowMeasuredSupport: false,
    ...overrides,
  }
}

describe('evaluateCell', () => {
  it('reproduces the verdict on file: ratio 0.675, break-even 10.81, flip point 109', () => {
    const result = evaluateCell(cell())
    expect(result.contributionPerClientDayUsd).toBeCloseTo(37, 10)
    expect(result.breakEvenConcurrentClients).toBeCloseTo(10.8108, 4)
    expect(result.feasibilityRatio).toBeCloseTo(0.6753, 4)
    expect(result.flipPointPopulation).toBe(109)
    expect(result.clears).toBe(false)
  })

  it('takes no tenure argument at all, because tenure cancels out of the ratio', () => {
    // reprice.ts confirms this empirically at 3.01d, 8.59d, 11.59d and 32d. It
    // is asserted structurally here: there is no tenure field to pass, so no
    // future edit can smuggle one into the feasibility answer.
    expect(Object.keys(cell())).not.toContain('tenureDays')
    // required signings/week = breakEven * 7 / tenure. Publishing it per day of
    // tenure keeps the identity visible without importing the assumption.
    const result = evaluateCell(cell())
    expect(result.requiredWeeklyAcquisitionsPerTenureDay / 11.59).toBeCloseTo(6.53, 2)
  })

  it('never produces a ratio from an unmeasured population', () => {
    const result = evaluateCell(cell({ winnablePopulation: undefined, belowMeasuredSupport: true }))
    expect(result.feasibilityRatio).toBeUndefined()
    expect(result.minWinRateToClear).toBeUndefined()
    expect(result.maxFixedCostToClear).toBeUndefined()
    expect(result.clears).toBe(false)
    expect(result.inadmissibleReasons).toContain('gate_below_measured_support')
  })

  it('refuses a ratio when the client loses money, at any client count', () => {
    // The $250/day T1 gate that config/protocol.ts deleted: $12.50/day of
    // revenue against $13.00/day of COGS.
    // no-hardcoded-rates: allow tier-gate-literal - the deleted $250/day gate named in the comment above; the point is that config no longer carries it
    const result = evaluateCell(cell({ gateQfPerDay: 250 }))
    expect(result.contributionPerClientDayUsd).toBeCloseTo(-0.5, 10)
    expect(result.breakEvenConcurrentClients).toBe(Number.POSITIVE_INFINITY)
    expect(result.feasibilityRatio).toBeUndefined()
    expect(result.clears).toBe(false)
  })

  it('marks a take above the measured market norm inadmissible however well it solves', () => {
    const result = evaluateCell(cell({ operatorBps: 1000 }))
    expect(result.feasibilityRatio).toBeGreaterThan(1)
    expect(result.clears).toBe(true)
    expect(result.admissible).toBe(false)
    expect(result.inadmissibleReasons).toContain('operator_bps_above_measured_market_norm')
  })

  it('marks a gate that empties the population inadmissible', () => {
    const result = evaluateCell(cell({ gateQfPerDay: TIERS.T3.gateQfPerDay, winnablePopulation: 3 }))
    expect(result.inadmissibleReasons).toContain('population_empty')
  })

  it('marks a gate whose procurement budget cannot fund its cheapest deliverable', () => {
    // QUALIFICATION_FLOOR_MONTHLY_USD is $1,500; at a 2000bps dial that needs
    // $250/day of QF.
    // no-hardcoded-rates: allow tier-gate-literal - an arbitrary sub-floor gate, not a tier's gate: it exists to fall under QUALIFICATION_FLOOR_MONTHLY_USD
    const low = evaluateCell(cell({ gateQfPerDay: 200 }))
    expect(low.monthlyBudgetUsd).toBeLessThan(QUALIFICATION_FLOOR_MONTHLY_USD)
    expect(low.inadmissibleReasons).toContain('below_qualification_floor')
    expect(evaluateCell(cell()).inadmissibleReasons).not.toContain('below_qualification_floor')
  })

  it('flags a win rate above the baseline rather than pretending it is measured', () => {
    const result = evaluateCell(cell({ winRate: 0.35 }))
    expect(result.flags).toContain('win_rate_above_baseline')
    // Flagged, NOT inadmissible: nothing in this repository measures a win rate,
    // so inventing a ceiling for it would be a fabrication of its own.
    expect(result.admissible).toBe(true)
  })

  it('solves the inverse questions consistently with the forward one', () => {
    const base = evaluateCell(cell())
    const atMinWinRate = evaluateCell(cell({ winRate: base.minWinRateToClear! }))
    expect(atMinWinRate.feasibilityRatio).toBeCloseTo(1, 9)
    const atMaxFixed = evaluateCell(cell({ fixedCostMonthlyUsd: base.maxFixedCostToClear! }))
    expect(atMaxFixed.feasibilityRatio).toBeCloseTo(1, 9)
  })
})

// ---------------------------------------------------------------------------
// The solve
// ---------------------------------------------------------------------------

function params(overrides: Partial<FrontierParams> = {}): FrontierParams {
  return {
    operatorBpsValues: [250, 500, 1000],
    gateValues: [500, 1000, 2000, 5000],
    winRateValues: [0.1, 0.35],
    fixedCostValues: [12_000, 6_000],
    budgetBps: TERMS.budgetBpsDefault,
    cogsMode: 'tier',
    cogsPerDayUsd: TIERS.T1.cogsPerDay,
    baselineTier: 'T1',
    stopThreshold: 40,
    maxMarketBps: MEASURED_MARKET_TAKE_BPS_MAX,
    minPopulation: 10,
    baselineWinRate: 0.1,
    distribution: recorded(),
    fixedPopulation: undefined,
    baselineGate: 1000,
    baselineOperatorBps: 500,
    ...overrides,
  }
}

describe('solveFrontier', () => {
  it('anchors on the configuration on file and reproduces its ratio', () => {
    const result = solveFrontier(params())
    const baseline = result.baselineCell
    expect(baseline).toBeDefined()
    expect(baseline!.operatorBps).toBe(500)
    expect(baseline!.gateQfPerDay).toBe(1000)
    expect(baseline!.winnablePopulation).toBe(70)
    // 0.6475 = 0.10 x 70 / 10.8108. VERDICT.md's headline 0.6753 uses 73: the
    // 70 signable coins plus the 3 contract-routed ones measured to carry
    // transferCreatorFeeRecipient, which this fixture does not record.
    expect(baseline!.feasibilityRatio).toBeCloseTo(0.6475, 4)
    expect(baseline!.flipPointPopulation).toBe(109)
    expect(baseline!.clears).toBe(false)
  })

  it('finds a region that clears, and reports that none of it is at the assumptions on file', () => {
    const result = solveFrontier(params())
    expect(result.summary.noAdmissibleConfigurationClears).toBe(false)
    expect(result.summary.admissibleClearingCells).toBeGreaterThan(0)
    // Every clearing configuration needs a lower fixed cost or a higher win
    // rate. That sentence is the finding, and it is a different one from
    // "a viable region exists".
    expect(result.summary.admissibleClearingCellsAtBaselineAssumptions).toBe(0)
    expect(result.summary.closestAdmissibleMiss?.feasibilityRatio).toBeLessThan(1)
  })

  it('says plainly when nothing admissible clears', () => {
    // Hold the take at the measured norm and put the fixed cost somewhere no
    // population in this distribution can carry.
    const result = solveFrontier(
      params({ operatorBpsValues: [500], fixedCostValues: [400_000], winRateValues: [0.1] }),
    )
    expect(result.summary.admissibleClearingCells).toBe(0)
    expect(result.summary.noAdmissibleConfigurationClears).toBe(true)
    expect(result.summary.region).toBeUndefined()
    expect(result.summary.best).toBeUndefined()
  })

  it('never lets an inadmissible cell into the region', () => {
    const result = solveFrontier(params())
    for (const cellResult of result.cells) {
      if (cellResult.operatorBps > MEASURED_MARKET_TAKE_BPS_MAX) {
        expect(cellResult.admissible).toBe(false)
      }
    }
    const region = result.summary.region!
    expect(region.operatorBps.max).toBeLessThanOrEqual(MEASURED_MARKET_TAKE_BPS_MAX)
  })

  it('charges T2 COGS to a gate in T2s band, which is what closes the region there', () => {
    const withTierCogs = solveFrontier(params({ gateValues: [5000], operatorBpsValues: [500] }))
    const withFlatCogs = solveFrontier(
      params({ gateValues: [5000], operatorBpsValues: [500], cogsMode: 'fixed' }),
    )
    const tiered = withTierCogs.cells.find((c) => c.winRate === 0.1 && c.fixedCostMonthlyUsd === 12_000)!
    const flat = withFlatCogs.cells.find((c) => c.winRate === 0.1 && c.fixedCostMonthlyUsd === 12_000)!
    expect(tiered.cogsPerDayUsd).toBe(TIERS.T2.cogsPerDay)
    expect(flat.cogsPerDayUsd).toBe(TIERS.T1.cogsPerDay)
    expect(tiered.feasibilityRatio!).toBeLessThan(flat.feasibilityRatio!)
    expect(tiered.flags).toContain('tier_cogs_raised')
  })

  it('refuses the whole gate axis when there is no distribution, instead of holding the population flat', () => {
    const result = solveFrontier(params({ distribution: undefined, fixedPopulation: 73 }))
    const atBaselineGate = result.cells.filter((c) => c.gateQfPerDay === 1000)
    const elsewhere = result.cells.filter((c) => c.gateQfPerDay !== 1000)
    expect(atBaselineGate.every((c) => c.winnablePopulation === 73)).toBe(true)
    expect(elsewhere.every((c) => c.winnablePopulation === undefined)).toBe(true)
    expect(elsewhere.every((c) => c.feasibilityRatio === undefined)).toBe(true)
    expect(elsewhere.every((c) => !c.clears)).toBe(true)
    expect(result.populations).toHaveLength(0)
  })

  it('evaluates every combination of the four axes exactly once', () => {
    const p = params()
    const result = solveFrontier(p)
    expect(result.summary.cellsEvaluated).toBe(
      p.operatorBpsValues.length * p.gateValues.length * p.winRateValues.length * p.fixedCostValues.length,
    )
    const keys = new Set(
      result.cells.map((c) => `${c.operatorBps}:${c.gateQfPerDay}:${c.winRate}:${c.fixedCostMonthlyUsd}`),
    )
    expect(keys.size).toBe(result.cells.length)
  })
})
