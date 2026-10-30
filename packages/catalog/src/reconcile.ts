/**
 * DAILY RECONCILIATION.
 *
 * Every pass-through price is compared to the archived copy of the vendor's
 * price in force; every operator-service price is compared to the published
 * rate schedule. Anything that differs - a missing card, a stale card, a card
 * whose hash moved, a SKU that fell off the vendor's list, a price observed too
 * long ago to still be evidence - disables the SKU.
 *
 * THERE IS NO "WARN" SEVERITY HERE, and that is deliberate. A price the
 * operator has not reconciled today is a price the operator could be marking up
 * today, and the honest response to "we are not sure what this costs" is to
 * stop selling it, not to sell it with an asterisk. Re-enabling is a human
 * action with a fresh archived card behind it.
 *
 * The pass ends by sealing a snapshot of the menu as it now stands, which is
 * what a purchase made today will be audited against months from now.
 */
import { CatalogError, PriceBookViolation } from './errors.js'
import { exactCentsFromUsd, formatCents } from './money.js'
import { assertRateCardSealed, snapshotCatalog } from './archive.js'
import type { CatalogSnapshotArchive, RateCardArchive } from './archive.js'
import type { Catalog } from './catalog.js'
import type { CatalogDrift, CatalogEntry, CatalogSnapshot, RateCard } from './types.js'

/**
 * Cards are archived daily; 26 hours leaves two hours of slack for a late job
 * without ever letting a two-day-old price through.
 *
 * packages/broker/src/limits.ts carries the same figure for the same reason.
 * See the assumptions note: one of the two should import the other.
 */
export const RATE_CARD_MAX_AGE_SECONDS = 26 * 60 * 60

export interface ReconciliationResult {
  drifts: CatalogDrift[]
  /** The catalog with every drifted SKU disabled. */
  catalog: Catalog
  /** The sealed menu as it stands after drift was applied. */
  snapshot: CatalogSnapshot
  reconciledAtUnix: number
}

function drift(
  entry: CatalogEntry,
  kind: CatalogDrift['kind'],
  nowUnix: number,
  note: string,
  extra: Partial<Pick<CatalogDrift, 'referenceCents' | 'spreadCents'>> = {},
): CatalogDrift {
  return {
    skuId: entry.sku.id,
    vendorId: entry.sku.vendorId,
    kind,
    catalogCents: exactCentsFromUsd(entry.sku.unitCostUsd, `sku ${entry.sku.id} unitCostUsd`),
    severity: 'critical',
    detectedAtUnix: nowUnix,
    note,
    ...extra,
  }
}

/** Provenance ages out. A price nobody has looked at is not a price we can quote. */
function provenanceDrift(entry: CatalogEntry, nowUnix: number): CatalogDrift | null {
  const { observedAtUnix, maxAgeSeconds, observedOnDate } = entry.priceProvenance
  const ageSeconds = nowUnix - observedAtUnix
  if (ageSeconds <= maxAgeSeconds) return null
  return drift(
    entry,
    'provenance_expired',
    nowUnix,
    `price was last observed on ${observedOnDate} (${ageSeconds}s ago), past its ${maxAgeSeconds}s freshness budget`,
  )
}

function passThroughDrifts(
  entry: CatalogEntry,
  card: RateCard | null,
  nowUnix: number,
): CatalogDrift[] {
  if (card === null) {
    return [drift(entry, 'missing_rate_card', nowUnix, 'no archived rate card on file for this vendor')]
  }

  try {
    assertRateCardSealed(card, `rate card for ${card.vendorId}`)
  } catch (error) {
    return [
      drift(
        entry,
        'unsealed_rate_card',
        nowUnix,
        error instanceof Error ? error.message : 'rate card seal could not be verified',
      ),
    ]
  }

  if (card.archivedAtUnix < nowUnix - RATE_CARD_MAX_AGE_SECONDS) {
    return [
      drift(
        entry,
        'stale_rate_card',
        nowUnix,
        `rate card was archived ${nowUnix - card.archivedAtUnix}s ago, past the ${RATE_CARD_MAX_AGE_SECONDS}s window`,
      ),
    ]
  }

  if (card.kind === 'vendor_countersigned_quote' && card.vendorCountersig === undefined) {
    return [
      drift(
        entry,
        'missing_countersignature',
        nowUnix,
        'the quote this price came from carries no vendor countersignature',
      ),
    ]
  }

  if (entry.rateCardRef !== undefined && entry.rateCardRef.sourceHash !== card.sourceHash) {
    // Not automatically a markup: the vendor may simply have republished. But
    // the price the catalog was approved against no longer exists, so it goes
    // back to a human rather than being silently adopted.
    return [
      drift(
        entry,
        'rate_card_hash_moved',
        nowUnix,
        `the catalog pins card ${entry.rateCardRef.sourceHash.slice(0, 12)}; the card in force is ` +
          `${card.sourceHash.slice(0, 12)}. The price this SKU was approved against no longer exists.`,
      ),
    ]
  }

  const listed = card.listPriceUsd[entry.sku.id]
  if (listed === undefined) {
    return [
      drift(
        entry,
        'sku_absent_from_rate_card',
        nowUnix,
        'this SKU no longer appears on the vendor rate card',
      ),
    ]
  }

  const catalogCents = exactCentsFromUsd(entry.sku.unitCostUsd, `sku ${entry.sku.id} unitCostUsd`)
  const referenceCents = exactCentsFromUsd(listed, `rate card ${card.vendorId}/${entry.sku.id}`)
  const spread = catalogCents - referenceCents
  if (spread === 0n) return []

  return [
    drift(
      entry,
      spread > 0n ? 'markup_detected' : 'discount_detected',
      nowUnix,
      spread > 0n
        ? `the catalog charges ${formatCents(spread)} ABOVE the vendor list price`
        : `the catalog charges ${formatCents(-spread)} BELOW the vendor list price; a discount can ` +
          `cross-subsidise and is refused for the same reason a markup is`,
      { referenceCents, spreadCents: spread },
    ),
  ]
}

