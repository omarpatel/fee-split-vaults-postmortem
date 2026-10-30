/**
 * Broker-local operating policy.
 *
 * config/protocol.ts owns the ECONOMICS. This file owns the OPERATING limits
 * that the protocol config does not define: staleness windows, sub-cap shares,
 * rate limits, qualification conjuncts, vendor probation. Nothing here
 * duplicates a protocol constant; where a protocol constant exists it is
 * imported and used directly.
 *
 * Every value here is a ceiling. The signed policy object may tighten these at
 * runtime. Nothing may loosen them without a deploy.
 */
import type { Sku } from '@fee-split-vaults/core'

export type SkuCategory = Sku['category']

/** The rolling window the median accrual is taken over. */
export const ROLLING_WINDOW_DAYS = 14

/**
 * Per-category ceilings as a share of the period's PROCUREMENT budget, which is
 * the period budget net of inference. These are individual ceilings, not an
 * allocation: they intentionally sum above 10_000 bps because the binding
 * constraint on the total is the procurement budget itself, checked separately.
 */
export const CATEGORY_SUBCAP_BPS: Readonly<Record<SkuCategory, number>> = {
  listing: 3_000,
  boost: 2_000,
  trending: 2_000,
  kol: 3_000,
  moderation: 1_500,
  build: 2_500,
  creative: 1_500,
}

/**
 * Conjuncts beyond raw QF. Wash trading can manufacture fee flow; it cannot
 * cheaply manufacture holder breadth or deconcentration.
 *
 * venuePoolVolumeShare is deliberately a floor near zero, not a quality bar. A
 * large gap between headline volume and Venue-pool volume is the NORMAL state of
 * a winner (CASHCAT ran a 122x gap). A share at the floor means the fee-bearing
 * pool is dead, which is a different fact and does block paid media. Between
 * the floor and the escalation band the decision goes to a human.
 */
export const QUALIFICATION_CONJUNCTS = {
  minUniqueBuyers7d: 150,
  maxTop10HolderSharePct: 60,
  maxDeployerSupplySharePct: 10,
  maxSelfTradeSharePct: 15,
  minVenuePoolVolumeSharePct: 0.5,
  escalateVenuePoolVolumeSharePct: 5,
  minCoinAgeDays: 3,
  /** Minimum days of observation before QF can be trusted. QF is a 7d median. */
  minObservedDays: 7,
  /** A QF measurement older than this is refused rather than reused. */
  maxQfAgeSeconds: 24 * 60 * 60,
} as const

export const RATE_LIMITS = {
  proposalsPerHourPerVault: 12,
  disbursementsPerDayPerVault: 6,
  disbursementsPerDayPerVendorPerVault: 2,
  disbursementsPerDayFleet: 250,
  /** Counters older than this are treated as unknown, and unknown means no. */
  counterMaxAgeSeconds: 300,
} as const

export const VENDOR_RELIABILITY = {
  /** New vendors start on probation, not at full trust. */
  initialScore: 0.7,
  /** Below this a vendor cannot be paid at all. */
  minScore: 0.6,
  /** Deliveries observed before a vendor leaves probation. */
  probationDeliveries: 3,
  /** Ceiling on a single purchase while on probation, USD. */
  probationMaxUsd: 250,
  /** EWMA weight applied to each new delivery outcome, in bps. */
  updateWeightBps: 2_500,
} as const

/** An OFAC screen older than this is not a screen. */
export const OFAC_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

/** A KYB record older than this must be refreshed before further spend. */
export const KYB_MAX_AGE_SECONDS = 365 * 24 * 60 * 60

/** Content screening expires; an expired screening blocks paid media. */
export const SCREENING_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

/** Vendor rate cards are archived and reconciled daily. */
export const RATE_CARD_MAX_AGE_SECONDS = 26 * 60 * 60

/**
 * A manual attestation is not machine-verifiable, so it is capped and always
 * escalated to a human. It exists for the irreducible cases, not as an escape
 * hatch from the measurability requirement.
 */
export const MANUAL_ATTESTATION_MAX_USD = 250

/** Largest quantity a single proposal may request of one SKU. */
export const MAX_SKU_QUANTITY = 20

/** Advisory rationale text is length-capped and never parsed for values. */
export const MAX_RATIONALE_CHARS = 500

/** KOL posts are verified at T+24h and again at T+7d. Both are mandatory. */
export const KOL_CHECK_OFFSETS_SECONDS = [24 * 60 * 60, 7 * 24 * 60 * 60] as const
