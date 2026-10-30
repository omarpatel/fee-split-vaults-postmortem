/**
 * THE ARCHIVE: what makes "we charged you what it cost" checkable rather than
 * merely stated.
 *
 * Two things are archived, both append-only and both content-addressed.
 *
 *   RATE CARDS. A copy of the vendor's price in force, taken daily. This is
 *   what a pass-through price is reconciled against. A card is never mutated -
 *   a price change produces a new card with a new hash, and the old one stays,
 *   because a purchase made last Tuesday must be auditable against last
 *   Tuesday's price and not against today's.
 *
 *   CATALOG SNAPSHOTS. The whole priced menu at one instant. This is the
 *   artefact that answers "what was this SKU's price on the day of that
 *   disbursement" without trusting anyone's memory, and `auditHistoricalPurchase`
 *   is the function that asks.
 *
 * Neither archive has a delete or an update. That is the point of them.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { CatalogError } from './errors.js'
import { canonicalJson, sealHash, sha256Hex } from './hash.js'
import { exactCentsFromUsd, formatCents } from './money.js'
import { parseRateCard } from './schema.js'
import type { Catalog } from './catalog.js'
import type {
  CatalogSnapshot,
  CatalogSnapshotLine,
  HistoricalPurchaseAudit,
  RateCard,
} from './types.js'

// ---------------------------------------------------------------------------
// Rate cards
// ---------------------------------------------------------------------------

export interface RateCardArchive {
  /** The most recent card on file for this vendor, or null. */
  latest(vendorId: string): Promise<RateCard | null>
  /** The card in force at a past instant. This is the audit path. */
  asOf(vendorId: string, atUnix: number): Promise<RateCard | null>
  /** Every card on file, oldest first. */
  history(vendorId: string): Promise<RateCard[]>
  /** Append. Re-archiving an identical card is a no-op, not a duplicate. */
  archive(card: RateCard): Promise<RateCard>
}

/** Recomputes the seal and refuses a card whose bytes were edited by hand. */
export function assertRateCardSealed(card: RateCard, where: string): void {
  const expected = sealHash(card as unknown as Record<string, unknown>, 'sourceHash')
  if (expected !== card.sourceHash) {
    throw new CatalogError(
      'archive',
      'seal_mismatch',
      `${where} is sealed ${card.sourceHash.slice(0, 12)} but its contents hash to ${expected.slice(0, 12)}. ` +
        `A price was edited without re-sealing; run "npm run seal -w @fee-split-vaults/catalog".`,
    )
  }
}

export class InMemoryRateCardArchive implements RateCardArchive {
  readonly #byVendor = new Map<string, RateCard[]>()

  constructor(seed: readonly RateCard[] = []) {
    for (const card of seed) this.#insert(card)
  }

  #insert(card: RateCard): RateCard {
    const list = this.#byVendor.get(card.vendorId) ?? []
    const existing = list.find(
      (c) => c.sourceHash === card.sourceHash && c.archivedAtUnix === card.archivedAtUnix,
    )
    if (existing !== undefined) return existing
    list.push(card)
    list.sort((a, b) => a.archivedAtUnix - b.archivedAtUnix)
    this.#byVendor.set(card.vendorId, list)
    return card
  }

  async latest(vendorId: string): Promise<RateCard | null> {
    const list = this.#byVendor.get(vendorId)
    if (list === undefined || list.length === 0) return null
    return list[list.length - 1] ?? null
  }

  async asOf(vendorId: string, atUnix: number): Promise<RateCard | null> {
    const list = this.#byVendor.get(vendorId) ?? []
    let found: RateCard | null = null
    for (const card of list) {
      if (card.archivedAtUnix <= atUnix) found = card
      else break
    }
    return found
  }

  async history(vendorId: string): Promise<RateCard[]> {
    return [...(this.#byVendor.get(vendorId) ?? [])]
  }

  async archive(card: RateCard): Promise<RateCard> {
    assertRateCardSealed(card, `rate card for ${card.vendorId}`)
    return this.#insert(card)
  }
}

/**
 * Disk-backed archive. One directory per vendor, one immutable file per card,
 * named by timestamp and hash so the ordering is visible in a listing and a
 * re-archive of the same card is idempotent at the filesystem level.
 */
export class FileRateCardArchive implements RateCardArchive {
  constructor(private readonly rootDir: string) {}

  #dir(vendorId: string): string {
    return join(this.rootDir, vendorId)
  }

  #read(vendorId: string): RateCard[] {
    const dir = this.#dir(vendorId)
    if (!existsSync(dir)) return []
    const cards: RateCard[] = []
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.json')) continue
      const path = join(dir, name)
      const card = parseRateCard(JSON.parse(readFileSync(path, 'utf8')), path)
      assertRateCardSealed(card, path)
      cards.push(card)
    }
    return cards.sort((a, b) => a.archivedAtUnix - b.archivedAtUnix)
  }

  async latest(vendorId: string): Promise<RateCard | null> {
    const cards = this.#read(vendorId)
    return cards[cards.length - 1] ?? null
  }

  async asOf(vendorId: string, atUnix: number): Promise<RateCard | null> {
    let found: RateCard | null = null
    for (const card of this.#read(vendorId)) {
      if (card.archivedAtUnix <= atUnix) found = card
      else break
    }
    return found
  }

  async history(vendorId: string): Promise<RateCard[]> {
    return this.#read(vendorId)
  }

  async archive(card: RateCard): Promise<RateCard> {
    assertRateCardSealed(card, `rate card for ${card.vendorId}`)
    const dir = this.#dir(card.vendorId)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${card.archivedAtUnix}-${card.sourceHash.slice(0, 12)}.json`)
    // Append-only: an existing file for this (time, hash) pair is the same card.
    if (!existsSync(path)) {
      writeFileSync(path, `${JSON.stringify(card, null, 2)}\n`, 'utf8')
    }
    return card
  }
}

