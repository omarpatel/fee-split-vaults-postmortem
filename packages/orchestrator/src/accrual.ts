/**
 * The indexer-to-ledger seam.
 *
 * THE ACCRUAL KEY CONVENTION IS PINNED HERE, and this is the only place in the
 * repository that decides it. The ledger's own note says it plainly: the three
 * or four views of one fee land in different transactions at different times -
 * the hook sweeps, the escrow credits, the vault claims - so the only available
 * join is SCOPE PLUS PERIOD. Every indexer that ever feeds a given fee must
 * produce the same key or precedence silently fails to deduplicate, and a wrong
 * key does not lose money but it does double-count.
 *
 *   THE CONVENTION: dailyAccrualKey(vault, asset, occurredAtUnix).
 *
 * It is correct for both phases because decideRecognition ACCUMULATES within a
 * source: many curve trades on one day sum into perSource.curve_event, and many
 * sweeps sum into perSource.pool_fees_swept, and the declared precedence order
 * picks between them. Using a per-posting key instead would make every posting
 * its own accrual and defeat precedence entirely, which is the exact
 * triple-counting bug the ledger exists to prevent.
 *
 * ONE EDGE CASE, stated because it is real. The declared order is
 * curve_event > pool_fees_swept, so on a GRADUATION DAY - the only day a coin
 * emits both - the curve sum outranks the sweep and the day is recognised at
 * the curve figure. If the sweep was larger, that under-recognises for that one
 * day. Under-recognition is the safe direction (the chain holds more than the
 * ledger claims, which reconciliation surfaces as a positive variance rather
 * than as money the client is allowed to spend), but a graduation-day-aware key
 * would be better and is listed as a followup rather than silently assumed.
 *
 * NOTE what this module does NOT do: it never calls the indexer's
 * toAccrualLedgerEntry(). That helper builds a LedgerEntry directly and would
 * bypass the precedence machinery. Income is recognised through exactly one
 * door, Ledger.recordFeeObservation, and this is it.
 */

import type { FeeObservation, FeeObservationResult, Ledger } from '@fee-split-vaults/ledger'
import { chainBatchKey, dailyAccrualKey } from '@fee-split-vaults/ledger'
import type { FeePosting } from '@fee-split-vaults/indexer'
import type { AllocationObservation, AssetRegistry, ClaimObservation } from './ports.js'
import { FailClosed } from './errors.js'

export interface AccrualResult {
  observed: number
  recognized: number
  duplicates: number
  superseded: number
  replayed: number
  refused: number
  recognizedMinorByAsset: Map<string, bigint>
  /** Machine codes for anything not accrued. Never a silent skip. */
  skipped: Array<{ postingId: string; code: string }>
}

export interface AccrualOptions {
  /**
   * Accrue unfinalized postings too. Income recognition is not spend authority:
   * the ledger recognises what the chain reported, the broker draws budget only
   * from finalized figures, and a reorg reverses through the same door.
   */
  includeUnfinalized?: boolean
  /**
   * The 99%-at-t=0 anti-snipe tax reaches the fee recipient along ordinary
   * rails. It is real money and it is recognised. It is EXCLUDED from QF (that
   * decision lives in the indexer) but excluding it here would leave the ledger
   * permanently short against the chain.
   */
  includeAntiSnipe?: boolean
}

/**
 * Feed postings to the ledger. Idempotent: the observation id is a pure
 * function of the posting's chain coordinates, so re-feeding a scanned range
 * writes nothing and reports 'replayed'.
 */
