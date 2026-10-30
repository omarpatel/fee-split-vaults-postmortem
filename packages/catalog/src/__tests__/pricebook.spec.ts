/**
 * The two-price-book invariant.
 *
 * The load-bearing test in this file is "a future SKU with a markup on a
 * recommended item fails the suite". Everything else is scaffolding for it.
 */
import { describe, expect, it } from 'vitest'
import { PriceBookViolation } from '../errors.js'
import {
  assertNoSpreadOnRecommendedPurchase,
  assertPricingModelShape,
  assertPublishedRateMatch,
  assertTwoPriceBooks,
  CATEGORY_PRICING_MODEL,
  isRecommendable,
  operatorMarginCents,
  OPERATOR_VENDOR_ID,
} from '../pricebook.js'
import type { PriceBookReferences } from '../pricebook.js'
import {
  cardFor,
  cleanCatalog,
  OPERATOR_VENDOR,
  passThroughEntry,
  scheduleFor,
  serviceEntry,
  THIRD_PARTY_VENDOR,
} from './fixtures.js'
import type { CatalogEntry, RateCard, VendorRecord } from '../types.js'

function refs(
  cards: readonly RateCard[],
  vendors: readonly VendorRecord[] = [OPERATOR_VENDOR, THIRD_PARTY_VENDOR],
  scheduleRates: Record<string, number> = { operator_thing: 45 },
): PriceBookReferences {
  return {
    rateCards: new Map(cards.map((card) => [card.vendorId, card])),
    schedules: new Map([['test-rates@v1', scheduleFor(scheduleRates)]]),
    vendors: new Map(vendors.map((vendor) => [vendor.id, vendor])),
  }
}

describe('the clean case', () => {
  it('accepts a catalog priced exactly at cost and exactly at the published rate', () => {
    const { catalog, card, schedule } = cleanCatalog()
    expect(() =>
      assertTwoPriceBooks(catalog.entries, {
        rateCards: new Map([[card.vendorId, card]]),
        schedules: new Map([[schedule.ref, schedule]]),
        vendors: new Map(catalog.vendors.map((vendor) => [vendor.id, vendor])),
      }),
    ).not.toThrow()
  })
})

describe('THE OPERATOR NEVER EARNS A SPREAD ON A PURCHASE IT RECOMMENDS', () => {
  const card = cardFor('vendorx', { vendorx_thing: 299 })

  it('refuses a SKU priced one cent above the archived list price', () => {
    const marked = passThroughEntry({ unitCostUsd: 299.01, rateCardHash: card.sourceHash })
    expect(isRecommendable(marked)).toBe(true)
    expect(() => assertTwoPriceBooks([marked], refs([card]))).toThrow(PriceBookViolation)
    expect(() => assertTwoPriceBooks([marked], refs([card]))).toThrow(/markup_detected/)
  })

  it('refuses a SKU priced far above the archived list price', () => {
    const marked = passThroughEntry({ unitCostUsd: 399, rateCardHash: card.sourceHash })
    expect(() => assertNoSpreadOnRecommendedPurchase(marked, card)).toThrow(/markup of \$100\.00/)
  })

  it('refuses a DISCOUNT as well, because an operator that can discount can cross-subsidise', () => {
    const discounted = passThroughEntry({ unitCostUsd: 289, rateCardHash: card.sourceHash })
    expect(() => assertNoSpreadOnRecommendedPurchase(discounted, card)).toThrow(/discount_detected/)
  })

  it('reports the margin as exactly zero when the price matches', () => {
    const clean = passThroughEntry({ unitCostUsd: 299, rateCardHash: card.sourceHash })
    expect(operatorMarginCents(clean, 299)).toBe(0n)
  })

  it('refuses a recommendable SKU that has no archived price to be checked against', () => {
    const unreferenced = passThroughEntry({ unitCostUsd: 299 })
    expect(() => assertTwoPriceBooks([unreferenced], refs([]))).toThrow(
      /no_reference_for_recommendable_sku/,
    )
  })

  it('lets a DISABLED SKU exist without a reference, because it is not recommended', () => {
    const parked = passThroughEntry({ unitCostUsd: 3000, enabled: false })
    expect(isRecommendable(parked)).toBe(false)
    expect(() => assertTwoPriceBooks([parked], refs([]))).not.toThrow()
  })

  it('refuses a SKU pinned to a rate card that has since moved', () => {
    const pinned = passThroughEntry({ unitCostUsd: 299, rateCardHash: 'f'.repeat(64) })
    expect(() => assertTwoPriceBooks([pinned], refs([card]))).toThrow(/rate_card_hash_moved/)
  })

  it('refuses a SKU that fell off the vendor rate card', () => {
    const orphan = passThroughEntry({
      id: 'vendorx_other',
      unitCostUsd: 299,
      rateCardHash: card.sourceHash,
    })
    expect(() => assertTwoPriceBooks([orphan], refs([card]))).toThrow(/sku_absent_from_rate_card/)
  })
})