// ---------------------------------------------------------------------------
// Catalog snapshots
// ---------------------------------------------------------------------------

export interface CatalogSnapshotArchive {
  take(snapshot: CatalogSnapshot): Promise<CatalogSnapshot>
  /** The most recent snapshot taken at or before `atUnix`. */
  inForceAt(atUnix: number): Promise<CatalogSnapshot | null>
  byId(snapshotId: string): Promise<CatalogSnapshot | null>
  list(): Promise<CatalogSnapshot[]>
}

/** Builds today's snapshot from the live catalog and seals it. */
export function snapshotCatalog(catalog: Catalog, nowUnix: number): CatalogSnapshot {
  if (!Number.isSafeInteger(nowUnix) || nowUnix <= 0) {
    throw new CatalogError('archive', 'bad_snapshot_time', 'snapshot time must be a positive unix timestamp')
  }
  const lines: CatalogSnapshotLine[] = catalog.entries
    .map((entry) => {
      const reference =
        entry.pricing === 'third_party_pass_through'
          ? `ratecard:${entry.rateCardRef?.vendorId ?? entry.sku.vendorId}@${entry.rateCardRef?.sourceHash ?? 'unpinned'}`
          : `schedule:${entry.publishedRateRef ?? 'unpinned'}`
      return {
        skuId: entry.sku.id,
        vendorId: entry.sku.vendorId,
        pricing: entry.pricing,
        unitCents: exactCentsFromUsd(
          entry.sku.unitCostUsd,
          `sku ${entry.sku.id} unitCostUsd`,
        ).toString(),
        enabled: entry.enabled,
        availableAtTiers: [...entry.sku.availableAtTiers],
        priceReference: reference,
        provenanceObservedAtUnix: entry.priceProvenance.observedAtUnix,
      }
    })
    .sort((a, b) => (a.skuId < b.skuId ? -1 : a.skuId > b.skuId ? 1 : 0))

  const takenOnDate = new Date(nowUnix * 1000).toISOString().slice(0, 10)
  const snapshotId = sha256Hex(canonicalJson({ takenAtUnix: nowUnix, lines }))
  return { snapshotId, takenAtUnix: nowUnix, takenOnDate, lines }
}

export class InMemoryCatalogSnapshotArchive implements CatalogSnapshotArchive {
  readonly #snapshots: CatalogSnapshot[] = []

  constructor(seed: readonly CatalogSnapshot[] = []) {
    for (const snapshot of seed) this.#insert(snapshot)
  }

  #insert(snapshot: CatalogSnapshot): CatalogSnapshot {
    const existing = this.#snapshots.find((s) => s.snapshotId === snapshot.snapshotId)
    if (existing !== undefined) return existing
    this.#snapshots.push(snapshot)
    this.#snapshots.sort((a, b) => a.takenAtUnix - b.takenAtUnix)
    return snapshot
  }

  async take(snapshot: CatalogSnapshot): Promise<CatalogSnapshot> {
    return this.#insert(snapshot)
  }

  async inForceAt(atUnix: number): Promise<CatalogSnapshot | null> {
    let found: CatalogSnapshot | null = null
    for (const snapshot of this.#snapshots) {
      if (snapshot.takenAtUnix <= atUnix) found = snapshot
      else break
    }
    return found
  }

  async byId(snapshotId: string): Promise<CatalogSnapshot | null> {
    return this.#snapshots.find((s) => s.snapshotId === snapshotId) ?? null
  }

  async list(): Promise<CatalogSnapshot[]> {
    return [...this.#snapshots]
  }
}

