/**
 * The arithmetic that turns per-asset minor units into a gated USD series.
 *
 * Used by tools/artifacts/reprice-merged.mjs; it lives here rather than beside
 * that script so tsc checks it and __tests__ can import it - tools/artifacts is
 * gitignored, and a committed test may not depend on an uncommitted tree.
 *
 * Three things in here are load-bearing, each with its own way of going wrong:
 *
 *   1. `valueDay` must apply each asset's OWN decimals. Getting this wrong is
 *      not a rounding error, it is a factor of 10^12 - which is exactly what
 *      happened when USDG's six decimals were assumed to be eighteen and
 *      $9,033,382.77 rendered as 9.033e-6.
 *   2. `valueDay` must report an unpriced asset as UNPRICED, never as zero. A
 *      partial sum that silently omits an unpriced holding understates a gate
 *      test, and a recipient understated below a gate simply disappears.
 *   3. The bigint must not be widened to a float before scaling. A large
 *      balance loses its low digits at 2^53, so the integer and fractional
 *      parts are separated first.
 */

/** Minor units per asset address, as decimal STRINGS - the on-disk shape. */
export type ByAssetMinor = Readonly<Record<string, string>>
/** Asset address -> USD per whole unit. */
export type PriceBook = ReadonlyMap<string, number>
/** Asset address -> 10n ** decimals, from the decimals the chain READ. */
export type ScaleTable = ReadonlyMap<string, bigint>

export interface DayValue {
  /**
   * Sum over the assets that had BOTH a price and a known scale. A LOWER BOUND
   * whenever `unpricedAssets` is non-zero. It is never a measurement of zero:
   * the caller must read the counts.
   */
  usd: number
  unpricedAssets: number
  /** Assets carrying a price but no decimals. Refused, never assumed to be 18. */
  missingScale: string[]
}

export function valueDay(byAssetMinor: ByAssetMinor, book: PriceBook, scaleOf: ScaleTable): DayValue {
  let usd = 0
  let unpricedAssets = 0
  const missingScale: string[] = []
  for (const [asset, minorText] of Object.entries(byAssetMinor)) {
    const price = book.get(asset)
    if (price === undefined) {
      unpricedAssets++
      continue
    }
    const scale = scaleOf.get(asset)
    if (scale === undefined) {
      // A price with no decimals is unusable, not "assume 18". Refusing here is
      // what keeps an unknown scale from becoming a wrong number.
      missingScale.push(asset)
      unpricedAssets++
      continue
    }
    const minor = BigInt(minorText)
    usd += (Number(minor / scale) + Number(minor % scale) / Number(scale)) * price
  }
  return { usd, unpricedAssets, missingScale }
}

/** Median of a numeric series. Even-length takes the mean of the middle pair. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * Longest run of CONSECUTIVE days at or above the gate.
 *
 * A day below the gate breaks the run rather than being skipped. That is the
 * whole point of the zero-filled series: a dormant day is a day below the gate,
 * not an absent one.
 */
export function longestRun(series: readonly number[], gate: number): number {
  let best = 0
  let current = 0
  for (const value of series) {
    current = value >= gate ? current + 1 : 0
    if (current > best) best = current
  }
  return best
}

/** Decimals -> 10n**decimals, for every asset whose decimals are known. */
export function scaleTable(assetDecimals: Readonly<Record<string, number>> | undefined): Map<string, bigint> {
  const scaleOf = new Map<string, bigint>()
  for (const [asset, decimals] of Object.entries(assetDecimals ?? {})) {
    scaleOf.set(asset.toLowerCase(), 10n ** BigInt(decimals))
  }
  return scaleOf
}
