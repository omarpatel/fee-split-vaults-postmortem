/**
 * QF measurement.
 *
 * QF is quote-denominated creator fees credited to the coin's own vault, in USD,
 * gross, as a trailing 7-day MEDIAN of daily credits.
 *
 * THE MEDIAN IS THE WHOLE POINT. A mean over seven days can be cleared by one day
 * of wash volume: $70,000 on a Tuesday and nothing else is a $10,000/day mean and
 * a $0/day median. Wash trading is cheap - the trader pays only the fee, and here
 * the fee comes back to them as the creator - so any gate built on a mean is a
 * gate that buys itself. Everything downstream of this file assumes the median.
 *
 * WHAT IS EXCLUDED, AND WHY EACH EXCLUSION IS A REFUSAL RATHER THAN A ZERO:
 *   unfinalised postings  - budget authority may only rest on finalized money.
 *   anti-snipe windfalls  - a 99% tax at t=0 would clear T3 on the first block.
 *   the launch token      - QF is quote-denominated by definition.
 *   disabled assets       - a paused issuer proxy strands escrow, so credits in
 *                           it are not spendable and must not authorise spending.
 *   days before coverage  - unknown is not zero; observedDays reports the gap and
 *                           a tier cannot be granted below seven observed days.
 */

import type { Address, Asset, AssetAddress, QfMeasurement } from '@fee-split-vaults/core'
import { addressEquals, type Hex } from './hex.js'
import type { CoinBinding, FeePosting } from './model.js'
import { DEFAULT_MAX_PRICE_AGE_SECONDS, requirePrice, toUsdValue, type PriceOracle } from './prices.js'
import { DAY_SECONDS } from './schedule.js'

export function utcDayIndex(unix: number): number {
  return Math.floor(unix / DAY_SECONDS)
}

/**
 * A true median: the middle value of an odd-length set, the mean of the two
 * middle values of an even-length one. Empty measures as zero, which is the
 * correct reading of "no observed days" for a gate.
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  const upper = sorted[middle] ?? 0
  if (sorted.length % 2 === 1) return upper
  return ((sorted[middle - 1] ?? 0) + upper) / 2
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((total, value) => total + value, 0) / values.length
}

export interface QfOptions {
  readonly nowUnix: number
  /** The gate sustainedDays is measured against. Usually TIERS[tier].gateQfPerDay. */
  readonly gateQfPerDay: number
  readonly windowDays?: number
  /** T2 and T3 need 14 consecutive days, so sustain is measured over a longer span. */
  readonly sustainedLookbackDays?: number
  readonly includeAntiSnipe?: boolean
  readonly maxPriceAgeSeconds?: number
}

export interface QfExclusions {
  readonly unfinalized: number
  readonly antiSnipe: number
  readonly launchToken: number
  readonly disabledAsset: number
  readonly unknownAsset: number
  readonly outsideWindow: number
}

export interface QfResult {
  readonly measurement: QfMeasurement
  /** Daily USD totals over the QF window, oldest first. */
  readonly dailyUsd: readonly number[]
  /**
   * Reported for the weekly report and for farm detection ONLY. A large gap
   * between mean and median is the signature of a one-day volume spike. Nothing
   * gates on this number.
   */
  readonly meanUsdNotForGating: number
  readonly excluded: QfExclusions
  readonly warnings: readonly string[]
}

interface DayBucket {
  usd: number
  perAsset: Map<string, { creditedMinor: bigint; blockHash: Hex | undefined; lastUnix: number }>
}

export interface QfInput {
  readonly binding: CoinBinding
  readonly postings: readonly FeePosting[]
  /** Approved quote assets, keyed lowercase. Absence is a refusal, not a skip. */
  readonly assets: ReadonlyMap<AssetAddress, Asset>
  readonly prices: PriceOracle
  readonly options: QfOptions
}

/**
 * Compute the measurement. Pure: it reads postings and prices and touches no
 * network, so a disputed tier decision can be replayed exactly from stored rows.
 */
