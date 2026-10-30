import { TIERS } from '../protocol.js'
import type { TierId } from '../protocol.js'
import { MODEL, modelForRole } from '../model/ids.js'
import type { ModelId, PlaneRole } from '../model/ids.js'
import type { ModelUsage } from '../model/client.js'
import { MODEL_PRICES, priceUsd } from './pricing.js'
import type { ModelPrice } from './pricing.js'

/**
 * Per-coin, per-day model spend against the tier's COGS budget.
 *
 * The rule is degrade, never overspend. A coin that has burned its daily model
 * budget does not get a smaller model quietly and an unchanged bill; it gets a
 * documented ladder, and at the bottom of the ladder it gets deterministic T0
 * behaviour with no model in the loop at all. Refusing to run is a correct
 * outcome. Running at a loss because a flood arrived is not.
 *
 * COGS in the tier table covers everything it takes to serve a coin, not just
 * inference, so only a fraction of it is available to the model. That fraction
 * is a parameter and should be re-derived from instrumented cost, not guessed at
 * a second time somewhere else.
 */

export type DegradeLevel = 'full' | 'batch' | 'downgrade' | 'suspend'

export interface GovernorOptions {
  tier: TierId
  /** Share of the tier's daily COGS budget available to inference. */
  modelShareOfCogs?: number
  /** Overrides the tier budget outright, for a coin on a bespoke arrangement. */
  dailyBudgetUsd?: number
  prices?: Record<ModelId, ModelPrice>
  thresholds?: Partial<Record<Exclude<DegradeLevel, 'full'>, number>>
}

const DEFAULT_THRESHOLDS: Record<Exclude<DegradeLevel, 'full'>, number> = {
  batch: 0.6,
  downgrade: 0.85,
  suspend: 1.0,
}

export interface ModelPlan {
  allowed: boolean
  model: ModelId
  viaBatch: boolean
  level: DegradeLevel
  reason: string
}

export interface DaySpend {
  dayKey: string
  usd: number
  calls: number
}

export class CostGovernor {
  private readonly dailyBudgetUsd: number
  private readonly prices: Record<ModelId, ModelPrice>
  private readonly thresholds: Record<Exclude<DegradeLevel, 'full'>, number>
  private readonly days = new Map<string, DaySpend>()

  constructor(private readonly options: GovernorOptions) {
    const share = options.modelShareOfCogs ?? 0.6
    if (share <= 0 || share > 1) throw new Error('modelShareOfCogs must be in (0, 1]')
    this.dailyBudgetUsd = options.dailyBudgetUsd ?? TIERS[options.tier].cogsPerDay * share
    this.prices = options.prices ?? MODEL_PRICES
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds }
  }

  get budgetUsd(): number {
    return this.dailyBudgetUsd
  }

  /** UTC day. A local-time boundary would give a coin two budgets a year. */
  static dayKey(nowUnix: number): string {
    return new Date(nowUnix * 1_000).toISOString().slice(0, 10)
  }

  spentUsd(nowUnix: number): number {
    return this.days.get(CostGovernor.dayKey(nowUnix))?.usd ?? 0
  }

  spend(nowUnix: number): DaySpend {
    const dayKey = CostGovernor.dayKey(nowUnix)
    return this.days.get(dayKey) ?? { dayKey, usd: 0, calls: 0 }
  }

  utilisation(nowUnix: number): number {
    if (this.dailyBudgetUsd <= 0) return Number.POSITIVE_INFINITY
    return this.spentUsd(nowUnix) / this.dailyBudgetUsd
  }

  level(nowUnix: number): DegradeLevel {
    const used = this.utilisation(nowUnix)
    if (used >= this.thresholds.suspend) return 'suspend'
    if (used >= this.thresholds.downgrade) return 'downgrade'
    if (used >= this.thresholds.batch) return 'batch'
    return 'full'
  }

  /**
   * What model to use for this call, if any.
   *
   * The reader never downgrades because it is already on the cheapest model; the
   * planner does, and at 'suspend' nothing runs. `urgent` marks work that cannot
   * wait for a batch - a scam wave response, not a weekly summary.
   */
  plan(role: PlaneRole, nowUnix: number, opts: { urgent?: boolean } = {}): ModelPlan {
    const level = this.level(nowUnix)
    const urgent = opts.urgent === true

    if (level === 'suspend') {
      return {
        allowed: false,
        model: MODEL.haiku45,
        viaBatch: false,
        level,
        reason: `daily model budget of $${this.dailyBudgetUsd.toFixed(2)} exhausted; degrading to deterministic operation`,
      }
    }

    const base = modelForRole(role, this.options.tier)
    const model = level === 'downgrade' ? MODEL.haiku45 : base
    const viaBatch = !urgent && (level === 'batch' || level === 'downgrade')

    return {
      allowed: true,
      model,
      viaBatch,
      level,
      reason:
        level === 'full'
          ? 'within budget'
          : `at ${(this.utilisation(nowUnix) * 100).toFixed(0)}% of the daily model budget`,
    }
  }

  /**
   * Refuse a call whose own estimated cost would push the day over budget. This
   * is what makes "never overspend" true rather than approximately true: without
   * it, the last call of the day can overshoot by its entire cost.
   */
  affords(nowUnix: number, estimatedUsd: number): boolean {
    return this.spentUsd(nowUnix) + estimatedUsd <= this.dailyBudgetUsd
  }

  estimate(model: ModelId, usage: ModelUsage, opts: { batch?: boolean } = {}): number {
    return priceUsd(model, usage, { prices: this.prices, ...opts })
  }

  /** Record actual usage. Returns the USD charged. */
  record(
    nowUnix: number,
    model: ModelId,
    usage: ModelUsage,
    opts: { batch?: boolean } = {},
  ): number {
    const usd = this.estimate(model, usage, opts)
    const dayKey = CostGovernor.dayKey(nowUnix)
    const day = this.days.get(dayKey) ?? { dayKey, usd: 0, calls: 0 }
    day.usd += usd
    day.calls += 1
    this.days.set(dayKey, day)
    return usd
  }

  /** Retain a bounded history so a long-lived process does not grow unbounded. */
  prune(nowUnix: number, keepDays = 45): void {
    const cutoff = CostGovernor.dayKey(nowUnix - keepDays * 86_400)
    for (const key of [...this.days.keys()]) {
      if (key < cutoff) this.days.delete(key)
    }
  }
}
