/**
 * The loaded catalog, in the shape the broker's gate chain consumes.
 *
 * `loadCatalog()` is what validates data/; `VendorCatalog` is what the spend
 * gates read. This is the only bridge between them, so the fleet cannot be
 * priced from a hand-built VendorCatalog that never went through the loader.
 */
import { VendorCatalog, type CatalogEntry as BrokerCatalogEntry } from '@fee-split-vaults/broker'
import type { Vendor } from '@fee-split-vaults/core'
import type { Catalog } from './catalog.js'
import { CatalogError } from './errors.js'

export function catalogToBrokerCatalog(catalog: Catalog): VendorCatalog {
  const vendors: Vendor[] = catalog.vendors.map((record) => {
    const vendor: Vendor = {
      id: record.id,
      displayName: record.displayName,
      isRelatedParty: record.isRelatedParty,
      reliabilityScore: record.reliabilityScore,
      enabled: record.enabled,
    }
    if (record.kybVerifiedAtUnix !== undefined) vendor.kybVerifiedAtUnix = record.kybVerifiedAtUnix
    if (record.ofacScreenedAtUnix !== undefined) {
      vendor.ofacScreenedAtUnix = record.ofacScreenedAtUnix
    }
    // No payoutAddress, ever. The loader refuses one; this does not re-add it.
    return vendor
  })

  const entries: BrokerCatalogEntry[] = []
  for (const entry of catalog.entries) {
    if (entry.pricing === 'third_party_pass_through' && entry.rateCardRef === undefined) {
      if (entry.enabled) {
        throw new CatalogError(
          'load',
          'enabled_without_rate_card',
          `sku ${entry.sku.id} is enabled but pins no archived rate card; there is no price to charge at cost`,
        )
      }
      // A disabled quote-priced SKU with no archived quote has no broker
      // representation: the broker requires a rate card on every pass-through
      // line. Absent from the broker's menu is the same refusal as disabled.
      continue
    }
    const out: BrokerCatalogEntry = {
      sku: entry.sku,
      pricing: entry.pricing,
      enabled: entry.enabled,
      observedDeliveries: entry.observedDeliveries,
      maxQuantity: entry.maxQuantity,
    }
    if (entry.rateCardRef !== undefined) out.rateCardRef = entry.rateCardRef
    if (entry.publishedRateRef !== undefined) out.publishedRateRef = entry.publishedRateRef
    entries.push(out)
  }

  return new VendorCatalog(vendors, entries)
}
