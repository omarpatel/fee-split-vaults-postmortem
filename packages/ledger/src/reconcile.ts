/**
 * Reconciliation: the ledger against independent views of the same money.
 *
 * TWO-WAY (chain reconciliation). The ledger's `asset:vault` balance against the
 * token balance actually held by the vault address, read at a pinned blockHash.
 *
 * THREE-WAY MATCH (per sweep). The equivalent of an AP three-way match, with the
 * hook, the escrow and the token contract standing in for PO, receipt and
 * invoice:
 *
 *   swept            the hook's PoolFeesSwept(poolId, ...). The ONLY per-coin
 *                    attribution that survives graduation.
 *   escrow_credited  the credit inside the shared Venue fee escrow.
 *   received         the ERC-20 amount that actually landed in the vault when it
 *                    claimed. Claims are chunked, so this is a sum of chunks.
 *
 * plus the ledger's own recognised figure as the fourth leg, because a match
 * between three chain views that all disagree with the book is still a defect.
 *
 * A missing leg is not a pass. Under the default policy it is CRITICAL: an
 * unobserved leg means the indexer is behind or an event was missed, and both of
 * those are exactly the conditions under which money goes missing quietly.
 */

import type { Address, AssetAddress, PoolId, ReconciliationVariance } from '@fee-split-vaults/core'
import { canonicalDigest } from './ids.js'
import {
  classifySeverity,
  DEFAULT_VARIANCE_POLICY,
  worseSeverity,
  type Severity,
  type VariancePolicy,
} from './variance.js'

export type MatchLegName =
  | 'swept'
  | 'escrow_credited'
  | 'received'
  | 'ledger_recognized'

export interface MatchLeg {
  name: MatchLegName
  amountMinor: bigint | null
  /** Chain provenance for the observation, when there was one. */
  blockHash?: string
  txHash?: string
}

export interface SweepMatchInput {
  sweepId: string
  vault: Address
  asset: AssetAddress
  poolId?: PoolId
  observedAtUnix: number
  sweptMinor?: bigint
  escrowCreditedMinor?: bigint
  receivedMinor?: bigint
  ledgerRecognizedMinor?: bigint
  /** USD of one minor unit's worth of delta, resolved by the caller. */
  usdOfDelta?: (deltaMinor: bigint) => number | undefined
  policy?: VariancePolicy
}

export interface PairwiseVariance {
  a: MatchLegName
  b: MatchLegName
  deltaMinor: bigint
  severity: Severity
}

export interface ThreeWayMatchResult {
  sweepId: string
  vault: Address
  asset: AssetAddress
  poolId?: PoolId
  status: 'matched' | 'variance' | 'incomplete'
  legs: MatchLeg[]
  missingLegs: MatchLegName[]
  pairwise: PairwiseVariance[]
  worstSeverity: Severity
  variances: ReconciliationVariance[]
}

const LEG_ORDER: readonly MatchLegName[] = [
  'swept',
  'escrow_credited',
  'received',
  'ledger_recognized',
]

