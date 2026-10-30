/**
 * The SHIPPED data, not a fixture.
 *
 * Everything else in this suite proves the machinery works. This file proves
 * the machinery is pointed at the real catalog, and that the real catalog says
 * what the business claims it says.
 */
import { describe, expect, it } from 'vitest'
import { loadCatalog } from '../load.js'
import { dataPaths } from '../paths.js'
import {
  auditHistoricalPurchase,
  FileCatalogSnapshotArchive,
  FileRateCardArchive,
} from '../archive.js'
import { computeDrifts } from '../reconcile.js'
import { assertNoSpreadOnRecommendedPurchase, operatorMarginCents } from '../pricebook.js'
import { affordableTiers, evaluateTier, minViableSpendCents, monthlyProcurementBudgetUsd } from '../tiers.js'
import { usdFromCents } from '../money.js'
import { DISCLOSURE, QUALIFICATION_FLOOR_MONTHLY_USD, TIER_ORDER } from '../protocol.js'
import { KOL_REQUIRED_OFFSETS_SECONDS } from '../schema.js'
import { catalogToBrokerCatalog } from '../broker.js'
import { PREDICATE_PARAMS, PredicateRegistry, FakeEvidenceSource } from '@fee-split-vaults/broker'

const { catalog } = loadCatalog()

/** Every price in the catalog was observed on the same pass. */
const OBSERVED_AT = Math.max(
  ...catalog.entries.map((entry) => entry.priceProvenance.observedAtUnix),
)

describe('the shipped catalog loads', () => {
  it('validates without a single relaxation', () => {
    expect(catalog.skuIds.length).toBeGreaterThan(0)
    expect(catalog.vendorIds).toContain('operator')
  })

  it('reconciles with zero drift on the day its prices were observed', () => {
    const cards = new Map(catalog.rateCards.map((card) => [card.vendorId, card]))
    const drifts = computeDrifts(catalog, (vendorId) => cards.get(vendorId) ?? null, OBSERVED_AT)
    // Only the SKUs that ship deliberately unpriced (band placeholders awaiting
    // a countersigned quote) may drift, and they are all already disabled.
    for (const drift of drifts) {
      expect(drift.kind).toBe('missing_rate_card')
      expect(catalog.entry(drift.skuId).enabled).toBe(false)
    }
  })
})

describe('zero markup, everywhere, in both directions', () => {
  it('charges every pass-through SKU exactly its archived list price', () => {
    const checked: string[] = []
    for (const entry of catalog.entries) {
      if (entry.pricing !== 'third_party_pass_through') continue
      const card = catalog.rateCard(entry.sku.vendorId)
      if (card === undefined) {
        // No card means no price to charge on, which means the SKU must not be
        // offered. That is the invariant, and it is checked rather than assumed.
        expect(entry.enabled).toBe(false)
        continue
      }
      expect(() => assertNoSpreadOnRecommendedPurchase(entry, card)).not.toThrow()
      const listed = card.listPriceUsd[entry.sku.id]
      expect(listed).toBeDefined()
      expect(operatorMarginCents(entry, listed ?? -1)).toBe(0n)
      checked.push(entry.sku.id)
    }
    expect(checked.length).toBeGreaterThan(0)
  })

  it('charges every operator service exactly its published rate', () => {
    const checked: string[] = []
    for (const entry of catalog.entries) {
      if (entry.pricing !== 'operator_service') continue
      const schedule = catalog.schedule(entry.publishedRateRef ?? '')
      expect(schedule).toBeDefined()
      const published = schedule?.unitRateUsd[entry.sku.id]
      expect(published).toBeDefined()
      expect(operatorMarginCents(entry, published ?? -1)).toBe(0n)
      checked.push(entry.sku.id)
    }
    expect(checked.length).toBeGreaterThan(0)
  })

  it('publishes no rate schedule that mentions a client', () => {
    // Coin independence, checked against the data rather than the signature:
    // there is no vault-shaped key anywhere in the published rates.
    for (const schedule of catalog.schedules) {
      for (const key of Object.keys(schedule.unitRateUsd)) {
        expect(key).not.toMatch(/^0x/i)
        expect(catalog.has(key)).toBe(true)
      }
    }
  })
})

