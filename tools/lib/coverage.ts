/**
 * Pricing coverage for a long tail of assets.
 *
 * THE PROBLEM THIS SOLVES. A live ERC-20 escrow run found credits in 263
 * distinct assets over two days. Pricing 263 issuer-launched memecoins
 * individually is not realistic, and the answer is emphatically not to guess:
 * an unpriced asset scored as zero understates a recipient's daily total, and
 * a recipient understated below a tier gate simply disappears from the
 * population count. A wrong population is worse than a partial one.
 *
 * SO THE DELIVERABLE IS NOT A NUMBER. It is a statement of the form
 *
 *   "assets covering X% of credits are priced; the remainder is unpriced and
 *    excluded"
 *
 * plus the ranked shortlist an operator should price next. Everything here
 * exists to make that statement computable and hard to misread.
 *
 * RANKING, per the two regimes that actually exist:
 *   - an asset whose decimals AND price are known has a determinable VALUE, so
 *     it ranks by value;
 *   - an asset that has neither has no value at all, so it ranks by RECIPIENT
 *     COUNT, which is the only signal left about how much it matters.
 * Mixing the two into one score would invent a comparison that the data does
 * not support.
 */

import type { EscrowCredit } from './escrow.ts'
import { minorToUnits, type PriceBook } from './prices.ts'
import type { TokenMetadata } from './token-metadata.ts'

export const COVERAGE_SCHEMA = 'pricing-coverage-1'

export interface AssetRollup {
  address: string
  symbol: string | null
  /** null is UNKNOWN. Nothing here substitutes 18. */
  decimals: number | null
  priceUsd: number | null
  creditCount: number
  recipientCount: number
  totalMinor: bigint
  /** null when decimals or price is unknown. NEVER zero for "we don't know". */
  valueUsd: number | null
  /** True only when the amount can be converted to USD at all. */
  priceable: boolean
  /** Why not, when not. */
  blockedBy: 'none' | 'decimals' | 'price' | 'decimals+price'
}

export interface RollupInput {
  metadata?: ReadonlyMap<string, TokenMetadata>
  prices: PriceBook
}

/** Fold credits into one row per asset, carrying everything coverage needs. */
export function rollupAssets(
  credits: readonly EscrowCredit[],
  input: RollupInput,
): AssetRollup[] {
  const byAsset = new Map<
    string,
    { creditCount: number; recipients: Set<string>; totalMinor: bigint }
  >()
  for (const credit of credits) {
    const key = credit.asset.toLowerCase()
    let entry = byAsset.get(key)
    if (entry === undefined) {
      entry = { creditCount: 0, recipients: new Set(), totalMinor: 0n }
      byAsset.set(key, entry)
    }
    entry.creditCount++
    entry.recipients.add(credit.recipient)
    entry.totalMinor += credit.amountMinor
  }

  const out: AssetRollup[] = []
  for (const [address, entry] of byAsset) {
    const meta = input.metadata?.get(address)
    const registered = input.prices.asset(address)
    // Decimals come from the resolver first, then from anything the operator
    // registered by hand. Absent both, they stay null.
    const decimals = meta?.decimals ?? registered?.decimals ?? null
    const symbol = meta?.symbol ?? registered?.symbol ?? null
    const priceUsd = input.prices.priceOf(address) ?? null
    const priceable = decimals !== null && priceUsd !== null
    out.push({
      address,
      symbol,
      decimals,
      priceUsd,
      creditCount: entry.creditCount,
      recipientCount: entry.recipients.size,
      totalMinor: entry.totalMinor,
      valueUsd: priceable ? minorToUnits(entry.totalMinor, decimals) * priceUsd : null,
      priceable,
      blockedBy:
        decimals === null && priceUsd === null
          ? 'decimals+price'
          : decimals === null
            ? 'decimals'
            : priceUsd === null
              ? 'price'
              : 'none',
    })
  }
  return out
}

/**
 * Rank assets the only two ways the data supports.
 *
 * Priced assets first, by USD value descending. Then everything unpriced, by
 * recipient count descending. The boundary between the two blocks IS the
 * coverage frontier, and it is where an operator should start pricing.
 */
export function rankAssets(rollups: readonly AssetRollup[]): AssetRollup[] {
  const priced = rollups
    .filter((r) => r.priceable)
    .sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0))
  const unpriced = rollups
    .filter((r) => !r.priceable)
    .sort((a, b) =>
      b.recipientCount !== a.recipientCount
        ? b.recipientCount - a.recipientCount
        : b.creditCount - a.creditCount,
    )
  return [...priced, ...unpriced]
}

export interface CoverageCounts {
  total: number
  priced: number
  /** priced / total, or 1 when total is 0 (nothing to miss). */
  share: number
}

