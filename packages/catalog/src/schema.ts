/**
 * Runtime validation for everything under data/.
 *
 * These files are operator-authored and hand-edited, which makes them the most
 * likely source of a silent economic defect in the whole system: a dropped
 * predicate, a price with three decimal places, a tier added because it looked
 * plausible. Every one of those is caught here, at load, by refusing to start.
 *
 * UNKNOWN KEYS ARE REJECTED. A misspelled `predicat:` would otherwise leave a
 * SKU with no delivery predicate and a validator that never noticed, which is
 * exactly the failure the "no predicate, no purchase" rule exists to stop.
 */
import { PREDICATE_KINDS, PREDICATE_PARAMS } from '@fee-split-vaults/broker'
import type { DeliveryPredicateSpec, Sku } from '@fee-split-vaults/core'
import { CatalogError } from './errors.js'
import { exactCentsFromUsd } from './money.js'
import { CATEGORY_PRICING_MODEL } from './pricebook.js'
import { TIER_ORDER } from './protocol.js'
import type { TierId } from './protocol.js'
import type {
  CatalogEntry,
  OperatorRateSchedule,
  PriceProvenance,
  PriceSourceKind,
  PricingModel,
  RateCard,
  VendorRecord,
} from './types.js'

const SKU_CATEGORIES = [
  'listing',
  'boost',
  'trending',
  'kol',
  'moderation',
  'build',
  'creative',
] as const

const PRICE_SOURCE_KINDS: readonly PriceSourceKind[] = [
  'vendor_public_pricing',
  'vendor_countersigned_quote',
  'operator_published_rate',
]

const VENDOR_REQUIREMENTS = ['kyb', 'ofac', 'countersigned_quote'] as const

/** KOL posts are verified at T+24h AND T+7d. Both, always, non-negotiable. */
export const KOL_REQUIRED_OFFSETS_SECONDS = [24 * 60 * 60, 7 * 24 * 60 * 60] as const

/** A trending buy must be checked at least this many times across the window. */
export const TRENDING_MIN_CHECKS = 8

// ---------------------------------------------------------------------------
// Primitive readers. Every one of them throws rather than coercing.
// ---------------------------------------------------------------------------

function fail(code: string, message: string): never {
  throw new CatalogError('schema', code, message)
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('not_an_object', `${where} is not an object`)
  }
  return value as Record<string, unknown>
}

function noExtraKeys(source: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const permitted = new Set(allowed)
  for (const key of Object.keys(source)) {
    if (!permitted.has(key)) {
      fail('unknown_field', `${where} carries unknown field "${key}"; the schema is closed`)
    }
  }
}

function readString(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value.length === 0) {
    fail('missing_string', `${where}.${key} must be a non-empty string`)
  }
  return value
}

function readOptionalString(
  source: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    fail('bad_string', `${where}.${key}, when present, must be a non-empty string`)
  }
  return value
}

function readNumber(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('missing_number', `${where}.${key} must be a finite number`)
  }
  return value
}

function readInt(source: Record<string, unknown>, key: string, where: string): number {
  const value = readNumber(source, key, where)
  if (!Number.isSafeInteger(value)) {
    fail('not_an_integer', `${where}.${key} must be an integer`)
  }
  return value
}

function readOptionalInt(
  source: Record<string, unknown>,
  key: string,
  where: string,
): number | undefined {
  if (source[key] === undefined) return undefined
  return readInt(source, key, where)
}

function readBoolean(source: Record<string, unknown>, key: string, where: string): boolean {
  const value = source[key]
  if (typeof value !== 'boolean') {
    fail('missing_boolean', `${where}.${key} must be a boolean`)
  }
  return value
}

function readArray(source: Record<string, unknown>, key: string, where: string): unknown[] {
  const value = source[key]
  if (!Array.isArray(value)) {
    fail('missing_array', `${where}.${key} must be an array`)
  }
  return value
}

function readEnum<T extends string>(
  source: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  where: string,
): T {
  const value = source[key]
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(
      'bad_enum',
      `${where}.${key} must be one of ${allowed.join(', ')}; got "${String(value)}"`,
    )
  }
  return value as T
}

/** ISO date, and it must name the same day as the unix timestamp beside it. */
function assertDateMatchesUnix(date: string, unix: number, where: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    fail('bad_date', `${where} must be an ISO date (YYYY-MM-DD); got "${date}"`)
  }
  const derived = new Date(unix * 1000).toISOString().slice(0, 10)
  if (derived !== date) {
    fail(
      'date_unix_mismatch',
      `${where} says ${date} but its timestamp ${unix} is ${derived}; one of them is wrong`,
    )
  }
}

