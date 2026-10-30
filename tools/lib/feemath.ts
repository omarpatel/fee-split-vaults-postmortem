/**
 * Fee decomposition, in exact integer arithmetic.
 *
 * The Phase 0 model, from verified on-chain parameters:
 *
 *   base       = volume * hookFeeBps / 1e4                  (1.00%)
 *   protocol   = base * protocolFeeShareBps / 1e4           (Venue takes 30% FIRST)
 *   remainder  = base - protocol                            (0.70% of volume)
 *   buyback    = remainder * buybackBurnBps / 1e4 if enabled (0.35% of volume)
 *   creatorNet = remainder - buyback + base * creatorTaxBps / 1e4
 *
 * Note the last term. creatorNetBps() in config/protocol.ts adds
 * `hookFeeBps * creatorTaxBps / 1e4` BPS OF VOLUME, which is the same thing as
 * creatorTaxBps of the BASE FEE - not of volume. So the creator tax is a slice
 * of the 1% pool fee, capped at creatorTaxBpsMax = 1000 (10% of the fee, i.e.
 * 0.10% of volume). Backing it out against volume instead of against the base
 * fee overstates it by 100x, so the residual here is divided by the base fee.
 *
 * Everything here inverts that from an observed PoolFeesSwept, so the two
 * unknowns the tier gates depend on - IS BUYBACK ON, and WHAT IS creatorTax -
 * come out of measurement rather than assumption. Whether the gate is 0.35% or
 * 0.70% of volume is a 2x swing on the entire addressable market.
 *
 * All amounts are bigint minor units of the pool's quote asset. Ratios are
 * computed in scaled integers and only converted to a float for reporting.
 */

import { VENUE, creatorNetBps } from '../../config/protocol.ts'

/** Fixed-point scale for reported ratios. 1e6 keeps 4 decimal places of a bps. */
const RATIO_SCALE = 1_000_000n

export interface SweepObservation {
  poolId: string
  protocolMinor: bigint
  buybackSpentMinor: bigint
  creatorMinor: bigint
  tokensLockedMinor: bigint
  blockNumber: bigint
  timestampUnix: number
}

export interface SweepDecomposition {
  poolId: string
  /** Volume implied by the protocol leg. Exact given the verified parameters. */
  impliedVolumeMinor: bigint
  /** volume * hookFeeBps / 1e4. The pot the whole split comes out of. */
  baseFeeMinor: bigint
  /** base - protocol. What the hook had left to split. */
  remainderMinor: bigint
  /** Whether this sweep spent anything on buyback. */
  buybackObserved: boolean
  /**
   * buybackSpent / remainder in bps. Should equal VENUE.buybackBurnBps (5000)
   * when buyback is on and 0 when off. Anything else means the fee model in
   * config/protocol.ts does not describe this pool.
   */
  observedBuybackShareBps: number
  /** creator minus what the hook split explains. The creator tax, if any. */
  residualMinor: bigint
  /**
   * residual / BASE FEE, in bps. This is the per-token creatorTaxBps as
   * config/protocol.ts defines it - a slice of the pool fee, not of volume.
   */
  impliedCreatorTaxBps: number
  /** creator / impliedVolume in bps: what the creator ACTUALLY received. */
  effectiveCreatorBps: number
  /** What creatorNetBps() predicts for this configuration. */
  predictedCreatorBps: number
  /** Set when the observation cannot be explained by the verified model. */
  modelViolation?: string
}

export class ZeroProtocolLegError extends Error {
  constructor(poolId: string) {
    super(
      `pool ${poolId}: protocol leg is zero, so volume cannot be backed out. ` +
        `Either the sweep is empty or protocolFeeShareBps is not ${VENUE.protocolFeeShareBps} for this pool.`,
    )
    this.name = 'ZeroProtocolLegError'
  }
}

/** Round-half-up division of a bigint, keeping the sign of the numerator. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('division by zero')
  const negative = numerator < 0n !== denominator < 0n
  const a = numerator < 0n ? -numerator : numerator
  const b = denominator < 0n ? -denominator : denominator
  const quotient = (a + b / 2n) / b
  return negative ? -quotient : quotient
}

function ratioToBps(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) return 0
  return Number(divRound(numerator * 10_000n * RATIO_SCALE, denominator)) / Number(RATIO_SCALE)
}

/**
 * Invert one PoolFeesSwept into volume, buyback state and creator tax.
 *
 * Volume comes from the PROTOCOL leg rather than the creator leg, because the
 * protocol leg is the only one with no per-token variation: it is always
 * hookFeeBps * protocolFeeShareBps of volume, whatever the token elected.
 */