export class FileCatalogSnapshotArchive implements CatalogSnapshotArchive {
  constructor(private readonly rootDir: string) {}

  #read(): CatalogSnapshot[] {
    if (!existsSync(this.rootDir)) return []
    const out: CatalogSnapshot[] = []
    for (const name of readdirSync(this.rootDir).sort()) {
      if (!name.endsWith('.json')) continue
      const path = join(this.rootDir, name)
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as CatalogSnapshot
      const expected = sha256Hex(
        canonicalJson({ takenAtUnix: parsed.takenAtUnix, lines: parsed.lines }),
      )
      if (expected !== parsed.snapshotId) {
        throw new CatalogError(
          'archive',
          'snapshot_seal_mismatch',
          `${path} claims id ${parsed.snapshotId.slice(0, 12)} but hashes to ${expected.slice(0, 12)}`,
        )
      }
      out.push(parsed)
    }
    return out.sort((a, b) => a.takenAtUnix - b.takenAtUnix)
  }

  async take(snapshot: CatalogSnapshot): Promise<CatalogSnapshot> {
    mkdirSync(this.rootDir, { recursive: true })
    const path = join(this.rootDir, `${snapshot.takenOnDate}-${snapshot.snapshotId.slice(0, 12)}.json`)
    if (!existsSync(path)) {
      writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    }
    return snapshot
  }

  async inForceAt(atUnix: number): Promise<CatalogSnapshot | null> {
    let found: CatalogSnapshot | null = null
    for (const snapshot of this.#read()) {
      if (snapshot.takenAtUnix <= atUnix) found = snapshot
      else break
    }
    return found
  }

  async byId(snapshotId: string): Promise<CatalogSnapshot | null> {
    return this.#read().find((s) => s.snapshotId === snapshotId) ?? null
  }

  async list(): Promise<CatalogSnapshot[]> {
    return this.#read()
  }
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

export interface HistoricalPurchaseQuery {
  skuId: string
  quantity: number
  /** Total charged to the client's procurement budget, in cents. */
  chargedCents: bigint
  disbursedAtUnix: number
}

/**
 * Audit one historical disbursement against the price that was in force on the
 * day it happened.
 *
 * Returns a verdict rather than throwing, because this runs over a whole
 * client's history in a report and one mismatch must not abort the other
 * ninety-nine lines. Callers that want a hard failure check `outcome`.
 */
export async function auditHistoricalPurchase(
  archive: CatalogSnapshotArchive,
  query: HistoricalPurchaseQuery,
): Promise<HistoricalPurchaseAudit> {
  const base = {
    skuId: query.skuId,
    disbursedAtUnix: query.disbursedAtUnix,
    chargedCents: query.chargedCents,
  }
  if (!Number.isSafeInteger(query.quantity) || query.quantity < 1) {
    return { ...base, outcome: 'amount_mismatch', note: 'quantity is not a positive integer' }
  }

  const snapshot = await archive.inForceAt(query.disbursedAtUnix)
  if (snapshot === null) {
    return {
      ...base,
      outcome: 'no_snapshot_in_force',
      note:
        `no catalog snapshot was archived at or before ${query.disbursedAtUnix}, so this purchase cannot ` +
        `be checked against the price in force. An unauditable purchase is an unproven one.`,
    }
  }

  const line = snapshot.lines.find((l) => l.skuId === query.skuId)
  if (line === undefined) {
    return {
      ...base,
      outcome: 'sku_absent_from_snapshot',
      snapshotId: snapshot.snapshotId,
      snapshotTakenAtUnix: snapshot.takenAtUnix,
      note: `sku ${query.skuId} was not in the catalog on ${snapshot.takenOnDate}`,
    }
  }

  const unit = BigInt(line.unitCents)
  const expected = unit * BigInt(query.quantity)
  const delta = query.chargedCents - expected
  if (delta !== 0n) {
    return {
      ...base,
      outcome: 'amount_mismatch',
      snapshotId: snapshot.snapshotId,
      snapshotTakenAtUnix: snapshot.takenAtUnix,
      priceInForceCents: expected,
      deltaCents: delta,
      note:
        `charged ${formatCents(query.chargedCents)} against a price in force of ${formatCents(expected)} ` +
        `(${formatCents(unit)} x ${query.quantity}) on ${snapshot.takenOnDate}: ${formatCents(delta)} out`,
    }
  }

  return {
    ...base,
    outcome: 'match',
    snapshotId: snapshot.snapshotId,
    snapshotTakenAtUnix: snapshot.takenAtUnix,
    priceInForceCents: expected,
    deltaCents: 0n,
    note: `matches the price in force on ${snapshot.takenOnDate} (snapshot ${snapshot.snapshotId.slice(0, 12)})`,
  }
}
