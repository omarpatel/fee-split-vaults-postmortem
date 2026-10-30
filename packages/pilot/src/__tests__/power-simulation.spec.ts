import { describe, expect, it } from 'vitest'

import { approximatePower, HL_EFFICIENCY_NORMAL, PowerError, type PowerDesign } from '../power.js'
import { simulateDeskPower } from '../power-simulation.js'
import { defaultAnalysisPlan } from '../prereg.js'

const PLAN = defaultAnalysisPlan('pilot-2026-q4', 'vault-pilot-bootstrap/v1')

function design(coins: number, withinCoinSd: number): PowerDesign {
  return {
    coins,
    pairsPerCoin: PLAN.power.pairsPerCoin,
    withinCoinSd,
    betweenCoinEffectSd: PLAN.power.plannedBetweenCoinEffectSd,
    alpha: PLAN.power.alpha,
    thresholdPct: PLAN.decisionRule.minFeeEffectPct,
    ciLevel: PLAN.decisionRule.ciLevel,
    estimatorEfficiency: HL_EFFICIENCY_NORMAL,
  }
}

const REGISTERED = {
  seed: PLAN.power.simulation.seed,
  trials: PLAN.power.simulation.trials,
  bootstrapIterations: PLAN.power.simulation.bootstrapIterations,
}

/**
 * The simulation is the registered validation of the committed power table, so
 * these run at the registered settings and take a few seconds each. That cost is
 * the point: a spot-check run at cheaper settings would validate a different
 * study from the one that was committed.
 */
describe('the committed spot-checks are reproducible from the published seed', () => {
  for (const check of PLAN.power.spotChecks) {
    it(`reproduces n=${check.coins} sd=${check.withinCoinSd} effect=+${check.trueEffectPct}%`, () => {
      const simulated = simulateDeskPower(
        design(check.coins, check.withinCoinSd),
        check.trueEffectPct,
        PLAN,
        REGISTERED,
      )
      expect(simulated.rulePower).toBe(check.simulatedRulePower)
      expect(simulated.wilcoxonPower).toBe(check.simulatedWilcoxonPower)
    }, 120_000)
  }
})

describe('what the simulation says about the design', () => {
  const headline = simulateDeskPower(design(60, 1.5), 10, PLAN, REGISTERED)

  it('confirms the rule cannot clear one half against a true +10%', () => {
    expect(headline.rulePower).toBeLessThan(0.55)
    expect(headline.thresholdPower).toBeLessThan(0.6)
  }, 120_000)

  it('recovers the true effect it was given, so the estimator is unbiased here', () => {
    expect(headline.medianEstimatePct).toBeGreaterThan(8)
    expect(headline.medianEstimatePct).toBeLessThan(12)
  }, 120_000)

  it('agrees with the normal approximation the committed table is built from', () => {
    for (const check of PLAN.power.spotChecks) {
      const approximate = approximatePower(
        design(check.coins, check.withinCoinSd),
        check.trueEffectPct,
      )
      // Six points is roughly two Monte Carlo standard errors at 400 trials.
      // A wider gap than this would mean the table and the estimator disagree
      // about the study, and the table is what gets published.
      expect(Math.abs(check.simulatedRulePower - approximate.rulePower)).toBeLessThan(0.06)
    }
  })

  it('never returns PROCEED under a true null more often than alpha allows', () => {
    const nullRun = simulateDeskPower(design(60, 1.5), 0, PLAN, {
      seed: 'vault-pilot-power/v1|null',
      trials: 200,
      bootstrapIterations: 1_000,
    })
    // Two-sided interval plus a positive threshold: the false-proceed rate is
    // bounded well below alpha, not at it.
    expect(nullRun.rulePower).toBeLessThan(0.05)
    expect(nullRun.verdicts.PROCEED_TO_PHASE_1).toBe(
      Math.round(nullRun.rulePower * nullRun.trials),
    )
  }, 120_000)

  it('depends on the design and the seed, never on which pilot committed the plan', () => {
    const other = defaultAnalysisPlan('some-other-pilot', 'a-completely-different-seed')
    const options = { seed: 'cross-pilot', trials: 30, bootstrapIterations: 1_000 }
    const a = simulateDeskPower(design(30, 1.5), 20, PLAN, options)
    const b = simulateDeskPower(design(30, 1.5), 20, other, options)
    expect(b.rulePower).toBe(a.rulePower)
    expect(b.medianEstimatePct).toBe(a.medianEstimatePct)
  }, 60_000)
})

describe('reproducibility and refusals', () => {
  const options = { seed: 'repeatable', trials: 20, bootstrapIterations: 1_000 }

  it('is a pure function of the seed', () => {
    const first = simulateDeskPower(design(30, 1), 20, PLAN, options)
    const second = simulateDeskPower(design(30, 1), 20, PLAN, options)
    expect(second.rulePower).toBe(first.rulePower)
    expect(second.medianEstimatePct).toBe(first.medianEstimatePct)
  }, 60_000)

  it('changes when the seed changes, so it is not accidentally constant', () => {
    const other = simulateDeskPower(design(30, 1), 20, PLAN, { ...options, seed: 'different' })
    const base = simulateDeskPower(design(30, 1), 20, PLAN, options)
    expect(other.medianEstimatePct).not.toBe(base.medianEstimatePct)
  }, 60_000)

  it('refuses an unseeded run, which would be unreproducible', () => {
    expect(() => simulateDeskPower(design(30, 1), 20, PLAN, { ...options, seed: '' })).toThrow(
      PowerError,
    )
  })

  it('refuses a run with no trials', () => {
    expect(() => simulateDeskPower(design(30, 1), 20, PLAN, { ...options, trials: 0 })).toThrow(
      PowerError,
    )
  })
})