// ---------------------------------------------------------------------------
// Delivery predicates. "No predicate, no purchase" is enforced here.
// ---------------------------------------------------------------------------

function parsePredicateParams(
  value: unknown,
  where: string,
): Record<string, string | number> {
  const source = asObject(value, `${where}.params`)
  const out: Record<string, string | number> = {}
  for (const [key, param] of Object.entries(source)) {
    if (typeof param === 'string') {
      out[key] = param
      continue
    }
    if (typeof param === 'number' && Number.isFinite(param)) {
      out[key] = param
      continue
    }
    fail(
      'bad_predicate_param',
      `${where}.params.${key} must be a string or a finite number; predicates carry no nested structure`,
    )
  }
  return out
}

/**
 * The names come from the broker's verifiers, not from here. A param this
 * loader accepted under one name and a verifier read under another would ship
 * a SKU that fails closed at its first check, after the money moved; a param
 * no verifier reads is a claim in a JSON file, not a check.
 */
function requireParams(
  params: Record<string, string | number>,
  kind: (typeof PREDICATE_KINDS)[number],
  where: string,
): void {
  const { required, optional } = PREDICATE_PARAMS[kind]
  for (const key of required) {
    if (params[key] === undefined) {
      fail('missing_predicate_param', `${where} requires params.${key}`)
    }
  }
  for (const key of Object.keys(params)) {
    if (!required.includes(key) && !optional.includes(key)) {
      fail(
        'unknown_predicate_param',
        `${where}.params.${key} is read by no ${kind} verifier`,
      )
    }
  }
}

export function parseDeliveryPredicate(
  value: unknown,
  where: string,
  pricing: PricingModel,
): DeliveryPredicateSpec {
  if (value === undefined || value === null) {
    // The hard rule. A SKU with no way to prove delivery is not a SKU.
    fail('no_predicate', `${where} has no delivery predicate; no predicate, no purchase`)
  }
  const source = asObject(value, where)
  noExtraKeys(source, ['kind', 'verifyAtOffsetsSeconds', 'params'], where)

  const kind = readEnum(source, 'kind', PREDICATE_KINDS, where)
  const rawOffsets = readArray(source, 'verifyAtOffsetsSeconds', where)
  if (rawOffsets.length === 0) {
    fail('no_verification_schedule', `${where} schedules no verification; delivery would never be checked`)
  }
  const offsets: number[] = []
  let previous = -1
  for (const [index, raw] of rawOffsets.entries()) {
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
      fail(
        'bad_offset',
        `${where}.verifyAtOffsetsSeconds[${index}] must be a non-negative integer number of seconds`,
      )
    }
    if (raw <= previous) {
      fail(
        'unsorted_offsets',
        `${where}.verifyAtOffsetsSeconds must be strictly ascending and unique`,
      )
    }
    previous = raw
    offsets.push(raw)
  }

  const params = parsePredicateParams(source.params ?? {}, where)
  requireParams(params, kind, where)

  switch (kind) {
    case 'eti_listing':
      // Fetch the pair record and verify the listing is actually attached.
      break
    case 'boost_delta':
      // A boost is only evidence if the count moved AND the rank was sampled
      // while the effect was live; boosts decay over hours, not days.
      break
    case 'trending_rank': {
      // Randomized checks across the paid window, with pro-rata clawback for
      // every check that missed. A single check at a time the vendor can
      // predict is not a measurement, it is a photo opportunity.
      const minChecks = params.minChecks
      if (typeof minChecks !== 'number' || minChecks < TRENDING_MIN_CHECKS) {
        fail(
          'insufficient_trending_checks',
          `${where} schedules ${String(minChecks)} rank checks; at least ${TRENDING_MIN_CHECKS} are required across the paid window`,
        )
      }
      if (params.randomized !== 1) {
        fail(
          'trending_checks_not_randomized',
          `${where} must set params.randomized = 1; a predictable check schedule is not a measurement`,
        )
      }
      if (params.clawback !== 'pro_rata') {
        fail(
          'no_clawback',
          `${where} must set params.clawback = "pro_rata"; unverified trending time is refunded, not written off`,
        )
      }
      break
    }
    case 'kol_post': {
      // Post exists, correct handle, disclosure literal present, still live at
      // BOTH T+24h and T+7d. A post deleted on day two was never delivered.
      for (const required of KOL_REQUIRED_OFFSETS_SECONDS) {
        if (!offsets.includes(required)) {
          fail(
            'missing_kol_recheck',
            `${where} must verify at T+${required}s; KOL posts are checked at T+24h AND T+7d`,
          )
        }
      }
      break
    }
    case 'manual_attestation':
      // Not machine-verifiable, so it is confined to the operator's own labour,
      // where the operator attests against its own records rather than a
      // third party's. It is never an escape hatch for a media buy.
      if (pricing !== 'operator_service') {
        fail(
          'manual_attestation_on_media',
          `${where} uses a manual attestation on a third-party purchase; media buys must be machine-verifiable`,
        )
      }
      break
    default:
      fail('unknown_predicate_kind', `${where} has an unhandled predicate kind`)
  }

  return { kind, verifyAtOffsetsSeconds: offsets, params }
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export function parsePriceProvenance(value: unknown, where: string): PriceProvenance {
  const source = asObject(value, where)
  noExtraKeys(
    source,
    ['kind', 'sourceUri', 'observedAtUnix', 'observedOnDate', 'maxAgeSeconds', 'note'],
    where,
  )
  const kind = readEnum(source, 'kind', PRICE_SOURCE_KINDS, where)
  const observedAtUnix = readInt(source, 'observedAtUnix', where)
  if (observedAtUnix <= 0) fail('bad_observed_at', `${where}.observedAtUnix must be positive`)
  const observedOnDate = readString(source, 'observedOnDate', where)
  assertDateMatchesUnix(observedOnDate, observedAtUnix, `${where}.observedOnDate`)
  const maxAgeSeconds = readInt(source, 'maxAgeSeconds', where)
  if (maxAgeSeconds <= 0) {
    fail('bad_max_age', `${where}.maxAgeSeconds must be positive; a price with no expiry is a price nobody re-checks`)
  }
  const provenance: PriceProvenance = {
    kind,
    sourceUri: readString(source, 'sourceUri', where),
    observedAtUnix,
    observedOnDate,
    maxAgeSeconds,
  }
  const note = readOptionalString(source, 'note', where)
  if (note !== undefined) provenance.note = note
  return provenance
}

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

