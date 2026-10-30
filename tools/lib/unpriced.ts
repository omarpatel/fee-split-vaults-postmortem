/**
 * The unpriced-population guard.
 *
 * THE DEFECT THIS FILE EXISTS FOR. A live run against the fee escrow whose
 * credit assets had no USD price printed exactly this:
 *
 *     tier               gate  ever >= gate  7d median >= gate  run >= 7d  run >= 14d
 *     T1 Desk       $1000/day             0                  0          0           0
 *     T2 Campaign   $2500/day             0                  0          0           0
 *     T3 Flagship  $20000/day             0                  0          0           0
 *
 * Every zero there was an artefact of a missing price. The real answer, once
 * the same window was priced, was 140 / 83 / 14. A reader glancing at that
 * table concludes there is no market and kills the business on a formatting
 * artefact. The per-recipient rows were worse: they printed "n/a" for the
 * window total while printing "$0.00" for peak/day in the SAME ROW, so the
 * table contradicted itself and the $0.00 won the eye.
 *
 * THE RULES, applied by every renderer in tools/:
 *
 *   1. A USD figure derived from an unpriced amount renders as the single
 *      marker UNPRICED (format.ts). Never 0, never "$0.00", never blank.
 *   2. A COUNT over a population containing any unpriced member is not a
 *      count. It is refused, not rendered - a lower bound presented in a
 *      column headed "ever >= gate" is read as a measurement.
 *   3. The run says so loudly, up front, with the numbers behind the refusal.
 *   4. The process exit code is not 0.
 *
 * The toolkit's own warning block already said "a wrong signature yields zero
 * credits, which reads exactly like no market". Missing prices are the same
 * failure with a different cause, and nothing guarded it.
 */

import { UNPRICED } from './format.ts'
import type { EscrowSeriesDocument, RecipientSeries } from './series.ts'

/**
 * How much of a document could actually be valued in USD.
 *
 * Every consumer of a USD figure has to consult this first. `complete: false`
 * does not mean "some rounding is off"; it means the gate counts, the tenure
 * cohorts and the daily totals are not measurements of the market, because the
 * population they are computed over contains amounts of unknown value.
 */
export interface PricingCoverage {
  /** Distinct credit assets seen in the window. */
  assetsSeen: number
  assetsUnpriced: number
  /** A short sample; the full list lives in the document. */
  unpricedAssetSample: string[]
  recipientsTotal: number
  /** Recipients holding at least one credit in an unpriced asset. */
  recipientsUnpriced: number
  creditsTotal: number
  /** Raw credit EVENTS whose asset has no price. */
  creditsUnpriced: number
  /** creditsUnpriced / creditsTotal. */
  unpricedCreditShare: number
  /** True when every credit in the window could be valued. */
  complete: boolean
  /**
   * True when counted from the credit stream at aggregation time. False when
   * reconstructed from a stored document, where per-day asset keys are known
   * but per-credit assets are not - then `creditsUnpriced` is an upper bound
   * and is labelled as one rather than passed off as a count.
   */
  exact: boolean
}

/** Coverage for a run that priced everything it saw. */
export function fullyPricedCoverage(recipients: number, credits: number, assets: number): PricingCoverage {
  return {
    assetsSeen: assets,
    assetsUnpriced: 0,
    unpricedAssetSample: [],
    recipientsTotal: recipients,
    recipientsUnpriced: 0,
    creditsTotal: credits,
    creditsUnpriced: 0,
    unpricedCreditShare: 0,
    complete: true,
    exact: true,
  }
}

/**
 * Pricing coverage for a document, however it was obtained.
 *
 * Prefers the exact block written at aggregation time. Documents without one -
 * anything written before this guard existed - get it RECONSTRUCTED from the
 * day buckets. The reconstruction cannot see per-credit assets, so it counts
 * every credit in a day that CONTAINS an unpriced asset: an upper bound,
 * flagged `exact: false` and reported as an upper bound wherever it is printed.
 */
export function pricingCoverage(document: EscrowSeriesDocument): PricingCoverage {
  const stored = (document as { pricing?: PricingCoverage }).pricing
  if (stored !== undefined) return stored

  const unpriced = new Set(document.unpricedAssets ?? [])
  let recipientsUnpriced = 0
  let creditsUnpriced = 0
  for (const recipient of document.recipients) {
    let touched = false
    for (const day of recipient.days) {
      if (!Object.keys(day.byAssetMinor).some((asset) => unpriced.has(asset))) continue
      touched = true
      creditsUnpriced += day.creditCount
    }
    if (!touched && Object.keys(recipient.totalByAssetMinor).some((a) => unpriced.has(a))) {
      touched = true
    }
    if (touched) recipientsUnpriced++
  }
  const assetsUnpriced = (document.unpricedAssets ?? []).length
  return {
    assetsSeen: Object.keys(document.priceUsdByAsset ?? {}).length,
    assetsUnpriced,
    unpricedAssetSample: (document.unpricedAssets ?? []).slice(0, 5),
    recipientsTotal: document.recipients.length,
    recipientsUnpriced,
    creditsTotal: document.totalCredits,
    creditsUnpriced,
    unpricedCreditShare:
      document.totalCredits === 0 ? 0 : Math.min(1, creditsUnpriced / document.totalCredits),
    complete: assetsUnpriced === 0,
    exact: false,
  }
}

