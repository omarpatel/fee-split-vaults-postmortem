/**
 * The account taxonomy and, more importantly, the CLOSED WHITELIST of legal
 * debit/credit pairs.
 *
 * There are exactly sixteen legal pairs. Every one maps to a distinct posting
 * kind, so `(debit, credit)` is a total function onto PostingKind and any pair
 * outside the table is a refusal rather than a novel posting. Two consequences
 * worth stating because the code cannot show them:
 *
 *   1. There is NO legal pair that moves `asset:vault` to anything other than an
 *      expense account or a leg settlement. There is no vendor account and no
 *      third-party payee account, so no sequence of legal postings can express
 *      "client money went to a vendor". Budget spend is a reimbursement of the
 *      operator's own treasury and is recorded as such.
 *   2. The classification is derived from the pair, not from a caller-supplied
 *      label, so a mislabelled call cannot produce a mis-classified flow.
 *
 * The account union itself is fixed by packages/core/src/types.ts and is not
 * extensible from here. Two facts about it are load-bearing:
 *   - The referrer has its own leg, `liability:referrer_claimable`, because on
 *     chain it is a real fourth leg with its own pull (CoinVault.withdrawReferrer,
 *     callable only by REFERRER). Its share is carved out of the OPERATOR's slice
 *     in CoinVault._splitOf, never out of the client's, so operator plus referrer
 *     is always the gross operator take and the dev leg is untouched by it.
 *   - There is no equity / net-assets account. That is why discharging a
 *     restricted leg is recorded as a release to `income:fees` paired with the
 *     cash-out expense, which is the standard restricted-fund release and keeps
 *     the accounting identity at zero without inventing an account.
 */

import type { LedgerAccount } from '@fee-split-vaults/core'
import { IllegalPostingError, InvalidInputError, LedgerBalanceError } from './errors.js'

export const LEDGER_ACCOUNTS = [
  'income:fees',
  'asset:escrow',
  'asset:vault',
  'liability:dev_claimable',
  'liability:budget',
  'liability:operator_claimable',
  'liability:referrer_claimable',
  'expense:procurement',
  'expense:cogs',
] as const satisfies readonly LedgerAccount[]

const ACCOUNT_SET: ReadonlySet<string> = new Set<string>(LEDGER_ACCOUNTS)

export function isLedgerAccount(value: unknown): value is LedgerAccount {
  return typeof value === 'string' && ACCOUNT_SET.has(value)
}

export function assertLedgerAccount(value: unknown, field: string): LedgerAccount {
  if (!isLedgerAccount(value)) {
    throw new InvalidInputError(`unknown ledger account ${JSON.stringify(value)}`, field)
  }
  return value
}

/**
 * Normal balance. Balances are stored SIGNED and DEBIT-POSITIVE everywhere in
 * this package, so a credit-normal account carries a non-positive number. The
 * natural (human-facing) figure is the sign-flipped one; see naturalBalance().
 */
export type NormalBalance = 'debit' | 'credit'

export function normalBalanceOf(account: LedgerAccount): NormalBalance {
  return account.startsWith('asset:') || account.startsWith('expense:') ? 'debit' : 'credit'
}

/** Signed debit-positive balance rendered in the account's own normal sign. */
export function naturalBalance(account: LedgerAccount, signedMinor: bigint): bigint {
  return normalBalanceOf(account) === 'debit' ? signedMinor : -signedMinor
}

/**
 * The sixteen legal postings.
 *
 * `accrue_income` is the ONLY kind that recognises income, and precedence.ts is
 * the only thing permitted to emit it.
 */
export type PostingKind =
  /** Fee recognised at accrual. The receivable sits in the Venue escrow. */
  | 'accrue_income'
  /** A higher-precedence source corrected a previous recognition downward. */
  | 'reverse_income'
  /** vault.claim()/claimToken() moved escrow credit into the vault. Not income. */
  | 'claim'
  | 'allocate_dev'
  | 'allocate_budget'
  | 'allocate_operator'
  /** The referrer's cut of the operator slice, as settle() carved it. */
  | 'allocate_referrer'
  /** Pull by the dev's own address. Asset in equals asset out; no conversion. */
  | 'withdraw_dev'
  | 'withdraw_operator'
  /** Pull by the referrer's own address (CoinVault.withdrawReferrer). */
  | 'withdraw_referrer'
  /** Restricted budget leg released because it was spent on the coin's behalf. */
  | 'release_budget'
  /** Reimbursement of the operator treasury against a countersigned invoice. */
  | 'spend_procurement'
  | 'release_operator'
  | 'spend_cogs'
  /** Unproven or refunded procurement escrow returning to the dev leg. */
  | 'refund_budget_to_dev'
  /**
   * Value that arrived without a fee attribution: launch-token vests, airdrops,
   * and the 99% anti-snipe tax at t=0. Never charged, never income; it belongs
   * to the dev leg in full, exactly as CoinVault._splitOf treats it.
   */
  | 'unattributed_inflow'