export interface CoverageReport {
  schema: typeof COVERAGE_SCHEMA
  assets: CoverageCounts
  credits: CoverageCounts
  /**
   * Recipient coverage is deliberately three numbers, not one. A recipient
   * holding one priced and one unpriced asset has an UNDERSTATED total, and an
   * understated total silently drops them below a tier gate. "Touched by a
   * priced asset" flatters; "fully priced" is the number that can be trusted.
   */
  recipients: {
    total: number
    fullyPriced: number
    partiallyUnpriced: number
    fullyUnpriced: number
    fullyPricedShare: number
  }
  value: {
    /** Sum over priced assets only. */
    pricedUsd: number
    /** Always false today: an unpriced asset has no determinable USD value. */
    unpricedValueDeterminable: boolean
    /** Assets that are unpriceable because decimals could not be read. */
    assetsMissingDecimals: number
    /** Assets with known decimals but no USD price configured. */
    assetsMissingPrice: number
  }
  /** Full ranking, priced-by-value then unpriced-by-recipients. */
  ranked: AssetRollup[]
  /** The head of the unpriced block: what to price next, in order. */
  priceNext: AssetRollup[]
  /** The one sentence that may be quoted. */
  statement: string
}

export function computeCoverage(
  credits: readonly EscrowCredit[],
  rollups: readonly AssetRollup[],
  options: { priceNextCount?: number } = {},
): CoverageReport {
  const ranked = rankAssets(rollups)
  const priceableAddresses = new Set(rollups.filter((r) => r.priceable).map((r) => r.address))

  const totalCredits = rollups.reduce((sum, r) => sum + r.creditCount, 0)
  const pricedCredits = rollups
    .filter((r) => r.priceable)
    .reduce((sum, r) => sum + r.creditCount, 0)

  // Per-recipient coverage has to be computed from the CREDITS, not from the
  // asset rows: the question is whether any one recipient's total is complete.
  const recipientState = new Map<string, { priced: boolean; unpriced: boolean }>()
  for (const credit of credits) {
    const key = credit.recipient
    let state = recipientState.get(key)
    if (state === undefined) {
      state = { priced: false, unpriced: false }
      recipientState.set(key, state)
    }
    if (priceableAddresses.has(credit.asset.toLowerCase())) state.priced = true
    else state.unpriced = true
  }
  let fullyPriced = 0
  let partiallyUnpriced = 0
  let fullyUnpriced = 0
  for (const state of recipientState.values()) {
    if (state.priced && !state.unpriced) fullyPriced++
    else if (state.priced && state.unpriced) partiallyUnpriced++
    else fullyUnpriced++
  }

  const pricedUsd = rollups.reduce((sum, r) => sum + (r.valueUsd ?? 0), 0)
  const assetsMissingDecimals = rollups.filter(
    (r) => r.blockedBy === 'decimals' || r.blockedBy === 'decimals+price',
  ).length
  const assetsMissingPrice = rollups.filter((r) => r.blockedBy === 'price').length

  const share = (part: number, whole: number): number => (whole === 0 ? 1 : part / whole)
  const report: CoverageReport = {
    schema: COVERAGE_SCHEMA,
    assets: {
      total: rollups.length,
      priced: priceableAddresses.size,
      share: share(priceableAddresses.size, rollups.length),
    },
    credits: {
      total: totalCredits,
      priced: pricedCredits,
      share: share(pricedCredits, totalCredits),
    },
    recipients: {
      total: recipientState.size,
      fullyPriced,
      partiallyUnpriced,
      fullyUnpriced,
      fullyPricedShare: share(fullyPriced, recipientState.size),
    },
    value: {
      pricedUsd,
      unpricedValueDeterminable: false,
      assetsMissingDecimals,
      assetsMissingPrice,
    },
    ranked,
    priceNext: ranked.filter((r) => !r.priceable).slice(0, options.priceNextCount ?? 20),
    statement: '',
  }
  report.statement = coverageStatement(report)
  return report
}

