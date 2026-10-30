/**
 * Balance arithmetic, the trial-balance recompute, and the diff.
 *
 * The recompute is the only check that catches a broken incremental balance
 * maintainer. A materialized table that agrees with itself proves nothing; the
 * store's own upsert path is exactly what would be wrong. So the recompute
 * NEVER reads a materialized row - it streams raw postings and re-derives every
 * figure from them.
 *
 * Balances are signed and DEBIT-POSITIVE. A per-(vault, asset) residual of zero
 * is structural given well-formed entries, which is why a non-zero residual is
 * evidence of corrupted storage rather than of a bookkeeping mistake, and is
 * reported as such.
 */

import type { Address, AssetAddress, LedgerAccount, LedgerEntry } from '@fee-split-vaults/core'
import {
  assertLedgerAccount,
  assertSignRule,
  classifyPair,
  naturalBalance,
  type PostingKind,
} from './accounts.js'
import { InvalidInputError, UnbalancedWriteError } from './errors.js'

export interface AccountBalance {
  vault: Address
  asset: AssetAddress
  account: LedgerAccount
  debitsMinor: bigint
  creditsMinor: bigint
  /** debits - credits. Negative for credit-normal accounts. */
  balanceMinor: bigint
  entryCount: number
}

export interface FlowTotal {
  vault: Address
  asset: AssetAddress
  kind: PostingKind
  amountMinor: bigint
  entryCount: number
}

export interface LedgerScope {
  vault?: Address
  asset?: AssetAddress
}

export interface TrialBalance {
  accounts: AccountBalance[]
  flows: FlowTotal[]
  /** debits - credits per "vault|asset". Must be zero everywhere. */
  residualByAssetKey: Map<string, bigint>
  entryCount: number
}

export function scopeKey(vault: string, asset: string): string {
  return `${vault}|${asset}`
}

function accountKey(vault: string, asset: string, account: string): string {
  return `${vault}|${asset}|${account}`
}

function flowKey(vault: string, asset: string, kind: string): string {
  return `${vault}|${asset}|${kind}`
}

/**
 * Streaming accumulator. Used by the recompute and by the store's incremental
 * maintainer, so both sides derive balances through the same arithmetic and a
 * divergence can only come from persistence, not from two implementations of
 * the same sum.
 */
export class BalanceAccumulator {
  private readonly accounts = new Map<string, AccountBalance>()
  private readonly flows = new Map<string, FlowTotal>()
  private count = 0

  add(entry: LedgerEntry): void {
    assertEntryShape(entry)
    const kind = classifyPair(entry.debit, entry.credit)

    this.bump(entry, entry.debit, entry.amountMinor, 0n)
    this.bump(entry, entry.credit, 0n, entry.amountMinor)

    const fk = flowKey(entry.vault, entry.asset, kind)
    const flow = this.flows.get(fk)
    if (flow === undefined) {
      this.flows.set(fk, {
        vault: entry.vault,
        asset: entry.asset,
        kind,
        amountMinor: entry.amountMinor,
        entryCount: 1,
      })
    } else {
      flow.amountMinor += entry.amountMinor
      flow.entryCount += 1
    }

    this.count += 1
  }

  private bump(
    entry: LedgerEntry,
    account: LedgerAccount,
    debit: bigint,
    credit: bigint,
  ): void {
    const key = accountKey(entry.vault, entry.asset, account)
    const row = this.accounts.get(key)
    if (row === undefined) {
      this.accounts.set(key, {
        vault: entry.vault,
        asset: entry.asset,
        account,
        debitsMinor: debit,
        creditsMinor: credit,
        balanceMinor: debit - credit,
        entryCount: 1,
      })
    } else {
      row.debitsMinor += debit
      row.creditsMinor += credit
      row.balanceMinor = row.debitsMinor - row.creditsMinor
      row.entryCount += 1
    }
  }

