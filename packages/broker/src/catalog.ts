/**
 * THE VENDOR CATALOG AND THE ZERO-MARKUP ACCOUNTING INVARIANT.
 *
 * Two kinds of line item exist and they are priced by different rules:
 *
 *   third_party_pass_through - a good with a PUBLIC list price, bought by the
 *       operator as principal and charged on at COST, zero markup, reconciled
 *       daily against an archived copy of the vendor's rate card.
 *
 *   operator_service - the operator's own labour, billed at a PUBLISHED,
 *       COIN-INDEPENDENT unit rate. Coin independence is structural here:
 *       priceCents() takes no vault argument, so there is no expression in this
 *       module capable of quoting one client a different number than another.
 *
 * THE INVARIANT THAT KILLS SELF-DEALING: the operator never earns a spread on a
 * purchase it recommends. For a pass-through SKU, charged cents minus archived
 * list cents must be exactly zero - not "within tolerance", not "at most zero".
 * A negative spread is refused too, because an operator that can discount can
 * cross-subsidise, and cross-subsidy is what the commitment rule exists to stop.
 */
import type { Sku, Vendor } from '@fee-split-vaults/core'
import { BrokerError, SelfDealingError } from './errors.js'
import { sha256Hex } from './hash.js'
import { exactCentsFromUsd } from './money.js'
import { TIER_ORDER } from './protocol.js'
import type { TierId } from './protocol.js'
import { MAX_SKU_QUANTITY, RATE_CARD_MAX_AGE_SECONDS } from './limits.js'
import type { HttpClient } from './http.js'

/** The operator bills its own labour under this vendor id and no other. */
export const OPERATOR_VENDOR_ID = 'operator'

export type PricingModel = 'third_party_pass_through' | 'operator_service'

/** An archived, content-addressed copy of a vendor's public price list. */
export interface RateCard {
  vendorId: string
  archivedAtUnix: number
  sourceUri: string
  /** sha256 of the exact bytes archived. The catalog pins this. */
  sourceHash: string
  /** skuId -> public list price in USD. */
  listPriceUsd: Record<string, number>
}

export interface CatalogEntry {
  sku: Sku
  pricing: PricingModel
  /** Pass-through only. Pins the archived rate card the price was taken from. */
  rateCardRef?: { vendorId: string; sourceHash: string }
  /** Operator services only. The published, coin-independent rate schedule. */
  publishedRateRef?: string
  enabled: boolean
  /** Deliveries observed for this vendor. Drives probation, not pricing. */
  observedDeliveries: number
  maxQuantity: number
}

export type CatalogVarianceKind =
  | 'missing_rate_card'
  | 'stale_rate_card'
  | 'sku_absent_from_rate_card'
  | 'price_mismatch'
  | 'markup_detected'

export interface CatalogVariance {
  skuId: string
  vendorId: string
  kind: CatalogVarianceKind
  catalogCents: bigint
  rateCardCents?: bigint
  /** Positive means the client would have been overcharged. */
  spreadCents?: bigint
  severity: 'warn' | 'critical'
  detectedAtUnix: number
  note: string
}

export { sha256Hex }

/**
 * THE ANTI-SELF-DEALING ASSERTION. Called on every reconciliation pass and
 * before every disbursement of a pass-through line.
 */
export function assertNoSpreadOnRecommendedPurchase(entry: CatalogEntry, card: RateCard): void {
  if (entry.pricing !== 'third_party_pass_through') {
    throw new SelfDealingError(
      'not_pass_through',
      `sku ${entry.sku.id} is not a pass-through line and has no rate card`,
    )
  }
  const listed = card.listPriceUsd[entry.sku.id]
  if (listed === undefined) {
    throw new SelfDealingError(
      'sku_absent_from_rate_card',
      `sku ${entry.sku.id} does not appear on the archived rate card for ${card.vendorId}`,
    )
  }
  const chargedCents = exactCentsFromUsd(entry.sku.unitCostUsd, `sku ${entry.sku.id} unitCostUsd`)
  const listCents = exactCentsFromUsd(listed, `rate card ${card.vendorId}/${entry.sku.id}`)
  const spread = chargedCents - listCents
  if (spread !== 0n) {
    throw new SelfDealingError(
      'markup_detected',
      `sku ${entry.sku.id} charges ${chargedCents} against a list price of ${listCents}; spread must be exactly zero`,
    )
  }
}

