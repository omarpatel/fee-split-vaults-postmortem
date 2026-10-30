/**
 * The escrow-index output document, and the aggregation that produces it.
 *
 * This shape is a published interface: tenure.ts and reprice.ts read it, and
 * so will anyone re-running the measurement later. Minor units cross as decimal
 * STRINGS (see json.ts); USD figures carry their price provenance.
 */

import { toMinor } from './json.ts'
import type { PriceBook } from './prices.ts'
import type { CreditEventMode, CreditScanMode, EscrowCredit } from './escrow.ts'
import { SECONDS_PER_DAY, dayStartUnix, isoDate } from './time.ts'
import type { PricingCoverage } from './unpriced.ts'

/**
 * Bumped from -1 for a reason that is not cosmetic: in a -1 document the keys of
 * `byAssetMinor` were whatever address sat at indexed position 1 of the credit
 * event, which for the native event is the DEPOSITOR. A consumer that reads a -1
 * document as if those keys were assets gets a per-asset breakdown of nonsense.
 * The version bump makes that a loud parse failure instead.
 */
export const ESCROW_SERIES_SCHEMA = 'escrow-daily-credits-2'

export interface DailyPoint {
  dayUnix: number
  dateUtc: string
  /** Minor units per asset address, as decimal strings. Native is address(0). */
  byAssetMinor: Record<string, string>
  /** USD sum across assets. null when any asset in the day is unpriced. */
  usd: number | null
  creditCount: number
}

/** One scanned credit event, recorded so a merged run says exactly what it read. */
export interface CreditEventDescriptor {
  mode: CreditEventMode
  signature: string
  topic0: string
}

/** Window totals for one asset, native and ERC-20 distinguishable by `kind`. */
export interface AssetTotal {
  asset: string
  kind: 'native' | 'erc20'
  symbol: string
  decimals: number
  totalMinor: string
  /** Distinct recipients credited in this asset. */
  recipients: number
  credits: number
  priceUsd: number | null
  totalUsd: number | null
}

export interface RecipientSeries {
  recipient: string
  firstCreditUnix: number
  lastCreditUnix: number
  /** Days with at least one credit. */
  activeDays: number
  totalByAssetMinor: Record<string, string>
  totalUsd: number | null
  /** Contiguous, zero-filled over the whole observation window. */
  days: DailyPoint[]
}

export interface EscrowSeriesDocument {
  schema: typeof ESCROW_SERIES_SCHEMA
  escrow: string
  chainId: number
  /**
   * Human summary of what was scanned. When more than one credit event was
   * merged these are the signatures joined by " + "; `events` is authoritative.
   */
  eventSignature: string
  topic0: string
  /** native | token | both. `both` is the only mode that cannot undercount. */
  mode: CreditScanMode
  /** Every credit event this document merged, in scan order. */
  events: CreditEventDescriptor[]
  backend: string
  fromBlock: string
  toBlock: string
  windowStartDayUnix: number
  windowEndDayUnix: number
  windowDays: number
  /** Price provenance for every USD figure in this document. */
  priceSource: string
  pricedAtUnix: number
  priceUsdByAsset: Record<string, number | null>
  assetDecimals: Record<string, number>
  assetSymbols: Record<string, string>
  /**
   * native | erc20 per asset address. Taken from the EVENT that carried the
   * credit, never guessed from the address, so a merged document says which
   * side of the escrow each figure came from.
   */
  assetKinds: Record<string, 'native' | 'erc20'>
  /** Window totals per asset, largest USD first. The per-asset breakdown. */
  assetTotals: AssetTotal[]
  unpricedAssets: string[]
  totalCredits: number
  /**
   * Exact pricing coverage, counted from the credit stream. Optional only so
   * that documents written before this field existed still parse; read it
   * through pricingCoverage(), which reconstructs it when it is absent.
   */
  pricing?: PricingCoverage
  recipients: RecipientSeries[]
}