export function threeWayMatch(input: SweepMatchInput): ThreeWayMatchResult {
  const policy = input.policy ?? DEFAULT_VARIANCE_POLICY
  const amounts: Record<MatchLegName, bigint | null> = {
    swept: input.sweptMinor ?? null,
    escrow_credited: input.escrowCreditedMinor ?? null,
    received: input.receivedMinor ?? null,
    ledger_recognized: input.ledgerRecognizedMinor ?? null,
  }

  const legs: MatchLeg[] = LEG_ORDER.map((name) => ({ name, amountMinor: amounts[name] }))
  const missingLegs = LEG_ORDER.filter((name) => amounts[name] === null)

  const present = LEG_ORDER.filter((name) => amounts[name] !== null)
  const pairwise: PairwiseVariance[] = []
  const variances: ReconciliationVariance[] = []
  let worst: Severity = 'info'

  for (let i = 0; i < present.length; i += 1) {
    for (let j = i + 1; j < present.length; j += 1) {
      const a = present[i] as MatchLegName
      const b = present[j] as MatchLegName
      const av = amounts[a] as bigint
      const bv = amounts[b] as bigint
      const deltaMinor = av - bv
      if (deltaMinor === 0n) continue

      const magnitude = deltaMinor < 0n ? -deltaMinor : deltaMinor
      const referenceMinor = av > bv ? av : bv
      const severity = classifySeverity({
        deltaMinor,
        referenceMinor,
        deltaUsd: input.usdOfDelta?.(magnitude),
        policy,
      })
      pairwise.push({ a, b, deltaMinor, severity })
      worst = worseSeverity(worst, severity)
      variances.push({
        vault: input.vault,
        asset: input.asset,
        ledgerBalanceMinor: av,
        chainBalanceMinor: bv,
        deltaMinor,
        severity,
        detectedAtUnix: input.observedAtUnix,
      })
    }
  }

  if (missingLegs.length > 0 && policy.missingLegIsCritical) {
    worst = worseSeverity(worst, 'critical')
  }

  const status: ThreeWayMatchResult['status'] =
    missingLegs.length > 0 ? 'incomplete' : pairwise.length > 0 ? 'variance' : 'matched'

  const result: ThreeWayMatchResult = {
    sweepId: input.sweepId,
    vault: input.vault,
    asset: input.asset,
    status,
    legs,
    missingLegs,
    pairwise,
    worstSeverity: worst,
    variances,
  }
  if (input.poolId !== undefined) result.poolId = input.poolId
  return result
}

// ---------------------------------------------------------------------------
// Two-way chain reconciliation
// ---------------------------------------------------------------------------

export interface ChainReconcileInput {
  vault: Address
  asset: AssetAddress
  /** Signed debit-positive `asset:vault` balance from the ledger. */
  ledgerBalanceMinor: bigint
  /** balanceOf(vault) read at a pinned block hash, never a block number. */
  chainBalanceMinor: bigint
  detectedAtUnix: number
  blockHash?: string
  usdOfDelta?: (deltaMinor: bigint) => number | undefined
  policy?: VariancePolicy
}

export interface ChainReconcileResult {
  variance: ReconciliationVariance
  /** Stable id so a repeated detection of the same variance is one record. */
  varianceId: string
  blockHash?: string
}

export function reconcileChainBalance(input: ChainReconcileInput): ChainReconcileResult {
  const deltaMinor = input.ledgerBalanceMinor - input.chainBalanceMinor
  const magnitude = deltaMinor < 0n ? -deltaMinor : deltaMinor
  const referenceMinor =
    input.chainBalanceMinor > input.ledgerBalanceMinor
      ? input.chainBalanceMinor
      : input.ledgerBalanceMinor

  const severity = classifySeverity({
    deltaMinor,
    referenceMinor,
    deltaUsd: input.usdOfDelta?.(magnitude),
    policy: input.policy ?? DEFAULT_VARIANCE_POLICY,
  })

  const variance: ReconciliationVariance = {
    vault: input.vault,
    asset: input.asset,
    ledgerBalanceMinor: input.ledgerBalanceMinor,
    chainBalanceMinor: input.chainBalanceMinor,
    deltaMinor,
    severity,
    detectedAtUnix: input.detectedAtUnix,
  }

  const varianceId = `vr_${canonicalDigest([
    'variance.v1',
    input.vault,
    input.asset,
    input.ledgerBalanceMinor,
    input.chainBalanceMinor,
    input.blockHash,
  ])}`

  const result: ChainReconcileResult = { variance, varianceId }
  if (input.blockHash !== undefined) result.blockHash = input.blockHash
  return result
}

export function sweepVarianceId(sweepId: string, a: MatchLegName, b: MatchLegName): string {
  return `vr_${canonicalDigest(['sweep_variance.v1', sweepId, a, b])}`
}
