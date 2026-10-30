/**
 * TIER AFFORDABILITY: what a tier's budget can actually buy.
 *
 * The failure mode this file exists to prevent is advertising a deliverable a
 * client's budget cannot fund. It is a worse failure than it sounds. A T1 coin
 * clearing exactly its gate accrues a month of procurement budget in the low
 * thousands - gate x default dial x 30, computed below and never written down
 * as a constant. DEXTools trending costs thousands PER DAY and sells in packs
 * of days. Putting trending on the T1 menu produces a client who was sold a
 * campaign that was arithmetically impossible before anyone wrote a line of
 * copy, and the operator finds out when the coin asks why it never ran.
 *
 * So availability is not an editorial choice. It is computed, and the declared
 * `availableAtTiers` on every SKU is CHECKED against the computation at load.
 * A SKU declaring a tier it cannot be funded at refuses to load.
 *
 * THE MODEL, and its deliberate conservatism:
 *
 *   monthly procurement budget(tier)
 *       = tier.gateQfPerDay x TERMS.budgetBpsDefault x 30 days
 *
 * At the DEFAULT dial, not the maximum. A tier must be affordable to a dev who
 * never touched the dial, because the menu is shown before the dial is set.
 *
 * At the GATE, not at some assumed multiple of it. A coin sitting exactly on
 * the gate is a real client, and it is the client most likely to be oversold.
 *
 * And a single line may consume at most half of one month, because a purchase
 * that eats the whole month leaves the coin with no moderation, no creative and
 * no second attempt - an offer that can only be taken once was never an offer.
 */
import { exactCentsFromUsd, applyBps, usdFromCents } from './money.js'
import { TERMS, TIERS, TIER_ORDER } from './protocol.js'
import type { TierId } from './protocol.js'
import { TierAvailabilityViolation } from './errors.js'
import type { CatalogEntry } from './types.js'

export const AFFORDABILITY = {
  /** The dial a tier's budget is modelled at. Default, never the maximum. */
  modelBudgetBps: TERMS.budgetBpsDefault,
  /** Budget months are 30 days. The tier gates are stated per day. */
  daysPerMonth: 30,
  /**
   * Ceiling on one line item as a share of a month's procurement budget, in
   * bps. 5_000 = half. Raising this is a commercial decision that makes the
   * menu less honest, so it is stated once, here, and tested.
   */
  maxSingleLineShareBps: 5_000,
} as const

/** The procurement budget a coin sitting exactly on a tier gate accrues per day. */
export function dailyProcurementBudgetCents(tier: TierId): bigint {
  const spec = TIERS[tier]
  const qfCents = exactCentsFromUsd(spec.gateQfPerDay, `TIERS.${tier}.gateQfPerDay`)
  return applyBps(qfCents, AFFORDABILITY.modelBudgetBps)
}

/** The same figure over a 30-day month. This is the number the menu is built on. */
export function monthlyProcurementBudgetCents(tier: TierId): bigint {
  return dailyProcurementBudgetCents(tier) * BigInt(AFFORDABILITY.daysPerMonth)
}

export function monthlyProcurementBudgetUsd(tier: TierId): number {
  return usdFromCents(monthlyProcurementBudgetCents(tier))
}

/** The largest single line a tier may be offered. */
export function maxSingleLineCents(tier: TierId): bigint {
  return applyBps(monthlyProcurementBudgetCents(tier), AFFORDABILITY.maxSingleLineShareBps)
}

/**
 * The smallest spend on this SKU that could plausibly deliver anything.
 *
 * Not the unit price. One day of trending in a seven-day window is not a
 * campaign, and the vendor's own pack floors are real. Affordability is judged
 * against what a purchase actually has to be.
 */
