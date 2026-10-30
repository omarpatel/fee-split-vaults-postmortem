/**
 * The ledger facade.
 *
 * Everything an indexer or a broker touches goes through here, because the
 * invariants live in the ORDER of operations, not in any one function:
 *
 *   1. Replay is checked first, against the observation table. A re-fed log
 *      returns 'replayed' and writes nothing.
 *   2. Precedence decides whether an observation is income at all.
 *   3. The batch is validated against current balances before the store is
 *      asked to write, and again by the store inside its own transaction.
 *   4. Entries, the observation record and the recognition record commit
 *      together. A partial commit is what would re-recognise a fee later.
 *
 * The freeze gate sits on AUTHORIZATION only. Disbursing an already-signed,
 * already-banked commitment is not gated, because the commitment rule already
 * guaranteed the money was there when the obligation was made.
 */

import type {
  Address,
  AssetAddress,
  LedgerAccount,
  LedgerEntry,
  ReconciliationVariance,
} from '@fee-split-vaults/core'
import {
  accumulateAsync,
  assertBalanced,
  assertSignRules,
  diffBalances,
  diffFlows,
  incomeSummary,
  type AccountBalance,
  type BalanceVerification,
  type FlowTotal,
  type IncomeSummary,
  type LedgerScope,
  type TrialBalance,
} from './balances.js'
import { InvalidInputError, LedgerBalanceError, SpendFrozenError } from './errors.js'
import { observationId } from './ids.js'
import {
  accrualEntries,
  allocationEntries,
  budgetDisbursementEntries,
  budgetRefundEntries,
  claimEntries,
  cogsEntries,
  devWithdrawalEntries,
  operatorWithdrawalEntries,
  referrerWithdrawalEntries,
  reversalEntries,
  unattributedInflowEntries,
  type AllocationAmounts,
  type PostingContext,
} from './postings.js'
import {
  assertIncomeSource,
  decideRecognition,
  type IncomeSource,
  type RecognitionOutcome,
} from './precedence.js'
import {
  iterateEntries,
  type AppendResult,
  type LedgerStore,
  type LedgerWrite,
  type ObservationRecord,
  type RecognitionRecord,
  type StoredVariance,
} from './store/types.js'
import {
  freezeCovers,
  freezeIdFor,
  isCommitmentExempt,
  type Commitment,
  type FreezeRecord,
  type FreezeScope,
  type SpendTarget,
} from './variance.js'

export interface FeeObservation {
  vault: Address
  asset: AssetAddress
  amountMinor: bigint
  source: IncomeSource
  /**
   * Groups the views of ONE economic event across sources. Use dailyAccrualKey
   * or sweepAccrualKey from ids.ts; a wrong key does not lose money but it does
   * defeat precedence, so two sources must agree on it exactly.
   */
  accrualKey: string
  occurredAtUnix: number
  blockHash?: string
  txHash?: string
  logIndex?: number
  /** For observations with no chain coordinate, e.g. a backfill. */
  externalRef?: string
  memo?: string
}

export interface FeeObservationResult {
  outcome: RecognitionOutcome
  observationId: string
  entryIds: string[]
  recognizedMinor: bigint
  recognizedSource: IncomeSource
  /** Set when the outcome is 'refused_unbalanced'. */
  refusal?: { reason: string; variance: ReconciliationVariance }
}

export interface MovementRequest {
  vault: Address
  asset: AssetAddress
  amountMinor: bigint
  occurredAtUnix: number
  /** Deterministic. Reuse it on replay or the movement double-posts. */
  batchKey: string
  source?: LedgerEntry['source']
  blockHash?: string
  txHash?: string
  logIndex?: number
  memo?: string
}

export interface DisbursementRequest extends MovementRequest {
  /** The obligation this reimbursement settles. Carries the freeze exemption. */
  commitment: Commitment
  invoiceHash: string
}

export interface LedgerOptions {
  /** Clock injected so replays and tests are deterministic. */
  now?: () => number
}

export class Ledger {
  private readonly now: () => number

  constructor(
    private readonly store: LedgerStore,
    options: LedgerOptions = {},
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
  }

  // -------------------------------------------------------------------------
  // Income
  // -------------------------------------------------------------------------

