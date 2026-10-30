/**
 * The zero-markup accounting invariant: the operator never earns a spread on a
 * purchase it recommends.
 */
import { describe, expect, it } from 'vitest'
import {
  InMemoryRateCardArchive,
  VendorCatalog,
  applyReconciliation,
  assertNoSpreadOnRecommendedPurchase,
  reconcileCatalog,
  spreadCents,
} from '../catalog.js'
import { evaluateGates } from '../gates.js'
import {
  KOL_SKU_ID,
  LISTING_SKU_ID,
  NOW,
  OPERATOR_SKU_ID,
  OTHER_VAULT_ADDRESS,
  DAY,
  makeCatalog,
  makeContext,
  makeEntries,
  makeProposal,
  makeRateCards,
  makeRequest,
  makeVault,
  makeVendors,
} from './fixtures.js'

function catalogWithPrice(skuId: string, unitCostUsd: number): VendorCatalog {
  return new VendorCatalog(
    makeVendors(),
    makeEntries().map((entry) =>
      entry.sku.id === skuId ? { ...entry, sku: { ...entry.sku, unitCostUsd } } : entry,
    ),
  )
}

describe('zero markup', () => {
  it('holds when the catalog charges exactly the archived list price', () => {
    const entry = makeCatalog().entry(LISTING_SKU_ID)
    const card = makeRateCards()[0]!
    expect(spreadCents(entry, card)).toBe(0n)
    expect(() => assertNoSpreadOnRecommendedPurchase(entry, card)).not.toThrow()
  })

  it('refuses a positive spread', () => {
    const entry = catalogWithPrice(LISTING_SKU_ID, 349).entry(LISTING_SKU_ID)
    const card = makeRateCards()[0]!
    expect(spreadCents(entry, card)).toBe(5_000n)
    expect(() => assertNoSpreadOnRecommendedPurchase(entry, card)).toThrow(/spread must be exactly zero/)
  })

  it('refuses a negative spread too, because a discount is a cross-subsidy', () => {
    const entry = catalogWithPrice(LISTING_SKU_ID, 249).entry(LISTING_SKU_ID)
    const card = makeRateCards()[0]!
    expect(() => assertNoSpreadOnRecommendedPurchase(entry, card)).toThrow()
  })

  it('refuses a price that cannot be stated in whole cents', () => {
    expect(() => catalogWithPrice(LISTING_SKU_ID, 299.005)).toThrow(/exact number of cents/)
  })

  it('will not let the operator bill itself as a third party', () => {
    const entries = makeEntries().map((entry) =>
      entry.sku.id === OPERATOR_SKU_ID
        ? {
            ...entry,
            pricing: 'third_party_pass_through' as const,
            publishedRateRef: undefined,
            rateCardRef: { vendorId: 'operator', sourceHash: 'x' },
          }
        : entry,
    )
    expect(() => new VendorCatalog(makeVendors(), entries)).toThrow(/as if it were a third party/)
  })

  it('will not accept a pass-through price with no archived rate card behind it', () => {
    const entries = makeEntries().map((entry) =>
      entry.sku.id === LISTING_SKU_ID ? { ...entry, rateCardRef: undefined } : entry,
    )
    expect(() => new VendorCatalog(makeVendors(), entries)).toThrow(/pins no archived rate card/)
  })
})

describe('coin independence', () => {
  it('has no expression capable of quoting one client differently', () => {
    // The control is structural: priceCents takes (skuId, quantity) and no vault.
    expect(VendorCatalog.prototype.priceCents.length).toBe(2)
  })

  it('quotes the same cents to two different vaults', () => {
    const first = evaluateGates(makeContext(makeRequest()))
    const second = evaluateGates(
      makeContext(
        makeRequest({
          proposal: makeProposal({ vault: OTHER_VAULT_ADDRESS }),
          vault: makeVault({ address: OTHER_VAULT_ADDRESS }),
        }),
      ),
    )
    expect(second.quotedCostUsd).toBe(first.quotedCostUsd)
  })
})

describe('daily reconciliation against archived rate cards', () => {
  it('reports no variance when the catalog matches the archive', async () => {
    const variances = await reconcileCatalog(
      makeCatalog(),
      new InMemoryRateCardArchive(makeRateCards()),
      NOW,
    )
    expect(variances).toEqual([])
  })

  it('detects a markup and disables the SKU until a human clears it', async () => {
    const catalog = catalogWithPrice(LISTING_SKU_ID, 399)
    const variances = await reconcileCatalog(
      catalog,
      new InMemoryRateCardArchive(makeRateCards()),
      NOW,
    )
    expect(variances).toHaveLength(1)
    expect(variances[0]?.kind).toBe('markup_detected')
    expect(variances[0]?.spreadCents).toBe(10_000n)

    const repaired = applyReconciliation(catalog, variances)
    const decision = evaluateGates(makeContext(makeRequest(), { catalog: repaired }))
    expect(decision.failedGate).toBe('catalog')
  })

  it('treats a missing rate card as critical, not as an absence of evidence', async () => {
    const variances = await reconcileCatalog(makeCatalog(), new InMemoryRateCardArchive([]), NOW)
    expect(variances.length).toBeGreaterThan(0)
    expect(variances.every((v) => v.severity === 'critical')).toBe(true)
    expect(variances.some((v) => v.kind === 'missing_rate_card')).toBe(true)
  })

  it('treats a stale rate card as critical', async () => {
    const stale = makeRateCards().map((card) => ({ ...card, archivedAtUnix: NOW - 3 * DAY }))
    const variances = await reconcileCatalog(
      makeCatalog(),
      new InMemoryRateCardArchive(stale),
      NOW,
    )
    expect(variances.some((v) => v.kind === 'stale_rate_card')).toBe(true)
  })

  it('flags a rate card that no longer lists the SKU', async () => {
    const cards = makeRateCards().map((card) =>
      card.vendorId === 'kolnet' ? { ...card, listPriceUsd: {} } : card,
    )
    const variances = await reconcileCatalog(
      makeCatalog(),
      new InMemoryRateCardArchive(cards),
      NOW,
    )
    expect(variances.some((v) => v.skuId === KOL_SKU_ID && v.kind === 'sku_absent_from_rate_card')).toBe(
      true,
    )
  })

  it('never reconciles an operator service against a third-party rate card', async () => {
    const variances = await reconcileCatalog(
      makeCatalog(),
      new InMemoryRateCardArchive(makeRateCards()),
      NOW,
    )
    expect(variances.some((v) => v.skuId === OPERATOR_SKU_ID)).toBe(false)
  })
})