/** Spread in cents. Exists so tests and reports can assert on the number. */
export function spreadCents(entry: CatalogEntry, card: RateCard): bigint {
  const listed = card.listPriceUsd[entry.sku.id]
  if (listed === undefined) {
    throw new SelfDealingError(
      'sku_absent_from_rate_card',
      `sku ${entry.sku.id} is absent from the rate card`,
    )
  }
  return (
    exactCentsFromUsd(entry.sku.unitCostUsd, 'unitCostUsd') -
    exactCentsFromUsd(listed, 'listPriceUsd')
  )
}

function validateSku(sku: Sku): void {
  if (typeof sku.id !== 'string' || sku.id.length === 0) {
    throw new BrokerError('catalog', 'bad_sku', 'sku id must be a non-empty string')
  }
  if (typeof sku.vendorId !== 'string' || sku.vendorId.length === 0) {
    throw new BrokerError('catalog', 'bad_sku', `sku ${sku.id} has no vendorId`)
  }
  if (sku.unitCostUsd <= 0) {
    throw new BrokerError('catalog', 'bad_sku', `sku ${sku.id} must have a positive unit cost`)
  }
  exactCentsFromUsd(sku.unitCostUsd, `sku ${sku.id} unitCostUsd`)
  if (!Array.isArray(sku.availableAtTiers) || sku.availableAtTiers.length === 0) {
    throw new BrokerError('catalog', 'bad_sku', `sku ${sku.id} is available at no tier`)
  }
  for (const tier of sku.availableAtTiers) {
    if (!(TIER_ORDER as readonly string[]).includes(tier)) {
      throw new BrokerError('catalog', 'unknown_tier', `sku ${sku.id} names unknown tier ${tier}`)
    }
  }
  if (sku.predicate === undefined || typeof sku.predicate.kind !== 'string') {
    throw new BrokerError('catalog', 'no_predicate', `sku ${sku.id} has no delivery predicate`)
  }
}

function validateEntry(entry: CatalogEntry): void {
  validateSku(entry.sku)
  if (!Number.isInteger(entry.maxQuantity) || entry.maxQuantity < 1) {
    throw new BrokerError('catalog', 'bad_entry', `sku ${entry.sku.id} has an invalid maxQuantity`)
  }
  if (entry.maxQuantity > MAX_SKU_QUANTITY) {
    throw new BrokerError(
      'catalog',
      'bad_entry',
      `sku ${entry.sku.id} maxQuantity exceeds the broker ceiling of ${MAX_SKU_QUANTITY}`,
    )
  }
  if (!Number.isInteger(entry.observedDeliveries) || entry.observedDeliveries < 0) {
    throw new BrokerError('catalog', 'bad_entry', `sku ${entry.sku.id} has invalid delivery count`)
  }

  if (entry.pricing === 'third_party_pass_through') {
    if (entry.sku.vendorId === OPERATOR_VENDOR_ID) {
      throw new SelfDealingError(
        'operator_as_third_party',
        `sku ${entry.sku.id} bills the operator as if it were a third party`,
      )
    }
    if (entry.rateCardRef === undefined) {
      throw new SelfDealingError(
        'no_rate_card_ref',
        `pass-through sku ${entry.sku.id} pins no archived rate card`,
      )
    }
    if (entry.rateCardRef.vendorId !== entry.sku.vendorId) {
      throw new SelfDealingError(
        'rate_card_vendor_mismatch',
        `sku ${entry.sku.id} pins a rate card belonging to ${entry.rateCardRef.vendorId}`,
      )
    }
    if (entry.publishedRateRef !== undefined) {
      throw new BrokerError(
        'catalog',
        'bad_entry',
        `pass-through sku ${entry.sku.id} must not carry a published operator rate`,
      )
    }
    return
  }

  if (entry.pricing === 'operator_service') {
    if (entry.sku.vendorId !== OPERATOR_VENDOR_ID) {
      throw new BrokerError(
        'catalog',
        'bad_entry',
        `operator-service sku ${entry.sku.id} must be billed under "${OPERATOR_VENDOR_ID}"`,
      )
    }
    if (entry.publishedRateRef === undefined || entry.publishedRateRef.length === 0) {
      throw new BrokerError(
        'catalog',
        'bad_entry',
        `operator-service sku ${entry.sku.id} names no published rate schedule`,
      )
    }
    if (entry.rateCardRef !== undefined) {
      throw new BrokerError(
        'catalog',
        'bad_entry',
        `operator-service sku ${entry.sku.id} must not pin a third-party rate card`,
      )
    }
    return
  }

  throw new BrokerError(
    'catalog',
    'unknown_pricing_model',
    `sku ${entry.sku.id} has unknown pricing model "${String(entry.pricing)}"`,
  )
}

