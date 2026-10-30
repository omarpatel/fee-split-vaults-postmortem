/**
 * In-memory store. Not a stub: it is the reference implementation of the write
 * contract, and the SQL store is checked against the same test suite.
 *
 * ATOMICITY. Every check runs before any mutation, and the mutations are staged
 * and applied in one synchronous block at the end. A refused write leaves no
 * trace at all - no orphan entry, no advanced recognition record, no drifted
 * balance - which is what makes a refusal safe to retry.
 */

import type { Address, AssetAddress, LedgerAccount, LedgerEntry } from '@fee-split-vaults/core'
import { classifyPair } from '../accounts.js'
import {
  assertWriteIsLegal,
  type AccountBalance,
  type FlowTotal,
  type LedgerScope,
} from '../balances.js'
import { EntryIdCollisionError, InvalidInputError } from '../errors.js'
import {
  matchesScope,
  type AppendResult,
  type EntryFilter,
  type EntryPage,
  type LedgerStore,
  type LedgerWrite,
  type ObservationRecord,
  type RecognitionRecord,
  type StoredVariance,
  DEFAULT_PAGE_SIZE,
} from './types.js'
import type { FreezeRecord } from '../variance.js'

interface StoredEntry {
  seq: number
  entry: LedgerEntry
}

function accountKey(vault: string, asset: string, account: string): string {
  return `${vault}|${asset}|${account}`
}

function recognitionKey(vault: string, asset: string, accrualKey: string): string {
  return `${vault}|${asset}|${accrualKey}`
}

/** Structural equality for replay detection. bigints compared as bigints. */
function sameEntry(a: LedgerEntry, b: LedgerEntry): boolean {
  return (
    a.vault === b.vault &&
    a.asset === b.asset &&
    a.debit === b.debit &&
    a.credit === b.credit &&
    a.amountMinor === b.amountMinor &&
    a.occurredAtUnix === b.occurredAtUnix &&
    a.source === b.source &&
    a.blockHash === b.blockHash &&
    a.txHash === b.txHash &&
    a.logIndex === b.logIndex
  )
}

export class InMemoryLedgerStore implements LedgerStore {
  private readonly entries = new Map<string, StoredEntry>()
  private readonly order: StoredEntry[] = []
  private readonly observations = new Map<string, ObservationRecord>()
  private readonly recognitions = new Map<string, RecognitionRecord>()
  private readonly accounts = new Map<string, AccountBalance>()
  private readonly flows = new Map<string, FlowTotal>()
  private readonly variances = new Map<string, StoredVariance>()
  private readonly freezes = new Map<string, FreezeRecord>()
  private seq = 0

  async appendWrite(write: LedgerWrite): Promise<AppendResult> {
    const fresh: LedgerEntry[] = []
    let duplicates = 0

    for (const entry of write.entries) {
      const existing = this.entries.get(entry.id)
      if (existing === undefined) {
        fresh.push(entry)
        continue
      }
      if (!sameEntry(existing.entry, entry)) {
        throw new EntryIdCollisionError(entry.id)
      }
      duplicates += 1
    }

    if (fresh.length > 0) {
      assertWriteIsLegal(fresh, (vault, asset, account) => this.balanceOf(vault, asset, account))
    }

    for (const entry of fresh) {
      const stored: StoredEntry = { seq: this.seq++, entry }
      this.entries.set(entry.id, stored)
      this.order.push(stored)
      this.applyToBalances(entry)
    }

    if (write.observation !== undefined) {
      this.observations.set(write.observation.id, write.observation)
    }
    if (write.recognition !== undefined) {
      const r = write.recognition
      this.recognitions.set(recognitionKey(r.vault, r.asset, r.accrualKey), r)
    }

    return {
      inserted: fresh.length,
      duplicates,
      entryIds: write.entries.map((e) => e.id),
    }
  }

  private balanceOf(vault: string, asset: string, account: LedgerAccount): bigint {
    return this.accounts.get(accountKey(vault, asset, account))?.balanceMinor ?? 0n
  }

