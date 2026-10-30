import { describe, expect, it } from 'vitest'

import {
  approximatePower,
  coinDifferenceSd,
  estimateStandardError,
  HL_EFFICIENCY_NORMAL,
  logShiftToPct,
  minimumDetectableEffectPct,
  pctToLogShift,
  PowerError,
  powerDesignFromPlan,
  powerTable,
  requiredCoins,
  type PowerDesign,
} from '../power.js'
import { defaultAnalysisPlan } from '../prereg.js'

/** The registered design: 40-60 coins, 30 matched 12-hour pairs each. */
const DESIGN: PowerDesign = {
  coins: 40,
  pairsPerCoin: 30,
  withinCoinSd: 1.5,
  betweenCoinEffectSd: 0.1,
  alpha: 0.05,
  thresholdPct: 10,
  ciLevel: 0.95,
  estimatorEfficiency: HL_EFFICIENCY_NORMAL,
}

describe('the variance the paired design actually faces', () => {
  it('divides the within-coin variance by the PAIR count, not the block count', () => {
    const noHeterogeneity = { ...DESIGN, betweenCoinEffectSd: 0 }
    expect(coinDifferenceSd(noHeterogeneity)).toBeCloseTo(Math.sqrt(2 / 30) * 1.5, 12)
  })

  it('adds per-coin effect heterogeneity that no number of blocks removes', () => {
    const manyBlocks = { ...DESIGN, pairsPerCoin: 100_000_000 }
    // The within-coin term goes to zero; the floor is the heterogeneity alone.
    expect(coinDifferenceSd(manyBlocks)).toBeCloseTo(DESIGN.betweenCoinEffectSd, 6)
  })

  it('shrinks the standard error with the square root of the coin count', () => {
    const four = estimateStandardError({ ...DESIGN, coins: 40 })
    const sixteen = estimateStandardError({ ...DESIGN, coins: 160 })
    expect(four / sixteen).toBeCloseTo(2, 6)
  })
})

describe('the ceiling the committed rule imposes', () => {
  it('CANNOT reach 80% power against a true effect of exactly the threshold, at ANY n', () => {
    for (const coins of [40, 60, 500, 5_000]) {
      const power = approximatePower({ ...DESIGN, coins }, DESIGN.thresholdPct)
      expect(power.rulePower).toBeLessThanOrEqual(0.5)
    }
  })

  it('approaches exactly one half from below as the sample grows', () => {
    const small = approximatePower({ ...DESIGN, coins: 40 }, 10).rulePower
    const huge = approximatePower({ ...DESIGN, coins: 100_000 }, 10).rulePower
    expect(small).toBeLessThan(huge)
    expect(huge).toBeCloseTo(0.5, 6)
  })

  it('reports the target as structurally unreachable rather than returning a big number', () => {
    const needed = requiredCoins(DESIGN, 10, 0.8)
    expect(needed.reachable).toBe(false)
    expect(needed.coins).toBeNull()
    expect(needed.reason).toContain('POINT ESTIMATE')
    expect(needed.powerAtCap).toBeLessThanOrEqual(0.5)
  })

  it('is a property of the RULE, not of the test: the interval alone is reachable', () => {
    const viaInterval = requiredCoins(DESIGN, 10, 0.8, 'ci_only')
    expect(viaInterval.reachable).toBe(true)
    expect(viaInterval.coins).toBeGreaterThan(0)
  })

  it('gets WORSE with more coins below the threshold, which is correct behaviour', () => {
    // A bigger study should be less likely to act on an effect too small to be
    // worth acting on. The search must not mistake that for a solvable problem.
    const below = (coins: number): number => approximatePower({ ...DESIGN, coins }, 5).rulePower
    expect(below(2_000)).toBeLessThan(below(60))
    const needed = requiredCoins(DESIGN, 5, 0.8)
    expect(needed.reachable).toBe(false)
    expect(needed.reason).toContain('does not help and eventually hurts')
  })

  it('does not treat the two halves of the rule as independent', () => {
    const p = approximatePower({ ...DESIGN, coins: 60 }, 20)
    // Multiplying them would understate: both read the same statistic.
    expect(p.rulePower).toBeGreaterThan(p.ciPower * p.thresholdPower)
    expect(p.rulePower).toBeCloseTo(Math.min(p.ciPower, p.thresholdPower), 3)
  })
})