export function decomposeSweep(sweep: SweepObservation): SweepDecomposition {
  if (sweep.protocolMinor <= 0n) throw new ZeroProtocolLegError(sweep.poolId)

  const hookBps = BigInt(VENUE.hookFeeBps)
  const protoShareBps = BigInt(VENUE.protocolFeeShareBps)

  // protocol = V * hookBps/1e4 * protoShare/1e4  =>  V = protocol * 1e8 / (hookBps*protoShare)
  const impliedVolumeMinor = divRound(sweep.protocolMinor * 100_000_000n, hookBps * protoShareBps)
  // base = protocol * 1e4 / protoShare
  const baseFeeMinor = divRound(sweep.protocolMinor * 10_000n, protoShareBps)
  const remainderMinor = baseFeeMinor - sweep.protocolMinor

  const buybackObserved = sweep.buybackSpentMinor > 0n
  const observedBuybackShareBps = ratioToBps(sweep.buybackSpentMinor, remainderMinor)

  // What the hook's own split explains, using the OBSERVED buyback spend rather
  // than the configured 50%, so a pool with a different burn share still
  // decomposes correctly instead of dumping the difference into "creator tax".
  const creatorFromHook = remainderMinor - sweep.buybackSpentMinor
  const residualMinor = sweep.creatorMinor - creatorFromHook
  // Against the BASE FEE, matching creatorNetBps()'s definition of the tax.
  const impliedCreatorTaxBps = ratioToBps(residualMinor, baseFeeMinor)
  const effectiveCreatorBps = ratioToBps(sweep.creatorMinor, impliedVolumeMinor)
  const predictedCreatorBps = creatorNetBps(
    buybackObserved,
    Math.max(0, Math.round(impliedCreatorTaxBps)),
  )

  let modelViolation: string | undefined
  if (buybackObserved && Math.abs(observedBuybackShareBps - VENUE.buybackBurnBps) > 1) {
    modelViolation = `buyback share is ${observedBuybackShareBps.toFixed(2)}bps of the remainder, not the verified ${VENUE.buybackBurnBps}`
  } else if (residualMinor < 0n) {
    modelViolation = `creator leg is SMALLER than the hook split explains by ${(-residualMinor).toString()} minor units; the fee model does not describe this pool`
  } else if (impliedCreatorTaxBps > VENUE.creatorTaxBpsMax + 1) {
    modelViolation = `implied creator tax ${impliedCreatorTaxBps.toFixed(2)}bps exceeds the ${VENUE.creatorTaxBpsMax}bps maximum; either the tax is not in this leg or the model is wrong`
  }

  return {
    poolId: sweep.poolId,
    impliedVolumeMinor,
    baseFeeMinor,
    remainderMinor,
    buybackObserved,
    observedBuybackShareBps,
    residualMinor,
    impliedCreatorTaxBps,
    effectiveCreatorBps,
    predictedCreatorBps,
    ...(modelViolation !== undefined ? { modelViolation } : {}),
  }
}

export interface PoolFeeProfile {
  poolId: string
  sweeps: number
  /** A pool is buyback-ON if ANY sweep spent on buyback. */
  buybackEnabled: boolean
  /** Sweeps that spent on buyback, over total sweeps. Detects a mid-life flip. */
  buybackSweepShare: number
  totalProtocolMinor: bigint
  totalBuybackMinor: bigint
  totalCreatorMinor: bigint
  totalTokensLockedMinor: bigint
  totalImpliedVolumeMinor: bigint
  /** Volume-weighted creator tax across this pool's sweeps. */
  impliedCreatorTaxBps: number
  /** Volume-weighted effective creator rate. */
  effectiveCreatorBps: number
  firstSeenUnix: number
  lastSeenUnix: number
  modelViolations: string[]
}

