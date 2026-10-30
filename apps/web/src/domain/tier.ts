/**
 * Tier presentation.
 *
 * Gates are stated in QF - quote-denominated creator fees credited to this
 * coin's own vault, USD, gross, as a trailing 7-day MEDIAN of daily credits.
 * The gate is version- and buyback-agnostic by construction, which is why it is
 * expressed that way and not as a volume number.
 *
 * The VOLUME needed to clear a gate depends on the token's own configuration,
 * so this module never publishes a volume threshold as if it were universal:
 * volumeForQf() is called per coin, with that coin's buyback setting.
 */

import { TERMS, TIERS, TIER_ORDER, volumeForQf, type Tier, type TierId } from '../protocol.js'
import { usdToCents, type Cents } from './money.js'

export interface TierStatus {
  tier: Tier
  next: Tier | null
  /** Trailing 7-day median of daily credits, in cents. */
  qfPerDayCents: Cents
  observedDays: number
  sustainedDays: number
  /** 0..1 toward the next gate. 1 means the level is met but not yet sustained. */
  gateProgress: number
  /** Days still required at or above the gate before the next tier is granted. */
  sustainDaysRemaining: number
  /**
   * Fewer than 7 observed days means no tier can be granted at all, whatever
   * the level looks like. Stated rather than hidden.
   */
  hasEnoughHistory: boolean
  /** Per-coin, because the creator rate branches on the buyback setting. */
  volumePerDayForNextGateUsd: number | null
  blockers: string[]
}

export function tierById(id: TierId): Tier {
  const tier = TIERS[id]
  return tier
}

export function nextTier(id: TierId): Tier | null {
  const index = TIER_ORDER.indexOf(id)
  if (index < 0 || index >= TIER_ORDER.length - 1) return null
  const nextId = TIER_ORDER[index + 1]
  return nextId === undefined ? null : TIERS[nextId]
}

export interface TierInput {
  tierId: TierId
  qfPerDayUsd: number
  observedDays: number
  sustainedDays: number
  buybackEnabled: boolean
  creatorTaxBps: number
  /** Screening verdict RESTRICTED blocks paid media even at a qualifying tier. */
  paidMediaPermitted: boolean
  /**
   * This coin's own procurement dial, in bps. Optional because a coin that has
   * not signed yet has no dial of its own; when it is absent the published
   * default is used and nothing may write that number down here.
   */
  budgetBps?: number
}

const MIN_OBSERVED_DAYS = 7

/**
 * Days in the month used for the "about $X a month" figure. A calendar
 * convention, not a commercial term: the same 30-day month the protocol's own
 * qualification-floor note uses.
 */
export const DAYS_PER_MONTH = 30

/**
 * The procurement slice this coin actually accrues, per month, in USD.
 *
 * The dial is read from the coin, NOT assumed: a dev who has moved the dial off
 * the default must not be shown the default's number, and the default itself is
 * TERMS.budgetBpsDefault rather than a float written down in a component.
 */
export function monthlyProcurementUsd(input: Pick<TierInput, 'qfPerDayUsd' | 'budgetBps'>): number {
  const budgetBps = input.budgetBps ?? TERMS.budgetBpsDefault
  return (input.qfPerDayUsd * budgetBps * DAYS_PER_MONTH) / 10_000
}

export function tierStatus(input: TierInput): TierStatus {
  const tier = tierById(input.tierId)
  const next = nextTier(input.tierId)
  const qfPerDayCents = usdToCents(input.qfPerDayUsd)

  const gateProgress =
    next === null || next.gateQfPerDay === 0
      ? 1
      : Math.min(1, input.qfPerDayUsd / next.gateQfPerDay)

  const sustainDaysRemaining =
    next === null ? 0 : Math.max(0, next.sustainedDays - input.sustainedDays)

  const hasEnoughHistory = input.observedDays >= MIN_OBSERVED_DAYS

  const volumePerDayForNextGateUsd =
    next === null || next.gateQfPerDay === 0
      ? null
      : volumeForQf(next.gateQfPerDay, input.buybackEnabled, input.creatorTaxBps)

  const blockers: string[] = []
  if (!hasEnoughHistory) {
    blockers.push(
      `Only ${input.observedDays} of ${MIN_OBSERVED_DAYS} days of fee history. A tier cannot be ` +
        'granted on a shorter window, because a 7-day median needs 7 days.',
    )
  }
  if (next !== null && gateProgress < 1) {
    blockers.push(
      `Trailing 7-day median creator fees are below the ${next.name} gate of ` +
        `$${next.gateQfPerDay.toLocaleString('en-US')}/day.`,
    )
  }
  if (next !== null && gateProgress >= 1 && sustainDaysRemaining > 0) {
    blockers.push(
      `At the ${next.name} level, but it must hold for ${next.sustainedDays} consecutive days. ` +
        `${sustainDaysRemaining} to go.`,
    )
  }
  if (tier.paidMedia && !input.paidMediaPermitted) {
    blockers.push(
      'Screening returned RESTRICTED for this token. Organic operations continue; no paid media ' +
        'may be purchased.',
    )
  }

  return {
    tier,
    next,
    qfPerDayCents,
    observedDays: input.observedDays,
    sustainedDays: input.sustainedDays,
    gateProgress,
    sustainDaysRemaining,
    hasEnoughHistory,
    volumePerDayForNextGateUsd,
    blockers,
  }
}

export function tierDescription(tier: Tier): string {
  if (!tier.usesModel) {
    return 'Deterministic desk only. No model runs at this tier, by design: slash commands ' +
      'answered from cached chain reads, moderation, and a pinned fact sheet.'
  }
  return tier.paidMedia
    ? 'Model-operated desk plus procurement. Paid third-party media may be bought at cost from ' +
      'the dev-elected budget, against a delivery predicate.'
    : 'Model-operated desk. No paid media at this tier.'
}
