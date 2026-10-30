/**
 * Daily reconciliation, the snapshot archive, and the historical audit.
 */
import { describe, expect, it } from 'vitest'
import { Catalog } from '../catalog.js'
import {
  auditHistoricalPurchase,
  InMemoryCatalogSnapshotArchive,
  InMemoryRateCardArchive,
  snapshotCatalog,
} from '../archive.js'
import {
  applyDrift,
  assertNoDrift,
  computeDrifts,
  RATE_CARD_MAX_AGE_SECONDS,
  reconcileCatalogDaily,
  runDailyReconciliation,
} from '../reconcile.js'
import { PriceBookViolation } from '../errors.js'
import {
  cardFor,
  cleanCatalog,
  OPERATOR_VENDOR,
  passThroughEntry,
  publicProvenance,
  quoteCardFor,
  scheduleFor,
  serviceEntry,
  T0_UNIX,
  THIRD_PARTY_VENDOR,
} from './fixtures.js'

const DAY = 86_400

describe('a catalog that reconciles', () => {
  it('reports no drift on the day the cards were archived', async () => {
    const { catalog, card } = cleanCatalog()
    const archive = new InMemoryRateCardArchive([card])
    const result = await reconcileCatalogDaily(catalog, archive, T0_UNIX)
    expect(result.drifts).toEqual([])
    expect(result.catalog.entry('vendorx_thing').enabled).toBe(true)
  })
})

describe('drift disables the SKU', () => {
  it('flags a vendor price that moved, and disables the line', async () => {
    const { catalog } = cleanCatalog()
    // The vendor republished at a higher price. The catalog still says 299.
    const moved = cardFor('vendorx', { vendorx_thing: 349 })
    const archive = new InMemoryRateCardArchive([moved])
    const result = await reconcileCatalogDaily(catalog, archive, T0_UNIX)
    // The pinned hash no longer matches, which is caught before the price
    // comparison: the price this SKU was approved against no longer exists.
    expect(result.drifts).toHaveLength(1)
    expect(result.drifts[0]?.kind).toBe('rate_card_hash_moved')
    expect(result.catalog.entry('vendorx_thing').enabled).toBe(false)
    expect(result.catalog.entry('vendorx_thing').disabledReason).toMatch(/human re-approval/)
  })

  it('flags a markup when the pin still matches but the catalog charges more', () => {
    const card = cardFor('vendorx', { vendorx_thing: 299 })
    const catalog = new Catalog({
      vendors: [OPERATOR_VENDOR, THIRD_PARTY_VENDOR],
      entries: [passThroughEntry({ unitCostUsd: 399, rateCardHash: card.sourceHash })],
      rateCards: [card],
      schedules: [],
    })
    const drifts = computeDrifts(catalog, () => card, T0_UNIX)
    expect(drifts).toHaveLength(1)
    expect(drifts[0]).toMatchObject({
      kind: 'markup_detected',
      catalogCents: 39_900n,
      referenceCents: 29_900n,
      spreadCents: 10_000n,
      severity: 'critical',
    })
  })

  it('flags a discount too', () => {
    const card = cardFor('vendorx', { vendorx_thing: 299 })
    const catalog = new Catalog({
      vendors: [OPERATOR_VENDOR, THIRD_PARTY_VENDOR],
      entries: [passThroughEntry({ unitCostUsd: 199, rateCardHash: card.sourceHash })],
      rateCards: [card],
      schedules: [],
    })
    const drifts = computeDrifts(catalog, () => card, T0_UNIX)
    expect(drifts[0]?.kind).toBe('discount_detected')
    expect(drifts[0]?.spreadCents).toBe(-10_000n)
  })

  it('flags a stale rate card at 26 hours and one second', () => {
    const { catalog, card } = cleanCatalog()
    const justInside = card.archivedAtUnix + RATE_CARD_MAX_AGE_SECONDS
    expect(computeDrifts(catalog, () => card, justInside)).toEqual([])
    const justOutside = justInside + 1
    const drifts = computeDrifts(catalog, () => card, justOutside)
    expect(drifts[0]?.kind).toBe('stale_rate_card')
  })

  it('flags a missing rate card', () => {
    const { catalog } = cleanCatalog()
    const drifts = computeDrifts(catalog, () => null, T0_UNIX)
    expect(drifts[0]?.kind).toBe('missing_rate_card')
  })

  it('flags a rate card whose seal does not match its contents', () => {
    const { catalog, card } = cleanCatalog()
    const tampered = { ...card, listPriceUsd: { vendorx_thing: 199 } }
    const drifts = computeDrifts(catalog, () => tampered, T0_UNIX)
    expect(drifts[0]?.kind).toBe('unsealed_rate_card')
  })

  it('flags a per-campaign quote with no countersignature', () => {
    // An uncountersigned quote is a rumour, and a rumour is not a price the
    // operator can charge on at cost.
    const unsigned = quoteCardFor('vendorx', { vendorx_thing: 299 })
    const catalog = new Catalog({
      vendors: [OPERATOR_VENDOR, THIRD_PARTY_VENDOR],
      entries: [passThroughEntry({ unitCostUsd: 299, rateCardHash: unsigned.sourceHash })],
      rateCards: [unsigned],
      schedules: [],
    })
    expect(computeDrifts(catalog, () => unsigned, T0_UNIX)[0]?.kind).toBe(
      'missing_countersignature',
    )

    const signed = quoteCardFor('vendorx', { vendorx_thing: 299 }, '0xsig')
    const withSigned = new Catalog({
      vendors: [OPERATOR_VENDOR, THIRD_PARTY_VENDOR],
      entries: [passThroughEntry({ unitCostUsd: 299, rateCardHash: signed.sourceHash })],
      rateCards: [signed],
      schedules: [],
    })
    expect(computeDrifts(withSigned, () => signed, T0_UNIX)).toEqual([])
  })

  it('flags a price whose provenance has aged out, before it looks at the card', () => {
    const card = cardFor('vendorx', { vendorx_thing: 299 })
    const catalog = new Catalog({
      vendors: [OPERATOR_VENDOR, THIRD_PARTY_VENDOR],
      entries: [
        passThroughEntry({
          unitCostUsd: 299,
          rateCardHash: card.sourceHash,
          provenance: publicProvenance({ maxAgeSeconds: DAY }),
        }),
      ],
      rateCards: [card],
      schedules: [],
    })
    const drifts = computeDrifts(catalog, () => card, T0_UNIX + DAY + 1)
    expect(drifts).toHaveLength(1)
    expect(drifts[0]?.kind).toBe('provenance_expired')
  })

  it('flags an operator service that drifted from its published rate', () => {
    const catalog = new Catalog({
      vendors: [OPERATOR_VENDOR],
      entries: [serviceEntry({ unitCostUsd: 60 })],
      rateCards: [],
      schedules: [scheduleFor({ operator_thing: 45 })],
    })
    const drifts = computeDrifts(catalog, () => null, T0_UNIX)
    expect(drifts[0]).toMatchObject({
      kind: 'published_rate_mismatch',
      catalogCents: 6_000n,
      referenceCents: 4_500n,
      spreadCents: 1_500n,
    })
  })

  it('checks disabled SKUs too, so a re-enable never looks clean by accident', () => {
    const card = cardFor('vendorx', { vendorx_thing: 299 })
    const catalog = new Catalog({
      vendors: [OPERATOR_VENDOR, THIRD_PARTY_VENDOR],
      entries: [
        passThroughEntry({ unitCostUsd: 499, rateCardHash: card.sourceHash, enabled: false }),
      ],
      rateCards: [card],
      schedules: [],
    })
    expect(computeDrifts(catalog, () => card, T0_UNIX)).toHaveLength(1)
  })
})

