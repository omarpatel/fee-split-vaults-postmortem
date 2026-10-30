/**
 * THE TWO PRICE BOOKS, AND THE INVARIANT THAT KILLS SELF-DEALING.
 *
 * The whole commercial claim of this business is one sentence: the operator
 * buys third-party media as principal, charges it on at cost, and earns its
 * money from a flat published fee and from published unit rates for its own
 * labour. Every incentive to recommend the wrong thing is removed by making
 * the recommendation worth nothing.
 *
 * That sentence is only true if it is unrepresentable to violate it. This file
 * is where it becomes unrepresentable:
 *
 *   1. THE CATEGORY DECIDES THE BOOK. `CATEGORY_PRICING_MODEL` maps every SKU
 *      category to exactly one pricing model. A trending buy cannot be filed as
 *      an operator service, so "campaign management, $9,000" cannot be a $3,000
 *      media buy with $6,000 of margin wearing a hat. This is the control that
 *      matters, because a spread hidden inside a service line is invisible to
 *      any comparison against a vendor rate card.
 *
 *   2. PASS-THROUGH SPREAD MUST BE EXACTLY ZERO. Not "within tolerance", not
 *      "at most zero". A NEGATIVE spread is refused too: an operator that can
 *      discount can cross-subsidise, and cross-subsidy is precisely what
 *      COMMITMENT_RULE.allowCrossCoinSubsidy exists to forbid.
 *
 *   3. OPERATOR SERVICES MUST MATCH THE PUBLISHED SCHEDULE, EXACTLY. The
 *      schedule is versioned, public, and has no vault key anywhere in it, so
 *      coin independence is structural rather than promised.
 *
 *   4. ANYTHING RECOMMENDABLE MUST HAVE A REFERENCE. A SKU the planner can
 *      propose, with no archived price to check it against, is refused. No
 *      reference, no recommendation.
 *
 * A future SKU that puts a markup on a recommended item fails at load, and the
 * suite in __tests__/pricebook.spec.ts constructs exactly that SKU and proves
 * it throws.
 */
import type { Sku } from '@fee-split-vaults/core'
import { PriceBookViolation } from './errors.js'
import { exactCentsFromUsd, formatCents } from './money.js'
import type {
  CatalogEntry,
  OperatorRateSchedule,
  PricingModel,
  RateCard,
  VendorRecord,
} from './types.js'

/** The operator bills its own labour under this vendor id and no other. */
export const OPERATOR_VENDOR_ID = 'operator'

export type SkuCategory = Sku['category']

/**
 * THE CATEGORY DECIDES THE BOOK.
 *
 * Adding a category to core/types.ts without adding it here fails to compile,
 * which is the intended way to force the pricing question to be answered before
 * a new kind of line item can be sold.
 */
export const CATEGORY_PRICING_MODEL: Readonly<Record<SkuCategory, PricingModel>> = {
  listing: 'third_party_pass_through',
  boost: 'third_party_pass_through',
  trending: 'third_party_pass_through',
  kol: 'third_party_pass_through',
  moderation: 'operator_service',
  build: 'operator_service',
  creative: 'operator_service',
}

/**
 * A SKU the planner may propose. Only these carry the recommendation duty, and
 * they carry it absolutely: a recommendable SKU with no archived price to check
 * is refused rather than sold on trust.
 */
export function isRecommendable(entry: CatalogEntry): boolean {
  return entry.enabled && entry.sku.availableAtTiers.length > 0
}

/**
 * The operator's margin on one unit, in cents, against the price in force.
 *
 * This is the number the whole business model asserts is zero for pass-through
 * and zero-over-published-rate for services. It is returned rather than merely
 * asserted so reports and tests can print it.
 */
export function operatorMarginCents(entry: CatalogEntry, referenceUsd: number): bigint {
  const charged = exactCentsFromUsd(entry.sku.unitCostUsd, `sku ${entry.sku.id} unitCostUsd`)
  const reference = exactCentsFromUsd(referenceUsd, `reference price for ${entry.sku.id}`)
  return charged - reference
}

