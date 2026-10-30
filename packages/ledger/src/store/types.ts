/**
 * The storage contract.
 *
 * `appendWrite` is the only mutation. It is ATOMIC across entries, the
 * observation record, the recognition record and the materialized balances: a
 * store that persists entries but loses the recognition record would re-recognise
 * the same fee on the next replay, which is the exact bug this package exists to
 * prevent.
 *
 * The store maintains balances incrementally. That maintainer is assumed to be
 * wrong until the recompute in balances.ts says otherwise, which is why
 * `listAccountBalances` and the recompute are separate reads over separate data.
 */

import type { Address, AssetAddress, LedgerEntry } from '@fee-split-vaults/core'
import type { AccountBalance, FlowTotal, LedgerScope } from '../balances.js'
import type { IncomeSource, PerSourceTotals } from '../precedence.js'
import type { FreezeRecord } from '../variance.js'

/** One fee observation, kept for replay dedupe and for the audit trail. */
export interface ObservationRecord {
  id: string
  vault: Address
  asset: AssetAddress
  accrualKey: string
  source: IncomeSource
  amountMinor: bigint
  occurredAtUnix: number
  blockHash?: string
  txHash?: string
  logIndex?: number
  /** What the ledger did with it. A duplicate is stored, not discarded. */
  outcome: string
  entryIds: string[]
}

/** Recognition state for one accrual key. At most one row per key. */
export interface RecognitionRecord {
  vault: Address
  asset: AssetAddress
  accrualKey: string
  /** Totals observed per source, including sources that lost on precedence. */
  perSource: PerSourceTotals
  recognizedSource: IncomeSource
  recognizedMinor: bigint
  firstRecognizedAtUnix: number
  lastObservedAtUnix: number
  supersessions: number
}

export interface StoredVariance {
  id: string
  vault: Address
  asset: AssetAddress
  ledgerBalanceMinor: bigint
  chainBalanceMinor: bigint
  deltaMinor: bigint
  severity: 'info' | 'warn' | 'critical'
  detectedAtUnix: number
  note?: string
  blockHash?: string
}

export interface LedgerWrite {
  entries: LedgerEntry[]
  observation?: ObservationRecord
  recognition?: RecognitionRecord
}

export interface AppendResult {
  inserted: number
  /** Entries already present with byte-identical content. Replay landed here. */
  duplicates: number
  entryIds: string[]
}

export interface EntryFilter extends LedgerScope {
  fromUnix?: number
  toUnix?: number
  accountAnySide?: string
}

export interface EntryPage {
  entries: LedgerEntry[]
  /** Opaque. Absent when the listing is exhausted. */
  cursor?: string
}

export interface LedgerStore {
  appendWrite(write: LedgerWrite): Promise<AppendResult>

  getEntry(id: string): Promise<LedgerEntry | undefined>
  /** Ordered by insertion sequence so paging is stable under concurrent writes. */
  listEntries(filter?: EntryFilter, cursor?: string, limit?: number): Promise<EntryPage>

  getObservation(id: string): Promise<ObservationRecord | undefined>
  getRecognition(
    vault: Address,
    asset: AssetAddress,
    accrualKey: string,
  ): Promise<RecognitionRecord | undefined>
  listRecognitions(scope?: LedgerScope): Promise<RecognitionRecord[]>

  listAccountBalances(scope?: LedgerScope): Promise<AccountBalance[]>
  listFlowTotals(scope?: LedgerScope): Promise<FlowTotal[]>

  putVariance(variance: StoredVariance): Promise<void>
  listVariances(scope?: LedgerScope): Promise<StoredVariance[]>

  putFreeze(freeze: FreezeRecord): Promise<void>
  listFreezes(activeOnly?: boolean): Promise<FreezeRecord[]>
  clearFreeze(id: string, clearedAtUnix: number, clearedBy: string): Promise<void>
}

export const DEFAULT_PAGE_SIZE = 500

/**
 * Page through a store as an async iterable. The recompute walks the whole book
 * through this rather than materialising every posting in memory at once.
 */
export async function* iterateEntries(
  store: LedgerStore,
  filter?: EntryFilter,
  pageSize: number = DEFAULT_PAGE_SIZE,
): AsyncIterable<LedgerEntry> {
  let cursor: string | undefined
  for (;;) {
    const page = await store.listEntries(filter, cursor, pageSize)
    for (const entry of page.entries) yield entry
    if (page.cursor === undefined || page.entries.length === 0) return
    cursor = page.cursor
  }
}

export function matchesScope(
  row: { vault: string; asset: string },
  scope?: LedgerScope,
): boolean {
  if (scope === undefined) return true
  if (scope.vault !== undefined && scope.vault !== row.vault) return false
  if (scope.asset !== undefined && scope.asset !== row.asset) return false
  return true
}