describe('no third-party payee anywhere', () => {
  it('gives no vendor a payout address', () => {
    expect(catalog.vendors.every((vendor) => vendor.payoutAddress === undefined)).toBe(true)
  })

  it('flags the operator as a related party', () => {
    expect(catalog.vendor('operator').isRelatedParty).toBe(true)
  })
})

describe('tier availability', () => {
  it('offers nothing at T0', () => {
    expect(catalog.offeredSkuIds('T0')).toEqual([])
    for (const entry of catalog.entries) {
      expect(entry.sku.availableAtTiers).not.toContain('T0')
    }
  })

  it('clears the qualification floor at every tier it publishes a menu for', () => {
    // The floor is the monthly procurement below which a tier cannot fund its
    // own cheapest deliverable. A tier the catalog offers something at must be
    // above it; T0 offers nothing and is skipped by the data, not by a special
    // case here.
    for (const tier of TIER_ORDER) {
      if (catalog.offeredSkuIds(tier).length === 0) continue
      expect(monthlyProcurementBudgetUsd(tier)).toBeGreaterThanOrEqual(
        QUALIFICATION_FLOOR_MONTHLY_USD,
      )
    }
  })

  it('DOES NOT OFFER DEXTOOLS TRENDING AT T1', () => {
    // The named failure mode: advertising what the budget cannot buy. A T1 coin
    // accrues one month of procurement at its gate; trending is quoted per DAY
    // in the low thousands and a viable buy is a run of days.
    const trending = catalog.entry('dextools_trending_24h')
    expect(trending.sku.category).toBe('trending')
    expect(trending.sku.availableAtTiers).not.toContain('T1')
    expect(catalog.offeredSkuIds('T1')).not.toContain('dextools_trending_24h')

    const verdict = evaluateTier(trending, 'T1')
    expect(verdict.available).toBe(false)
    expect(verdict.reason).toBe('exceeds_single_line_ceiling')
    // Not a near miss: the smallest viable buy exceeds the single-line ceiling
    // and exceeds the tier's WHOLE month of procurement budget as well.
    expect(verdict.minViableSpendCents).toBeGreaterThan(verdict.maxSingleLineCents)
    expect(usdFromCents(verdict.minViableSpendCents)).toBeGreaterThan(
      monthlyProcurementBudgetUsd('T1'),
    )
    expect(affordableTiers(trending)).not.toContain('T1')
    expect(affordableTiers(trending)).not.toContain('T2')
  })

  it('offers the Dexscreener listing at T1, which is what the floor is sized for', () => {
    expect(catalog.offeredSkuIds('T1')).toContain('dexscreener_eti')
    expect(catalog.entry('dexscreener_eti').sku.unitCostUsd).toBe(299)
  })

  it('never offers a SKU whose minimum viable purchase exceeds the tier ceiling', () => {
    for (const tier of TIER_ORDER) {
      for (const entry of catalog.entriesForTier(tier)) {
        const verdict = evaluateTier(entry, tier)
        expect(verdict.available).toBe(true)
        expect(minViableSpendCents(entry)).toBeLessThanOrEqual(verdict.maxSingleLineCents)
      }
    }
  })

  it('leaves every tier above T0 with something it can actually buy', () => {
    for (const tier of TIER_ORDER) {
      if (tier === 'T0') continue
      expect(catalog.offeredSkuIds(tier).length).toBeGreaterThan(0)
    }
  })
})

