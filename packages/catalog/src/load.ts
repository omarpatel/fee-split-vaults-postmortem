/**
 * THE LOADER. It refuses to start.
 *
 * Order matters, and it runs cheapest-and-most-specific first so the error a
 * human sees names the file and the field rather than an invariant three layers
 * down:
 *
 *   1. Parse and validate every record. A SKU WITH NO DELIVERY PREDICATE STOPS
 *      THE PROCESS HERE. "No predicate, no purchase" is not a runtime check at
 *      the point of sale, because by then the money is already moving; it is a
 *      condition of the catalog existing at all.
 *   2. Verify every seal. A price edited without re-sealing does not load.
 *   3. Build the allowlist.
 *   4. Assert the two price books over the whole catalog.
 *   5. Assert tier availability, so nothing is offered at a tier that cannot
 *      fund it.
 *   6. Optionally reconcile against the archive at a caller-supplied time.
 *
 * Steps 1-5 are time-independent by design, so the suite that proves them does
 * not start failing on a Tuesday. Freshness is step 6, and a production boot
 * passes `nowUnix` to get it.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { CatalogError } from './errors.js'
import { sealHash } from './hash.js'
import { Catalog } from './catalog.js'
import { assertTwoPriceBooks } from './pricebook.js'
import { assertTierAvailability } from './tiers.js'
import { assertRateCardSealed, InMemoryRateCardArchive } from './archive.js'
import type { RateCardArchive } from './archive.js'
import { assertNoDrift, computeDrifts, reconcileCatalogDaily } from './reconcile.js'
import {
  parseOperatorRateSchedule,
  parseRateCard,
  parseSkusFile,
  parseVendorsFile,
} from './schema.js'
import { dataPaths, defaultDataDir, OPERATOR_SCHEDULE_BASENAME } from './paths.js'
import type { CatalogDrift, OperatorRateSchedule, RateCard, VendorRecord } from './types.js'

export interface LoadOptions {
  dataDir?: string
  /**
   * Supply a wall-clock time to also run the freshness half: stale rate cards,
   * expired price provenance. Omit it in tests that are about structure.
   */
  nowUnix?: number
}

export interface LoadedCatalog {
  catalog: Catalog
  /** Empty unless `nowUnix` was supplied; non-empty means the load threw. */
  drifts: CatalogDrift[]
  dataDir: string
}

function readJson(path: string): unknown {
  if (!existsSync(path)) {
    throw new CatalogError('load', 'missing_file', `${path} does not exist`)
  }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new CatalogError(
      'load',
      'unreadable_file',
      `${path} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new CatalogError(
      'load',
      'malformed_json',
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** Verifies the schedule's own seal before anything is priced against it. */
export function assertScheduleSealed(schedule: OperatorRateSchedule, where: string): void {
  const expected = sealHash(schedule as unknown as Record<string, unknown>, 'sealHash')
  if (expected !== schedule.sealHash) {
    throw new CatalogError(
      'load',
      'schedule_seal_mismatch',
      `${where} is sealed ${schedule.sealHash.slice(0, 12)} but hashes to ${expected.slice(0, 12)}. ` +
        `A published rate was edited without re-sealing; run "npm run seal -w @fee-split-vaults/catalog".`,
    )
  }
}

export function loadRateCards(rateCardDir: string): RateCard[] {
  if (!existsSync(rateCardDir)) {
    throw new CatalogError('load', 'missing_rate_card_dir', `${rateCardDir} does not exist`)
  }
  const cards: RateCard[] = []
  for (const name of readdirSync(rateCardDir).sort()) {
    if (!name.endsWith('.json')) continue
    if (name === OPERATOR_SCHEDULE_BASENAME) continue
    const path = join(rateCardDir, name)
    const card = parseRateCard(readJson(path), path)
    assertRateCardSealed(card, path)
    const expectedName = `${card.vendorId}.json`
    if (basename(path) !== expectedName) {
      throw new CatalogError(
        'load',
        'misfiled_rate_card',
        `${path} holds the card for vendor "${card.vendorId}" and must be named ${expectedName}`,
      )
    }
    cards.push(card)
  }
  return cards
}

/**
 * Load, validate, and refuse to start on anything that does not hold.
 *
 * Every failure path here throws. There is no partial catalog, no "load what we
 * can" mode, and no flag to skip a check, because each of those is a way for a
 * marked-up or unverifiable line item to reach a client.
 */
export function loadCatalog(options: LoadOptions = {}): LoadedCatalog {
  const dataDir = options.dataDir ?? defaultDataDir()
  const paths = dataPaths(dataDir)

  // 1. Parse. A SKU with no delivery predicate dies inside parseSkusFile.
  const vendors: VendorRecord[] = parseVendorsFile(readJson(paths.vendors))
  const entries = parseSkusFile(readJson(paths.skus))

  // 2. Seals.
  const schedule = parseOperatorRateSchedule(
    readJson(paths.operatorRateSchedule),
    paths.operatorRateSchedule,
  )
  assertScheduleSealed(schedule, paths.operatorRateSchedule)
  const rateCards = loadRateCards(paths.rateCardDir)

  // 3. Allowlist.
  const catalog = new Catalog({ vendors, entries, rateCards, schedules: [schedule] })

  // 4. The two price books, over everything.
  assertTwoPriceBooks(catalog.entries, {
    rateCards: new Map(rateCards.map((card) => [card.vendorId, card])),
    schedules: new Map([[schedule.ref, schedule]]),
    vendors: new Map(vendors.map((vendor) => [vendor.id, vendor])),
  })

  // 5. Nothing offered at a tier that cannot fund it.
  for (const entry of catalog.entries) assertTierAvailability(entry)

  // A SKU may not be enabled behind a disabled vendor: the menu would offer a
  // line nobody is cleared to buy from.
  for (const entry of catalog.entries) {
    if (!entry.enabled) continue
    const vendor = catalog.vendor(entry.sku.vendorId)
    if (!vendor.enabled) {
      throw new CatalogError(
        'load',
        'enabled_sku_disabled_vendor',
        `sku ${entry.sku.id} is enabled but its vendor "${vendor.id}" is not`,
      )
    }
  }

  if (options.nowUnix === undefined) {
    return { catalog, drifts: [], dataDir }
  }

  // 6. Freshness, against the cards already in memory. `computeDrifts` is the
  //    synchronous core of the daily job, so the load path needs no await and
  //    no second read of the disk.
  const byVendor = new Map(rateCards.map((card) => [card.vendorId, card]))
  const drifts = computeDrifts(catalog, (vendorId) => byVendor.get(vendorId) ?? null, options.nowUnix)
  assertNoDrift(drifts)
  return { catalog, drifts, dataDir }
}

/**
 * The async form, for a boot that reconciles against the on-disk archive rather
 * than against the cards shipped alongside the catalog.
 */
export async function loadCatalogAsync(
  options: LoadOptions & { archive?: RateCardArchive } = {},
): Promise<LoadedCatalog> {
  const { catalog, dataDir } = loadCatalog({ dataDir: options.dataDir })
  if (options.nowUnix === undefined) return { catalog, drifts: [], dataDir }

  const archive = options.archive ?? new InMemoryRateCardArchive(catalog.rateCards)
  const result = await reconcileCatalogDaily(catalog, archive, options.nowUnix)
  assertNoDrift(result.drifts)
  return { catalog: result.catalog, drifts: result.drifts, dataDir }
}
