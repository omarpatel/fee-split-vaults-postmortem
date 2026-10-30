/**
 * Synthetic pilot data.
 *
 * This is not only test scaffolding. The plan must be rehearsed against data
 * that does not exist yet - a dry run on a synthetic null and a synthetic
 * positive is how you find out that your decision rule is unreachable BEFORE
 * you spend 60 days discovering it, and it is how the committed rule gets
 * checked without anyone seeing a real outcome.
 *
 * The generator deliberately includes the three nuisances the paired design
 * exists to remove: a per-coin level, a per-coin decay curve, and a strong
 * diurnal cycle.
 *
 * It also injects, on request, the four contaminants the registered exclusions
 * exist to remove - an anti-snipe windfall, a mid-trial graduation, a recipient
 * change and an unvalued window - plus the two the plan deliberately KEEPS, a
 * whale window and an undelivered block. A dry run against contaminated data is
 * the only way to find out whether the exclusion machinery works before it
 * matters, and the anti-snipe case in particular is a single observation capable
 * of moving a coin's whole series by four standard deviations.
 */

import { makeRng, type Rng } from '../hash.js'
import type {
  BlockIntegrity,
  BlockOutcome,
  PilotAssignment,
  PilotCoin,
  PilotDataset,
} from '../types.js'

export interface SyntheticContamination {
  /**
   * A launch windfall in USD, added to the first measured window at or after
   * the coin's launch and recorded as anti-snipe money. At the default base fee
   * flow a windfall of 20,000 moves that window from about log1p 5.3 to log1p
   * 9.9, which is the whole reason the exclusion exists.
   */
  antiSnipeWindfallUsd?: number
  /** These block indexes could not be valued: NaN endpoint, unmeasured window. */
  unvaluedBlockIndexes?: readonly number[]
  /** These block indexes were not delivered as assigned, in either direction. */
  undeliveredBlockIndexes?: readonly number[]
  /** These block indexes had one credit worth this share of the window total. */
  whaleBlockIndexes?: readonly number[]
  /** The share a whale credit takes. Default 0.9. */
  whaleShare?: number
}

export interface SyntheticParams {
  seed: string
  /** Median fee flow per 12h window for a typical coin, USD. */
  baseFeesUsd: number
  /** Multiplicative effect of a staffed block on the FOLLOWING window. */
  staffedMultiplier: number
  /** Lognormal noise sigma on the fee flow. Real coins are very noisy. */
  noiseSigma: number
  /** Per-coin level dispersion, lognormal sigma. */
  coinLevelSigma: number
  /** Half life of the coin's own decay, days. The thing the pairing removes. */
  decayHalfLifeDays: number
  /** Peak-to-trough diurnal swing, as a multiplier amplitude in [0, 1). */
  diurnalAmplitude: number
  collectedAtUnix: number
  /** Quote asset decimals used to render minor units. */
  quoteDecimals?: number
  /** Pinned USD price per whole quote unit. */
  quoteUsdPerWholeUnit?: number
  /** Off by default: clean data is the baseline the contaminated runs are read against. */
  contamination?: SyntheticContamination
}

export const DEFAULT_SYNTHETIC: Omit<SyntheticParams, 'seed' | 'collectedAtUnix'> = {
  baseFeesUsd: 420,
  staffedMultiplier: 1,
  noiseSigma: 0.55,
  coinLevelSigma: 0.9,
  decayHalfLifeDays: 21,
  diurnalAmplitude: 0.6,
}