export function minViableSpendCents(entry: CatalogEntry): bigint {
  const unit = exactCentsFromUsd(entry.sku.unitCostUsd, `sku ${entry.sku.id} unitCostUsd`)
  const quantity = entry.minViableQuantity
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new TierAvailabilityViolation(
      'bad_min_viable_quantity',
      `sku ${entry.sku.id} has a non-positive minViableQuantity`,
    )
  }
  if (quantity > entry.maxQuantity) {
    throw new TierAvailabilityViolation(
      'min_viable_over_max',
      `sku ${entry.sku.id} cannot be bought in a viable quantity (${quantity}) without exceeding maxQuantity (${entry.maxQuantity})`,
    )
  }
  return unit * BigInt(quantity)
}

export type TierUnavailableReason =
  | 'tier_has_no_budget'
  | 'tier_forbids_paid_media'
  | 'exceeds_single_line_ceiling'

export interface TierAvailability {
  tier: TierId
  available: boolean
  reason?: TierUnavailableReason
  minViableSpendCents: bigint
  maxSingleLineCents: bigint
  monthlyBudgetCents: bigint
}

export function evaluateTier(entry: CatalogEntry, tier: TierId): TierAvailability {
  const monthly = monthlyProcurementBudgetCents(tier)
  const ceiling = maxSingleLineCents(tier)
  const need = minViableSpendCents(entry)
  const base: TierAvailability = {
    tier,
    available: false,
    minViableSpendCents: need,
    maxSingleLineCents: ceiling,
    monthlyBudgetCents: monthly,
  }

  // A tier with no procurement budget can fund nothing, not even a service.
  // This subsumes the paid-media check for every tier in the CURRENT table,
  // since T0 is the only tier with paidMedia false and it also has no budget.
  if (monthly <= 0n) return { ...base, reason: 'tier_has_no_budget' }

  // Kept for a future tier that has a budget but is still barred from buying
  // third-party media. Without it, adding such a tier would silently start
  // offering media there.
  if (entry.pricing === 'third_party_pass_through' && !TIERS[tier].paidMedia) {
    return { ...base, reason: 'tier_forbids_paid_media' }
  }

  if (need > ceiling) return { ...base, reason: 'exceeds_single_line_ceiling' }

  return { ...base, available: true }
}

/** Every tier this SKU can honestly be offered at, computed from the numbers. */
export function affordableTiers(entry: CatalogEntry): TierId[] {
  return TIER_ORDER.filter((tier) => evaluateTier(entry, tier).available)
}

/**
 * THE ASSERTION. Called on every SKU at load and again on every reconciliation
 * pass. A SKU whose declared availability includes a tier that cannot fund it
 * refuses to load.
 *
 * The check is one-directional on purpose: declaring FEWER tiers than are
 * affordable is allowed, because an operator may hold a SKU back for reasons
 * arithmetic does not see. Declaring MORE is the lie, and it throws.
 */
export function assertTierAvailability(entry: CatalogEntry): void {
  const declared = entry.sku.availableAtTiers
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new TierAvailabilityViolation(
      'no_tiers_declared',
      `sku ${entry.sku.id} is available at no tier`,
    )
  }
  const seen = new Set<string>()
  for (const tier of declared) {
    if (seen.has(tier)) {
      throw new TierAvailabilityViolation(
        'duplicate_tier',
        `sku ${entry.sku.id} lists tier ${tier} twice`,
      )
    }
    seen.add(tier)
    if (!(TIER_ORDER as readonly string[]).includes(tier)) {
      throw new TierAvailabilityViolation(
        'unknown_tier',
        `sku ${entry.sku.id} names unknown tier ${tier}`,
      )
    }
    const verdict = evaluateTier(entry, tier)
    if (!verdict.available) {
      throw new TierAvailabilityViolation(
        verdict.reason ?? 'unavailable',
        `sku ${entry.sku.id} is offered at ${tier}, whose modelled monthly procurement budget is ` +
          `${usdFromCents(verdict.monthlyBudgetCents).toFixed(2)} USD and whose single-line ceiling is ` +
          `${usdFromCents(verdict.maxSingleLineCents).toFixed(2)} USD, but its minimum viable purchase is ` +
          `${usdFromCents(verdict.minViableSpendCents).toFixed(2)} USD`,
      )
    }
  }
}
