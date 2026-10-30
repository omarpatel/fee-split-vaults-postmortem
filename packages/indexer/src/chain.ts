/**
 * Reorg handling, finality and backfill ranges.
 *
 * The rule that shapes this file: a posting may be rolled back freely while it
 * is unfinalised, and NEVER once it is finalised. If a reorg reaches a block at
 * or below the finalized head, budget authority was granted against money that
 * may no longer exist, and no amount of re-scanning fixes that. It halts.
 *
 * Backfill and live tailing are the same code path. Because posting ids are pure
 * functions of chain position, re-scanning an already-scanned range is a no-op,
 * so ranges may overlap freely and a crash mid-tick costs nothing.
 */

import { FinalityViolationError, ReorgTooDeepError, ScanRetryError } from './errors.js'
import type { Hex } from './hex.js'
import type { FeePosting } from './model.js'
import type { QuorumRpc } from './quorum.js'
import type { BlockRef } from './rpc.js'
import type { CursorKey, IndexerStore } from './store.js'

export interface ChainTrackerOptions {
  /** How far below the tracked tip we will search for a common ancestor. */
  readonly maxReorgDepth?: number
  /** Tracked block records below (finalized - this) are pruned. */
  readonly blockRetentionDepth?: number
}

export interface ReorgOutcome {
  readonly reorged: boolean
  readonly commonAncestor: bigint | null
  readonly depth: number
  readonly removedPostings: readonly FeePosting[]
}

const ALL_CURSORS: readonly CursorKey[] = ['curve_trades', 'pool_fees', 'registry_events']

export class ChainTracker {
  private readonly maxReorgDepth: number
  private readonly blockRetentionDepth: number

  constructor(
    private readonly rpc: QuorumRpc,
    private readonly store: IndexerStore,
    options: ChainTrackerOptions = {},
  ) {
    this.maxReorgDepth = options.maxReorgDepth ?? 256
    this.blockRetentionDepth = options.blockRetentionDepth ?? 2_048
  }

  /**
   * Compare our tracked blocks against the canonical chain and, if they have
   * diverged, discard everything above the common ancestor and rewind the
   * cursors so the new branch is re-scanned.
   */
  async reconcile(head: BlockRef, finalized: BlockRef): Promise<ReorgOutcome> {
    const tracked = await this.store.highestTrackedBlock()
    if (!tracked) {
      return { reorged: false, commonAncestor: null, depth: 0, removedPostings: [] }
    }

    // A head below our tracked tip means the quorum itself rewound. Treat the
    // head as authoritative and re-derive everything above it.
    let cursor = tracked.number < head.number ? tracked.number : head.number
    const searchedFrom = cursor
    let depth = 0
    let diverged = false

    while (depth <= this.maxReorgDepth) {
      const ours = await this.store.block(cursor)
      if (ours === undefined) {
        // Nothing tracked at this height; nothing to contradict.
        if (cursor === 0n) break
        cursor -= 1n
        depth++
        continue
      }

      const canonical = await this.rpc.blockByNumber(cursor)
      if (canonical !== null && canonical.hash === ours.hash) break

      diverged = true
      if (cursor <= finalized.number) {
        throw new FinalityViolationError(
          cursor,
          finalized.number,
          `tracked ${ours.hash} is no longer canonical (chain says ${canonical?.hash ?? 'nothing'})`,
        )
      }
      if (cursor === 0n) break
      cursor -= 1n
      depth++
    }

    if (depth > this.maxReorgDepth) {
      throw new ReorgTooDeepError(searchedFrom, this.maxReorgDepth)
    }

    const staleAbove = tracked.number > head.number
    if (!diverged && !staleAbove) {
      return { reorged: false, commonAncestor: cursor, depth: 0, removedPostings: [] }
    }

    const ancestor = diverged ? cursor : head.number
    const removedPostings = await this.store.rollbackAboveBlock(ancestor)
    await this.store.deleteBlocksAbove(ancestor)
    for (const key of ALL_CURSORS) {
      const existing = await this.store.getCursor(key)
      if (existing !== undefined && existing > ancestor) {
        await this.store.setCursor(key, ancestor)
      }
    }

    return {
      reorged: true,
      commonAncestor: ancestor,
      depth: diverged ? depth : Number(tracked.number - head.number),
      removedPostings,
    }
  }

  /**
   * Resolve the blocks a batch of logs came from, pinned by hash, so postings
   * carry a real timestamp. A hash that no longer resolves means the chain moved
   * mid-scan: abort the tick and retry rather than post an invented time.
   */
  async hydrateBlocks(blockHashes: readonly Hex[]): Promise<Map<Hex, BlockRef>> {
    const unique = [...new Set(blockHashes)]
    const out = new Map<Hex, BlockRef>()
    for (const hash of unique) {
      const ref = await this.rpc.blockByHash(hash)
      if (ref === null) {
        throw new ScanRetryError(`block ${hash} disappeared while scanning`)
      }
      out.set(hash, ref)
      await this.store.putBlock(ref)
    }
    return out
  }

  async recordBlock(block: BlockRef): Promise<void> {
    await this.store.putBlock(block)
  }

  /** Promote postings to finalized and prune block records we no longer need. */
  async applyFinality(finalized: BlockRef): Promise<number> {
    await this.store.putBlock(finalized)
    const marked = await this.store.markFinalizedThrough(finalized.number)
    const pruneBelow = finalized.number - BigInt(this.blockRetentionDepth)
    if (pruneBelow > 0n) await this.store.pruneBlocksBelow(pruneBelow)
    return marked
  }

  /**
   * The next range to scan for a cursor, bounded by maxSpan. Returns null when
   * the cursor has caught up to the head.
   */
  async nextScanRange(
    key: CursorKey,
    head: BlockRef,
    maxSpan: bigint,
    defaultStart: bigint,
  ): Promise<{ fromBlock: bigint; toBlock: bigint } | null> {
    const cursor = await this.store.getCursor(key)
    const fromBlock = cursor === undefined ? defaultStart : cursor + 1n
    if (fromBlock > head.number) return null
    const last = fromBlock + maxSpan - 1n
    return { fromBlock, toBlock: last < head.number ? last : head.number }
  }
}
