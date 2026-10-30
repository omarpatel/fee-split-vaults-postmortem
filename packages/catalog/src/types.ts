/**
 * Catalog domain types.
 *
 * These are deliberately SHAPE-COMPATIBLE with the structures the broker
 * already consumes (packages/broker/src/catalog.ts): `CatalogEntry` here is
 * assignable to `CatalogEntry` there, and `RateCard` here is assignable to
 * `RateCard` there. The extra fields this package adds - price provenance,
 * seals, minimum viable quantity - are additive, so a broker built against the
 * narrower shape keeps working while an auditor gets the provenance.
 */
import type { Sku, Vendor } from '@fee-split-vaults/core'
import type { TierId } from './protocol.js'

/**
 * THE TWO PRICE BOOKS. Every line the operator can bill is in exactly one.
 *
 *   third_party_pass_through - a good bought by the operator AS PRINCIPAL from
 *       a third party and charged on at COST. Zero markup, exactly. Reconciled
 *       daily against an archived copy of the vendor's price in force.
 *
 *   operator_service - the operator's own labour, billed at a PUBLISHED,
 *       COIN-INDEPENDENT unit rate from a versioned rate schedule.
 *
 * There is no third book, and there is no line that is partly one and partly
 * the other. A "service" that is really a resold third-party good is the exact
 * shape of the self-dealing this package refuses to load.
 */
export type PricingModel = 'third_party_pass_through' | 'operator_service'

/** Where a price came from and when we last saw it with our own eyes. */
export type PriceSourceKind =
  /** A price list the vendor publishes publicly and anyone can re-check. */
  | 'vendor_public_pricing'
  /** A per-campaign quote from the vendor. Requires a countersignature. */
  | 'vendor_countersigned_quote'
  /** The operator's own published rate schedule. */
  | 'operator_published_rate'

export interface PriceProvenance {
  kind: PriceSourceKind
  /** Where a third party can go and check this number themselves. */
  sourceUri: string
  /** When a human or the fetcher last observed this price at that source. */
  observedAtUnix: number
  /** The same instant as an ISO date, so a git diff of the data reads. */
  observedOnDate: string
  /**
   * Past this age the price is not evidence of anything. The SKU is disabled by
   * the daily reconciliation rather than sold at a number nobody has checked.
   */
  maxAgeSeconds: number
  note?: string
}

/**
 * An archived, content-addressed copy of a vendor's price in force.
 *
 * For a public price list this is a transcription of what the vendor published.
 * For a KOL it is the countersigned quote. Either way it is the artefact a
 * historical purchase is audited against, so it is sealed and immutable.
 */
export interface RateCard {
  vendorId: string
  archivedAtUnix: number
  sourceUri: string
  /** sha256 over the canonical JSON of this document minus `sourceHash`. */
  sourceHash: string
  /** skuId -> public list price in USD. */
  listPriceUsd: Record<string, number>
  /** Present on seeded cards. Absent on cards produced by a live fetch. */
  archivedOnDate?: string
  kind?: PriceSourceKind
  /** Vendor countersignature over `sourceHash`. Required for a quote. */
  vendorCountersig?: string
  note?: string
}

export interface RateCardRef {
  vendorId: string
  sourceHash: string
}

export interface CatalogEntry {
  sku: Sku
  pricing: PricingModel
  /** Pass-through only. Pins the archived rate card the price was taken from. */
  rateCardRef?: RateCardRef
  /** Operator services only. The published, coin-independent rate schedule. */
  publishedRateRef?: string
  enabled: boolean
  /** Deliveries observed for this vendor. Drives probation, not pricing. */
  observedDeliveries: number
  maxQuantity: number
  /** Where this price came from and when. Additive to the broker's shape. */
  priceProvenance: PriceProvenance
  /**
   * The smallest purchase of this SKU that could plausibly deliver anything.
   * Trending sold by the day is not meaningfully bought for one day; a boost
   * pack has a floor set by the vendor. Tier affordability is computed against
   * unitCost * minViableQuantity, NOT against a single unit, because offering a
   * tier a quantity that cannot work is the same failure as offering it a price
   * it cannot pay.
   */
  minViableQuantity: number
  /** Operator-facing reason this SKU is disabled, when it is. */
  disabledReason?: string
}

