/**
 * Synthetic catalogs for the invariant suite.
 *
 * The shipped data is exercised separately in data.spec.ts. These fixtures
 * exist so a test can construct the SKU that must not be allowed to exist -
 * the one with a markup on a recommended item - without editing data/.
 */
import { Catalog } from '../catalog.js'
import { sealHash } from '../hash.js'
import type {
  CatalogEntry,
  OperatorRateSchedule,
  PriceProvenance,
  RateCard,
  VendorRecord,
} from '../types.js'
import type { TierId } from '../protocol.js'

export const T0_UNIX = 1_788_652_800 // 2026-09-06T00:00:00Z

export function seal<T extends Record<string, unknown>>(document: T, field: string): T {
  return { ...document, [field]: sealHash(document, field) }
}

export function sealCard(card: Omit<RateCard, 'sourceHash'> & { sourceHash?: string }): RateCard {
  const base = { ...card, sourceHash: '' } as unknown as Record<string, unknown>
  return seal(base, 'sourceHash') as unknown as RateCard
}

export function sealSchedule(
  schedule: Omit<OperatorRateSchedule, 'sealHash'> & { sealHash?: string },
): OperatorRateSchedule {
  const base = { ...schedule, sealHash: '' } as unknown as Record<string, unknown>
  return seal(base, 'sealHash') as unknown as OperatorRateSchedule
}

export function publicProvenance(overrides: Partial<PriceProvenance> = {}): PriceProvenance {
  return {
    kind: 'vendor_public_pricing',
    sourceUri: 'https://vendor.test/pricing',
    observedAtUnix: T0_UNIX,
    observedOnDate: '2026-09-06',
    maxAgeSeconds: 604_800,
    ...overrides,
  }
}

export function operatorProvenance(overrides: Partial<PriceProvenance> = {}): PriceProvenance {
  return {
    kind: 'operator_published_rate',
    sourceUri: 'https://operator.test/rates',
    observedAtUnix: T0_UNIX,
    observedOnDate: '2026-09-06',
    maxAgeSeconds: 7_776_000,
    ...overrides,
  }
}

export const OPERATOR_VENDOR: VendorRecord = {
  id: 'operator',
  displayName: 'Test operator',
  isRelatedParty: true,
  reliabilityScore: 1,
  enabled: true,
}

export const THIRD_PARTY_VENDOR: VendorRecord = {
  id: 'vendorx',
  displayName: 'Vendor X',
  isRelatedParty: false,
  reliabilityScore: 0.7,
  enabled: true,
}

export interface PassThroughOptions {
  id?: string
  vendorId?: string
  unitCostUsd: number
  tiers?: TierId[]
  enabled?: boolean
  minViableQuantity?: number
  maxQuantity?: number
  category?: 'listing' | 'boost' | 'trending' | 'kol'
  rateCardHash?: string
  provenance?: PriceProvenance
}

export function passThroughEntry(options: PassThroughOptions): CatalogEntry {
  const id = options.id ?? 'vendorx_thing'
  const entry: CatalogEntry = {
    sku: {
      id,
      vendorId: options.vendorId ?? THIRD_PARTY_VENDOR.id,
      description: 'A third-party good bought at cost.',
      unitCostUsd: options.unitCostUsd,
      category: options.category ?? 'listing',
      predicate: {
        kind: 'eti_listing',
        verifyAtOffsetsSeconds: [3600, 86_400],
        params: { chain: '4663', pairSource: 'test', expectFieldPresent: 'info' },
      },
      availableAtTiers: options.tiers ?? ['T1', 'T2', 'T3'],
    },
    pricing: 'third_party_pass_through',
    enabled: options.enabled ?? true,
    observedDeliveries: 0,
    maxQuantity: options.maxQuantity ?? 4,
    minViableQuantity: options.minViableQuantity ?? 1,
    priceProvenance: options.provenance ?? publicProvenance(),
  }
  if (options.rateCardHash !== undefined) {
    entry.rateCardRef = { vendorId: entry.sku.vendorId, sourceHash: options.rateCardHash }
  }
  if (!entry.enabled) entry.disabledReason = 'disabled by fixture'
  return entry
}

export interface ServiceOptions {
  id?: string
  unitCostUsd: number
  tiers?: TierId[]
  scheduleRef?: string
  minViableQuantity?: number
  maxQuantity?: number
  category?: 'moderation' | 'build' | 'creative'
}

export function serviceEntry(options: ServiceOptions): CatalogEntry {
  return {
    sku: {
      id: options.id ?? 'operator_thing',
      vendorId: 'operator',
      description: "The operator's own labour at a published rate.",
      unitCostUsd: options.unitCostUsd,
      category: options.category ?? 'moderation',
      predicate: {
        kind: 'manual_attestation',
        verifyAtOffsetsSeconds: [86_400],
        params: { evidenceKind: 'shift_log_hash' },
      },
      availableAtTiers: options.tiers ?? ['T1', 'T2', 'T3'],
    },
    pricing: 'operator_service',
    publishedRateRef: options.scheduleRef ?? 'test-rates@v1',
    enabled: true,
    observedDeliveries: 0,
    maxQuantity: options.maxQuantity ?? 10,
    minViableQuantity: options.minViableQuantity ?? 1,
    priceProvenance: operatorProvenance(),
  }
}

export function scheduleFor(unitRateUsd: Record<string, number>): OperatorRateSchedule {
  return sealSchedule({
    ref: 'test-rates@v1',
    version: 1,
    publishedAtUnix: T0_UNIX,
    publishedOnDate: '2026-09-06',
    publicUri: 'https://operator.test/rates',
    unitRateUsd,
  })
}

export function cardFor(
  vendorId: string,
  listPriceUsd: Record<string, number>,
  archivedAtUnix: number = T0_UNIX,
): RateCard {
  return sealCard({
    vendorId,
    archivedAtUnix,
    sourceUri: `https://${vendorId}.test/pricing`,
    kind: 'vendor_public_pricing',
    listPriceUsd,
  })
}

/** A per-campaign quote. Omit `countersig` to build the unsigned-quote case. */
export function quoteCardFor(
  vendorId: string,
  listPriceUsd: Record<string, number>,
  countersig?: string,
): RateCard {
  const base: Record<string, unknown> = {
    vendorId,
    archivedAtUnix: T0_UNIX,
    sourceUri: `operator-archive://quotes/${vendorId}`,
    kind: 'vendor_countersigned_quote',
    listPriceUsd,
  }
  if (countersig !== undefined) base.vendorCountersig = countersig
  return sealCard(base as unknown as Omit<RateCard, 'sourceHash'>)
}

/**
 * A small, correct catalog: one pass-through good at cost, one operator service
 * at its published rate. Every invariant holds, so a test can break exactly one
 * thing and watch it fail.
 */
export function cleanCatalog(): {
  catalog: Catalog
  card: RateCard
  schedule: OperatorRateSchedule
} {
  const card = cardFor('vendorx', { vendorx_thing: 299 })
  const schedule = scheduleFor({ operator_thing: 45 })
  const catalog = new Catalog({
    vendors: [OPERATOR_VENDOR, THIRD_PARTY_VENDOR],
    entries: [
      passThroughEntry({ unitCostUsd: 299, rateCardHash: card.sourceHash }),
      serviceEntry({ unitCostUsd: 45 }),
    ],
    rateCards: [card],
    schedules: [schedule],
  })
  return { catalog, card, schedule }
}