/** Structural half: the entry is shaped like exactly one of the two books. */
export function assertPricingModelShape(entry: CatalogEntry, vendor: VendorRecord): void {
  const expected = CATEGORY_PRICING_MODEL[entry.sku.category]
  if (expected === undefined) {
    throw new PriceBookViolation(
      'unknown_category',
      `sku ${entry.sku.id} has category "${String(entry.sku.category)}", which is in neither price book`,
    )
  }
  if (entry.pricing !== expected) {
    throw new PriceBookViolation(
      'category_book_mismatch',
      `sku ${entry.sku.id} is category "${entry.sku.category}", which is always ${expected}, ` +
        `but it is filed as ${entry.pricing}. A media buy cannot be sold as a service.`,
    )
  }

  if (entry.pricing === 'third_party_pass_through') {
    if (entry.sku.vendorId === OPERATOR_VENDOR_ID) {
      throw new PriceBookViolation(
        'operator_as_third_party',
        `sku ${entry.sku.id} bills the operator as if it were a third party`,
      )
    }
    if (entry.publishedRateRef !== undefined) {
      throw new PriceBookViolation(
        'pass_through_with_published_rate',
        `pass-through sku ${entry.sku.id} must not carry a published operator rate`,
      )
    }
    if (entry.rateCardRef !== undefined && entry.rateCardRef.vendorId !== entry.sku.vendorId) {
      throw new PriceBookViolation(
        'rate_card_vendor_mismatch',
        `sku ${entry.sku.id} pins a rate card belonging to ${entry.rateCardRef.vendorId}`,
      )
    }
    // "No third-party payee anywhere": the operator buys as principal and is
    // reimbursed, so a third-party vendor has no payout address in this system.
    if (vendor.payoutAddress !== undefined) {
      throw new PriceBookViolation(
        'third_party_payee',
        `vendor ${vendor.id} carries a payout address; third parties are paid by the operator ` +
          `as principal and never by this protocol`,
      )
    }
    return
  }

  if (entry.pricing === 'operator_service') {
    if (entry.sku.vendorId !== OPERATOR_VENDOR_ID) {
      throw new PriceBookViolation(
        'service_not_billed_by_operator',
        `operator-service sku ${entry.sku.id} must be billed under "${OPERATOR_VENDOR_ID}"`,
      )
    }
    if (entry.publishedRateRef === undefined || entry.publishedRateRef.length === 0) {
      throw new PriceBookViolation(
        'no_published_rate',
        `operator-service sku ${entry.sku.id} names no published rate schedule`,
      )
    }
    if (entry.rateCardRef !== undefined) {
      throw new PriceBookViolation(
        'service_with_rate_card',
        `operator-service sku ${entry.sku.id} pins a third-party rate card, which would make it a ` +
          `resale rather than labour`,
      )
    }
    return
  }

  throw new PriceBookViolation(
    'unknown_pricing_model',
    `sku ${entry.sku.id} has unknown pricing model "${String(entry.pricing)}"`,
  )
}

/**
 * THE ANTI-SELF-DEALING ASSERTION for a pass-through line. Exactly zero, in
 * both directions.
 */
export function assertNoSpreadOnRecommendedPurchase(entry: CatalogEntry, card: RateCard): void {
  if (entry.pricing !== 'third_party_pass_through') {
    throw new PriceBookViolation(
      'not_pass_through',
      `sku ${entry.sku.id} is not a pass-through line and has no rate card`,
    )
  }
  if (card.vendorId !== entry.sku.vendorId) {
    throw new PriceBookViolation(
      'rate_card_vendor_mismatch',
      `sku ${entry.sku.id} was checked against ${card.vendorId}'s rate card`,
    )
  }
  const listed = card.listPriceUsd[entry.sku.id]
  if (listed === undefined) {
    throw new PriceBookViolation(
      'sku_absent_from_rate_card',
      `sku ${entry.sku.id} does not appear on the archived rate card for ${card.vendorId}`,
    )
  }
  const spread = operatorMarginCents(entry, listed)
  if (spread > 0n) {
    throw new PriceBookViolation(
      'markup_detected',
      `sku ${entry.sku.id} charges ${formatCents(exactCentsFromUsd(entry.sku.unitCostUsd, 'unitCostUsd'))} ` +
        `against an archived list price of ${formatCents(exactCentsFromUsd(listed, 'listPriceUsd'))}: ` +
        `a markup of ${formatCents(spread)}. Pass-through spread must be exactly zero.`,
    )
  }
  if (spread < 0n) {
    throw new PriceBookViolation(
      'discount_detected',
      `sku ${entry.sku.id} charges ${formatCents(spread)} BELOW the archived list price. A discount is ` +
        `refused for the same reason a markup is: an operator that can discount can cross-subsidise.`,
    )
  }
}