export function computeQf(input: QfInput): QfResult {
  const { binding, postings, assets, prices, options } = input
  const windowDays = options.windowDays ?? 7
  const lookbackDays = Math.max(options.sustainedLookbackDays ?? 30, windowDays)
  const maxPriceAge = options.maxPriceAgeSeconds ?? DEFAULT_MAX_PRICE_AGE_SECONDS
  const includeAntiSnipe = options.includeAntiSnipe === true

  // Only COMPLETE UTC days are measured. A partial day is a partial count, and a
  // partial count in a median is a fabricated low reading.
  const lastCompleteDay = utcDayIndex(options.nowUnix) - 1
  const firstLookbackDay = lastCompleteDay - lookbackDays + 1
  const firstWindowDay = lastCompleteDay - windowDays + 1

  const excluded = {
    unfinalized: 0,
    antiSnipe: 0,
    launchToken: 0,
    disabledAsset: 0,
    unknownAsset: 0,
    outsideWindow: 0,
  }
  const warnings: string[] = []
  const buckets = new Map<number, DayBucket>()

  for (const posting of postings) {
    if (!posting.finalized) {
      excluded.unfinalized++
      continue
    }
    if (posting.classification === 'anti_snipe_window' && !includeAntiSnipe) {
      excluded.antiSnipe++
      continue
    }
    if (addressEquals(posting.asset, binding.token)) {
      excluded.launchToken++
      continue
    }

    const asset = assets.get(posting.asset.toLowerCase())
    if (!asset) {
      excluded.unknownAsset++
      warnings.push(`posting ${posting.id} is in unapproved asset ${posting.asset} and was excluded`)
      continue
    }
    if (!asset.enabled) {
      excluded.disabledAsset++
      warnings.push(
        `asset ${asset.symbol} is disabled by the kill switch; ${posting.id} grants no authority`,
      )
      continue
    }

    const day = utcDayIndex(posting.occurredAtUnix)
    if (day < firstLookbackDay || day > lastCompleteDay) {
      excluded.outsideWindow++
      continue
    }

    const price = requirePrice(prices, posting.asset, posting.occurredAtUnix, maxPriceAge)
    const bucket = buckets.get(day) ?? { usd: 0, perAsset: new Map() }
    const usdValue = toUsdValue(posting.creditedMinor, asset, price, posting.blockHash)
    bucket.usd += usdValue.usd

    const assetKey = posting.asset.toLowerCase()
    const existing = bucket.perAsset.get(assetKey)
    if (existing === undefined || posting.occurredAtUnix >= existing.lastUnix) {
      bucket.perAsset.set(assetKey, {
        creditedMinor: (existing?.creditedMinor ?? 0n) + posting.creditedMinor,
        blockHash: posting.blockHash,
        lastUnix: posting.occurredAtUnix,
      })
    } else {
      bucket.perAsset.set(assetKey, {
        ...existing,
        creditedMinor: existing.creditedMinor + posting.creditedMinor,
      })
    }
    buckets.set(day, bucket)
  }

  // Unknown is not zero: days before we started watching are not counted at all.
  const firstFullyObservedDay = Math.ceil(binding.coverageStartUnix / DAY_SECONDS)
  const observedDays = Math.max(
    0,
    Math.min(windowDays, lastCompleteDay - firstFullyObservedDay + 1),
  )

  const dailyUsd: number[] = []
  for (let day = Math.max(firstWindowDay, firstFullyObservedDay); day <= lastCompleteDay; day++) {
    dailyUsd.push(buckets.get(day)?.usd ?? 0)
  }

  let sustainedDays = 0
  for (let day = lastCompleteDay; day >= Math.max(firstLookbackDay, firstFullyObservedDay); day--) {
    const usd = buckets.get(day)?.usd ?? 0
    if (usd < options.gateQfPerDay) break
    sustainedDays++
  }

  const perAssetTotals = new Map<string, { creditedMinor: bigint; blockHash: Hex | undefined; lastUnix: number }>()
  for (let day = firstWindowDay; day <= lastCompleteDay; day++) {
    const bucket = buckets.get(day)
    if (!bucket) continue
    for (const [assetKey, entry] of bucket.perAsset) {
      const existing = perAssetTotals.get(assetKey)
      if (existing === undefined) {
        perAssetTotals.set(assetKey, { ...entry })
        continue
      }
      perAssetTotals.set(assetKey, {
        creditedMinor: existing.creditedMinor + entry.creditedMinor,
        blockHash: entry.lastUnix >= existing.lastUnix ? entry.blockHash : existing.blockHash,
        lastUnix: Math.max(existing.lastUnix, entry.lastUnix),
      })
    }
  }

  const perAsset: QfMeasurement['perAsset'] = []
  for (const [assetKey, entry] of perAssetTotals) {
    const asset = assets.get(assetKey)
    if (!asset) continue
    const price = requirePrice(prices, assetKey, entry.lastUnix, maxPriceAge)
    perAsset.push({
      asset: assetKey,
      creditedMinor: entry.creditedMinor,
      usd: toUsdValue(entry.creditedMinor, asset, price, entry.blockHash),
    })
  }

  const measurement: QfMeasurement = {
    vault: binding.vault,
    qfPerDay: median(dailyUsd),
    observedDays,
    sustainedDays,
    measuredAtUnix: options.nowUnix,
    perAsset,
  }

  return {
    measurement,
    dailyUsd,
    meanUsdNotForGating: mean(dailyUsd),
    excluded,
    warnings,
  }
}

/**
 * Cumulative FINALIZED credit per asset for a vault. This is the number budget
 * authority is drawn against: unfinalised money is money the chain may still
 * take back, and it has never authorised a purchase.
 */
export function finalizedCreditByAsset(
  postings: readonly FeePosting[],
  vault: Address,
): Map<AssetAddress, bigint> {
  const totals = new Map<AssetAddress, bigint>()
  for (const posting of postings) {
    if (!posting.finalized || !addressEquals(posting.vault, vault)) continue
    const key = posting.asset.toLowerCase()
    totals.set(key, (totals.get(key) ?? 0n) + posting.creditedMinor)
  }
  return totals
}