const VENDOR_KEYS = [
  'id',
  'displayName',
  'isRelatedParty',
  'reliabilityScore',
  'enabled',
  'kybVerifiedAtUnix',
  'ofacScreenedAtUnix',
  'requires',
  'note',
  // Permitted as a KEY only so the refusal below can explain itself. A vendor
  // that carries one still fails to load.
  'payoutAddress',
] as const

export function parseVendorsFile(raw: unknown): VendorRecord[] {
  const file = asObject(raw, 'vendors.json')
  noExtraKeys(file, ['schemaVersion', 'note', 'vendors'], 'vendors.json')
  if (readInt(file, 'schemaVersion', 'vendors.json') !== 1) {
    fail('unsupported_schema_version', 'vendors.json declares an unsupported schemaVersion')
  }

  const out: VendorRecord[] = []
  const seen = new Set<string>()
  for (const [index, item] of readArray(file, 'vendors', 'vendors.json').entries()) {
    const where = `vendors.json/vendors[${index}]`
    const source = asObject(item, where)
    noExtraKeys(source, VENDOR_KEYS, where)

    const id = readString(source, 'id', where)
    if (!/^[a-z0-9_]+$/.test(id)) {
      fail('bad_vendor_id', `${where}.id must be lowercase snake_case; got "${id}"`)
    }
    if (seen.has(id)) fail('duplicate_vendor', `${where} duplicates vendor id "${id}"`)
    seen.add(id)

    const reliabilityScore = readNumber(source, 'reliabilityScore', where)
    if (reliabilityScore < 0 || reliabilityScore > 1) {
      fail('bad_reliability', `${where}.reliabilityScore must be within [0, 1]`)
    }

    // A payee that can be changed by editing a data file is not an allowlist.
    // Payout destinations are deployment configuration, and there is exactly
    // one of them - the operator treasury - because no third party is ever
    // paid by this protocol.
    if ('payoutAddress' in source) {
      fail(
        'payout_address_in_data',
        `${where} carries a payoutAddress. Payee addresses are deployment configuration, never catalog ` +
          `data, and no third-party payee exists in this system at all.`,
      )
    }

    const vendor: VendorRecord = {
      id,
      displayName: readString(source, 'displayName', where),
      isRelatedParty: readBoolean(source, 'isRelatedParty', where),
      reliabilityScore,
      enabled: readBoolean(source, 'enabled', where),
    }

    const kyb = readOptionalInt(source, 'kybVerifiedAtUnix', where)
    if (kyb !== undefined) vendor.kybVerifiedAtUnix = kyb
    const ofac = readOptionalInt(source, 'ofacScreenedAtUnix', where)
    if (ofac !== undefined) vendor.ofacScreenedAtUnix = ofac
    const note = readOptionalString(source, 'note', where)
    if (note !== undefined) vendor.note = note

    if (source.requires !== undefined) {
      const requires: Array<'kyb' | 'ofac' | 'countersigned_quote'> = []
      for (const [i, entry] of readArray(source, 'requires', where).entries()) {
        if (
          typeof entry !== 'string' ||
          !(VENDOR_REQUIREMENTS as readonly string[]).includes(entry)
        ) {
          fail('bad_requirement', `${where}.requires[${i}] is not a known requirement`)
        }
        requires.push(entry as 'kyb' | 'ofac' | 'countersigned_quote')
      }
      vendor.requires = requires
    }

    // Fail closed on standing: a vendor that still owes KYB or an OFAC screen
    // cannot be enabled by asserting `enabled: true` in a JSON file.
    if (vendor.enabled) {
      const requires = vendor.requires ?? []
      if (requires.includes('kyb') && vendor.kybVerifiedAtUnix === undefined) {
        fail(
          'enabled_without_kyb',
          `${where} is enabled but has no KYB record and declares it required`,
        )
      }
      if (requires.includes('ofac') && vendor.ofacScreenedAtUnix === undefined) {
        fail(
          'enabled_without_ofac',
          `${where} is enabled but has no OFAC screening record and declares it required`,
        )
      }
    }

    out.push(vendor)
  }

  if (out.length === 0) fail('no_vendors', 'vendors.json lists no vendors')
  return out
}