describe('delivery predicates', () => {
  it('gives every SKU a predicate and a verification schedule', () => {
    for (const entry of catalog.entries) {
      expect(entry.sku.predicate.kind).toBeTruthy()
      expect(entry.sku.predicate.verifyAtOffsetsSeconds.length).toBeGreaterThan(0)
    }
  })

  it('checks every KOL post at BOTH T+24h and T+7d', () => {
    const kolSkus = catalog.entries.filter((entry) => entry.sku.category === 'kol')
    expect(kolSkus.length).toBeGreaterThan(0)
    for (const entry of kolSkus) {
      for (const offset of KOL_REQUIRED_OFFSETS_SECONDS) {
        expect(entry.sku.predicate.verifyAtOffsetsSeconds).toContain(offset)
      }
    }
  })

  it('requires the paid-promotion disclosure literal from config, not a copy of it', () => {
    for (const entry of catalog.entries) {
      if (entry.sku.predicate.kind !== 'kol_post') continue
      expect(entry.sku.predicate.params.requireDisclosureLiteral).toBe(
        DISCLOSURE.paidPromotionTag,
      )
      expect(entry.sku.predicate.params.requireHandleMatch).toBe(1)
      expect(entry.sku.predicate.params.requireStillLive).toBe(1)
    }
  })

  it('samples a trending buy repeatedly, randomly, with pro-rata clawback', () => {
    const trending = catalog.entry('dextools_trending_24h')
    expect(trending.sku.predicate.kind).toBe('trending_rank')
    expect(trending.sku.predicate.params.randomized).toBe(1)
    expect(trending.sku.predicate.params.clawback).toBe('pro_rata')
    expect(Number(trending.sku.predicate.params.minChecks)).toBeGreaterThanOrEqual(8)
    expect(trending.sku.predicate.verifyAtOffsetsSeconds.length).toBeGreaterThanOrEqual(
      Number(trending.sku.predicate.params.minChecks),
    )
  })

  it('verifies boosts inside the window the effect actually lasts', () => {
    for (const entry of catalog.entries) {
      if (entry.sku.predicate.kind !== 'boost_delta') continue
      const window = Number(entry.sku.predicate.params.effectWindowSeconds)
      // Boost effects are measured in hours, so every check has to land inside
      // the day. A T+7d re-check of a boost measures nothing.
      expect(window).toBeLessThanOrEqual(86_400)
      for (const offset of entry.sku.predicate.verifyAtOffsetsSeconds) {
        expect(offset).toBeLessThanOrEqual(window)
      }
    }
  })

  it('confines manual attestation to the operator\'s own labour', () => {
    for (const entry of catalog.entries) {
      if (entry.sku.predicate.kind !== 'manual_attestation') continue
      expect(entry.pricing).toBe('operator_service')
      expect(entry.sku.vendorId).toBe('operator')
    }
  })
})

describe('the shipped archive', () => {
  it('holds the rate card in force on the day the catalog was priced', async () => {
    const archive = new FileRateCardArchive(dataPaths().rateCardArchiveDir)
    const card = await archive.asOf('dexscreener', OBSERVED_AT)
    expect(card).not.toBeNull()
    expect(card?.listPriceUsd.dexscreener_eti).toBe(299)
    // Reading it verified its seal; a hand-edited archive copy would throw.
    expect(card?.sourceHash).toBe(catalog.rateCard('dexscreener')?.sourceHash)
  })

  it('lets a purchase made today be audited against the price in force today', async () => {
    const snapshots = new FileCatalogSnapshotArchive(dataPaths().snapshotDir)
    expect((await snapshots.list()).length).toBeGreaterThan(0)

    const match = await auditHistoricalPurchase(snapshots, {
      skuId: 'dexscreener_eti',
      quantity: 1,
      chargedCents: 29_900n,
      disbursedAtUnix: OBSERVED_AT + 3600,
    })
    expect(match.outcome).toBe('match')

    const overcharged = await auditHistoricalPurchase(snapshots, {
      skuId: 'dexscreener_eti',
      quantity: 1,
      chargedCents: 34_900n,
      disbursedAtUnix: OBSERVED_AT + 3600,
    })
    expect(overcharged.outcome).toBe('amount_mismatch')
    expect(overcharged.deltaCents).toBe(5_000n)
  })
})