describe('assertNoDrift', () => {
  it('names every drifted SKU in one throw', () => {
    const { catalog } = cleanCatalog()
    const drifts = computeDrifts(catalog, () => null, T0_UNIX)
    expect(() => assertNoDrift(drifts)).toThrow(PriceBookViolation)
    expect(() => assertNoDrift(drifts)).toThrow(/vendorx_thing/)
  })

  it('passes silently on an empty list', () => {
    expect(() => assertNoDrift([])).not.toThrow()
  })
})

describe('applyDrift', () => {
  it('returns the same catalog when nothing drifted', () => {
    const { catalog } = cleanCatalog()
    expect(applyDrift(catalog, [])).toBe(catalog)
  })
})

describe('snapshots and the historical audit', () => {
  it('seals a snapshot that is stable for identical content', () => {
    const { catalog } = cleanCatalog()
    const a = snapshotCatalog(catalog, T0_UNIX)
    const b = snapshotCatalog(catalog, T0_UNIX)
    expect(a.snapshotId).toBe(b.snapshotId)
    expect(a.takenOnDate).toBe('2026-09-06')
    expect(a.lines.map((line) => line.skuId)).toEqual(['operator_thing', 'vendorx_thing'])
  })

  it('changes the snapshot id when a price changes', () => {
    const { catalog, card, schedule } = cleanCatalog()
    const repriced = new Catalog({
      vendors: catalog.vendors,
      entries: catalog.entries.map((entry) =>
        entry.sku.id === 'vendorx_thing'
          ? { ...entry, sku: { ...entry.sku, unitCostUsd: 399 } }
          : entry,
      ),
      rateCards: [card],
      schedules: [schedule],
    })
    expect(snapshotCatalog(repriced, T0_UNIX).snapshotId).not.toBe(
      snapshotCatalog(catalog, T0_UNIX).snapshotId,
    )
  })

  it('audits a purchase against the price in force on the day it happened', async () => {
    const { catalog, card, schedule } = cleanCatalog()
    const snapshots = new InMemoryCatalogSnapshotArchive()
    await snapshots.take(snapshotCatalog(catalog, T0_UNIX))

    // A week later the vendor raised the price and the catalog followed.
    const laterCard = cardFor('vendorx', { vendorx_thing: 399 })
    const later = new Catalog({
      vendors: catalog.vendors,
      entries: [
        passThroughEntry({ unitCostUsd: 399, rateCardHash: laterCard.sourceHash }),
        serviceEntry({ unitCostUsd: 45 }),
      ],
      rateCards: [laterCard],
      schedules: [schedule],
    })
    await snapshots.take(snapshotCatalog(later, T0_UNIX + 7 * DAY))
    expect(card.sourceHash).not.toBe(laterCard.sourceHash)

    // The old purchase is still audited against the OLD price.
    const old = await auditHistoricalPurchase(snapshots, {
      skuId: 'vendorx_thing',
      quantity: 1,
      chargedCents: 29_900n,
      disbursedAtUnix: T0_UNIX + DAY,
    })
    expect(old.outcome).toBe('match')
    expect(old.priceInForceCents).toBe(29_900n)

    // And a purchase made after the change is audited against the new one.
    const recent = await auditHistoricalPurchase(snapshots, {
      skuId: 'vendorx_thing',
      quantity: 2,
      chargedCents: 79_800n,
      disbursedAtUnix: T0_UNIX + 8 * DAY,
    })
    expect(recent.outcome).toBe('match')
  })

  it('reports a mismatch with the exact delta', async () => {
    const { catalog } = cleanCatalog()
    const snapshots = new InMemoryCatalogSnapshotArchive([snapshotCatalog(catalog, T0_UNIX)])
    const audit = await auditHistoricalPurchase(snapshots, {
      skuId: 'vendorx_thing',
      quantity: 1,
      chargedCents: 34_900n,
      disbursedAtUnix: T0_UNIX + 60,
    })
    expect(audit.outcome).toBe('amount_mismatch')
    expect(audit.deltaCents).toBe(5_000n)
    expect(audit.note).toMatch(/\$50\.00 out/)
  })

  it('refuses to bless a purchase made before any snapshot existed', async () => {
    const { catalog } = cleanCatalog()
    const snapshots = new InMemoryCatalogSnapshotArchive([snapshotCatalog(catalog, T0_UNIX)])
    const audit = await auditHistoricalPurchase(snapshots, {
      skuId: 'vendorx_thing',
      quantity: 1,
      chargedCents: 29_900n,
      disbursedAtUnix: T0_UNIX - 1,
    })
    expect(audit.outcome).toBe('no_snapshot_in_force')
    expect(audit.note).toMatch(/unauditable purchase is an unproven one/)
  })

  it('reports a SKU that did not exist on the day of the purchase', async () => {
    const { catalog } = cleanCatalog()
    const snapshots = new InMemoryCatalogSnapshotArchive([snapshotCatalog(catalog, T0_UNIX)])
    const audit = await auditHistoricalPurchase(snapshots, {
      skuId: 'vendorx_ghost',
      quantity: 1,
      chargedCents: 100n,
      disbursedAtUnix: T0_UNIX + 60,
    })
    expect(audit.outcome).toBe('sku_absent_from_snapshot')
  })
})