// ---------------------------------------------------------------------------
// SKUs
// ---------------------------------------------------------------------------

const SKU_KEYS = [
  'id',
  'vendorId',
  'description',
  'unitCostUsd',
  'category',
  'pricing',
  'availableAtTiers',
  'enabled',
  'disabledReason',
  'maxQuantity',
  'minViableQuantity',
  'observedDeliveries',
  'rateCardRef',
  'publishedRateRef',
  'priceProvenance',
  'predicate',
] as const

export function parseSkusFile(raw: unknown): CatalogEntry[] {
  const file = asObject(raw, 'skus.json')
  noExtraKeys(file, ['schemaVersion', 'note', 'skus'], 'skus.json')
  if (readInt(file, 'schemaVersion', 'skus.json') !== 1) {
    fail('unsupported_schema_version', 'skus.json declares an unsupported schemaVersion')
  }

  const out: CatalogEntry[] = []
  const seen = new Set<string>()
  for (const [index, item] of readArray(file, 'skus', 'skus.json').entries()) {
    const where = `skus.json/skus[${index}]`
    const source = asObject(item, where)
    noExtraKeys(source, SKU_KEYS, where)

    const id = readString(source, 'id', where)
    if (!/^[a-z0-9_]+$/.test(id)) {
      fail('bad_sku_id', `${where}.id must be lowercase snake_case; got "${id}"`)
    }
    if (seen.has(id)) fail('duplicate_sku', `${where} duplicates sku id "${id}"`)
    seen.add(id)

    const category = readEnum(source, 'category', SKU_CATEGORIES, where)
    const pricing = readEnum(
      source,
      'pricing',
      ['third_party_pass_through', 'operator_service'] as const,
      where,
    )
    // Checked here as well as in pricebook.ts so a malformed file fails with a
    // schema error naming the file and line rather than an invariant error.
    if (CATEGORY_PRICING_MODEL[category] !== pricing) {
      fail(
        'category_book_mismatch',
        `${where} is category "${category}", which is always ${CATEGORY_PRICING_MODEL[category]}, but is filed as ${pricing}`,
      )
    }

    const unitCostUsd = readNumber(source, 'unitCostUsd', where)
    if (unitCostUsd <= 0) fail('non_positive_price', `${where}.unitCostUsd must be positive`)
    exactCentsFromUsd(unitCostUsd, `${where}.unitCostUsd`)

    const tiers: TierId[] = []
    for (const [i, tier] of readArray(source, 'availableAtTiers', where).entries()) {
      if (typeof tier !== 'string' || !(TIER_ORDER as readonly string[]).includes(tier)) {
        fail('unknown_tier', `${where}.availableAtTiers[${i}] is not a known tier`)
      }
      if (tiers.includes(tier as TierId)) {
        fail('duplicate_tier', `${where}.availableAtTiers lists ${tier} twice`)
      }
      tiers.push(tier as TierId)
    }
    if (tiers.length === 0) {
      fail('no_tiers', `${where} is available at no tier; remove it rather than shipping it dark`)
    }

    const maxQuantity = readInt(source, 'maxQuantity', where)
    if (maxQuantity < 1) fail('bad_max_quantity', `${where}.maxQuantity must be at least 1`)
    const minViableQuantity = readInt(source, 'minViableQuantity', where)
    if (minViableQuantity < 1) {
      fail('bad_min_viable_quantity', `${where}.minViableQuantity must be at least 1`)
    }
    if (minViableQuantity > maxQuantity) {
      fail(
        'min_viable_over_max',
        `${where} cannot be bought in a viable quantity without exceeding its own maxQuantity`,
      )
    }
    const observedDeliveries = readInt(source, 'observedDeliveries', where)
    if (observedDeliveries < 0) {
      fail('bad_delivery_count', `${where}.observedDeliveries must not be negative`)
    }

    const sku: Sku = {
      id,
      vendorId: readString(source, 'vendorId', where),
      description: readString(source, 'description', where),
      unitCostUsd,
      category,
      predicate: parseDeliveryPredicate(source.predicate, `${where}.predicate`, pricing),
      availableAtTiers: tiers,
    }

    const entry: CatalogEntry = {
      sku,
      pricing,
      enabled: readBoolean(source, 'enabled', where),
      observedDeliveries,
      maxQuantity,
      minViableQuantity,
      priceProvenance: parsePriceProvenance(source.priceProvenance, `${where}.priceProvenance`),
    }

    if (source.rateCardRef !== undefined) {
      const refWhere = `${where}.rateCardRef`
      const ref = asObject(source.rateCardRef, refWhere)
      noExtraKeys(ref, ['vendorId', 'sourceHash'], refWhere)
      const sourceHash = readString(ref, 'sourceHash', refWhere)
      if (!/^[0-9a-f]{64}$/.test(sourceHash)) {
        fail(
          'unsealed_rate_card_ref',
          `${refWhere}.sourceHash is not a sha256 digest. Run "npm run seal -w @fee-split-vaults/catalog" ` +
            `after editing any price.`,
        )
      }
      entry.rateCardRef = { vendorId: readString(ref, 'vendorId', refWhere), sourceHash }
    }

    const publishedRateRef = readOptionalString(source, 'publishedRateRef', where)
    if (publishedRateRef !== undefined) entry.publishedRateRef = publishedRateRef

    const disabledReason = readOptionalString(source, 'disabledReason', where)
    if (disabledReason !== undefined) entry.disabledReason = disabledReason
    if (!entry.enabled && disabledReason === undefined) {
      fail(
        'disabled_without_reason',
        `${where} is disabled but gives no reason; a dark SKU with no explanation gets re-enabled by accident`,
      )
    }
    if (entry.enabled && disabledReason !== undefined) {
      fail('enabled_with_disabled_reason', `${where} is enabled but carries a disabledReason`)
    }

    out.push(entry)
  }

  if (out.length === 0) fail('no_skus', 'skus.json lists no SKUs')
  return out
}