describe('price provenance', () => {
  it('marks every price with a source and the date it was observed', () => {
    for (const entry of catalog.entries) {
      const provenance = entry.priceProvenance
      expect(provenance.sourceUri.length).toBeGreaterThan(0)
      expect(provenance.observedOnDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(provenance.maxAgeSeconds).toBeGreaterThan(0)
    }
  })

  it('never ships an enabled SKU whose price is only an indicative band', () => {
    // A band is not a list price and cannot be charged at cost. Anything priced
    // from a quote must have that quote archived before it can be sold.
    for (const entry of catalog.entries) {
      if (entry.priceProvenance.kind !== 'vendor_countersigned_quote') continue
      if (catalog.rateCard(entry.sku.vendorId) !== undefined) continue
      expect(entry.enabled).toBe(false)
      expect(entry.disabledReason).toBeTruthy()
    }
  })
})

describe('every shipped predicate can run against the broker verifiers', () => {
  it('names its params in the vocabulary the verifiers read', () => {
    for (const entry of catalog.entries) {
      const { kind, params } = entry.sku.predicate
      const vocabulary = PREDICATE_PARAMS[kind]
      for (const key of vocabulary.required) {
        expect(params, `${entry.sku.id} lacks ${key}`).toHaveProperty(key)
      }
      for (const key of Object.keys(params)) {
        expect(
          [...vocabulary.required, ...vocabulary.optional],
          `${entry.sku.id} carries ${key}, which no ${kind} verifier reads`,
        ).toContain(key)
      }
    }
  })

  it('verifies the enhanced-listing SKU against a pair record with the expected field', async () => {
    const spec = catalog.entry('dexscreener_eti').sku.predicate
    const registry = new PredicateRegistry(
      new FakeEvidenceSource({
        eti: { chain: '4663', pairSource: 'dexscreener_pairs_api', presentFields: ['info'], socialsPresent: 2 },
      }),
    )
    const delivery = {
      disbursementId: 'db_1',
      vault: `0x${'1'.repeat(40)}`,
      token: `0x${'2'.repeat(40)}`,
      fundedAtUnix: OBSERVED_AT,
    }
    const passed = await registry.verify({ spec, delivery, offsetSeconds: 3600, nowUnix: OBSERVED_AT + 3600 })
    expect(passed.passed).toBe(true)
    expect(passed.note).not.toMatch(/missing_param|bad_param/)
  })

  it('measures a boost pack against its declared delta without a missing-param refusal', async () => {
    const spec = catalog.entry('dexscreener_boost_10').sku.predicate
    const registry = new PredicateRegistry(new FakeEvidenceSource({ boosts: 15 }))
    const delivery = {
      disbursementId: 'db_2',
      vault: `0x${'1'.repeat(40)}`,
      token: `0x${'2'.repeat(40)}`,
      fundedAtUnix: OBSERVED_AT,
      baseline: { boosts: 5 },
    }
    const result = await registry.verify({ spec, delivery, offsetSeconds: 900, nowUnix: OBSERVED_AT + 900 })
    expect(result.passed).toBe(true)
  })
})

describe('the broker consumes the shipped catalog', () => {
  const broker = catalogToBrokerCatalog(catalog)

  it('offers what the loader offers and nothing it cannot price', () => {
    for (const tier of TIER_ORDER) {
      expect(broker.entriesForTier(tier).map((e) => e.sku.id).sort()).toEqual(
        catalog.offeredSkuIds(tier).sort(),
      )
    }
    expect(broker.has('dextools_trending_24h')).toBe(false)
  })

  it('ships dexscreener without diligence dates, so paid media stays refused until the operator records them', () => {
    const vendor = broker.vendor('dexscreener')
    expect(vendor.kybVerifiedAtUnix).toBeUndefined()
    expect(vendor.ofacScreenedAtUnix).toBeUndefined()
    expect(broker.payoutAddresses).toEqual([])
  })
})