/** The same assertion for the operator's own labour, against its published rate. */
export function assertPublishedRateMatch(
  entry: CatalogEntry,
  schedule: OperatorRateSchedule,
): void {
  if (entry.pricing !== 'operator_service') {
    throw new PriceBookViolation(
      'not_operator_service',
      `sku ${entry.sku.id} is not an operator service and has no published rate`,
    )
  }
  if (entry.publishedRateRef !== schedule.ref) {
    throw new PriceBookViolation(
      'published_rate_ref_mismatch',
      `sku ${entry.sku.id} names schedule "${String(entry.publishedRateRef)}" but was checked against "${schedule.ref}"`,
    )
  }
  const published = schedule.unitRateUsd[entry.sku.id]
  if (published === undefined) {
    throw new PriceBookViolation(
      'sku_absent_from_published_rates',
      `sku ${entry.sku.id} is billed as an operator service but does not appear in published schedule ${schedule.ref}`,
    )
  }
  const delta = operatorMarginCents(entry, published)
  if (delta !== 0n) {
    throw new PriceBookViolation(
      'published_rate_mismatch',
      `sku ${entry.sku.id} charges ${formatCents(delta)} away from published schedule ${schedule.ref}. ` +
        `The published rate is the price; there is no second number.`,
    )
  }
}

export interface PriceBookReferences {
  /** vendorId -> the archived card in force. */
  rateCards: ReadonlyMap<string, RateCard>
  /** schedule ref -> the published operator rate schedule. */
  schedules: ReadonlyMap<string, OperatorRateSchedule>
  vendors: ReadonlyMap<string, VendorRecord>
}

/**
 * The whole invariant over a whole catalog. Called at load, and again by the
 * daily reconciliation against freshly archived cards.
 */
export function assertTwoPriceBooks(
  entries: readonly CatalogEntry[],
  refs: PriceBookReferences,
): void {
  for (const entry of entries) {
    const vendor = refs.vendors.get(entry.sku.vendorId)
    if (vendor === undefined) {
      throw new PriceBookViolation(
        'unknown_vendor',
        `sku ${entry.sku.id} names vendor ${entry.sku.vendorId}, which is not allowlisted`,
      )
    }
    assertPricingModelShape(entry, vendor)

    if (entry.pricing === 'third_party_pass_through') {
      const card = refs.rateCards.get(entry.sku.vendorId)
      if (card === undefined) {
        if (isRecommendable(entry)) {
          throw new PriceBookViolation(
            'no_reference_for_recommendable_sku',
            `sku ${entry.sku.id} is offered to clients but has no archived rate card to check its ` +
              `price against. No reference, no recommendation.`,
          )
        }
        continue
      }
      if (entry.rateCardRef === undefined) {
        throw new PriceBookViolation(
          'no_rate_card_ref',
          `pass-through sku ${entry.sku.id} pins no archived rate card`,
        )
      }
      if (entry.rateCardRef.sourceHash !== card.sourceHash) {
        throw new PriceBookViolation(
          'rate_card_hash_moved',
          `sku ${entry.sku.id} pins rate card ${entry.rateCardRef.sourceHash.slice(0, 12)} but the ` +
            `card in force is ${card.sourceHash.slice(0, 12)}; the price it was approved against no longer exists`,
        )
      }
      assertNoSpreadOnRecommendedPurchase(entry, card)
      continue
    }

    const ref = entry.publishedRateRef
    if (ref === undefined) {
      throw new PriceBookViolation(
        'no_published_rate',
        `operator-service sku ${entry.sku.id} names no published rate schedule`,
      )
    }
    const schedule = refs.schedules.get(ref)
    if (schedule === undefined) {
      throw new PriceBookViolation(
        'unknown_published_rate_schedule',
        `sku ${entry.sku.id} names published schedule "${ref}", which is not loaded`,
      )
    }
    assertPublishedRateMatch(entry, schedule)
  }
}