// ---------------------------------------------------------------------------
// Rate cards and the published operator schedule
// ---------------------------------------------------------------------------

const RATE_CARD_KEYS = [
  'vendorId',
  'archivedAtUnix',
  'archivedOnDate',
  'sourceUri',
  'sourceHash',
  'kind',
  'vendorCountersig',
  'listPriceUsd',
  'note',
] as const

export function parseRateCard(raw: unknown, where: string): RateCard {
  const source = asObject(raw, where)
  noExtraKeys(source, RATE_CARD_KEYS, where)

  const archivedAtUnix = readInt(source, 'archivedAtUnix', where)
  if (archivedAtUnix <= 0) fail('bad_archived_at', `${where}.archivedAtUnix must be positive`)
  const sourceHash = readString(source, 'sourceHash', where)
  if (!/^[0-9a-f]{64}$/.test(sourceHash)) {
    fail(
      'unsealed_rate_card',
      `${where}.sourceHash is not a sha256 digest; run the seal script after editing a price`,
    )
  }

  const pricesWhere = `${where}.listPriceUsd`
  const prices = asObject(source.listPriceUsd, pricesWhere)
  const listPriceUsd: Record<string, number> = {}
  for (const [skuId, price] of Object.entries(prices)) {
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      fail('bad_list_price', `${pricesWhere}.${skuId} is not a positive price`)
    }
    exactCentsFromUsd(price, `${pricesWhere}.${skuId}`)
    listPriceUsd[skuId] = price
  }
  if (Object.keys(listPriceUsd).length === 0) {
    fail('empty_rate_card', `${where} prices nothing`)
  }

  const card: RateCard = {
    vendorId: readString(source, 'vendorId', where),
    archivedAtUnix,
    sourceUri: readString(source, 'sourceUri', where),
    sourceHash,
    listPriceUsd,
  }

  const archivedOnDate = readOptionalString(source, 'archivedOnDate', where)
  if (archivedOnDate !== undefined) {
    assertDateMatchesUnix(archivedOnDate, archivedAtUnix, `${where}.archivedOnDate`)
    card.archivedOnDate = archivedOnDate
  }
  if (source.kind !== undefined) {
    card.kind = readEnum(source, 'kind', PRICE_SOURCE_KINDS, where)
  }
  const countersig = readOptionalString(source, 'vendorCountersig', where)
  if (countersig !== undefined) card.vendorCountersig = countersig
  const note = readOptionalString(source, 'note', where)
  if (note !== undefined) card.note = note

  // A per-campaign quote is only a price if the vendor signed it. A public
  // price list needs no signature because anyone can re-read the source.
  if (card.kind === 'vendor_countersigned_quote' && card.vendorCountersig === undefined) {
    fail(
      'quote_without_countersignature',
      `${where} is a per-campaign quote with no vendor countersignature; an uncountersigned quote is a rumour`,
    )
  }

  return card
}