export interface PostingPair {
  kind: PostingKind
  debit: LedgerAccount
  credit: LedgerAccount
}

export const POSTING_PAIRS: readonly PostingPair[] = [
  { kind: 'accrue_income', debit: 'asset:escrow', credit: 'income:fees' },
  { kind: 'reverse_income', debit: 'income:fees', credit: 'asset:escrow' },
  { kind: 'claim', debit: 'asset:vault', credit: 'asset:escrow' },
  { kind: 'allocate_dev', debit: 'income:fees', credit: 'liability:dev_claimable' },
  { kind: 'allocate_budget', debit: 'income:fees', credit: 'liability:budget' },
  { kind: 'allocate_operator', debit: 'income:fees', credit: 'liability:operator_claimable' },
  { kind: 'allocate_referrer', debit: 'income:fees', credit: 'liability:referrer_claimable' },
  { kind: 'withdraw_dev', debit: 'liability:dev_claimable', credit: 'asset:vault' },
  { kind: 'withdraw_operator', debit: 'liability:operator_claimable', credit: 'asset:vault' },
  { kind: 'withdraw_referrer', debit: 'liability:referrer_claimable', credit: 'asset:vault' },
  { kind: 'release_budget', debit: 'liability:budget', credit: 'income:fees' },
  { kind: 'spend_procurement', debit: 'expense:procurement', credit: 'asset:vault' },
  { kind: 'release_operator', debit: 'liability:operator_claimable', credit: 'income:fees' },
  { kind: 'spend_cogs', debit: 'expense:cogs', credit: 'asset:vault' },
  { kind: 'refund_budget_to_dev', debit: 'liability:budget', credit: 'liability:dev_claimable' },
  { kind: 'unattributed_inflow', debit: 'asset:vault', credit: 'liability:dev_claimable' },
] as const

export const POSTING_KINDS: readonly PostingKind[] = POSTING_PAIRS.map((p) => p.kind)

const PAIR_INDEX: ReadonlyMap<string, PostingKind> = new Map(
  POSTING_PAIRS.map((p) => [`${p.debit}>${p.credit}`, p.kind]),
)

const KIND_INDEX: ReadonlyMap<PostingKind, PostingPair> = new Map(
  POSTING_PAIRS.map((p) => [p.kind, p]),
)

/** Fail closed: an unlisted pair is a defect, not a new feature. */
export function classifyPair(debit: LedgerAccount, credit: LedgerAccount): PostingKind {
  const kind = PAIR_INDEX.get(`${debit}>${credit}`)
  if (kind === undefined) {
    throw new IllegalPostingError(
      `no legal posting debits ${debit} and credits ${credit}`,
      debit,
      credit,
    )
  }
  return kind
}

export function pairForKind(kind: PostingKind): PostingPair {
  const pair = KIND_INDEX.get(kind)
  if (pair === undefined) {
    throw new IllegalPostingError(`unknown posting kind ${String(kind)}`, '', '')
  }
  return pair
}

/**
 * Sign constraints enforced on every write.
 *
 * These are the economic statements the ledger is actually making:
 *   - You cannot claim escrow you were never credited.
 *   - You cannot pay out a leg beyond what settlement allocated to it, which is
 *     the ledger-side expression of the commitment rule: no credit line, ever.
 *   - You cannot allocate more income than you recognised.
 *   - Expense accounts only ever accumulate; a negative expense is a defect.
 */
export function assertSignRule(
  account: LedgerAccount,
  signedMinor: bigint,
  context: { vault: string; asset: string },
): void {
  const natural = naturalBalance(account, signedMinor)
  if (natural < 0n) {
    throw new LedgerBalanceError(
      `${account} would go to ${natural.toString()} (${normalBalanceOf(account)}-normal)`,
      context.vault,
      context.asset,
      account,
      signedMinor,
    )
  }
}