function standardNormal(rng: Rng): number {
  let u = 0
  while (u === 0) u = rng.next()
  const v = rng.next()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function toMinor(usd: number, decimals: number, usdPerWholeUnit: number): bigint {
  const whole = usd / usdPerWholeUnit
  return BigInt(Math.round(whole * 10 ** decimals))
}

/**
 * Build a dataset from a real assignment. The effect is applied to the window
 * FOLLOWING each block, which is where the registered primary endpoint lives.
 */
export function synthesizeDataset(
  assignment: PilotAssignment,
  coins: readonly PilotCoin[],
  params: SyntheticParams,
): PilotDataset {
  const decimals = params.quoteDecimals ?? 6
  const usdPerWholeUnit = params.quoteUsdPerWholeUnit ?? 1
  const contamination = params.contamination ?? {}
  const unvalued = new Set(contamination.unvaluedBlockIndexes ?? [])
  const undelivered = new Set(contamination.undeliveredBlockIndexes ?? [])
  const whales = new Set(contamination.whaleBlockIndexes ?? [])
  const whaleShare = contamination.whaleShare ?? 0.9
  const byRef = new Map(coins.map((c) => [c.coinRef, c]))
  const outcomes: BlockOutcome[] = []
  let firstObservationUnix = Number.POSITIVE_INFINITY

  for (const coinAssignment of assignment.coins) {
    const coin = byRef.get(coinAssignment.coinRef)
    if (!coin) throw new Error(`synthetic: assignment references unenrolled ${coinAssignment.coinRef}`)

    const coinRng = makeRng(`${params.seed}|level|${coin.coinRef}`)
    const level = Math.exp(params.coinLevelSigma * standardNormal(coinRng))
    const rng = makeRng(`${params.seed}|blocks|${coin.coinRef}`)

    const randomized = coinAssignment.blocks.filter((b) => b.phase === 'RANDOMIZED')
    const start = randomized.length > 0 ? randomized[0]!.startUnix : 0
    let windfallSpent = contamination.antiSnipeWindfallUsd === undefined

    for (let i = 0; i < randomized.length; i += 1) {
      const block = randomized[i]!
      const next = randomized[i + 1] ?? null
      const windowSeconds = block.endUnixExclusive - block.startUnix
      const from = block.endUnixExclusive
      const to = from + windowSeconds

      const ageDays = (from - start) / 86_400
      const decay = Math.pow(0.5, ageDays / params.decayHalfLifeDays)
      const followHour = new Date(from * 1_000).getUTCHours()
      const diurnal = 1 + params.diurnalAmplitude * Math.cos((2 * Math.PI * followHour) / 24)
      const treatment = block.arm === 'STAFFED' ? params.staffedMultiplier : 1
      const noise = Math.exp(params.noiseSigma * standardNormal(rng))

      const organicUsd = Math.max(0, params.baseFeesUsd * level * decay * diurnal * treatment * noise)

      // The windfall lands in the first window at or after launch, which is
      // exactly where a real one lands: the tax is charged at t=0 and reaches
      // the fee recipient along the ordinary rails.
      let antiSnipeUsd = 0
      if (!windfallSpent && from >= coin.launchedAtUnix) {
        antiSnipeUsd = contamination.antiSnipeWindfallUsd ?? 0
        windfallSpent = true
      }

      const valuationComplete = !unvalued.has(block.blockIndex)
      const feesUsd = organicUsd + antiSnipeUsd
      const largestCreditShare = whales.has(block.blockIndex)
        ? whaleShare
        : antiSnipeUsd > 0 && feesUsd > 0
          ? antiSnipeUsd / feesUsd
          : 0.25

      const buyers = Math.max(0, Math.round((organicUsd / 90) * (0.75 + 0.5 * rng.next())))
      const membersEnd = 400 + Math.round(200 * level)
      const joins = Math.round(buyers * (0.5 + 0.4 * rng.next()))
      const leaves = Math.round(joins * (block.arm === 'STAFFED' ? 0.35 : 0.6) * (0.7 + 0.6 * rng.next()))
      const backlog =
        block.arm === 'STAFFED'
          ? Math.round(2 * rng.next())
          : Math.round(6 + 8 * rng.next())

      if (from < firstObservationUnix) firstObservationUnix = from

      const integrity: BlockIntegrity = {
        secondsSinceLaunch: from - coin.launchedAtUnix,
        antiSnipeUsd,
        feeMechanism:
          coin.graduatedAtUnix !== undefined && from >= coin.graduatedAtUnix
            ? 'POST_GRADUATION_SWEEP'
            : 'PRE_GRADUATION_CURVE',
        valuationComplete,
        largestCreditShare,
        deliveredAsAssigned: !undelivered.has(block.blockIndex),
      }
      if (coin.graduatedAtUnix !== undefined) {
        integrity.graduationAgeSeconds = from - coin.graduatedAtUnix
      }
      if (coin.recipientChangedAtUnix !== undefined) {
        integrity.recipientChangedAtUnix = coin.recipientChangedAtUnix
      }

      outcomes.push({
        coinRef: coin.coinRef,
        blockIndex: block.blockIndex,
        arm: block.arm,
        phase: block.phase,
        hourOfDay: block.hourOfDay,
        dayOfWeek: block.dayOfWeek,
        followWindowStartUnix: from,
        followWindowEndUnixExclusive: to,
        primaryLog1pFeesUsd: valuationComplete ? Math.log1p(feesUsd) : Number.NaN,
        feesUsd: {
          usd: valuationComplete ? feesUsd : Number.NaN,
          priceSource: valuationComplete ? 'synthetic:pinned' : 'unmeasured:synthetic',
          pricedAtUnix: from,
        },
        feesMinorByAsset: valuationComplete
          ? [{ asset: coin.quoteAsset, minor: toMinor(feesUsd, decimals, usdPerWholeUnit) }]
          : [],
        uniqueNewBuyers: buyers,
        membership: { joins, leaves, membersEnd },
        unansweredBacklog: backlog,
        nextBlockArm: next ? next.arm : null,
        integrity,
      })
    }
  }

  return {
    pilotId: assignment.pilotId,
    assignmentHash: assignment.assignmentHash,
    outcomes,
    firstObservationUnix,
    collectedAtUnix: params.collectedAtUnix,
  }
}

/**
 * A recruited cohort of plausible pilot coins.
 *
 * They launch a week before enrolment, which is both realistic - nobody signs a
 * marketing agency at t=0 - and keeps a clean cohort clear of the registered
 * 24-hour launch exclusion. A test that wants the exclusion to bite overrides
 * `launchedAtUnix`.
 */
export function syntheticCoins(
  count: number,
  enrolledAtUnix: number,
  overrides: Partial<Omit<PilotCoin, 'coinRef' | 'token' | 'poolId'>> = {},
): PilotCoin[] {
  const coins: PilotCoin[] = []
  for (let i = 0; i < count; i += 1) {
    const n = String(i + 1).padStart(3, '0')
    coins.push({
      coinRef: `coin-${n}`,
      token: `0x${'a'.repeat(36)}${n}`,
      poolId: `pool-${n}`,
      quoteAsset: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
      enrolledAtUnix,
      launchedAtUnix: enrolledAtUnix - 7 * 86_400,
      telegramChatRef: `tg-${n}`,
      baselineStratum: i % 2 === 0 ? 'low' : 'high',
      ...overrides,
    })
  }
  return coins
}