describe('the category decides the book', () => {
  it('files every media category as pass-through and every labour category as a service', () => {
    expect(CATEGORY_PRICING_MODEL).toEqual({
      listing: 'third_party_pass_through',
      boost: 'third_party_pass_through',
      trending: 'third_party_pass_through',
      kol: 'third_party_pass_through',
      moderation: 'operator_service',
      build: 'operator_service',
      creative: 'operator_service',
    })
  })

  it('refuses a media buy dressed up as an operator service', () => {
    // The self-dealing shape that a rate-card comparison alone cannot see:
    // "campaign management, $9,000" hiding a $3,000 media buy.
    const disguised: CatalogEntry = {
      ...serviceEntry({ unitCostUsd: 9000 }),
      sku: { ...serviceEntry({ unitCostUsd: 9000 }).sku, category: 'trending' },
    }
    expect(() => assertPricingModelShape(disguised, OPERATOR_VENDOR)).toThrow(
      /category_book_mismatch/,
    )
    expect(() => assertPricingModelShape(disguised, OPERATOR_VENDOR)).toThrow(
      /A media buy cannot be sold as a service/,
    )
  })

  it('refuses an operator service billed under a third-party vendor id', () => {
    const misfiled: CatalogEntry = {
      ...serviceEntry({ unitCostUsd: 45 }),
      sku: { ...serviceEntry({ unitCostUsd: 45 }).sku, vendorId: 'vendorx' },
    }
    expect(() => assertPricingModelShape(misfiled, THIRD_PARTY_VENDOR)).toThrow(
      /service_not_billed_by_operator/,
    )
  })

  it('refuses the operator billing itself as if it were a third party', () => {
    const selfDealt = passThroughEntry({ unitCostUsd: 299, vendorId: OPERATOR_VENDOR_ID })
    expect(() => assertPricingModelShape(selfDealt, OPERATOR_VENDOR)).toThrow(
      /operator_as_third_party/,
    )
  })

  it('refuses an operator service that also pins a third-party rate card', () => {
    const resale: CatalogEntry = {
      ...serviceEntry({ unitCostUsd: 45 }),
      rateCardRef: { vendorId: 'operator', sourceHash: 'a'.repeat(64) },
    }
    expect(() => assertPricingModelShape(resale, OPERATOR_VENDOR)).toThrow(/service_with_rate_card/)
  })
})

describe('no third-party payee anywhere', () => {
  it('refuses a pass-through vendor that carries a payout address', () => {
    const payee: VendorRecord = { ...THIRD_PARTY_VENDOR, payoutAddress: `0x${'1'.repeat(40)}` }
    const entry = passThroughEntry({ unitCostUsd: 299 })
    expect(() => assertPricingModelShape(entry, payee)).toThrow(/third_party_payee/)
  })
})

describe('operator services are priced from the published schedule', () => {
  it('accepts a service priced exactly at its published rate', () => {
    const entry = serviceEntry({ unitCostUsd: 45 })
    expect(() => assertPublishedRateMatch(entry, scheduleFor({ operator_thing: 45 }))).not.toThrow()
  })

  it('refuses a service priced away from its published rate', () => {
    const entry = serviceEntry({ unitCostUsd: 60 })
    expect(() => assertPublishedRateMatch(entry, scheduleFor({ operator_thing: 45 }))).toThrow(
      /published_rate_mismatch/,
    )
  })

  it('refuses a service that does not appear in the schedule at all', () => {
    const entry = serviceEntry({ id: 'operator_secret', unitCostUsd: 45 })
    expect(() => assertPublishedRateMatch(entry, scheduleFor({ operator_thing: 45 }))).toThrow(
      /sku_absent_from_published_rates/,
    )
  })

  it('refuses a service naming a schedule that is not loaded', () => {
    const entry = serviceEntry({ unitCostUsd: 45, scheduleRef: 'ghost-rates@v9' })
    expect(() => assertTwoPriceBooks([entry], refs([]))).toThrow(
      /unknown_published_rate_schedule/,
    )
  })
})

describe('coin independence is structural', () => {
  it('prices a SKU without any way to name a client', () => {
    const { catalog } = cleanCatalog()
    // The signature is the control: there is no vault parameter to pass.
    expect(catalog.priceCents('vendorx_thing', 1)).toBe(29_900n)
    expect(catalog.priceCents('vendorx_thing', 2)).toBe(59_800n)
    expect(Catalog_priceCentsArity(catalog)).toBe(2)
  })
})

/** Reads the arity of priceCents so the "no vault argument" claim is tested. */
function Catalog_priceCentsArity(catalog: object): number {
  const proto = Object.getPrototypeOf(catalog) as Record<string, unknown>
  const fn = proto.priceCents
  return typeof fn === 'function' ? fn.length : -1
}
