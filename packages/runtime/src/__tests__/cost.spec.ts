import { describe, expect, it } from 'vitest'
import { TIERS } from '../protocol.js'
import { CostGovernor } from '../cost/governor.js'
import { MODEL_PRICES, priceUsd } from '../cost/pricing.js'
import { MODEL, TierHasNoModel, modelForRole, supportsEffort } from '../model/ids.js'
import { ZERO_USAGE } from '../model/client.js'
import type { ModelUsage } from '../model/client.js'
import { T0 } from './helpers.js'

function usage(input: number, output: number, cacheRead = 0): ModelUsage {
  return { ...ZERO_USAGE, inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead }
}

describe('pricing', () => {
  it('prices a call from the published rate card', () => {
    const cost = priceUsd(MODEL.haiku45, usage(1_000_000, 1_000_000))
    expect(cost).toBeCloseTo(
      MODEL_PRICES[MODEL.haiku45].inputPerMTokUsd + MODEL_PRICES[MODEL.haiku45].outputPerMTokUsd,
    )
  })

  it('charges cache reads at a fraction of the input rate', () => {
    const uncached = priceUsd(MODEL.sonnet5, usage(100_000, 0))
    const cached = priceUsd(MODEL.sonnet5, usage(0, 0, 100_000))
    expect(cached).toBeLessThan(uncached)
    expect(cached / uncached).toBeCloseTo(MODEL_PRICES[MODEL.sonnet5].cacheReadMultiplier)
  })

  it('halves the bill for batched work', () => {
    const sync = priceUsd(MODEL.sonnet5, usage(50_000, 5_000))
    const batched = priceUsd(MODEL.sonnet5, usage(50_000, 5_000), { batch: true })
    expect(batched).toBeCloseTo(sync / 2)
  })
})

describe('model selection by tier', () => {
  it('puts the reader and the desk on the cheap model at every tier', () => {
    for (const tier of ['T1', 'T2', 'T3'] as const) {
      expect(modelForRole('reader', tier)).toBe(MODEL.haiku45)
      expect(modelForRole('desk', tier)).toBe(MODEL.haiku45)
    }
  })

  it('escalates the planner at T2 and above', () => {
    expect(modelForRole('planner', 'T1')).toBe(MODEL.haiku45)
    expect(modelForRole('planner', 'T2')).toBe(MODEL.sonnet5)
    expect(modelForRole('planner', 'T3')).toBe(MODEL.sonnet5)
  })

  it('refuses to pick a model for a tier that is deterministic by design', () => {
    expect(() => modelForRole('planner', 'T0')).toThrow(TierHasNoModel)
  })

  it('knows which model rejects output_config.effort', () => {
    expect(supportsEffort(MODEL.haiku45)).toBe(false)
    expect(supportsEffort(MODEL.sonnet5)).toBe(true)
  })
})

describe('cost governor', () => {
  const tier = 'T2' as const
  const share = 0.6

  it('derives the daily budget from the tier COGS figure', () => {
    const governor = new CostGovernor({ tier, modelShareOfCogs: share })
    expect(governor.budgetUsd).toBeCloseTo(TIERS[tier].cogsPerDay * share)
  })

  it('walks the degradation ladder instead of overspending', () => {
    const governor = new CostGovernor({ tier, dailyBudgetUsd: 10 })
    expect(governor.level(T0)).toBe('full')
    expect(governor.plan('planner', T0).model).toBe(MODEL.sonnet5)
    expect(governor.plan('planner', T0).viaBatch).toBe(false)

    // 65% spent: non-urgent work moves to the Batch API at half price.
    governor.record(T0, MODEL.sonnet5, usage(3_250_000, 0))
    expect(governor.level(T0)).toBe('batch')
    expect(governor.plan('planner', T0).viaBatch).toBe(true)
    expect(governor.plan('planner', T0, { urgent: true }).viaBatch).toBe(false)

    // 90% spent: the planner drops to the cheap model.
    governor.record(T0, MODEL.sonnet5, usage(1_250_000, 0))
    expect(governor.level(T0)).toBe('downgrade')
    expect(governor.plan('planner', T0).model).toBe(MODEL.haiku45)

    // Over budget: nothing runs. Degrading to deterministic operation is a
    // correct outcome; running at a loss because a flood arrived is not.
    governor.record(T0, MODEL.sonnet5, usage(600_000, 0))
    expect(governor.level(T0)).toBe('suspend')
    const suspended = governor.plan('planner', T0)
    expect(suspended.allowed).toBe(false)
    expect(suspended.reason).toMatch(/exhausted/u)
  })

  it('refuses a call whose own cost would break the day', () => {
    const governor = new CostGovernor({ tier, dailyBudgetUsd: 1 })
    expect(governor.affords(T0, 0.5)).toBe(true)
    governor.record(T0, MODEL.haiku45, usage(900_000, 0))
    expect(governor.affords(T0, 0.5)).toBe(false)
  })

  it('resets on the UTC day boundary and not a local one', () => {
    const governor = new CostGovernor({ tier, dailyBudgetUsd: 1 })
    governor.record(T0, MODEL.haiku45, usage(500_000, 0))
    expect(governor.spentUsd(T0)).toBeGreaterThan(0)
    expect(governor.spentUsd(T0 + 86_400)).toBe(0)
    expect(CostGovernor.dayKey(T0)).toBe('2026-09-06')
  })

  it('keeps per-coin ledgers separate', () => {
    const alpha = new CostGovernor({ tier, dailyBudgetUsd: 10 })
    const beta = new CostGovernor({ tier, dailyBudgetUsd: 10 })
    alpha.record(T0, MODEL.sonnet5, usage(4_000_000, 0))
    expect(alpha.level(T0)).toBe('batch')
    expect(beta.level(T0)).toBe('full')
    expect(beta.spentUsd(T0)).toBe(0)
  })

  it('prunes old days so a long-lived process does not grow without bound', () => {
    const governor = new CostGovernor({ tier, dailyBudgetUsd: 10 })
    governor.record(T0, MODEL.haiku45, usage(1_000, 0))
    const muchLater = T0 + 200 * 86_400
    governor.prune(muchLater, 45)
    expect(governor.spentUsd(T0)).toBe(0)
  })
})