/** The defensible sentence. Written once, here, so every report says the same thing. */
export function coverageStatement(report: CoverageReport): string {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`
  if (report.assets.total === 0) return 'No credits were found, so there is nothing to price.'
  if (report.assets.priced === report.assets.total) {
    return (
      `All ${report.assets.total} assets are priced: ${pct(1)} of ${report.credits.total.toLocaleString()} ` +
      `credits and all ${report.recipients.total.toLocaleString()} recipients are covered.`
    )
  }
  return (
    `Assets covering ${pct(report.credits.share)} of credits ` +
    `(${report.assets.priced} of ${report.assets.total} assets, ` +
    `${report.recipients.fullyPriced.toLocaleString()} of ${report.recipients.total.toLocaleString()} recipients ` +
    `fully priced) are priced; the remaining ${report.assets.total - report.assets.priced} assets are UNPRICED ` +
    `and excluded from every USD figure here. ` +
    `${report.recipients.partiallyUnpriced.toLocaleString()} recipients hold both priced and unpriced assets, so ` +
    `their totals are UNDERSTATED, not merely incomplete. The unpriced remainder has no determinable USD value: ` +
    `it is excluded, never counted as zero.`
  )
}

// ---------------------------------------------------------------------------
// Materiality: does the ERC-20 tail change the answer, or is it dust?
// ---------------------------------------------------------------------------

export type MaterialityVerdict = 'material' | 'dust' | 'undetermined'

export interface MaterialityAssessment {
  verdict: MaterialityVerdict
  /** Lower bound on ERC-20 USD: the priced head only. */
  erc20PricedUsd: number
  nativeUsd: number
  /** erc20PricedUsd / nativeUsd. A LOWER BOUND on the true ratio. */
  ratioLowerBound: number
  creditCoverageShare: number
  thresholdShare: number
  coverageFloor: number
  statement: string
}

/**
 * Decide whether the ERC-20 tail is material against the native measurement.
 *
 * This is a BOUNDING argument, not an estimate, and the three outcomes are
 * genuinely different:
 *
 *   material     - the priced head ALONE already clears the threshold. No
 *                  assumption about the unpriced tail is needed; more pricing
 *                  can only raise the number.
 *   dust         - the priced head is below the threshold AND the priced
 *                  assets cover almost all credits, so the unpriced tail is a
 *                  small number of low-frequency assets. Still an argument
 *                  from credit COUNT, not from value, and it is labelled so.
 *   undetermined - too little of the tail is priced to say anything. This is
 *                  the honest default and the tool must not talk itself out
 *                  of it.
 */
export function assessMateriality(input: {
  erc20PricedUsd: number
  nativeUsd: number
  creditCoverageShare: number
  /** Share of the native figure above which the tail changes decisions. */
  thresholdShare?: number
  /** Credit coverage needed before a "dust" call is allowed. */
  coverageFloor?: number
}): MaterialityAssessment {
  const thresholdShare = input.thresholdShare ?? 0.05
  const coverageFloor = input.coverageFloor ?? 0.9
  const ratio = input.nativeUsd > 0 ? input.erc20PricedUsd / input.nativeUsd : 0

  let verdict: MaterialityVerdict
  let statement: string
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`

  if (input.nativeUsd <= 0) {
    verdict = 'undetermined'
    statement =
      'No native baseline was supplied, so the ERC-20 tail cannot be compared against anything. ' +
      'Run the native side over the same window first.'
  } else if (ratio >= thresholdShare) {
    verdict = 'material'
    statement =
      `MATERIAL. The PRICED ERC-20 head alone is $${input.erc20PricedUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}, ` +
      `${pct(ratio)} of the native $${input.nativeUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })} over the same window, ` +
      `against a ${pct(thresholdShare)} materiality threshold. That is a LOWER BOUND - the unpriced tail can only add to it. ` +
      `Native-only is therefore NOT a defensible measurement basis, and the QF definition has to say what it does with ERC-20 credits.`
  } else if (input.creditCoverageShare >= coverageFloor) {
    verdict = 'dust'
    statement =
      `DUST, bounded by coverage. The priced ERC-20 head is ${pct(ratio)} of the native figure, below the ` +
      `${pct(thresholdShare)} threshold, and priced assets account for ${pct(input.creditCoverageShare)} of all ERC-20 credits. ` +
      `The unpriced remainder is ${pct(1 - input.creditCoverageShare)} of credits, so it would have to be worth ` +
      `implausibly more per credit than the priced head to move the answer. Native-only is a defensible basis, ` +
      `and the run must still say so out loud rather than omitting the ERC-20 side silently.`
  } else {
    verdict = 'undetermined'
    statement =
      `UNDETERMINED. Only ${pct(input.creditCoverageShare)} of ERC-20 credits are priced, below the ` +
      `${pct(coverageFloor)} coverage floor needed to argue the tail is small, and the priced head is only ` +
      `${pct(ratio)} of native - not enough to argue it is large either. Price more of the ranked head and re-run. ` +
      `Do NOT publish a native-only figure as complete on this evidence.`
  }

  return {
    verdict,
    erc20PricedUsd: input.erc20PricedUsd,
    nativeUsd: input.nativeUsd,
    ratioLowerBound: ratio,
    creditCoverageShare: input.creditCoverageShare,
    thresholdShare,
    coverageFloor,
    statement,
  }
}