/** Fold many sweeps into one per-pool profile. */
export function profilePool(poolId: string, sweeps: readonly SweepObservation[]): PoolFeeProfile {
  let totalProtocol = 0n
  let totalBuyback = 0n
  let totalCreator = 0n
  let totalLocked = 0n
  let totalVolume = 0n
  let totalBaseFee = 0n
  let totalResidual = 0n
  let buybackSweeps = 0
  let firstSeen = Number.POSITIVE_INFINITY
  let lastSeen = 0
  const violations: string[] = []

  for (const sweep of sweeps) {
    totalProtocol += sweep.protocolMinor
    totalBuyback += sweep.buybackSpentMinor
    totalCreator += sweep.creatorMinor
    totalLocked += sweep.tokensLockedMinor
    firstSeen = Math.min(firstSeen, sweep.timestampUnix)
    lastSeen = Math.max(lastSeen, sweep.timestampUnix)
    if (sweep.buybackSpentMinor > 0n) buybackSweeps++
    if (sweep.protocolMinor <= 0n) continue
    const decomposed = decomposeSweep(sweep)
    totalVolume += decomposed.impliedVolumeMinor
    totalBaseFee += decomposed.baseFeeMinor
    totalResidual += decomposed.residualMinor
    if (decomposed.modelViolation !== undefined) violations.push(decomposed.modelViolation)
  }

  return {
    poolId,
    sweeps: sweeps.length,
    buybackEnabled: buybackSweeps > 0,
    buybackSweepShare: sweeps.length === 0 ? 0 : buybackSweeps / sweeps.length,
    totalProtocolMinor: totalProtocol,
    totalBuybackMinor: totalBuyback,
    totalCreatorMinor: totalCreator,
    totalTokensLockedMinor: totalLocked,
    totalImpliedVolumeMinor: totalVolume,
    impliedCreatorTaxBps: ratioToBps(totalResidual, totalBaseFee),
    effectiveCreatorBps: ratioToBps(totalCreator, totalVolume),
    firstSeenUnix: Number.isFinite(firstSeen) ? firstSeen : 0,
    lastSeenUnix: lastSeen,
    // Deduped: one pool emitting the same violation 400 times is one finding.
    modelViolations: [...new Set(violations)],
  }
}

/** Bucket an implied bps to the nearest whole bps, for a discrete distribution. */
export function bucketBps(value: number): number {
  return Math.round(value)
}

/**
 * The population-level answer the tier gates need.
 *
 * `weightedByVolume` matters more than the unweighted rate: a tier gate is
 * about where the FEES are, and if the six coins that clear $7.14M/day all run
 * buyback-on while 200 dust pools run it off, the unweighted rate is a lie.
 */
export interface BuybackPopulationRate {
  pools: number
  buybackOnPools: number
  buybackOnShareUnweighted: number
  buybackOnShareVolumeWeighted: number
  /** Blended creator bps implied by the measured mix, at zero creator tax. */
  blendedCreatorBpsUnweighted: number
  blendedCreatorBpsVolumeWeighted: number
  /** Pools whose sweeps disagree with the verified fee model. */
  poolsWithModelViolations: number
  /**
   * False when there were no pools to measure, or none of them had any volume.
   *
   * The numeric fields still hold their arithmetic identities in that case (an
   * empty population gives share 0, and blend(0) is the buyback-OFF rate), and
   * a renderer that prints them without checking this flag reports "0% of pools
   * run buyback" - a finding - when the truth is that nothing was observed.
   * Consult this before rendering or forwarding any field above.
   */
  measured: boolean
  /** True when pools were counted but every one had zero implied volume. */
  volumeWeightMeasured: boolean
}

export function buybackPopulationRate(profiles: readonly PoolFeeProfile[]): BuybackPopulationRate {
  const pools = profiles.length
  const on = profiles.filter((p) => p.buybackEnabled)
  let volumeOn = 0n
  let volumeAll = 0n
  for (const profile of profiles) {
    volumeAll += profile.totalImpliedVolumeMinor
    if (profile.buybackEnabled) volumeOn += profile.totalImpliedVolumeMinor
  }
  const unweighted = pools === 0 ? 0 : on.length / pools
  const weighted = volumeAll === 0n ? 0 : Number(divRound(volumeOn * RATIO_SCALE, volumeAll)) / Number(RATIO_SCALE)

  const blend = (share: number): number =>
    share * creatorNetBps(true, 0) + (1 - share) * creatorNetBps(false, 0)

  return {
    pools,
    buybackOnPools: on.length,
    buybackOnShareUnweighted: unweighted,
    buybackOnShareVolumeWeighted: weighted,
    blendedCreatorBpsUnweighted: blend(unweighted),
    blendedCreatorBpsVolumeWeighted: blend(weighted),
    poolsWithModelViolations: profiles.filter((p) => p.modelViolations.length > 0).length,
    measured: pools > 0,
    volumeWeightMeasured: volumeAll > 0n,
  }
}