  /**
   * The only path that can recognise income.
   *
   * A curve event, a pool sweep, an escrow credit and an ERC-20 transfer may all
   * describe the same fee. The first one to arrive recognises it; the rest are
   * recorded and post nothing, unless one of them outranks the recognised source,
   * in which case the difference is corrected.
   */
  async recordFeeObservation(observation: FeeObservation): Promise<FeeObservationResult> {
    const source = assertIncomeSource(observation.source)
    if (observation.amountMinor <= 0n) {
      throw new InvalidInputError('fee observation amount must be positive', 'amountMinor')
    }
    if (!observation.accrualKey) {
      throw new InvalidInputError('accrualKey is required', 'accrualKey')
    }

    const obsId = observationId({
      vault: observation.vault,
      asset: observation.asset,
      source,
      amountMinor: observation.amountMinor,
      occurredAtUnix: observation.occurredAtUnix,
      accrualKey: observation.accrualKey,
      blockHash: observation.blockHash,
      txHash: observation.txHash,
      logIndex: observation.logIndex,
      externalRef: observation.externalRef,
    })

    const seen = await this.store.getObservation(obsId)
    const existingRecognition = await this.store.getRecognition(
      observation.vault,
      observation.asset,
      observation.accrualKey,
    )

    if (seen !== undefined) {
      return {
        outcome: 'replayed',
        observationId: obsId,
        entryIds: seen.entryIds,
        recognizedMinor: existingRecognition?.recognizedMinor ?? 0n,
        recognizedSource: existingRecognition?.recognizedSource ?? source,
      }
    }

    const decision = decideRecognition({
      perSource: existingRecognition?.perSource ?? {},
      recognizedMinor: existingRecognition?.recognizedMinor ?? 0n,
      ...(existingRecognition === undefined
        ? {}
        : { recognizedSource: existingRecognition.recognizedSource }),
      source,
      amountMinor: observation.amountMinor,
    })

    const ctx: PostingContext = {
      batchKey: obsId,
      vault: observation.vault,
      asset: observation.asset,
      occurredAtUnix: observation.occurredAtUnix,
      source,
      ...(observation.blockHash === undefined ? {} : { blockHash: observation.blockHash }),
      ...(observation.txHash === undefined ? {} : { txHash: observation.txHash }),
      ...(observation.logIndex === undefined ? {} : { logIndex: observation.logIndex }),
      ...(observation.memo === undefined ? {} : { memo: observation.memo }),
    }

    let entries: LedgerEntry[] = []
    if (decision.deltaMinor > 0n) {
      entries = accrualEntries(ctx, decision.deltaMinor)
    } else if (decision.deltaMinor < 0n) {
      entries = reversalEntries(ctx, -decision.deltaMinor)
    }

    const recognition: RecognitionRecord = {
      vault: observation.vault,
      asset: observation.asset,
      accrualKey: observation.accrualKey,
      perSource: decision.perSource,
      recognizedSource: decision.winner,
      recognizedMinor: decision.targetMinor,
      firstRecognizedAtUnix:
        existingRecognition?.firstRecognizedAtUnix ?? observation.occurredAtUnix,
      lastObservedAtUnix: observation.occurredAtUnix,
      supersessions:
        (existingRecognition?.supersessions ?? 0) + (decision.outcome === 'superseded' ? 1 : 0),
    }

    const record: ObservationRecord = {
      id: obsId,
      vault: observation.vault,
      asset: observation.asset,
      accrualKey: observation.accrualKey,
      source,
      amountMinor: observation.amountMinor,
      occurredAtUnix: observation.occurredAtUnix,
      ...(observation.blockHash === undefined ? {} : { blockHash: observation.blockHash }),
      ...(observation.txHash === undefined ? {} : { txHash: observation.txHash }),
      ...(observation.logIndex === undefined ? {} : { logIndex: observation.logIndex }),
      outcome: decision.outcome,
      entryIds: entries.map((e) => e.id),
    }

    // A duplicate view posts no entries but still leaves an observation row:
    // "we saw it and ignored it" is a materially different claim from "we never
    // saw it", and only the first one is defensible in an audit.
    const write: LedgerWrite = { entries, observation: record, recognition }

    try {
      await this.store.appendWrite(write)
    } catch (error) {
      if (error instanceof LedgerBalanceError) {
        const variance = await this.freezeOnRefusedCorrection(observation, decision.deltaMinor, error)
        return {
          outcome: 'refused_unbalanced',
          observationId: obsId,
          entryIds: [],
          recognizedMinor: existingRecognition?.recognizedMinor ?? 0n,
          recognizedSource: existingRecognition?.recognizedSource ?? source,
          refusal: { reason: error.message, variance },
        }
      }
      throw error
    }

    return {
      outcome: decision.outcome,
      observationId: obsId,
      entryIds: record.entryIds,
      recognizedMinor: decision.targetMinor,
      recognizedSource: decision.winner,
    }
  }