describe('the answer on whether 40-60 coins is enough', () => {
  const at = (withinCoinSd: number, effectPct: number): number | null =>
    requiredCoins({ ...DESIGN, withinCoinSd }, effectPct, 0.8).coins

  it('is generous at a quiet endpoint', () => {
    expect(at(1, 20)).toBe(19)
    expect(at(0.5, 20)).toBe(7)
  })

  it('is exactly adequate for +20% at the planning SD of 1.5', () => {
    expect(at(1.5, 20)).toBe(40)
  })

  it('is INSUFFICIENT for +20% once the endpoint gets noisy', () => {
    expect(at(2, 20)).toBe(69)
    expect(at(2.5, 20)).toBe(106)
  })

  it('is insufficient for +15% at anything but a quiet endpoint', () => {
    expect(at(1, 15)).toBe(33)
    expect(at(1.5, 15)).toBe(68)
    expect(at(2.5, 15)).toBe(180)
  })

  it('puts the MDE at the registered figures', () => {
    expect(minimumDetectableEffectPct({ ...DESIGN, coins: 40 }, 0.8).effectPct).toBeCloseTo(19.88, 1)
    expect(minimumDetectableEffectPct({ ...DESIGN, coins: 60 }, 0.8).effectPct).toBeCloseTo(15.96, 1)
  })

  it('never lets the MDE fall below the committed threshold, whatever n is', () => {
    // A study cannot "detect" less than its own decision rule will act on.
    for (const coins of [40, 200, 5_000]) {
      const mde = minimumDetectableEffectPct({ ...DESIGN, coins }, 0.8)
      expect(mde.effectPct).toBeGreaterThan(DESIGN.thresholdPct)
    }
  })
})

describe('monotonicity, which a power function that is wrong usually breaks', () => {
  it('needs a larger effect the noisier the endpoint', () => {
    let previous = 0
    for (const withinCoinSd of [0.5, 1, 1.5, 2, 2.5]) {
      const mde = minimumDetectableEffectPct({ ...DESIGN, withinCoinSd }, 0.8).effectPct
      expect(mde).toBeGreaterThan(previous)
      previous = mde
    }
  })

  it('needs a smaller effect the more coins are enrolled', () => {
    let previous = Number.POSITIVE_INFINITY
    for (const coins of [20, 40, 60, 120]) {
      const mde = minimumDetectableEffectPct({ ...DESIGN, coins }, 0.8).effectPct
      expect(mde).toBeLessThan(previous)
      previous = mde
    }
  })

  it('gains power as the true effect grows', () => {
    let previous = 0
    for (const effect of [10, 15, 20, 30, 50]) {
      const power = approximatePower({ ...DESIGN, coins: 60 }, effect).rulePower
      expect(power).toBeGreaterThan(previous)
      previous = power
    }
  })
})

describe('the effect scale', () => {
  it('round-trips a percentage through the log shift', () => {
    for (const value of [-50, -10, 0, 10, 20, 250]) {
      expect(logShiftToPct(pctToLogShift(value))).toBeCloseTo(value, 9)
    }
  })

  it('refuses an effect that is not on the multiplicative scale', () => {
    expect(() => pctToLogShift(-100)).toThrow(PowerError)
  })
})

describe('refusals', () => {
  it('refuses a design that cannot be paired at all', () => {
    expect(() => approximatePower({ ...DESIGN, coins: 1 }, 20)).toThrow(PowerError)
  })

  it('refuses a non-positive within-coin SD, which would make power infinite', () => {
    expect(() => approximatePower({ ...DESIGN, withinCoinSd: 0 }, 20)).toThrow(PowerError)
  })

  it('refuses an estimator efficiency above one', () => {
    expect(() => approximatePower({ ...DESIGN, estimatorEfficiency: 1.4 }, 20)).toThrow(PowerError)
  })
})

describe('the plan and the derivation cannot drift apart', () => {
  const plan = defaultAnalysisPlan('pilot-power', 'seed-power')

  it('rebuilds the registered design from the committed plan', () => {
    const design = powerDesignFromPlan(plan)
    expect(design.coins).toBe(plan.decisionRule.minCoins)
    expect(design.pairsPerCoin).toBe(plan.power.pairsPerCoin)
    expect(design.thresholdPct).toBe(plan.decisionRule.minFeeEffectPct)
    expect(design.ciLevel).toBe(plan.decisionRule.ciLevel)
  })

  it('reproduces the MDE figures the plan committed', () => {
    expect(minimumDetectableEffectPct(powerDesignFromPlan(plan), 0.8).effectPct).toBeCloseTo(
      plan.power.mdePctAtMinCoins,
      2,
    )
    expect(
      minimumDetectableEffectPct(powerDesignFromPlan(plan, plan.power.enrolledCoinsMax), 0.8)
        .effectPct,
    ).toBeCloseTo(plan.power.mdePctAtMaxCoins, 2)
  })

  it('reproduces every row of the committed power curve', () => {
    const rows = powerTable(
      powerDesignFromPlan(plan),
      [plan.power.enrolledCoinsMin, plan.power.enrolledCoinsMax],
      plan.power.withinCoinSdGrid,
      [10, 20, 30],
    )
    expect(rows).toHaveLength(plan.power.powerCurve.length)
    for (const committed of plan.power.powerCurve) {
      const row = rows.find(
        (r) =>
          r.coins === committed.coins &&
          r.withinCoinSd === committed.withinCoinSd &&
          r.trueEffectPct === committed.trueEffectPct,
      )
      expect(row).toBeDefined()
      expect(row!.rulePower).toBeCloseTo(committed.rulePower, 4)
    }
  })

  it('commits a curve whose +10% rows never claim more than half', () => {
    for (const point of plan.power.powerCurve) {
      if (point.trueEffectPct === 10) expect(point.rulePower).toBeLessThanOrEqual(0.5)
    }
  })
})