function share(n: number, of: number): string {
  return of === 0 ? '0.0%' : `${((n / of) * 100).toFixed(1)}%`
}

/**
 * The loud banner. Printed at the TOP of the report, before any table, and the
 * same facts go into the report's incompleteReasons so the JSON carries them
 * too.
 */
export function unpricedBannerLines(coverage: PricingCoverage): string[] {
  return [
    'PRICES ARE MISSING. THE GATE COUNTS BELOW ARE NOT A MEASUREMENT OF THE MARKET.',
    '',
    `${coverage.assetsUnpriced.toLocaleString()} of ${coverage.assetsSeen.toLocaleString()} credit asset(s) have no USD price` +
      (coverage.unpricedAssetSample.length > 0
        ? `, e.g. ${coverage.unpricedAssetSample.slice(0, 3).join(' ')}`
        : '') +
      '.',
    `${coverage.recipientsUnpriced.toLocaleString()} of ${coverage.recipientsTotal.toLocaleString()} recipients (${share(coverage.recipientsUnpriced, coverage.recipientsTotal)}) hold at least one unpriced credit.`,
    `${coverage.creditsUnpriced.toLocaleString()} of ${coverage.creditsTotal.toLocaleString()} raw credit events (${share(coverage.creditsUnpriced, coverage.creditsTotal)}) are unpriced` +
      (coverage.exact ? '.' : ' (UPPER BOUND: reconstructed from a stored document).'),
    '',
    'A zero in a USD column below would be an artefact of the missing price, not a finding.',
    `Unknown USD figures print ${UNPRICED}. Counts over an unpriced population are REFUSED.`,
    'Fix: set VENUE_PRICE_USD_<SYMBOL>, and/or pass --assets with the right addresses and',
    'decimals for these assets, then re-run. Until then this run has measured nothing.',
  ]
}

/** The same facts as flat sentences, for meta.incompleteReasons and warnings. */
export function unpricedReasons(coverage: PricingCoverage): string[] {
  return [
    `${coverage.assetsUnpriced} of ${coverage.assetsSeen} credit asset(s) have no USD price, ` +
      `covering ${coverage.recipientsUnpriced} of ${coverage.recipientsTotal} recipients and ` +
      `${share(coverage.creditsUnpriced, coverage.creditsTotal)} of raw credit events` +
      (coverage.exact ? '.' : ' (upper bound, reconstructed from a stored document).'),
    'Every USD-denominated conclusion in this run was REFUSED rather than computed. The gate ' +
      'counts are not zero; they are unknown. Do not read the absence of a number as the absence ' +
      'of a market.',
    `Unpriced assets (first ${coverage.unpricedAssetSample.length}): ${coverage.unpricedAssetSample.join(', ') || 'none recorded'}. ` +
      'The full list is in the JSON under result.unpricedAssets.',
  ]
}

/** True when every day of this recipient's window could be valued in USD. */
export function isFullyPriced(recipient: RecipientSeries): boolean {
  return recipient.totalUsd !== null && recipient.days.every((d) => d.usd !== null)
}

/** The daily USD series with the gaps left visible, for renderers. */
export function usdSeriesOrNull(
  recipient: RecipientSeries,
): Array<{ dayUnix: number; value: number | null }> {
  return recipient.days.map((d) => ({ dayUnix: d.dayUnix, value: d.usd }))
}

/**
 * Peak daily USD, or null when any day of the window is unpriced.
 *
 * The old code was `Math.max(0, ...days.map((d) => d.usd ?? 0))`, which has two
 * separate bugs in one line: the `?? 0` turns an unknown day into a zero day,
 * and the leading `0` floors the answer at zero so a recipient with nothing but
 * unpriced days reports a peak of exactly $0.00.
 */
export function peakDailyUsd(recipient: RecipientSeries): number | null {
  let peak: number | null = null
  for (const day of recipient.days) {
    if (day.usd === null) return null
    peak = peak === null ? day.usd : Math.max(peak, day.usd)
  }
  return peak
}

/** Trailing-window median of daily USD, or null when the window is unpriced. */
export function trailingMedianUsd(recipient: RecipientSeries, window: number): number | null {
  const tail = recipient.days.slice(Math.max(0, recipient.days.length - window))
  if (tail.length === 0) return null
  const values: number[] = []
  for (const day of tail) {
    if (day.usd === null) return null
    values.push(day.usd)
  }
  values.sort((a, b) => a - b)
  const mid = Math.floor(values.length / 2)
  return values.length % 2 === 1 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2
}