export interface AggregateOptions {
  escrow: string
  chainId: number
  mode: CreditScanMode
  events: readonly CreditEventDescriptor[]
  backend: string
  fromBlock: bigint
  toBlock: bigint
  windowStartUnix: number
  windowEndUnix: number
  prices: PriceBook
  /** Zero-fill every day in the window, so a gap is a real zero, not a missing key. */
  zeroFill?: boolean
}

/**
 * Fold credits into per-recipient daily series.
 *
 * Zero-filling matters more than it looks: tenure is "consecutive days at or
 * above a gate", and a day with no credit is a day BELOW the gate. If absent
 * days were simply skipped, every dormant stretch would vanish and every coin
 * would look continuously active.
 */
export function aggregateDailyCredits(
  credits: readonly EscrowCredit[],
  options: AggregateOptions,
): EscrowSeriesDocument {
  const windowStartDay = dayStartUnix(options.windowStartUnix)
  const windowEndDay = dayStartUnix(options.windowEndUnix)
  const windowDays = (windowEndDay - windowStartDay) / SECONDS_PER_DAY + 1

  const byRecipient = new Map<
    string,
    {
      first: number
      last: number
      days: Map<number, { byAsset: Map<string, bigint>; count: number }>
      total: Map<string, bigint>
    }
  >()
  const seenAssets = new Set<string>()
  const assetKind = new Map<string, 'native' | 'erc20'>()
  const assetStats = new Map<string, { minor: bigint; credits: number; recipients: Set<string> }>()

  for (const credit of credits) {
    seenAssets.add(credit.asset)
    const priorKind = assetKind.get(credit.asset)
    if (priorKind !== undefined && priorKind !== credit.assetKind) {
      // Cannot happen with the real events - the native sentinel is only ever
      // produced by the native decoder - so if it does, something is wrong with
      // the event plans and a silent last-writer-wins would hide it.
      throw new Error(
        `asset ${credit.asset} arrived as both ${priorKind} and ${credit.assetKind}; ` +
          `the credit event plans disagree about what this address is.`,
      )
    }
    assetKind.set(credit.asset, credit.assetKind)
    let stat = assetStats.get(credit.asset)
    if (stat === undefined) {
      stat = { minor: 0n, credits: 0, recipients: new Set() }
      assetStats.set(credit.asset, stat)
    }
    stat.minor += credit.amountMinor
    stat.credits++
    stat.recipients.add(credit.recipient)

    let entry = byRecipient.get(credit.recipient)
    if (entry === undefined) {
      entry = {
        first: credit.timestampUnix,
        last: credit.timestampUnix,
        days: new Map(),
        total: new Map(),
      }
      byRecipient.set(credit.recipient, entry)
    }
    entry.first = Math.min(entry.first, credit.timestampUnix)
    entry.last = Math.max(entry.last, credit.timestampUnix)
    entry.total.set(credit.asset, (entry.total.get(credit.asset) ?? 0n) + credit.amountMinor)

    const day = dayStartUnix(credit.timestampUnix)
    let bucket = entry.days.get(day)
    if (bucket === undefined) {
      bucket = { byAsset: new Map(), count: 0 }
      entry.days.set(day, bucket)
    }
    bucket.byAsset.set(credit.asset, (bucket.byAsset.get(credit.asset) ?? 0n) + credit.amountMinor)
    bucket.count++
  }

  const priceUsdByAsset: Record<string, number | null> = {}
  const assetDecimals: Record<string, number> = {}
  const assetSymbols: Record<string, string> = {}
  const assetKinds: Record<string, 'native' | 'erc20'> = {}
  const unpricedAssets: string[] = []
  for (const asset of seenAssets) {
    const meta = options.prices.asset(asset)
    const price = options.prices.priceOf(asset)
    priceUsdByAsset[asset] = price ?? null
    assetDecimals[asset] = meta?.decimals ?? 18
    assetSymbols[asset] = meta?.symbol ?? 'UNKNOWN'
    assetKinds[asset] = assetKind.get(asset) ?? 'erc20'
    if (price === undefined) unpricedAssets.push(asset)
  }

  const assetTotals: AssetTotal[] = [...assetStats.entries()]
    .map(([asset, stat]) => {
      const priced = options.prices.toUsd(asset, stat.minor)
      return {
        asset,
        kind: assetKinds[asset]!,
        symbol: assetSymbols[asset]!,
        decimals: assetDecimals[asset]!,
        totalMinor: stat.minor.toString(),
        recipients: stat.recipients.size,
        credits: stat.credits,
        priceUsd: priceUsdByAsset[asset] ?? null,
        totalUsd: priced?.usd ?? null,
      }
    })
    .sort((a, b) => (b.totalUsd ?? -1) - (a.totalUsd ?? -1) || b.credits - a.credits)

  const usdOf = (byAsset: Map<string, bigint>): number | null => {
    let total = 0
    for (const [asset, amount] of byAsset) {
      const priced = options.prices.toUsd(asset, amount)
      // A day containing an unpriced asset is null, not a partial sum: a
      // partial sum silently understates a gate test.
      if (priced === undefined) return null
      total += priced.usd
    }
    return total
  }

  const recipients: RecipientSeries[] = []
  for (const [recipient, entry] of byRecipient) {
    const days: DailyPoint[] = []
    const dayKeys = options.zeroFill === false ? [...entry.days.keys()].sort((a, b) => a - b) : null
    const iterate =
      dayKeys ??
      Array.from({ length: windowDays }, (_, i) => windowStartDay + i * SECONDS_PER_DAY)

    for (const day of iterate) {
      const bucket = entry.days.get(day)
      const byAsset = bucket?.byAsset ?? new Map<string, bigint>()
      days.push({
        dayUnix: day,
        dateUtc: isoDate(day),
        byAssetMinor: Object.fromEntries([...byAsset].map(([a, v]) => [a, v.toString()])),
        usd: bucket === undefined ? 0 : usdOf(byAsset),
        creditCount: bucket?.count ?? 0,
      })
    }

    recipients.push({
      recipient,
      firstCreditUnix: entry.first,
      lastCreditUnix: entry.last,
      activeDays: entry.days.size,
      totalByAssetMinor: Object.fromEntries([...entry.total].map(([a, v]) => [a, v.toString()])),
      totalUsd: usdOf(entry.total),
      days,
    })
  }

  recipients.sort((a, b) => (b.totalUsd ?? -1) - (a.totalUsd ?? -1))

  // Counted from the credit stream, so this is exact rather than inferred from
  // the day buckets: a day carries asset keys but not per-asset credit counts.
  const unpricedAssetSet = new Set(unpricedAssets)
  let creditsUnpriced = 0
  const unpricedRecipientSet = new Set<string>()
  for (const credit of credits) {
    if (!unpricedAssetSet.has(credit.asset)) continue
    creditsUnpriced++
    unpricedRecipientSet.add(credit.recipient)
  }
  const pricing: PricingCoverage = {
    assetsSeen: seenAssets.size,
    assetsUnpriced: unpricedAssets.length,
    unpricedAssetSample: unpricedAssets.slice(0, 5),
    recipientsTotal: recipients.length,
    recipientsUnpriced: unpricedRecipientSet.size,
    creditsTotal: credits.length,
    creditsUnpriced,
    unpricedCreditShare: credits.length === 0 ? 0 : creditsUnpriced / credits.length,
    complete: unpricedAssets.length === 0,
    exact: true,
  }

  return {
    schema: ESCROW_SERIES_SCHEMA,
    escrow: options.escrow.toLowerCase(),
    chainId: options.chainId,
    eventSignature: options.events.map((e) => e.signature).join(' + '),
    topic0: options.events.map((e) => e.topic0).join(' + '),
    mode: options.mode,
    events: options.events.map((e) => ({ ...e })),
    backend: options.backend,
    fromBlock: options.fromBlock.toString(),
    toBlock: options.toBlock.toString(),
    windowStartDayUnix: windowStartDay,
    windowEndDayUnix: windowEndDay,
    windowDays,
    priceSource: options.prices.source,
    pricedAtUnix: options.prices.pinnedAtUnix,
    priceUsdByAsset,
    assetDecimals,
    assetSymbols,
    assetKinds,
    assetTotals,
    unpricedAssets,
    totalCredits: credits.length,
    pricing,
    recipients,
  }
}

