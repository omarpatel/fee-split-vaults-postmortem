/**
 * Posting templates.
 *
 * Callers never hand-write a debit/credit pair. Each template emits a balanced
 * set of entries for one economic event, with deterministic ids, and every entry
 * it produces is validated against the pair whitelist in accounts.ts.
 *
 * Two templates emit TWO entries because the event is genuinely two things:
 * discharging a restricted leg and paying cash. Splitting them is what lets the
 * weekly report show cumulative procurement expense while `liability:budget`
 * still answers "how much is banked right now", which is the number the
 * commitment rule is checked against.
 */

import type { Address, AssetAddress, LedgerAccount, LedgerEntry } from '@fee-split-vaults/core'
import { classifyPair } from './accounts.js'
import { InvalidInputError } from './errors.js'
import { entryId } from './ids.js'
import type { EntrySource } from './precedence.js'

export interface PostingContext {
  /** Deterministic identity of the event. Replays must reuse it exactly. */
  batchKey: string
  vault: Address
  asset: AssetAddress
  occurredAtUnix: number
  source: EntrySource
  blockHash?: string
  txHash?: string
  logIndex?: number
  memo?: string
}

function assertPositive(amountMinor: bigint, field: string): void {
  if (typeof amountMinor !== 'bigint') {
    throw new InvalidInputError(`${field} must be a bigint in minor units`, field)
  }
  if (amountMinor <= 0n) {
    throw new InvalidInputError(`${field} must be positive; got ${amountMinor.toString()}`, field)
  }
}

function assertContext(ctx: PostingContext): void {
  if (!ctx.batchKey) throw new InvalidInputError('batchKey is required', 'batchKey')
  if (!ctx.vault) throw new InvalidInputError('vault is required', 'vault')
  if (!ctx.asset) throw new InvalidInputError('asset is required', 'asset')
  if (!Number.isFinite(ctx.occurredAtUnix) || ctx.occurredAtUnix < 0) {
    throw new InvalidInputError('occurredAtUnix must be a non-negative finite number', 'occurredAtUnix')
  }
}

/**
 * Build one entry. `index` is the position inside the batch and is part of the
 * id, so two structurally identical legs of the same batch stay distinguishable.
 */
export function makeEntry(
  ctx: PostingContext,
  index: number,
  debit: LedgerAccount,
  credit: LedgerAccount,
  amountMinor: bigint,
  memo?: string,
): LedgerEntry {
  assertContext(ctx)
  assertPositive(amountMinor, 'amountMinor')
  classifyPair(debit, credit)

  const id = entryId({
    batchKey: ctx.batchKey,
    index,
    vault: ctx.vault,
    asset: ctx.asset,
    debit,
    credit,
    amountMinor,
    occurredAtUnix: ctx.occurredAtUnix,
    source: ctx.source,
    blockHash: ctx.blockHash,
    txHash: ctx.txHash,
    logIndex: ctx.logIndex,
  })

  const entry: LedgerEntry = {
    id,
    vault: ctx.vault,
    asset: ctx.asset,
    debit,
    credit,
    amountMinor,
    occurredAtUnix: ctx.occurredAtUnix,
    source: ctx.source,
  }
  if (ctx.blockHash !== undefined) entry.blockHash = ctx.blockHash
  if (ctx.txHash !== undefined) entry.txHash = ctx.txHash
  if (ctx.logIndex !== undefined) entry.logIndex = ctx.logIndex
  const note = memo ?? ctx.memo
  if (note !== undefined) entry.memo = note
  return entry
}

/** Fee recognised. Emitted only by the precedence path in ledger.ts. */
export function accrualEntries(ctx: PostingContext, amountMinor: bigint): LedgerEntry[] {
  return [makeEntry(ctx, 0, 'asset:escrow', 'income:fees', amountMinor)]
}

/**
 * Correction posted when a higher-precedence source revises an amount downward.
 * It reduces the escrow receivable only. If escrow cannot absorb it the write is
 * refused rather than pushed onto `asset:vault`: money already claimed into the
 * vault that turns out not to be this coin's is a mis-attribution a human has to
 * resolve, not a rounding difference the ledger may quietly absorb.
 */
export function reversalEntries(ctx: PostingContext, amountMinor: bigint): LedgerEntry[] {
  return [makeEntry(ctx, 0, 'income:fees', 'asset:escrow', amountMinor)]
}

/**
 * vault.claim()/claimToken(). Always a transfer, never income.
 * Claims are issued in bounded chunks because some approved quote assets impose
 * a per-transfer cap; each chunk is its own observation and its own entry.
 */
