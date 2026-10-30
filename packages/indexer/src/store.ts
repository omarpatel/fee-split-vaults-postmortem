/**
 * Persistence boundary.
 *
 * The interface is async because a real deployment puts this in Postgres beside
 * the ledger; the in-memory implementation is the test double and the single-
 * process default. Two behaviours are part of the contract, not the
 * implementation:
 *
 *   - putPostings is IDEMPOTENT on posting id, so re-scanning an overlapping
 *     range can never double-count a fee.
 *   - markFinalizedThrough only finalises a posting whose block hash still
 *     matches the tracked canonical hash at that height. A posting whose block
 *     we cannot vouch for stays unfinalised, and unfinalised money grants no
 *     budget authority.
 */

import type { Address, PoolId } from '@fee-split-vaults/core'
import type { Hex } from './hex.js'
import { addressEquals } from './hex.js'
import type { CoinBinding, FeePosting, PendingOverride, RecipientObservation } from './model.js'
import type { BlockRef } from './rpc.js'

export type CursorKey = 'curve_trades' | 'pool_fees' | 'registry_events'

export interface PostingQuery {
  readonly vault?: Address
  readonly token?: Address
  readonly fromUnix?: number
  readonly toUnix?: number
  readonly finalizedOnly?: boolean
}

export interface IndexerStore {
  putBindings(bindings: readonly CoinBinding[]): Promise<void>
  bindings(): Promise<CoinBinding[]>
  bindingByToken(token: Address): Promise<CoinBinding | undefined>
  bindingByCurve(curve: Address): Promise<CoinBinding | undefined>
  bindingByPoolId(poolId: PoolId): Promise<CoinBinding | undefined>

  /** Returns how many postings were new. Existing ids are left untouched. */
  putPostings(postings: readonly FeePosting[]): Promise<number>
  postings(query: PostingQuery): Promise<FeePosting[]>
  /** Removes every posting above blockNumber and returns what was removed. */
  rollbackAboveBlock(blockNumber: bigint): Promise<FeePosting[]>
  markFinalizedThrough(blockNumber: bigint): Promise<number>

  putBlock(block: BlockRef): Promise<void>
  block(blockNumber: bigint): Promise<BlockRef | undefined>
  highestTrackedBlock(): Promise<BlockRef | undefined>
  deleteBlocksAbove(blockNumber: bigint): Promise<void>
  pruneBlocksBelow(blockNumber: bigint): Promise<void>

  getCursor(key: CursorKey): Promise<bigint | undefined>
  setCursor(key: CursorKey, blockNumber: bigint): Promise<void>

  putOverride(override: PendingOverride): Promise<void>
  overrides(token?: Address): Promise<PendingOverride[]>
  clearOverride(token: Address, effectiveAtUnix: number): Promise<void>

  putRecipientObservation(observation: RecipientObservation): Promise<void>
  recipientObservation(token: Address): Promise<RecipientObservation | undefined>
}

export class InMemoryIndexerStore implements IndexerStore {
  private readonly bindingsByToken = new Map<string, CoinBinding>()
  private readonly postingsById = new Map<string, FeePosting>()
  private readonly blocksByNumber = new Map<string, BlockRef>()
  private readonly cursors = new Map<CursorKey, bigint>()
  private readonly overridesByToken = new Map<string, PendingOverride[]>()
  private readonly recipientByToken = new Map<string, RecipientObservation>()

  async putBindings(bindings: readonly CoinBinding[]): Promise<void> {
    for (const binding of bindings) {
      this.bindingsByToken.set(binding.token.toLowerCase(), binding)
    }
  }

  async bindings(): Promise<CoinBinding[]> {
    return [...this.bindingsByToken.values()]
  }

  async bindingByToken(token: Address): Promise<CoinBinding | undefined> {
    return this.bindingsByToken.get(token.toLowerCase())
  }

  async bindingByCurve(curve: Address): Promise<CoinBinding | undefined> {
    for (const binding of this.bindingsByToken.values()) {
      if (addressEquals(binding.curve, curve)) return binding
    }
    return undefined
  }

  /** Confirmed pool ids only. A candidate id never attributes a sweep. */
  async bindingByPoolId(poolId: PoolId): Promise<CoinBinding | undefined> {
    for (const binding of this.bindingsByToken.values()) {
      if (binding.poolId !== undefined && binding.poolId.toLowerCase() === poolId.toLowerCase()) {
        return binding
      }
    }
    return undefined
  }