export async function accruePostings(
  ledger: Ledger,
  postings: readonly FeePosting[],
  assets: AssetRegistry,
  options: AccrualOptions = {},
): Promise<AccrualResult> {
  const result: AccrualResult = {
    observed: 0,
    recognized: 0,
    duplicates: 0,
    superseded: 0,
    replayed: 0,
    refused: 0,
    recognizedMinorByAsset: new Map(),
    skipped: [],
  }

  const includeUnfinalized = options.includeUnfinalized ?? true
  const includeAntiSnipe = options.includeAntiSnipe ?? true

  // Deterministic order so a replay produces the same observation sequence.
  const ordered = [...postings].sort(
    (a, b) =>
      Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex || a.id.localeCompare(b.id),
  )

  for (const posting of ordered) {
    if (!posting.finalized && !includeUnfinalized) {
      result.skipped.push({ postingId: posting.id, code: 'unfinalized' })
      continue
    }
    if (posting.classification === 'anti_snipe_window' && !includeAntiSnipe) {
      result.skipped.push({ postingId: posting.id, code: 'anti_snipe_excluded' })
      continue
    }
    if (posting.creditedMinor <= 0n) {
      result.skipped.push({ postingId: posting.id, code: 'zero_credit' })
      continue
    }
    // An unregistered asset is not a skip we can shrug at: it is money arriving
    // in something nobody approved. Refuse the whole batch rather than accrue
    // against an asset with no decimals and no kill switch.
    const asset = assets.get(posting.asset)
    if (asset === undefined) {
      throw new FailClosed(
        'accrual',
        'unknown_asset',
        `posting ${posting.id} credits unregistered asset ${posting.asset}`,
      )
    }

    const observation: FeeObservation = {
      vault: posting.vault,
      asset: posting.asset,
      amountMinor: posting.creditedMinor,
      source: posting.source,
      accrualKey: dailyAccrualKey(posting.vault, posting.asset, posting.occurredAtUnix),
      occurredAtUnix: posting.occurredAtUnix,
      blockHash: posting.blockHash,
      txHash: posting.txHash,
      logIndex: posting.logIndex,
      memo: `${posting.phase}/${posting.classification}/${posting.derivation}`,
    }

    const outcome: FeeObservationResult = await ledger.recordFeeObservation(observation)
    result.observed += 1
    switch (outcome.outcome) {
      case 'recognized':
        result.recognized += 1
        break
      case 'duplicate_ignored':
        result.duplicates += 1
        break
      case 'superseded':
        result.superseded += 1
        break
      case 'replayed':
        result.replayed += 1
        break
      case 'refused_unbalanced':
        result.refused += 1
        result.skipped.push({ postingId: posting.id, code: 'refused_unbalanced' })
        break
    }
    if (outcome.outcome === 'recognized' || outcome.outcome === 'superseded') {
      const key = posting.asset.toLowerCase()
      result.recognizedMinorByAsset.set(
        key,
        (result.recognizedMinorByAsset.get(key) ?? 0n) + outcome.recognizedMinor,
      )
    }
  }

  return result
}

/**
 * Claims and allocations.
 *
 * Neither of these can recognise income - the whitelist of legal posting pairs
 * makes that structural, not a convention. A claim moves value from the escrow
 * account to the vault account; an allocation splits already-recognised income
 * into the three liability legs. Both are keyed off their chain coordinates, so
 * re-feeding a scanned range is a no-op.
 *
 * ORDER MATTERS AND IS ENFORCED BY THE LEDGER, not by this function: an
 * allocation larger than the income recognised so far fails the sign rule and
 * the write is refused. That is the correct behaviour - it means the indexer
 * saw a settle() whose fee accrual we have not yet observed, and proceeding
 * would credit a client a budget the chain never gave them.
 */
export interface MovementResult {
  claims: number
  allocations: number
  refusals: Array<{ ref: string; code: string; detail: string }>
}

export async function recordChainMovements(
  ledger: Ledger,
  claims: readonly ClaimObservation[],
  allocations: readonly AllocationObservation[],
): Promise<MovementResult> {
  const result: MovementResult = { claims: 0, allocations: 0, refusals: [] }

  for (const claim of claims) {
    if (claim.amountMinor <= 0n) continue
    try {
      await ledger.recordClaim({
        vault: claim.vault,
        asset: claim.asset,
        amountMinor: claim.amountMinor,
        occurredAtUnix: claim.occurredAtUnix,
        batchKey: chainBatchKey('claim', claim.txHash, claim.logIndex),
        txHash: claim.txHash,
        ...(claim.blockHash === undefined ? {} : { blockHash: claim.blockHash }),
        logIndex: claim.logIndex,
      })
      result.claims += 1
    } catch (error) {
      result.refusals.push({
        ref: `${claim.txHash}:${String(claim.logIndex)}`,
        code: 'claim_refused',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  for (const allocation of allocations) {
    const total =
      allocation.devMinor + allocation.budgetMinor + allocation.operatorMinor + allocation.referrerMinor
    if (total <= 0n) continue
    try {
      await ledger.recordAllocation({
        vault: allocation.vault,
        asset: allocation.asset,
        occurredAtUnix: allocation.occurredAtUnix,
        batchKey: chainBatchKey('allocation', allocation.txHash, allocation.logIndex),
        txHash: allocation.txHash,
        ...(allocation.blockHash === undefined ? {} : { blockHash: allocation.blockHash }),
        logIndex: allocation.logIndex,
        amounts: {
          devMinor: allocation.devMinor,
          budgetMinor: allocation.budgetMinor,
          operatorMinor: allocation.operatorMinor,
          referrerMinor: allocation.referrerMinor,
        },
      })
      result.allocations += 1
    } catch (error) {
      result.refusals.push({
        ref: `${allocation.txHash}:${String(allocation.logIndex)}`,
        code: 'allocation_refused',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return result
}