/** A vendor plus the catalog-local facts the shared Vendor type does not carry. */
export interface VendorRecord extends Vendor {
  /**
   * Third-party vendors are paid BY THE OPERATOR AS PRINCIPAL, off this chain
   * and out of the operator treasury. They therefore have no payout address in
   * this system at all, and the loader refuses one. "No third-party payee
   * anywhere" is enforced here, not documented here.
   */
  payoutAddress?: string
  /** Human note for the audit trail. Never rendered into client-facing output. */
  note?: string
  /** What must be true before this vendor may be paid at all. */
  requires?: Array<'kyb' | 'ofac' | 'countersigned_quote'>
}

/** The operator's published, versioned, coin-independent rate schedule. */
export interface OperatorRateSchedule {
  /** Referenced by CatalogEntry.publishedRateRef. Immutable once published. */
  ref: string
  version: number
  publishedAtUnix: number
  publishedOnDate: string
  /** Where clients can read this schedule. Publication is the whole control. */
  publicUri: string
  /** skuId -> unit rate in USD. No vault key exists here, by construction. */
  unitRateUsd: Record<string, number>
  /** sha256 over the canonical JSON of this document minus `sealHash`. */
  sealHash: string
  note?: string
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export type CatalogDriftKind =
  | 'missing_rate_card'
  | 'stale_rate_card'
  | 'unsealed_rate_card'
  | 'sku_absent_from_rate_card'
  | 'rate_card_hash_moved'
  | 'markup_detected'
  | 'discount_detected'
  | 'provenance_expired'
  | 'missing_countersignature'
  | 'published_rate_mismatch'

export interface CatalogDrift {
  skuId: string
  vendorId: string
  kind: CatalogDriftKind
  catalogCents: bigint
  referenceCents?: bigint
  /** Positive means the client would have been overcharged. */
  spreadCents?: bigint
  /**
   * Every drift is critical. There is no "warn" price variance: an unreconciled
   * price is a price the operator could be marking up, so the SKU is disabled
   * until a human clears it.
   */
  severity: 'critical'
  detectedAtUnix: number
  note: string
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/**
 * The priced catalog at one instant, sealed. A historical purchase is audited
 * by finding the snapshot in force on the day it happened and comparing the
 * amount charged to the price recorded there. Without this, "we charged you
 * what it cost" is an assertion; with it, it is a check anyone can run.
 */
export interface CatalogSnapshot {
  snapshotId: string
  takenAtUnix: number
  takenOnDate: string
  lines: CatalogSnapshotLine[]
}

export interface CatalogSnapshotLine {
  skuId: string
  vendorId: string
  pricing: PricingModel
  /** Rendered as a decimal string: JSON has no bigint and cents are exact. */
  unitCents: string
  enabled: boolean
  availableAtTiers: TierId[]
  /** The rate card or published schedule the price was taken from that day. */
  priceReference: string
  provenanceObservedAtUnix: number
}

export type HistoricalAuditOutcome =
  | 'match'
  | 'no_snapshot_in_force'
  | 'sku_absent_from_snapshot'
  | 'amount_mismatch'

export interface HistoricalPurchaseAudit {
  outcome: HistoricalAuditOutcome
  skuId: string
  disbursedAtUnix: number
  chargedCents: bigint
  snapshotId?: string
  snapshotTakenAtUnix?: number
  priceInForceCents?: bigint
  deltaCents?: bigint
  note: string
}

// ---------------------------------------------------------------------------
// Related party
// ---------------------------------------------------------------------------

/**
 * A dev's explicit, per-vendor, revocable permission to spend that coin's
 * procurement budget with a vendor the operator is affiliated with.
 *
 * Opt-in is per (vault, vendor). It is never inferred from a tier, never
 * inherited from another coin, and never granted by a model.
 */
export interface RelatedPartyOptIn {
  vault: string
  vendorId: string
  optedInAtUnix: number
  /** keccak/sha of the exact disclosure text the dev accepted. */
  disclosureHash: string
  revokedAtUnix?: number
}

export interface RelatedPartySpendContext {
  vault: string
  vendorId: string
  /** The coin's own procurement budget accrued over the trailing 30 days. */
  trailing30dBudgetCents: bigint
  /** Already spent with related parties for this vault in the same window. */
  relatedPartySpentCents: bigint
  proposedCents: bigint
  nowUnix: number
}

export interface RelatedPartyDecision {
  permitted: boolean
  capCents: bigint
  remainingCents: bigint
  reason: string
}