/**
 * The allowlist. A payee that is not in here does not exist as far as the
 * broker is concerned, and there is no code path that constructs a Vendor from
 * a model output, a message, or a proposal field.
 */
export class VendorCatalog {
  readonly #vendors: Map<string, Vendor>
  readonly #entries: Map<string, CatalogEntry>

  constructor(vendors: readonly Vendor[], entries: readonly CatalogEntry[]) {
    this.#vendors = new Map()
    for (const vendor of vendors) {
      if (typeof vendor.id !== 'string' || vendor.id.length === 0) {
        throw new BrokerError('catalog', 'bad_vendor', 'vendor id must be a non-empty string')
      }
      if (this.#vendors.has(vendor.id)) {
        throw new BrokerError('catalog', 'duplicate_vendor', `duplicate vendor id ${vendor.id}`)
      }
      this.#vendors.set(vendor.id, vendor)
    }

    const operator = this.#vendors.get(OPERATOR_VENDOR_ID)
    if (operator !== undefined && !operator.isRelatedParty) {
      throw new BrokerError(
        'catalog',
        'operator_not_flagged',
        'the operator vendor must be flagged as a related party',
      )
    }

    this.#entries = new Map()
    for (const entry of entries) {
      if (this.#entries.has(entry.sku.id)) {
        throw new BrokerError('catalog', 'duplicate_sku', `duplicate sku id ${entry.sku.id}`)
      }
      validateEntry(entry)
      if (!this.#vendors.has(entry.sku.vendorId)) {
        throw new BrokerError(
          'catalog',
          'unknown_vendor',
          `sku ${entry.sku.id} names vendor ${entry.sku.vendorId}, which is not allowlisted`,
        )
      }
      this.#entries.set(entry.sku.id, entry)
    }
  }

  /** Fail closed: an unknown SKU is a refusal, never a lookup miss. */
  entry(skuId: string): CatalogEntry {
    if (typeof skuId !== 'string' || skuId.length === 0 || skuId.length > 128) {
      throw new BrokerError('catalog', 'bad_sku_id', 'sku id is empty or implausibly long')
    }
    const entry = this.#entries.get(skuId)
    if (entry === undefined) {
      throw new BrokerError('catalog', 'unknown_sku', `sku "${skuId}" is not in the catalog`)
    }
    return entry
  }

  vendor(vendorId: string): Vendor {
    const vendor = this.#vendors.get(vendorId)
    if (vendor === undefined) {
      throw new BrokerError(
        'payee_allowlist',
        'unknown_vendor',
        `vendor "${vendorId}" is not allowlisted`,
      )
    }
    return vendor
  }

  has(skuId: string): boolean {
    return this.#entries.has(skuId)
  }

