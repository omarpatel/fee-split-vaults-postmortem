/**
 * Vendor reliability, computed only from observed delivery outcomes.
 *
 * The score is an EWMA over the VALUE released versus withheld, not over a
 * count of deliveries: a vendor that delivers ten $10 boosts and fails one
 * $5,000 KOL campaign is not a 91% reliable vendor.
 *
 * All arithmetic is integer basis points. A float EWMA would drift differently
 * on different machines and the score feeds the spend gate, so it has to be
 * reproducible from the outcome log alone.
 */
import type { Vendor } from '@fee-split-vaults/core'
import { BrokerError } from './errors.js'
import { VENDOR_RELIABILITY } from './limits.js'

export interface DeliveryOutcome {
  vendorId: string
  releasedCents: bigint
  withheldCents: bigint
  observedAtUnix: number
}

function toBps(score: number, field: string): number {
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
    throw new BrokerError('vendor_reliability', 'bad_score', `${field} must be within [0, 1]`)
  }
  return Math.round(score * 10_000)
}

export function updateReliabilityScore(previous: number, outcome: DeliveryOutcome): number {
  const previousBps = BigInt(toBps(previous, 'previous reliability'))
  if (outcome.releasedCents < 0n || outcome.withheldCents < 0n) {
    throw new BrokerError('vendor_reliability', 'bad_outcome', 'outcome amounts must not be negative')
  }
  const decided = outcome.releasedCents + outcome.withheldCents
  if (decided === 0n) {
    // Nothing was adjudicated, so nothing was learned.
    return previous
  }
  const outcomeBps = (outcome.releasedCents * 10_000n) / decided
  const weight = BigInt(VENDOR_RELIABILITY.updateWeightBps)
  const blended = previousBps * (10_000n - weight) + outcomeBps * weight
  // Round half up, in integers, so the result is identical everywhere.
  const nextBps = (blended + 5_000n) / 10_000n
  return Number(nextBps) / 10_000
}

/** Feeds the delivery result back into the allowlist the gate reads. */
export function applyDeliveryOutcome(vendor: Vendor, outcome: DeliveryOutcome): Vendor {
  if (vendor.id !== outcome.vendorId) {
    throw new BrokerError(
      'vendor_reliability',
      'vendor_mismatch',
      'delivery outcome belongs to a different vendor',
    )
  }
  const reliabilityScore = updateReliabilityScore(vendor.reliabilityScore, outcome)
  return {
    ...vendor,
    reliabilityScore,
    // A vendor that has fallen through the floor stops being payable at all,
    // rather than merely being scored badly.
    enabled: vendor.enabled && reliabilityScore >= VENDOR_RELIABILITY.minScore,
  }
}

/** Standing for a vendor with no history. Probation, not full trust. */
export function initialReliabilityScore(): number {
  return VENDOR_RELIABILITY.initialScore
}