  result(): TrialBalance {
    const accounts = [...this.accounts.values()].sort(compareAccountRows)
    const flows = [...this.flows.values()].sort(compareFlowRows)

    // Residual is recomputed from the account rows rather than carried forward,
    // so a corrupted stored amount shows up here instead of cancelling itself.
    const residualByAssetKey = new Map<string, bigint>()
    for (const row of accounts) {
      const sk = scopeKey(row.vault, row.asset)
      residualByAssetKey.set(sk, (residualByAssetKey.get(sk) ?? 0n) + row.balanceMinor)
    }
    return { accounts, flows, residualByAssetKey, entryCount: this.count }
  }
}

function compareAccountRows(a: AccountBalance, b: AccountBalance): number {
  return (
    a.vault.localeCompare(b.vault) ||
    a.asset.localeCompare(b.asset) ||
    a.account.localeCompare(b.account)
  )
}

function compareFlowRows(a: FlowTotal, b: FlowTotal): number {
  return (
    a.vault.localeCompare(b.vault) ||
    a.asset.localeCompare(b.asset) ||
    a.kind.localeCompare(b.kind)
  )
}

export function assertEntryShape(entry: LedgerEntry): void {
  if (!entry.id) throw new InvalidInputError('entry.id is required', 'id')
  if (!entry.vault) throw new InvalidInputError('entry.vault is required', 'vault')
  if (!entry.asset) throw new InvalidInputError('entry.asset is required', 'asset')
  assertLedgerAccount(entry.debit, 'debit')
  assertLedgerAccount(entry.credit, 'credit')
  if (entry.debit === entry.credit) {
    throw new InvalidInputError('an entry may not debit and credit the same account', 'debit')
  }
  if (typeof entry.amountMinor !== 'bigint' || entry.amountMinor <= 0n) {
    throw new InvalidInputError('amountMinor must be a positive bigint', 'amountMinor')
  }
  if (!Number.isInteger(entry.occurredAtUnix) || entry.occurredAtUnix < 0) {
    throw new InvalidInputError('occurredAtUnix must be a non-negative integer', 'occurredAtUnix')
  }
}

export function accumulate(entries: Iterable<LedgerEntry>): TrialBalance {
  const acc = new BalanceAccumulator()
  for (const entry of entries) acc.add(entry)
  return acc.result()
}

export async function accumulateAsync(
  entries: AsyncIterable<LedgerEntry>,
): Promise<TrialBalance> {
  const acc = new BalanceAccumulator()
  for await (const entry of entries) acc.add(entry)
  return acc.result()
}

/** Non-zero residual means storage corruption, not a bookkeeping error. */
export function assertBalanced(tb: TrialBalance): void {
  const bad = new Map<string, bigint>()
  for (const [key, residual] of tb.residualByAssetKey) {
    if (residual !== 0n) bad.set(key, residual)
  }
  if (bad.size > 0) {
    throw new UnbalancedWriteError(
      `trial balance does not net to zero for ${bad.size} asset scope(s)`,
      bad,
    )
  }
}

/** Every account must sit on its own side of zero. */
export function assertSignRules(tb: TrialBalance): void {
  for (const row of tb.accounts) {
    assertSignRule(row.account, row.balanceMinor, { vault: row.vault, asset: row.asset })
  }
}

// ---------------------------------------------------------------------------
// Applying a proposed write before it is committed
// ---------------------------------------------------------------------------

export type BalanceLookup = (
  vault: Address,
  asset: AssetAddress,
  account: LedgerAccount,
) => bigint

/**
 * Validate a batch against current balances. Called twice on purpose: once by
 * the Ledger before it asks the store to write, and once by the store inside
 * its own transaction, because between those two moments another writer may
 * have moved the balance.
 */