  async putPostings(postings: readonly FeePosting[]): Promise<number> {
    let added = 0
    for (const posting of postings) {
      if (this.postingsById.has(posting.id)) continue
      this.postingsById.set(posting.id, posting)
      added++
    }
    return added
  }

  async postings(query: PostingQuery): Promise<FeePosting[]> {
    const out: FeePosting[] = []
    for (const posting of this.postingsById.values()) {
      if (query.vault !== undefined && !addressEquals(posting.vault, query.vault)) continue
      if (query.token !== undefined && !addressEquals(posting.token, query.token)) continue
      if (query.fromUnix !== undefined && posting.occurredAtUnix < query.fromUnix) continue
      if (query.toUnix !== undefined && posting.occurredAtUnix >= query.toUnix) continue
      if (query.finalizedOnly === true && !posting.finalized) continue
      out.push(posting)
    }
    return out.sort(
      (a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex,
    )
  }

  async rollbackAboveBlock(blockNumber: bigint): Promise<FeePosting[]> {
    const removed: FeePosting[] = []
    for (const [id, posting] of this.postingsById) {
      if (posting.blockNumber > blockNumber) {
        removed.push(posting)
        this.postingsById.delete(id)
      }
    }
    return removed
  }

  async markFinalizedThrough(blockNumber: bigint): Promise<number> {
    let marked = 0
    for (const [id, posting] of this.postingsById) {
      if (posting.finalized || posting.blockNumber > blockNumber) continue
      const tracked = this.blocksByNumber.get(posting.blockNumber.toString())
      // No tracked block, or a different hash: we cannot vouch for it, so it
      // stays unfinalised and grants no authority.
      if (!tracked || tracked.hash !== posting.blockHash) continue
      this.postingsById.set(id, { ...posting, finalized: true })
      marked++
    }
    return marked
  }

  async putBlock(block: BlockRef): Promise<void> {
    this.blocksByNumber.set(block.number.toString(), block)
  }

  async block(blockNumber: bigint): Promise<BlockRef | undefined> {
    return this.blocksByNumber.get(blockNumber.toString())
  }

  async highestTrackedBlock(): Promise<BlockRef | undefined> {
    let highest: BlockRef | undefined
    for (const block of this.blocksByNumber.values()) {
      if (!highest || block.number > highest.number) highest = block
    }
    return highest
  }

  async deleteBlocksAbove(blockNumber: bigint): Promise<void> {
    for (const [key, block] of this.blocksByNumber) {
      if (block.number > blockNumber) this.blocksByNumber.delete(key)
    }
  }

  async pruneBlocksBelow(blockNumber: bigint): Promise<void> {
    for (const [key, block] of this.blocksByNumber) {
      if (block.number < blockNumber) this.blocksByNumber.delete(key)
    }
  }

  async getCursor(key: CursorKey): Promise<bigint | undefined> {
    return this.cursors.get(key)
  }

  async setCursor(key: CursorKey, blockNumber: bigint): Promise<void> {
    this.cursors.set(key, blockNumber)
  }

  async putOverride(override: PendingOverride): Promise<void> {
    const key = override.token.toLowerCase()
    const existing = this.overridesByToken.get(key) ?? []
    if (existing.some((o) => o.effectiveAtUnix === override.effectiveAtUnix && o.txHash === override.txHash)) {
      return
    }
    existing.push(override)
    this.overridesByToken.set(key, existing)
  }

  async overrides(token?: Address): Promise<PendingOverride[]> {
    if (token !== undefined) return [...(this.overridesByToken.get(token.toLowerCase()) ?? [])]
    return [...this.overridesByToken.values()].flat()
  }

  async clearOverride(token: Address, effectiveAtUnix: number): Promise<void> {
    const key = token.toLowerCase()
    const existing = this.overridesByToken.get(key) ?? []
    this.overridesByToken.set(
      key,
      existing.filter((o) => o.effectiveAtUnix !== effectiveAtUnix),
    )
  }

  async putRecipientObservation(observation: RecipientObservation): Promise<void> {
    this.recipientByToken.set(observation.token.toLowerCase(), observation)
  }

  async recipientObservation(token: Address): Promise<RecipientObservation | undefined> {
    return this.recipientByToken.get(token.toLowerCase())
  }

  /** Hash of the tracked canonical block at a height, if we have it. */
  trackedHashAt(blockNumber: bigint): Hex | undefined {
    return this.blocksByNumber.get(blockNumber.toString())?.hash
  }
}
