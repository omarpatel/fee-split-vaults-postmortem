/**
 * Variance classification and the spend freeze.
 *
 * A variance is any disagreement between the ledger and an independent view of
 * the same money. Three severities, and only one of them has teeth:
 *
 *   info      integer dust. The dev leg absorbs the on-chain rounding remainder,
 *             so a few minor units of drift is the expected state, not a signal.
 *   warn      real but small. Escalate to a human on the next report cycle.
 *   critical  the ledger and the chain disagree materially. FREEZE new spend
 *             authorization for the affected scope.
 *
 * A freeze stops AUTHORIZATION only. Commitments already signed and already
 * funded keep their disbursement path, because the commitment rule already
 * guaranteed they were fully banked at signing; cancelling them would strand a
 * vendor the operator is contractually bound to as principal. The mechanism is
 * the `authorizedAtUnix < frozenAtUnix` test in isCommitmentExempt().
 *
 * Fail closed: an unpriceable amount, an unknown asset, or a missing leg is
 * CRITICAL. Nothing here degrades to "probably fine".
 */

import type { Address, AssetAddress, ReconciliationVariance } from '@fee-split-vaults/core'
import { SPEND_LIMITS } from '../../../config/protocol.js'

export type Severity = ReconciliationVariance['severity']

const SEVERITY_ORDER: Record<Severity, number> = { info: 0, warn: 1, critical: 2 }

export function worseSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b
}

export interface VariancePolicy {
  /**
   * Absolute dust floor in minor units. At or below this, a variance is info
   * regardless of its ratio, because integer split remainders live here.
   */
  dustMinor: bigint
  /** Below this share of the reference amount, a variance is info. */
  warnBps: number
  /** At or above this share of the reference amount, a variance is critical. */
  criticalBps: number
  /**
   * Any variance worth at least this much USD is critical whatever its ratio.
   * Tied to the human-approval threshold: a difference big enough to need a
   * human to approve spending it is big enough to need a human to explain it.
   */
  criticalAbsUsd: number
  /** A leg of a three-way match that was never observed is critical, not absent. */
  missingLegIsCritical: boolean
}

export const DEFAULT_VARIANCE_POLICY: VariancePolicy = {
  dustMinor: 10n,
  warnBps: 5,
  criticalBps: 50,
  criticalAbsUsd: SPEND_LIMITS.humanApprovalThresholdUsd,
  missingLegIsCritical: true,
}

export interface ClassifyInput {
  deltaMinor: bigint
  /** What the delta is a share of. Usually the larger of the two views. */
  referenceMinor: bigint
  /**
   * USD value of |delta|, if it could be derived. `undefined` means no usable
   * price, which is treated as critical rather than as zero.
   */
  deltaUsd?: number
  policy?: VariancePolicy
}

export function classifySeverity(input: ClassifyInput): Severity {
  const policy = input.policy ?? DEFAULT_VARIANCE_POLICY
  const magnitude = input.deltaMinor < 0n ? -input.deltaMinor : input.deltaMinor

  if (magnitude === 0n) return 'info'
  if (input.deltaUsd === undefined) return 'critical'
  if (input.deltaUsd >= policy.criticalAbsUsd) return 'critical'
  if (magnitude <= policy.dustMinor) return 'info'
  if (input.referenceMinor <= 0n) return 'critical'

  const bps = (magnitude * 10_000n) / input.referenceMinor
  if (bps >= BigInt(policy.criticalBps)) return 'critical'
  if (bps >= BigInt(policy.warnBps)) return 'warn'
  return 'info'
}

// ---------------------------------------------------------------------------
// Freeze
// ---------------------------------------------------------------------------

export type FreezeScope =
  | { kind: 'global' }
  | { kind: 'vault'; vault: Address }
  | { kind: 'asset'; asset: AssetAddress }
  | { kind: 'vault_asset'; vault: Address; asset: AssetAddress }

export function freezeScopeKey(scope: FreezeScope): string {
  switch (scope.kind) {
    case 'global':
      return 'global'
    case 'vault':
      return `vault:${scope.vault}`
    case 'asset':
      return `asset:${scope.asset}`
    case 'vault_asset':
      return `vault_asset:${scope.vault}|${scope.asset}`
  }
}

export interface FreezeRecord {
  id: string
  scope: FreezeScope
  reason: string
  /** The variance that caused it, for the audit trail. */
  varianceId?: string
  frozenAtUnix: number
  clearedAtUnix?: number
  clearedBy?: string
}

export interface SpendTarget {
  vault: Address
  asset?: AssetAddress
}

/** Does this freeze cover the scope a spend authorization is being asked for? */
export function freezeCovers(freeze: FreezeRecord, target: SpendTarget): boolean {
  if (freeze.clearedAtUnix !== undefined) return false
  switch (freeze.scope.kind) {
    case 'global':
      return true
    case 'vault':
      return freeze.scope.vault === target.vault
    case 'asset':
      // No asset named means "any asset", so an asset-scoped freeze bites.
      return target.asset === undefined || freeze.scope.asset === target.asset
    case 'vault_asset':
      return (
        freeze.scope.vault === target.vault &&
        (target.asset === undefined || freeze.scope.asset === target.asset)
      )
  }
}

export interface Commitment {
  id: string
  /** When the obligation was signed. Must predate the freeze to stay exempt. */
  authorizedAtUnix: number
  /** The commitment rule already required this to be fully banked at signing. */
  fullyBankedAtSigning: boolean
}

/**
 * An already-funded commitment survives a freeze. Both conjuncts matter: a
 * commitment signed after the freeze is not grandfathered, and a commitment that
 * was never fully banked was illegal when it was made and is not rescued here.
 */
export function isCommitmentExempt(
  commitment: Commitment,
  freezes: readonly FreezeRecord[],
): boolean {
  if (!commitment.fullyBankedAtSigning) return false
  return freezes.every((f) => commitment.authorizedAtUnix < f.frozenAtUnix)
}

export function freezeIdFor(scope: FreezeScope, varianceId: string): string {
  return `fz_${freezeScopeKey(scope)}_${varianceId}`
}