  /**
   * A downward correction that escrow cannot absorb means value already claimed
   * into the vault is not attributable to this coin. That is a human problem,
   * not a rounding difference, so the correction is refused and the scope is
   * frozen rather than pushed onto `asset:vault`.
   *
   * The refused observation is deliberately NOT written to the observation
   * table. Recording it would mark it seen, and the correction would then never
   * be retried once a human has resolved the mis-attribution.
   */
  private async freezeOnRefusedCorrection(
    observation: FeeObservation,
    deltaMinor: bigint,
    error: LedgerBalanceError,
  ): Promise<ReconciliationVariance> {
    const variance: ReconciliationVariance = {
      vault: observation.vault,
      asset: observation.asset,
      ledgerBalanceMinor: error.resultingBalanceMinor,
      chainBalanceMinor: 0n,
      deltaMinor,
      severity: 'critical',
      detectedAtUnix: observation.occurredAtUnix,
    }
    const varianceId = `vr_correction_${observation.accrualKey}_${observation.source}`
    await this.recordVariance(
      { ...variance, id: varianceId, note: error.message },
      { kind: 'vault_asset', vault: observation.vault, asset: observation.asset },
    )
    return variance
  }

  // -------------------------------------------------------------------------
  // Movements. None of these can recognise income.
  // -------------------------------------------------------------------------

  /** vault.claim()/claimToken(), in bounded chunks. One chunk, one call. */
  async recordClaim(request: MovementRequest): Promise<AppendResult> {
    return this.write(claimEntries(this.context(request, 'erc20_transfer'), request.amountMinor))
  }

  /**
   * settle()'s split. The legs must sum to the credited amount; the dev leg
   * absorbs the on-chain rounding remainder, so a caller that computes the split
   * itself must reproduce that or the residual check rejects the write.
   */
  async recordAllocation(
    request: Omit<MovementRequest, 'amountMinor'> & { amounts: AllocationAmounts },
  ): Promise<AppendResult> {
    return this.write(allocationEntries(this.context(request, 'manual'), request.amounts))
  }

  async recordDevWithdrawal(request: MovementRequest): Promise<AppendResult> {
    return this.write(
      devWithdrawalEntries(this.context(request, 'erc20_transfer'), request.amountMinor),
    )
  }

  async recordOperatorWithdrawal(request: MovementRequest): Promise<AppendResult> {
    return this.write(
      operatorWithdrawalEntries(this.context(request, 'erc20_transfer'), request.amountMinor),
    )
  }

  /** CoinVault.withdrawReferrer: the referrer pulling its own leg. */
  async recordReferrerWithdrawal(request: MovementRequest): Promise<AppendResult> {
    return this.write(
      referrerWithdrawalEntries(this.context(request, 'erc20_transfer'), request.amountMinor),
    )
  }

  /**
   * Reimbursement of the operator treasury against a countersigned invoice.
   * A freeze does NOT block this when the commitment was signed before the
   * freeze and was fully banked at signing; a commitment failing either test is
   * refused.
   */
  async recordBudgetDisbursement(request: DisbursementRequest): Promise<AppendResult> {
    const freezes = await this.activeFreezesFor({ vault: request.vault, asset: request.asset })
    if (freezes.length > 0 && !isCommitmentExempt(request.commitment, freezes)) {
      throw new SpendFrozenError(
        `disbursement for commitment ${request.commitment.id} is not exempt from an active freeze`,
        freezes.map((f) => f.id),
      )
    }
    const ctx = this.context(
      { ...request, memo: request.memo ?? `invoice:${request.invoiceHash}` },
      'manual',
    )
    return this.write(budgetDisbursementEntries(ctx, request.amountMinor))
  }

  async recordCogs(request: MovementRequest): Promise<AppendResult> {
    return this.write(cogsEntries(this.context(request, 'manual'), request.amountMinor))
  }

  /** Unproven procurement escrow, or a termination refund, back to the dev leg. */
  async recordBudgetRefund(request: MovementRequest): Promise<AppendResult> {
    return this.write(
      budgetRefundEntries(this.context(request, 'manual'), request.amountMinor),
    )
  }

  /** Launch-token vests, airdrops, and the anti-snipe tax. Never income. */
  async recordUnattributedInflow(request: MovementRequest): Promise<AppendResult> {
    return this.write(
      unattributedInflowEntries(
        this.context(request, 'erc20_transfer'),
        request.amountMinor,
      ),
    )
  }

  private context(
    request: Omit<MovementRequest, 'amountMinor'>,
    fallbackSource: LedgerEntry['source'],
  ): PostingContext {
    if (!request.batchKey) throw new InvalidInputError('batchKey is required', 'batchKey')
    return {
      batchKey: request.batchKey,
      vault: request.vault,
      asset: request.asset,
      occurredAtUnix: request.occurredAtUnix,
      source: request.source ?? fallbackSource,
      ...(request.blockHash === undefined ? {} : { blockHash: request.blockHash }),
      ...(request.txHash === undefined ? {} : { txHash: request.txHash }),
      ...(request.logIndex === undefined ? {} : { logIndex: request.logIndex }),
      ...(request.memo === undefined ? {} : { memo: request.memo }),
    }
  }