function operatorServiceDrifts(
  catalog: Catalog,
  entry: CatalogEntry,
  nowUnix: number,
): CatalogDrift[] {
  const ref = entry.publishedRateRef
  if (ref === undefined) {
    return [
      drift(entry, 'published_rate_mismatch', nowUnix, 'this service names no published rate schedule'),
    ]
  }
  const schedule = catalog.schedule(ref)
  if (schedule === undefined) {
    return [
      drift(entry, 'published_rate_mismatch', nowUnix, `published rate schedule "${ref}" is not loaded`),
    ]
  }
  const published = schedule.unitRateUsd[entry.sku.id]
  if (published === undefined) {
    return [
      drift(
        entry,
        'published_rate_mismatch',
        nowUnix,
        `this service does not appear in published schedule ${ref}`,
      ),
    ]
  }
  const catalogCents = exactCentsFromUsd(entry.sku.unitCostUsd, `sku ${entry.sku.id} unitCostUsd`)
  const referenceCents = exactCentsFromUsd(published, `schedule ${ref}/${entry.sku.id}`)
  const delta = catalogCents - referenceCents
  if (delta === 0n) return []
  return [
    drift(
      entry,
      'published_rate_mismatch',
      nowUnix,
      `the catalog charges ${formatCents(delta)} away from published schedule ${ref}`,
      { referenceCents, spreadCents: delta },
    ),
  ]
}

/**
 * The pure core: every drift, given a way to look up the card in force.
 *
 * Synchronous and side-effect free so the load path can run it without an
 * await, and so the whole reconciliation is testable against a lookup function
 * rather than against a store.
 *
 * Every SKU is checked, enabled or not: a disabled SKU that has drifted further
 * must not look clean when someone comes to re-enable it.
 */
export function computeDrifts(
  catalog: Catalog,
  cardFor: (vendorId: string) => RateCard | null,
  nowUnix: number,
): CatalogDrift[] {
  if (!Number.isSafeInteger(nowUnix) || nowUnix <= 0) {
    throw new CatalogError(
      'reconciliation',
      'bad_time',
      'reconciliation time must be a positive unix timestamp',
    )
  }

  const drifts: CatalogDrift[] = []
  const cards = new Map<string, RateCard | null>()

  for (const entry of catalog.entries) {
    const expired = provenanceDrift(entry, nowUnix)
    if (expired !== null) {
      drifts.push(expired)
      continue
    }

    if (entry.pricing === 'third_party_pass_through') {
      const vendorId = entry.sku.vendorId
      if (!cards.has(vendorId)) cards.set(vendorId, cardFor(vendorId))
      drifts.push(...passThroughDrifts(entry, cards.get(vendorId) ?? null, nowUnix))
      continue
    }

    drifts.push(...operatorServiceDrifts(catalog, entry, nowUnix))
  }

  return drifts
}

/** Disables every SKU that drifted. Immutable; returns a new catalog. */
export function applyDrift(catalog: Catalog, drifts: readonly CatalogDrift[]): Catalog {
  const disabled = [...new Set(drifts.map((d) => d.skuId))]
  if (disabled.length === 0) return catalog
  return catalog.withDisabled(
    disabled,
    'failed daily price reconciliation; awaiting human re-approval',
  )
}

/** The daily pass against a real archive. */
export async function reconcileCatalogDaily(
  catalog: Catalog,
  rateCards: RateCardArchive,
  nowUnix: number,
): Promise<Omit<ReconciliationResult, 'snapshot'>> {
  // Resolve every card the catalog could need before entering the pure core,
  // so the core stays synchronous.
  const cards = new Map<string, RateCard | null>()
  for (const entry of catalog.entries) {
    if (entry.pricing !== 'third_party_pass_through') continue
    const vendorId = entry.sku.vendorId
    if (cards.has(vendorId)) continue
    cards.set(vendorId, await rateCards.latest(vendorId))
  }

  const drifts = computeDrifts(catalog, (vendorId) => cards.get(vendorId) ?? null, nowUnix)
  return { drifts, catalog: applyDrift(catalog, drifts), reconciledAtUnix: nowUnix }
}

/**
 * The whole daily job: reconcile, disable what drifted, seal a snapshot of the
 * result. The snapshot is taken AFTER disabling so it records the menu that was
 * actually in force, not the one we wished was.
 */
export async function runDailyReconciliation(
  catalog: Catalog,
  rateCards: RateCardArchive,
  snapshots: CatalogSnapshotArchive,
  nowUnix: number,
): Promise<ReconciliationResult> {
  const result = await reconcileCatalogDaily(catalog, rateCards, nowUnix)
  const snapshot = await snapshots.take(snapshotCatalog(result.catalog, nowUnix))
  return { ...result, snapshot }
}

/**
 * Throwing form for the load path. At startup a drift is not an operational
 * event to be reported, it is a reason not to come up: serving a catalog whose
 * prices do not reconcile is the one thing this package must never do.
 */
export function assertNoDrift(drifts: readonly CatalogDrift[]): void {
  if (drifts.length === 0) return
  const lines = drifts.map((d) => `  ${d.skuId} (${d.vendorId}): ${d.kind} - ${d.note}`)
  throw new PriceBookViolation(
    'reconciliation_failed',
    `${drifts.length} catalog price(s) did not reconcile:\n${lines.join('\n')}`,
  )
}