/**
 * A stored document this build refuses to read.
 *
 * Named so the CLI prints the one-line fix instead of a stack trace: since the
 * schema bump to -2, meeting a -1 artifact on disk is an ordinary operating
 * condition, not a defect. It is still fatal - a -1 document's per-asset keys
 * are depositors, and nothing can retro-fit an asset onto them.
 */
export class EscrowSeriesSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EscrowSeriesSchemaError'
  }
}

/** Validate a document read back from disk. Fails closed on shape drift. */
export function parseEscrowSeriesDocument(value: unknown): EscrowSeriesDocument {
  if (typeof value !== 'object' || value === null) {
    throw new Error('escrow series: not an object')
  }
  const doc = value as Record<string, unknown>
  // Tolerate the { meta, result } report envelope that the CLI writes.
  if (doc.schema === undefined && typeof doc.result === 'object' && doc.result !== null) {
    return parseEscrowSeriesDocument(doc.result)
  }
  if (doc.schema !== ESCROW_SERIES_SCHEMA) {
    throw new EscrowSeriesSchemaError(
      `escrow series: expected schema "${ESCROW_SERIES_SCHEMA}", got "${String(doc.schema)}". ` +
        (doc.schema === 'escrow-daily-credits-1'
          ? 'A -1 document keyed its per-asset amounts by indexed parameter 1, which for the native ' +
            'credit event is the DEPOSITOR, not an asset. Its per-asset figures cannot be repaired. '
          : '') +
        `Re-run escrow-index.ts to regenerate.`,
    )
  }
  if (!Array.isArray(doc.recipients)) throw new Error('escrow series: recipients must be an array')
  for (const [i, raw] of doc.recipients.entries()) {
    const recipient = raw as Record<string, unknown>
    if (typeof recipient.recipient !== 'string') {
      throw new Error(`escrow series: recipients[${i}].recipient missing`)
    }
    if (!Array.isArray(recipient.days)) {
      throw new Error(`escrow series: recipients[${i}].days must be an array`)
    }
    for (const point of recipient.days as Array<Record<string, unknown>>) {
      // Force the money rule: minor units must be strings, never JSON numbers.
      for (const [asset, amount] of Object.entries(
        (point.byAssetMinor ?? {}) as Record<string, unknown>,
      )) {
        toMinor(amount, `recipients[${i}].days[].byAssetMinor.${asset}`)
      }
    }
  }
  return doc as unknown as EscrowSeriesDocument
}