  private async write(entries: LedgerEntry[]): Promise<AppendResult> {
    return this.store.appendWrite({ entries })
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async balances(scope?: LedgerScope): Promise<AccountBalance[]> {
    return this.store.listAccountBalances(scope)
  }

  async flows(scope?: LedgerScope): Promise<FlowTotal[]> {
    return this.store.listFlowTotals(scope)
  }

  async balanceOf(
    vault: Address,
    asset: AssetAddress,
    account: LedgerAccount,
  ): Promise<bigint> {
    const rows = await this.store.listAccountBalances({ vault, asset })
    return rows.find((r) => r.account === account)?.balanceMinor ?? 0n
  }

  /** Recomputed from raw postings. Never reads a materialized row. */
  async recomputeTrialBalance(scope?: LedgerScope): Promise<TrialBalance> {
    const tb = await accumulateAsync(iterateEntries(this.store, scope))
    assertBalanced(tb)
    return tb
  }

  /**
   * The check that catches a broken incremental maintainer. Two independent
   * derivations of the same numbers; any difference is a defect, and integers
   * leave no room for a tolerance.
   */
  async verifyBalances(scope?: LedgerScope): Promise<BalanceVerification> {
    const recomputed = await this.recomputeTrialBalance(scope)
    const materialized = await this.store.listAccountBalances(scope)
    const materializedFlows = await this.store.listFlowTotals(scope)

    const balanceDiffs = diffBalances(materialized, recomputed.accounts)
    const flowDiffs = diffFlows(materializedFlows, recomputed.flows)

    return {
      ok: balanceDiffs.length === 0 && flowDiffs.length === 0,
      entryCount: recomputed.entryCount,
      balanceDiffs,
      flowDiffs,
      residualByAssetKey: recomputed.residualByAssetKey,
    }
  }

  /** Recomputes and additionally asserts every account's sign rule. */
  async auditIntegrity(scope?: LedgerScope): Promise<BalanceVerification> {
    const verification = await this.verifyBalances(scope)
    const recomputed = await this.recomputeTrialBalance(scope)
    assertSignRules(recomputed)
    return verification
  }

  async incomeSummary(scope?: LedgerScope): Promise<IncomeSummary[]> {
    return incomeSummary(await this.store.listFlowTotals(scope))
  }

  // -------------------------------------------------------------------------
  // Variances and the spend freeze
  // -------------------------------------------------------------------------

  /**
   * Persist a variance and, when it is critical, freeze new spend authorization
   * for its scope. Info and warn record and move on: a freeze that fires on
   * rounding dust is a freeze nobody will leave switched on.
   */
  async recordVariance(
    variance: StoredVariance,
    scope: FreezeScope = { kind: 'vault_asset', vault: variance.vault, asset: variance.asset },
  ): Promise<FreezeRecord | undefined> {
    await this.store.putVariance(variance)
    if (variance.severity !== 'critical') return undefined

    const freeze: FreezeRecord = {
      id: freezeIdFor(scope, variance.id),
      scope,
      reason: variance.note ?? `critical variance ${variance.id}`,
      varianceId: variance.id,
      frozenAtUnix: variance.detectedAtUnix,
    }
    await this.store.putFreeze(freeze)
    return freeze
  }

  async activeFreezesFor(target: SpendTarget): Promise<FreezeRecord[]> {
    const freezes = await this.store.listFreezes(true)
    return freezes.filter((f) => freezeCovers(f, target))
  }

  async isSpendAuthorizationFrozen(target: SpendTarget): Promise<boolean> {
    return (await this.activeFreezesFor(target)).length > 0
  }

  /**
   * The gate the broker calls before authorizing NEW spend. It has no
   * commitment argument on purpose: an authorization that does not exist yet
   * cannot be grandfathered.
   */
  async assertSpendAuthorizationAllowed(target: SpendTarget): Promise<void> {
    const freezes = await this.activeFreezesFor(target)
    if (freezes.length > 0) {
      throw new SpendFrozenError(
        `new spend authorization is frozen for ${target.vault}` +
          (target.asset === undefined ? '' : ` / ${target.asset}`),
        freezes.map((f) => f.id),
      )
    }
  }

  async clearFreeze(id: string, clearedBy: string, clearedAtUnix?: number): Promise<void> {
    await this.store.clearFreeze(id, clearedAtUnix ?? this.now(), clearedBy)
  }

  async listVariances(scope?: LedgerScope): Promise<StoredVariance[]> {
    return this.store.listVariances(scope)
  }
}