describe('the whole daily job', () => {
  it('disables what drifted and snapshots what is left', async () => {
    const { catalog } = cleanCatalog()
    const rateCards = new InMemoryRateCardArchive([])
    const snapshots = new InMemoryCatalogSnapshotArchive()
    const result = await runDailyReconciliation(catalog, rateCards, snapshots, T0_UNIX)

    expect(result.drifts[0]?.kind).toBe('missing_rate_card')
    // The snapshot records the menu ACTUALLY in force, not the one we wanted.
    const line = result.snapshot.lines.find((entry) => entry.skuId === 'vendorx_thing')
    expect(line?.enabled).toBe(false)
    expect(await snapshots.byId(result.snapshot.snapshotId)).not.toBeNull()
  })
})

describe('the rate card archive', () => {
  it('returns the card in force at a past instant, not the newest one', async () => {
    const first = cardFor('vendorx', { vendorx_thing: 299 }, T0_UNIX)
    const second = cardFor('vendorx', { vendorx_thing: 399 }, T0_UNIX + 7 * DAY)
    const archive = new InMemoryRateCardArchive([first])
    await archive.archive(second)

    expect((await archive.latest('vendorx'))?.listPriceUsd.vendorx_thing).toBe(399)
    expect((await archive.asOf('vendorx', T0_UNIX + DAY))?.listPriceUsd.vendorx_thing).toBe(299)
    expect((await archive.asOf('vendorx', T0_UNIX + 8 * DAY))?.listPriceUsd.vendorx_thing).toBe(399)
    expect(await archive.asOf('vendorx', T0_UNIX - 1)).toBeNull()
    expect(await archive.history('vendorx')).toHaveLength(2)
  })

  it('refuses to archive an unsealed card', async () => {
    const archive = new InMemoryRateCardArchive()
    const card = cardFor('vendorx', { vendorx_thing: 299 })
    await expect(archive.archive({ ...card, listPriceUsd: { vendorx_thing: 1 } })).rejects.toThrow(
      /seal_mismatch/,
    )
  })
})