/**
 * Thrown rather than silently substituting zero for an unpriced day.
 *
 * This line used to read `value: d.usd ?? 0`, and that single `?? 0` was the
 * whole defect: an unpriced day entered the survival analysis as a day BELOW
 * every gate, so an escrow whose assets had no prices produced empty cohorts
 * that read as "nobody clears the gate" rather than "we could not tell".
 */
export class UnpricedSeriesError extends Error {
  readonly recipient: string

  constructor(recipient: string, dateUtc: string) {
    super(
      `recipient ${recipient} has no USD value for ${dateUtc}. A gate test cannot treat an ` +
        `unpriced day as $0 - price the asset, or use usdSeriesOrNull() and render the gap.`,
    )
    this.name = 'UnpricedSeriesError'
    this.recipient = recipient
  }
}

/**
 * The daily USD series for one recipient, as tenure analysis wants it.
 *
 * Refuses an unpriced day rather than zero-filling it. Callers that must
 * tolerate unpriced recipients filter them out first with isFullyPriced().
 */
export function usdSeries(recipient: RecipientSeries): Array<{ dayUnix: number; value: number }> {
  return recipient.days.map((d) => {
    if (d.usd === null) throw new UnpricedSeriesError(recipient.recipient, d.dateUtc)
    return { dayUnix: d.dayUnix, value: d.usd }
  })
}

// usdSeriesOrNull(), isFullyPriced() and the coverage/banner helpers live in
// lib/unpriced.ts, next to the rest of the missing-price guard.
