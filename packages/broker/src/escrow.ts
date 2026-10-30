/**
 * MILESTONE ESCROW.
 *
 * Money moves against proof, not against an invoice. Funding a purchase creates
 * an escrow plan whose slices are released one at a time as each scheduled
 * delivery check passes. A failed check withholds its slice permanently; an
 * unproven slice returns to the dev leg once the procurement proof window
 * closes, because unproven procurement is the dev's money, not ours.
 *
 * The accounting invariant, asserted on every evaluation:
 *   released + withheld + pending + returnedToDevLeg == total
 * No cent may be created or lost by the schedule arithmetic. Slice sizes use
 * remainder-to-last so the parts sum exactly to the whole in integer cents.
 */
import type { Address, DeliveryPredicateSpec, PredicateResult } from '@fee-split-vaults/core'
import { BrokerError } from './errors.js'
import { applyBps, usdFromCents } from './money.js'
import { TERMS } from './protocol.js'
import type { DeliveryOutcome } from './reliability.js'

export interface MilestoneSpec {
  offsetSeconds: number
  /** Share of the total released when the check at this offset passes. */
  releaseBps: number
}

export interface EscrowPlan {
  disbursementId: string
  vault: Address
  vendorId: string
  totalCents: bigint
  milestones: MilestoneSpec[]
  fundedAtUnix: number
}

export interface WithheldLine {
  vendorId: string
  amountUsd: number
  reason: string
}

export interface EscrowOutcome {
  disbursementId: string
  releasedCents: bigint
  withheldCents: bigint
  pendingCents: bigint
  /** Unproven within the proof window. Goes back to the dev leg, not to us. */
  returnedToDevLegCents: bigint
  withheldLines: WithheldLine[]
  decidedAtUnix: number
  settled: boolean
}

/** Milestones from a predicate's check schedule, split evenly, remainder last. */
export function planEscrow(args: {
  disbursementId: string
  vault: Address
  vendorId: string
  totalCents: bigint
  spec: DeliveryPredicateSpec
  fundedAtUnix: number
}): EscrowPlan {
  const offsets = [...new Set(args.spec.verifyAtOffsetsSeconds)].sort((a, b) => a - b)
  if (offsets.length === 0) {
    throw new BrokerError('measurability', 'no_offsets', 'predicate schedules no checks')
  }
  if (args.totalCents <= 0n) {
    throw new BrokerError('solvency', 'empty_escrow', 'escrow total must be positive')
  }
  const base = Math.floor(10_000 / offsets.length)
  const milestones: MilestoneSpec[] = offsets.map((offsetSeconds, index) => ({
    offsetSeconds,
    releaseBps: index === offsets.length - 1 ? 10_000 - base * (offsets.length - 1) : base,
  }))
  return {
    disbursementId: args.disbursementId,
    vault: args.vault,
    vendorId: args.vendorId,
    totalCents: args.totalCents,
    milestones,
    fundedAtUnix: args.fundedAtUnix,
  }
}

/** Slice sizes in cents. Remainder to the last slice so the parts sum exactly. */
export function milestoneSlices(plan: EscrowPlan): bigint[] {
  const total = plan.milestones.reduce((sum, m) => sum + m.releaseBps, 0)
  if (total !== 10_000) {
    throw new BrokerError(
      'measurability',
      'bad_schedule',
      `milestone release shares sum to ${total}bps, not 10000`,
    )
  }
  const slices: bigint[] = []
  let assigned = 0n
  plan.milestones.forEach((milestone, index) => {
    const slice =
      index === plan.milestones.length - 1
        ? plan.totalCents - assigned
        : applyBps(plan.totalCents, milestone.releaseBps)
    assigned += slice
    slices.push(slice)
  })
  return slices
}

export function evaluateEscrow(
  plan: EscrowPlan,
  results: readonly PredicateResult[],
  nowUnix: number,
): EscrowOutcome {
  const slices = milestoneSlices(plan)
  const proofDeadline = plan.fundedAtUnix + TERMS.procurementProofWindowDays * 24 * 60 * 60

  let released = 0n
  let withheld = 0n
  let pending = 0n
  let returned = 0n
  const withheldLines: WithheldLine[] = []

  plan.milestones.forEach((milestone, index) => {
    const slice = slices[index] ?? 0n
    const result = results.find((r) => r.offsetSeconds === milestone.offsetSeconds)

    if (result !== undefined && result.passed) {
      released += slice
      return
    }
    if (result !== undefined) {
      withheld += slice
      withheldLines.push({
        vendorId: plan.vendorId,
        amountUsd: usdFromCents(slice),
        reason: `delivery check at +${milestone.offsetSeconds}s failed: ${result.note ?? 'no note'}`,
      })
      return
    }
    if (nowUnix >= proofDeadline) {
      returned += slice
      withheldLines.push({
        vendorId: plan.vendorId,
        amountUsd: usdFromCents(slice),
        reason: `unproven within the ${TERMS.procurementProofWindowDays}-day proof window; returned to the dev leg`,
      })
      return
    }
    pending += slice
  })

  if (released + withheld + pending + returned !== plan.totalCents) {
    throw new BrokerError(
      'solvency',
      'escrow_imbalance',
      'escrow slices do not sum to the escrow total',
    )
  }

  return {
    disbursementId: plan.disbursementId,
    releasedCents: released,
    withheldCents: withheld,
    pendingCents: pending,
    returnedToDevLegCents: returned,
    withheldLines,
    decidedAtUnix: nowUnix,
    settled: pending === 0n,
  }
}

/** Turns a settled escrow into the reliability signal the gate consumes. */
export function toDeliveryOutcome(plan: EscrowPlan, outcome: EscrowOutcome): DeliveryOutcome {
  return {
    vendorId: plan.vendorId,
    releasedCents: outcome.releasedCents,
    // Money the vendor did not earn, whether we kept the slice open or the dev
    // took it back, counts against the vendor either way.
    withheldCents: outcome.withheldCents + outcome.returnedToDevLegCents,
    observedAtUnix: outcome.decidedAtUnix,
  }
}