export function assertWriteIsLegal(entries: readonly LedgerEntry[], current: BalanceLookup): void {
  if (entries.length === 0) {
    throw new InvalidInputError('a write must contain at least one entry', 'entries')
  }

  const deltas = new Map<string, { vault: Address; asset: AssetAddress; account: LedgerAccount; delta: bigint }>()
  const residual = new Map<string, bigint>()

  for (const entry of entries) {
    assertEntryShape(entry)
    classifyPair(entry.debit, entry.credit)

    for (const [account, delta] of [
      [entry.debit, entry.amountMinor],
      [entry.credit, -entry.amountMinor],
    ] as Array<[LedgerAccount, bigint]>) {
      const key = accountKey(entry.vault, entry.asset, account)
      const row = deltas.get(key)
      if (row === undefined) {
        deltas.set(key, { vault: entry.vault, asset: entry.asset, account, delta })
      } else {
        row.delta += delta
      }
    }

    const sk = scopeKey(entry.vault, entry.asset)
    residual.set(sk, residual.get(sk) ?? 0n)
  }

  for (const [, row] of deltas) {
    const sk = scopeKey(row.vault, row.asset)
    residual.set(sk, (residual.get(sk) ?? 0n) + row.delta)
  }

  const bad = new Map<string, bigint>()
  for (const [key, value] of residual) {
    if (value !== 0n) bad.set(key, value)
  }
  if (bad.size > 0) {
    throw new UnbalancedWriteError('debits do not equal credits for every asset in the write', bad)
  }

  for (const [, row] of deltas) {
    const next = current(row.vault, row.asset, row.account) + row.delta
    assertSignRule(row.account, next, { vault: row.vault, asset: row.asset })
  }
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export interface BalanceDiff {
  vault: Address
  asset: AssetAddress
  account: LedgerAccount
  materializedMinor: bigint | null
  recomputedMinor: bigint | null
  deltaMinor: bigint
  reason: 'missing_row' | 'orphan_row' | 'amount_mismatch' | 'count_mismatch'
}

export interface FlowDiff {
  vault: Address
  asset: AssetAddress
  kind: PostingKind
  materializedMinor: bigint | null
  recomputedMinor: bigint | null
  deltaMinor: bigint
}

export interface BalanceVerification {
  ok: boolean
  entryCount: number
  balanceDiffs: BalanceDiff[]
  flowDiffs: FlowDiff[]
  residualByAssetKey: Map<string, bigint>
}

/**
 * Compare the maintained table against the recompute. Any difference at all is
 * a defect: these are integers, so there is no tolerance to allow.
 */
export function diffBalances(
  materialized: readonly AccountBalance[],
  recomputed: readonly AccountBalance[],
): BalanceDiff[] {
  const diffs: BalanceDiff[] = []
  const mat = new Map(materialized.map((r) => [accountKey(r.vault, r.asset, r.account), r]))
  const rec = new Map(recomputed.map((r) => [accountKey(r.vault, r.asset, r.account), r]))

  for (const [key, r] of rec) {
    const m = mat.get(key)
    if (m === undefined) {
      diffs.push({
        vault: r.vault,
        asset: r.asset,
        account: r.account,
        materializedMinor: null,
        recomputedMinor: r.balanceMinor,
        deltaMinor: -r.balanceMinor,
        reason: 'missing_row',
      })
      continue
    }
    if (m.balanceMinor !== r.balanceMinor) {
      diffs.push({
        vault: r.vault,
        asset: r.asset,
        account: r.account,
        materializedMinor: m.balanceMinor,
        recomputedMinor: r.balanceMinor,
        deltaMinor: m.balanceMinor - r.balanceMinor,
        reason: 'amount_mismatch',
      })
    } else if (m.entryCount !== r.entryCount) {
      diffs.push({
        vault: r.vault,
        asset: r.asset,
        account: r.account,
        materializedMinor: m.balanceMinor,
        recomputedMinor: r.balanceMinor,
        deltaMinor: 0n,
        reason: 'count_mismatch',
      })
    }
  }

  for (const [key, m] of mat) {
    if (!rec.has(key)) {
      diffs.push({
        vault: m.vault,
        asset: m.asset,
        account: m.account,
        materializedMinor: m.balanceMinor,
        recomputedMinor: null,
        deltaMinor: m.balanceMinor,
        reason: 'orphan_row',
      })
    }
  }

  return diffs.sort(
    (a, b) =>
      a.vault.localeCompare(b.vault) ||
      a.asset.localeCompare(b.asset) ||
      a.account.localeCompare(b.account),
  )
}

export function diffFlows(
  materialized: readonly FlowTotal[],
  recomputed: readonly FlowTotal[],
): FlowDiff[] {
  const diffs: FlowDiff[] = []
  const mat = new Map(materialized.map((r) => [flowKey(r.vault, r.asset, r.kind), r]))
  const rec = new Map(recomputed.map((r) => [flowKey(r.vault, r.asset, r.kind), r]))

  for (const [key, r] of rec) {
    const m = mat.get(key)
    const materializedMinor = m?.amountMinor ?? null
    if (materializedMinor !== r.amountMinor) {
      diffs.push({
        vault: r.vault,
        asset: r.asset,
        kind: r.kind,
        materializedMinor,
        recomputedMinor: r.amountMinor,
        deltaMinor: (materializedMinor ?? 0n) - r.amountMinor,
      })
    }
  }
  for (const [key, m] of mat) {
    if (!rec.has(key)) {
      diffs.push({
        vault: m.vault,
        asset: m.asset,
        kind: m.kind,
        materializedMinor: m.amountMinor,
        recomputedMinor: null,
        deltaMinor: m.amountMinor,
      })
    }
  }
  return diffs
}

// ---------------------------------------------------------------------------
// Derived figures
// ---------------------------------------------------------------------------

export interface IncomeSummary {
  vault: Address
  asset: AssetAddress
  /** Gross fee recognised, net of any precedence correction. This is QF. */
  recognizedMinor: bigint
  /** Split into legs by settlement. */
  allocatedMinor: bigint
  /** Recognised but not yet split. Non-zero means settle() has not caught up. */
  unallocatedMinor: bigint
  /** Restricted legs discharged by spending. Not revenue; see accounts.ts. */
  releasedMinor: bigint
}

const ALLOCATION_KINDS: readonly PostingKind[] = [
  'allocate_dev',
  'allocate_budget',
  'allocate_operator',
  'allocate_referrer',
]
const RELEASE_KINDS: readonly PostingKind[] = ['release_budget', 'release_operator']

/**
 * Income figures are derived from FLOW totals, never from the `income:fees`
 * balance. The balance mixes recognition, allocation and restricted-fund
 * release, so reading QF off it would silently include released restrictions.
 */
export function incomeSummary(flows: readonly FlowTotal[]): IncomeSummary[] {
  const byScope = new Map<string, IncomeSummary>()
  for (const flow of flows) {
    const key = scopeKey(flow.vault, flow.asset)
    let row = byScope.get(key)
    if (row === undefined) {
      row = {
        vault: flow.vault,
        asset: flow.asset,
        recognizedMinor: 0n,
        allocatedMinor: 0n,
        unallocatedMinor: 0n,
        releasedMinor: 0n,
      }
      byScope.set(key, row)
    }
    if (flow.kind === 'accrue_income') row.recognizedMinor += flow.amountMinor
    else if (flow.kind === 'reverse_income') row.recognizedMinor -= flow.amountMinor
    else if (ALLOCATION_KINDS.includes(flow.kind)) row.allocatedMinor += flow.amountMinor
    else if (RELEASE_KINDS.includes(flow.kind)) row.releasedMinor += flow.amountMinor
  }
  for (const row of byScope.values()) {
    row.unallocatedMinor = row.recognizedMinor - row.allocatedMinor
  }
  return [...byScope.values()].sort(
    (a, b) => a.vault.localeCompare(b.vault) || a.asset.localeCompare(b.asset),
  )
}

/** Human-facing balance in the account's own normal sign. */
export function presentBalance(row: AccountBalance): bigint {
  return naturalBalance(row.account, row.balanceMinor)
}