  private applyToBalances(entry: LedgerEntry): void {
    this.bump(entry, entry.debit, entry.amountMinor, 0n)
    this.bump(entry, entry.credit, 0n, entry.amountMinor)

    const kind = classifyPair(entry.debit, entry.credit)
    const fk = accountKey(entry.vault, entry.asset, kind)
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

  async getEntry(id: string): Promise<LedgerEntry | undefined> {
    return this.entries.get(id)?.entry
  }

  async listEntries(
    filter?: EntryFilter,
    cursor?: string,
    limit: number = DEFAULT_PAGE_SIZE,
  ): Promise<EntryPage> {
    const after = cursor === undefined ? -1 : Number.parseInt(cursor, 10)
    if (Number.isNaN(after)) throw new InvalidInputError('malformed cursor', 'cursor')

    const out: LedgerEntry[] = []
    let lastSeq = after
    for (const stored of this.order) {
      if (stored.seq <= after) continue
      if (!entryMatches(stored.entry, filter)) {
        lastSeq = stored.seq
        continue
      }
      out.push(stored.entry)
      lastSeq = stored.seq
      if (out.length >= limit) break
    }

    const exhausted = lastSeq >= this.seq - 1
    const page: EntryPage = { entries: out }
    if (!exhausted) page.cursor = String(lastSeq)
    return page
  }

  async getObservation(id: string): Promise<ObservationRecord | undefined> {
    return this.observations.get(id)
  }

  async getRecognition(
    vault: Address,
    asset: AssetAddress,
    accrualKey: string,
  ): Promise<RecognitionRecord | undefined> {
    return this.recognitions.get(recognitionKey(vault, asset, accrualKey))
  }

  async listRecognitions(scope?: LedgerScope): Promise<RecognitionRecord[]> {
    return [...this.recognitions.values()].filter((r) => matchesScope(r, scope))
  }

  async listAccountBalances(scope?: LedgerScope): Promise<AccountBalance[]> {
    return [...this.accounts.values()]
      .filter((r) => matchesScope(r, scope))
      .map((r) => ({ ...r }))
      .sort(
        (a, b) =>
          a.vault.localeCompare(b.vault) ||
          a.asset.localeCompare(b.asset) ||
          a.account.localeCompare(b.account),
      )
  }

  async listFlowTotals(scope?: LedgerScope): Promise<FlowTotal[]> {
    return [...this.flows.values()]
      .filter((r) => matchesScope(r, scope))
      .map((r) => ({ ...r }))
      .sort(
        (a, b) =>
          a.vault.localeCompare(b.vault) ||
          a.asset.localeCompare(b.asset) ||
          a.kind.localeCompare(b.kind),
      )
  }

  async putVariance(variance: StoredVariance): Promise<void> {
    this.variances.set(variance.id, variance)
  }

  async listVariances(scope?: LedgerScope): Promise<StoredVariance[]> {
    return [...this.variances.values()].filter((v) => matchesScope(v, scope))
  }

  async putFreeze(freeze: FreezeRecord): Promise<void> {
    const existing = this.freezes.get(freeze.id)
    // A repeated detection must not resurrect a freeze a human already cleared.
    if (existing !== undefined && existing.clearedAtUnix !== undefined) return
    this.freezes.set(freeze.id, freeze)
  }

  async listFreezes(activeOnly = true): Promise<FreezeRecord[]> {
    return [...this.freezes.values()].filter(
      (f) => !activeOnly || f.clearedAtUnix === undefined,
    )
  }

  async clearFreeze(id: string, clearedAtUnix: number, clearedBy: string): Promise<void> {
    const freeze = this.freezes.get(id)
    if (freeze === undefined) throw new InvalidInputError(`unknown freeze ${id}`, 'id')
    this.freezes.set(id, { ...freeze, clearedAtUnix, clearedBy })
  }

  /** Test and diagnostic helper. Corrupts a materialized row without touching
   *  postings, so the recompute has something real to catch. */
  corruptMaterializedBalanceForTest(
    vault: Address,
    asset: AssetAddress,
    account: LedgerAccount,
    deltaMinor: bigint,
  ): void {
    const key = accountKey(vault, asset, account)
    const row = this.accounts.get(key)
    if (row === undefined) throw new InvalidInputError('no such balance row', 'account')
    row.debitsMinor += deltaMinor
    row.balanceMinor = row.debitsMinor - row.creditsMinor
  }
}

function entryMatches(entry: LedgerEntry, filter?: EntryFilter): boolean {
  if (filter === undefined) return true
  if (!matchesScope(entry, filter)) return false
  if (filter.fromUnix !== undefined && entry.occurredAtUnix < filter.fromUnix) return false
  if (filter.toUnix !== undefined && entry.occurredAtUnix > filter.toUnix) return false
  if (
    filter.accountAnySide !== undefined &&
    entry.debit !== filter.accountAnySide &&
    entry.credit !== filter.accountAnySide
  ) {
    return false
  }
  return true
}