export function claimEntries(ctx: PostingContext, amountMinor: bigint): LedgerEntry[] {
  return [makeEntry(ctx, 0, 'asset:vault', 'asset:escrow', amountMinor)]
}

export interface AllocationAmounts {
  devMinor: bigint
  budgetMinor: bigint
  /** The operator's slice net of the referrer's cut, exactly as Credited reports it. */
  operatorMinor: bigint
  /** Carved out of the operator's gross slice on chain; zero when the vault has no referrer. */
  referrerMinor: bigint
}

/**
 * settle()'s split, mirrored. The dev leg absorbs the rounding remainder on
 * chain, so the four legs sum to the credited amount exactly; a caller that
 * hands over legs which do not sum to its own gross figure is rejected by the
 * residual check in balances.ts rather than silently balanced here.
 */
export function allocationEntries(
  ctx: PostingContext,
  amounts: AllocationAmounts,
): LedgerEntry[] {
  const entries: LedgerEntry[] = []
  const legs: Array<[LedgerAccount, bigint]> = [
    ['liability:dev_claimable', amounts.devMinor],
    ['liability:budget', amounts.budgetMinor],
    ['liability:operator_claimable', amounts.operatorMinor],
    ['liability:referrer_claimable', amounts.referrerMinor],
  ]
  legs.forEach(([account, amount], index) => {
    if (amount === 0n) return
    entries.push(makeEntry(ctx, index, 'income:fees', account, amount))
  })
  if (entries.length === 0) {
    throw new InvalidInputError('allocation must move a positive amount', 'amounts')
  }
  return entries
}

/** Pull by the dev's own address. Asset in equals asset out. No conversion. */
export function devWithdrawalEntries(ctx: PostingContext, amountMinor: bigint): LedgerEntry[] {
  return [makeEntry(ctx, 0, 'liability:dev_claimable', 'asset:vault', amountMinor)]
}

export function operatorWithdrawalEntries(ctx: PostingContext, amountMinor: bigint): LedgerEntry[] {
  return [makeEntry(ctx, 0, 'liability:operator_claimable', 'asset:vault', amountMinor)]
}

/**
 * CoinVault.withdrawReferrer: a pull by the REFERRER address against its own
 * leg, independent of the operator's withdrawal and of the operator key. Asset
 * in equals asset out, like the other two pulls.
 */
export function referrerWithdrawalEntries(ctx: PostingContext, amountMinor: bigint): LedgerEntry[] {
  return [makeEntry(ctx, 0, 'liability:referrer_claimable', 'asset:vault', amountMinor)]
}

/**
 * Budget disbursement: a REIMBURSEMENT of the operator's own treasury against a
 * countersigned invoice, because the operator buys all media as principal in its
 * own name. There is no vendor account in the taxonomy and therefore no posting
 * that could express a payment to a third party.
 */
export function budgetDisbursementEntries(
  ctx: PostingContext,
  amountMinor: bigint,
): LedgerEntry[] {
  return [
    makeEntry(ctx, 0, 'liability:budget', 'income:fees', amountMinor, ctx.memo),
    makeEntry(ctx, 1, 'expense:procurement', 'asset:vault', amountMinor, ctx.memo),
  ]
}

/**
 * Cost to serve, drawn against the operator's own leg. It moves cash out of the
 * vault to the operator treasury and classifies it as cost rather than margin.
 * A MODELLED cogs figure with no cash movement is telemetry, not a posting, and
 * must not be recorded here: the account union has no non-cash contra account.
 */
export function cogsEntries(ctx: PostingContext, amountMinor: bigint): LedgerEntry[] {
  return [
    makeEntry(ctx, 0, 'liability:operator_claimable', 'income:fees', amountMinor, ctx.memo),
    makeEntry(ctx, 1, 'expense:cogs', 'asset:vault', amountMinor, ctx.memo),
  ]
}

/** Unproven procurement escrow, or a termination refund, returning to the dev. */
export function budgetRefundEntries(ctx: PostingContext, amountMinor: bigint): LedgerEntry[] {
  return [makeEntry(ctx, 0, 'liability:budget', 'liability:dev_claimable', amountMinor)]
}

/**
 * Launch-token vests, airdrops, and the 99% anti-snipe tax at t=0. Never a fee,
 * never charged, never income. It will look like a windfall in the raw transfer
 * feed; recording it as income would tax the client's own supply as revenue.
 */
export function unattributedInflowEntries(
  ctx: PostingContext,
  amountMinor: bigint,
): LedgerEntry[] {
  return [makeEntry(ctx, 0, 'asset:vault', 'liability:dev_claimable', amountMinor)]
}