const SCHEDULE_KEYS = [
  'ref',
  'version',
  'publishedAtUnix',
  'publishedOnDate',
  'publicUri',
  'unitRateUsd',
  'sealHash',
  'note',
] as const

export function parseOperatorRateSchedule(raw: unknown, where: string): OperatorRateSchedule {
  const source = asObject(raw, where)
  noExtraKeys(source, SCHEDULE_KEYS, where)

  const publishedAtUnix = readInt(source, 'publishedAtUnix', where)
  if (publishedAtUnix <= 0) fail('bad_published_at', `${where}.publishedAtUnix must be positive`)
  const publishedOnDate = readString(source, 'publishedOnDate', where)
  assertDateMatchesUnix(publishedOnDate, publishedAtUnix, `${where}.publishedOnDate`)

  const sealHash = readString(source, 'sealHash', where)
  if (!/^[0-9a-f]{64}$/.test(sealHash)) {
    fail('unsealed_schedule', `${where}.sealHash is not a sha256 digest; run the seal script`)
  }

  const ratesWhere = `${where}.unitRateUsd`
  const rates = asObject(source.unitRateUsd, ratesWhere)
  const unitRateUsd: Record<string, number> = {}
  for (const [skuId, rate] of Object.entries(rates)) {
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      fail('bad_unit_rate', `${ratesWhere}.${skuId} is not a positive rate`)
    }
    exactCentsFromUsd(rate, `${ratesWhere}.${skuId}`)
    unitRateUsd[skuId] = rate
  }
  if (Object.keys(unitRateUsd).length === 0) {
    fail('empty_schedule', `${where} publishes no rates`)
  }

  const version = readInt(source, 'version', where)
  if (version < 1) fail('bad_version', `${where}.version must be at least 1`)

  const schedule: OperatorRateSchedule = {
    ref: readString(source, 'ref', where),
    version,
    publishedAtUnix,
    publishedOnDate,
    publicUri: readString(source, 'publicUri', where),
    unitRateUsd,
    sealHash,
  }
  const note = readOptionalString(source, 'note', where)
  if (note !== undefined) schedule.note = note

  // The ref pins the version, so a rate change cannot silently reprice a SKU
  // that was approved against an earlier schedule.
  if (!schedule.ref.endsWith(`@v${schedule.version}`)) {
    fail(
      'ref_version_mismatch',
      `${where}.ref must end with "@v${schedule.version}" so a SKU pins one immutable schedule version`,
    )
  }

  return schedule
}

export { SKU_CATEGORIES, PREDICATE_KINDS }