  get skuIds(): string[] {
    return [...this.#entries.keys()]
  }

  get vendorIds(): string[] {
    return [...this.#vendors.keys()]
  }

  get payoutAddresses(): string[] {
    const out: string[] = []
    for (const vendor of this.#vendors.values()) {
      if (vendor.payoutAddress !== undefined) out.push(vendor.payoutAddress.toLowerCase())
    }
    return out
  }

  entriesForTier(tier: TierId): CatalogEntry[] {
    return [...this.#entries.values()].filter(
      (e) => e.enabled && e.sku.availableAtTiers.includes(tier),
    )
  }

  /**
   * COIN INDEPENDENCE IS STRUCTURAL: this function takes no vault, so no client
   * can be quoted a different price than another for the same SKU. Do not add a
   * vault parameter; that is the whole control.
   */
  priceCents(skuId: string, quantity: number): bigint {
    const entry = this.entry(skuId)
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new BrokerError('catalog', 'bad_quantity', `quantity must be a positive integer`)
    }
    if (quantity > entry.maxQuantity) {
      throw new BrokerError(
        'catalog',
        'quantity_over_max',
        `quantity ${quantity} exceeds maxQuantity ${entry.maxQuantity} for ${skuId}`,
      )
    }
    const unit = exactCentsFromUsd(entry.sku.unitCostUsd, `sku ${skuId} unitCostUsd`)
    return unit * BigInt(quantity)
  }

  /** Immutable update used by the daily reconciliation to fail a SKU closed. */
  withDisabled(skuIds: readonly string[]): VendorCatalog {
    const disable = new Set(skuIds)
    const entries = [...this.#entries.values()].map((entry) =>
      disable.has(entry.sku.id) ? { ...entry, enabled: false } : entry,
    )
    return new VendorCatalog([...this.#vendors.values()], entries)
  }

  /** Immutable update used when a delivery outcome changes vendor standing. */
  withVendor(vendor: Vendor): VendorCatalog {
    const vendors = [...this.#vendors.values()].map((v) => (v.id === vendor.id ? vendor : v))
    return new VendorCatalog(vendors, [...this.#entries.values()])
  }
}

/** Where archived rate cards live. Daily reconciliation reads through this. */
export interface RateCardArchive {
  latest(vendorId: string): Promise<RateCard | null>
  archive(card: RateCard): Promise<RateCard>
}

export interface HttpRateCardFetcherOptions {
  /** Returns the vendor's public price list verbatim. */
  endpointFor: (vendorId: string) => string
  client: HttpClient
  store: RateCardArchive
  timeoutMs?: number
}

/**
 * Fetches a vendor's public price list, content-addresses it, and archives it.
 * Anything malformed is dropped rather than archived, so a vendor cannot move a
 * price by serving junk.
 */
export class HttpRateCardFetcher {
  readonly #options: HttpRateCardFetcherOptions

  constructor(options: HttpRateCardFetcherOptions) {
    this.#options = options
  }

  async refresh(vendorId: string, nowUnix: number): Promise<RateCard> {
    const url = this.#options.endpointFor(vendorId)
    const response = await this.#options.client({
      method: 'GET',
      url,
      timeoutMs: this.#options.timeoutMs ?? 5_000,
    })
    if (!response.ok) {
      throw new BrokerError(
        'catalog',
        'rate_card_fetch_failed',
        `rate card for ${vendorId} returned ${response.status}`,
      )
    }
    const raw = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new BrokerError('catalog', 'rate_card_malformed', `rate card for ${vendorId} is not JSON`)
    }
    const prices = (parsed as { listPriceUsd?: unknown }).listPriceUsd
    if (typeof prices !== 'object' || prices === null || Array.isArray(prices)) {
      throw new BrokerError(
        'catalog',
        'rate_card_malformed',
        `rate card for ${vendorId} has no listPriceUsd map`,
      )
    }
    const listPriceUsd: Record<string, number> = {}
    for (const [skuId, price] of Object.entries(prices as Record<string, unknown>)) {
      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
        throw new BrokerError(
          'catalog',
          'rate_card_malformed',
          `rate card for ${vendorId} prices ${skuId} with a non-price`,
        )
      }
      listPriceUsd[skuId] = price
    }
    const card: RateCard = {
      vendorId,
      archivedAtUnix: nowUnix,
      sourceUri: url,
      sourceHash: sha256Hex(raw),
      listPriceUsd,
    }
    return this.#options.store.archive(card)
  }
}

export class InMemoryRateCardArchive implements RateCardArchive {
  readonly #cards = new Map<string, RateCard>()

  constructor(seed: readonly RateCard[] = []) {
    for (const card of seed) this.#cards.set(card.vendorId, card)
  }

  async latest(vendorId: string): Promise<RateCard | null> {
    return this.#cards.get(vendorId) ?? null
  }

  async archive(card: RateCard): Promise<RateCard> {
    this.#cards.set(card.vendorId, card)
    return card
  }
}

/**
 * Daily reconciliation. Every pass-through SKU is compared to the archived list
 * price. Any variance - a missing card, a stale card, an absent SKU, a price
 * that moved - is CRITICAL and the SKU is disabled until a human clears it,
 * because an unreconciled price is a price the operator could be marking up.
 */
export async function reconcileCatalog(
  catalog: VendorCatalog,
  archive: RateCardArchive,
  nowUnix: number,
): Promise<CatalogVariance[]> {
  const variances: CatalogVariance[] = []
  const cards = new Map<string, RateCard | null>()

  for (const skuId of catalog.skuIds) {
    const entry = catalog.entry(skuId)
    if (entry.pricing !== 'third_party_pass_through') continue

    const vendorId = entry.sku.vendorId
    if (!cards.has(vendorId)) {
      cards.set(vendorId, await archive.latest(vendorId))
    }
    const card = cards.get(vendorId) ?? null
    const catalogCents = exactCentsFromUsd(entry.sku.unitCostUsd, `sku ${skuId} unitCostUsd`)

    if (card === null) {
      variances.push({
        skuId,
        vendorId,
        kind: 'missing_rate_card',
        catalogCents,
        severity: 'critical',
        detectedAtUnix: nowUnix,
        note: 'no archived rate card on file',
      })
      continue
    }
    if (card.archivedAtUnix < nowUnix - RATE_CARD_MAX_AGE_SECONDS) {
      variances.push({
        skuId,
        vendorId,
        kind: 'stale_rate_card',
        catalogCents,
        severity: 'critical',
        detectedAtUnix: nowUnix,
        note: `rate card archived ${nowUnix - card.archivedAtUnix}s ago`,
      })
      continue
    }
    if (entry.rateCardRef !== undefined && entry.rateCardRef.sourceHash !== card.sourceHash) {
      // The pinned card moved. Not automatically a markup, but the price the
      // catalog was built against no longer exists, so it must be re-approved.
      variances.push({
        skuId,
        vendorId,
        kind: 'price_mismatch',
        catalogCents,
        severity: 'critical',
        detectedAtUnix: nowUnix,
        note: 'archived rate card hash differs from the pinned reference',
      })
      continue
    }

    const listed = card.listPriceUsd[skuId]
    if (listed === undefined) {
      variances.push({
        skuId,
        vendorId,
        kind: 'sku_absent_from_rate_card',
        catalogCents,
        severity: 'critical',
        detectedAtUnix: nowUnix,
        note: 'sku no longer appears on the vendor rate card',
      })
      continue
    }
    const rateCardCents = exactCentsFromUsd(listed, `rate card ${vendorId}/${skuId}`)
    const spread = catalogCents - rateCardCents
    if (spread !== 0n) {
      variances.push({
        skuId,
        vendorId,
        kind: spread > 0n ? 'markup_detected' : 'price_mismatch',
        catalogCents,
        rateCardCents,
        spreadCents: spread,
        severity: 'critical',
        detectedAtUnix: nowUnix,
        note:
          spread > 0n
            ? 'catalog charges above the vendor list price'
            : 'catalog charges below the vendor list price',
      })
    }
  }

  return variances
}

/** Applies a reconciliation result by disabling every SKU that varied. */
export function applyReconciliation(
  catalog: VendorCatalog,
  variances: readonly CatalogVariance[],
): VendorCatalog {
  return catalog.withDisabled(variances.map((v) => v.skuId))
}
