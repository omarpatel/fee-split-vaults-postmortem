/**
 * The loaded, validated catalog.
 *
 * This object is the payee and price allowlist. Nothing constructs a vendor or
 * a price from a model output, a chat message, or a proposal field; the planner
 * selects a SKU id and this object supplies the number.
 *
 * COIN INDEPENDENCE IS STRUCTURAL. `priceCents` takes no vault argument. There
 * is therefore no expression in this module capable of quoting one client a
 * different number than another, which is a stronger guarantee than a policy
 * saying we would not. Do not add a vault parameter; that is the whole control.
 */
import { CatalogError } from './errors.js'
import { exactCentsFromUsd } from './money.js'
import { OPERATOR_VENDOR_ID } from './pricebook.js'
import type { TierId } from './protocol.js'
import type { CatalogEntry, OperatorRateSchedule, RateCard, VendorRecord } from './types.js'

export interface CatalogInput {
  vendors: readonly VendorRecord[]
  entries: readonly CatalogEntry[]
  /** vendorId -> the archived card the catalog was priced against. */
  rateCards: readonly RateCard[]
  schedules: readonly OperatorRateSchedule[]
}

export class Catalog {
  readonly #vendors: Map<string, VendorRecord>
  readonly #entries: Map<string, CatalogEntry>
  readonly #rateCards: Map<string, RateCard>
  readonly #schedules: Map<string, OperatorRateSchedule>

  constructor(input: CatalogInput) {
    this.#vendors = new Map()
    for (const vendor of input.vendors) {
      if (this.#vendors.has(vendor.id)) {
        throw new CatalogError('load', 'duplicate_vendor', `duplicate vendor id ${vendor.id}`)
      }
      this.#vendors.set(vendor.id, vendor)
    }

    const operator = this.#vendors.get(OPERATOR_VENDOR_ID)
    if (operator === undefined) {
      throw new CatalogError(
        'load',
        'no_operator_vendor',
        `the catalog must define the "${OPERATOR_VENDOR_ID}" vendor; operator services have nowhere else to be billed`,
      )
    }
    if (!operator.isRelatedParty) {
      throw new CatalogError(
        'load',
        'operator_not_flagged',
        'the operator vendor must be flagged as a related party; it sells to a budget it directs',
      )
    }

    this.#rateCards = new Map()
    for (const card of input.rateCards) {
      if (this.#rateCards.has(card.vendorId)) {
        throw new CatalogError(
          'load',
          'duplicate_rate_card',
          `two rate cards in force for vendor ${card.vendorId}`,
        )
      }
      if (!this.#vendors.has(card.vendorId)) {
        throw new CatalogError(
          'load',
          'rate_card_unknown_vendor',
          `rate card names vendor ${card.vendorId}, which is not allowlisted`,
        )
      }
      this.#rateCards.set(card.vendorId, card)
    }

    this.#schedules = new Map()
    for (const schedule of input.schedules) {
      if (this.#schedules.has(schedule.ref)) {
        throw new CatalogError(
          'load',
          'duplicate_schedule',
          `two published rate schedules share ref ${schedule.ref}`,
        )
      }
      this.#schedules.set(schedule.ref, schedule)
    }

    this.#entries = new Map()
    for (const entry of input.entries) {
      if (this.#entries.has(entry.sku.id)) {
        throw new CatalogError('load', 'duplicate_sku', `duplicate sku id ${entry.sku.id}`)
      }
      if (!this.#vendors.has(entry.sku.vendorId)) {
        throw new CatalogError(
          'load',
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
      throw new CatalogError('load', 'bad_sku_id', 'sku id is empty or implausibly long')
    }
    const entry = this.#entries.get(skuId)
    if (entry === undefined) {
      throw new CatalogError('load', 'unknown_sku', `sku "${skuId}" is not in the catalog`)
    }
    return entry
  }

  vendor(vendorId: string): VendorRecord {
    const vendor = this.#vendors.get(vendorId)
    if (vendor === undefined) {
      throw new CatalogError('load', 'unknown_vendor', `vendor "${vendorId}" is not allowlisted`)
    }
    return vendor
  }

  /** The archived card the catalog was priced against, if this is pass-through. */
  rateCard(vendorId: string): RateCard | undefined {
    return this.#rateCards.get(vendorId)
  }

  schedule(ref: string): OperatorRateSchedule | undefined {
    return this.#schedules.get(ref)
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

  get entries(): CatalogEntry[] {
    return [...this.#entries.values()]
  }

  get vendors(): VendorRecord[] {
    return [...this.#vendors.values()]
  }

  get rateCards(): RateCard[] {
    return [...this.#rateCards.values()]
  }

  get schedules(): OperatorRateSchedule[] {
    return [...this.#schedules.values()]
  }

  /**
   * The menu at a tier. Disabled SKUs and disabled vendors are absent, not
   * greyed out: a menu that shows what cannot be bought is the failure mode.
   */
  entriesForTier(tier: TierId): CatalogEntry[] {
    return this.entries.filter((entry) => {
      if (!entry.enabled) return false
      if (!entry.sku.availableAtTiers.includes(tier)) return false
      const vendor = this.#vendors.get(entry.sku.vendorId)
      return vendor !== undefined && vendor.enabled
    })
  }

  /** Every SKU a client at this tier can actually be offered, by id. */
  offeredSkuIds(tier: TierId): string[] {
    return this.entriesForTier(tier).map((entry) => entry.sku.id)
  }

  /**
   * The price. No vault argument, deliberately - see the file header.
   */
  priceCents(skuId: string, quantity: number): bigint {
    const entry = this.entry(skuId)
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new CatalogError('load', 'bad_quantity', 'quantity must be a positive integer')
    }
    if (quantity > entry.maxQuantity) {
      throw new CatalogError(
        'load',
        'quantity_over_max',
        `quantity ${quantity} exceeds maxQuantity ${entry.maxQuantity} for ${skuId}`,
      )
    }
    const unit = exactCentsFromUsd(entry.sku.unitCostUsd, `sku ${skuId} unitCostUsd`)
    return unit * BigInt(quantity)
  }

  /** Immutable update used by the daily reconciliation to fail a SKU closed. */
  withDisabled(skuIds: readonly string[], reason: string): Catalog {
    const disable = new Set(skuIds)
    const entries = this.entries.map((entry) =>
      disable.has(entry.sku.id) && entry.enabled
        ? { ...entry, enabled: false, disabledReason: reason }
        : entry,
    )
    return new Catalog({
      vendors: this.vendors,
      entries,
      rateCards: this.rateCards,
      schedules: this.schedules,
    })
  }

  /** Immutable update used when a delivery outcome changes vendor standing. */
  withVendor(vendor: VendorRecord): Catalog {
    if (!this.#vendors.has(vendor.id)) {
      throw new CatalogError('load', 'unknown_vendor', `vendor "${vendor.id}" is not allowlisted`)
    }
    return new Catalog({
      vendors: this.vendors.map((v) => (v.id === vendor.id ? vendor : v)),
      entries: this.entries,
      rateCards: this.rateCards,
      schedules: this.schedules,
    })
  }

  /** Immutable update used after a rate card refresh. */
  withRateCard(card: RateCard): Catalog {
    return new Catalog({
      vendors: this.vendors,
      entries: this.entries,
      rateCards: [...this.rateCards.filter((c) => c.vendorId !== card.vendorId), card],
      schedules: this.schedules,
    })
  }
}
