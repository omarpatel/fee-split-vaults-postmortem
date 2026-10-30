/**
 * The quorum as the public Venue endpoints can actually serve it.
 *
 * Both endpoints are load balancers over pools of nodes that are NOT at the
 * same height. Measured on 2026-09-15: one URL answers `latest` at N and, a
 * moment later, `null` for block N-300; the other trails it by 15-65 blocks;
 * a read pinned at the tip lands on a node that has not seen the block
 * ("header not found") or has not executed it ("historical state is not
 * available"). At ~7 blocks a second none of this is a fork, all of it is
 * lag, and the quorum is right to refuse every single sample: it cannot tell
 * the two apart from one answer.
 *
 * So the API pins its reads to a SETTLED block: `depth` blocks below the
 * lower of the two reported heads, resolved by number through the quorum so
 * both providers must still agree on its hash. Every backend node has that
 * block, and it is far inside the primary's state window (finalized, ~12k
 * blocks back, is not - the primary refuses eth_call there). A pointing that
 * landed in the last few minutes is simply not visible yet, which is the
 * conservative direction for everything this feeds.
 *
 * Each read is then asked a bounded number of times. A disagreement or a node
 * error on one attempt is retried after a pause; agreement on any attempt is
 * real agreement, and agreement not reached in `attempts` is the refusal the
 * quorum already gave. A decode error or a refusal from the adapter above is
 * final on the first throw: retrying "the factory has no such token" would
 * not make it exist.
 */

import type { PinnedChainReads } from '@fee-split-vaults/adapters'
import { QuorumDisagreementError, QuorumRpc, RpcError, type BlockRef, type Hex, type RpcClient } from '@fee-split-vaults/indexer'

/** The quorum's pinned reads plus bytecode, which the diligence probe's selector scan needs. */
export interface SettledChainReads extends PinnedChainReads {
  getCode(address: string, blockHash: Hex): Promise<Hex>
}

export interface SettledReadsOptions {
  quorum: QuorumRpc
  /** The same two clients the quorum was built from, for their unagreed heights. */
  clients: readonly [RpcClient, RpcClient]
  /** Blocks below the lower reported head the pin sits. >= 0. */
  depth: bigint
  /** Total attempts per read, including the first. >= 1. */
  attempts: number
  pauseMs: number
  sleep?: (ms: number) => Promise<void>
}

export function settledReads(options: SettledReadsOptions): SettledChainReads {
  if (!Number.isInteger(options.attempts) || options.attempts < 1) throw new RangeError('attempts must be >= 1')
  if (options.depth < 0n) throw new RangeError('depth must be >= 0')
  const { quorum, depth } = options
  const [primary, secondary] = options.clients
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const retried = async <T>(read: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await read()
      } catch (error) {
        const transient = error instanceof QuorumDisagreementError || error instanceof RpcError
        if (!transient || attempt >= options.attempts) throw error
        await sleep(options.pauseMs)
      }
    }
  }

  const settled = async (): Promise<BlockRef> => {
    const [a, b] = await Promise.all([primary.getBlockByTag('latest'), secondary.getBlockByTag('latest')])
    const lower = a.number < b.number ? a.number : b.number
    const target = lower > depth ? lower - depth : 0n
    const block = await quorum.blockByNumber(target)
    if (block === null) throw new RpcError(`block ${target} below the reported heads is unknown to both providers`, 'quorum')
    return block
  }

  return {
    assertChain: () => retried(() => quorum.assertChain()),
    head: () => retried(settled),
    blockByNumber: (blockNumber) => retried(() => quorum.blockByNumber(blockNumber)),
    blockByHash: (blockHash) => retried(() => quorum.blockByHash(blockHash)),
    getLogs: (query) => retried(() => quorum.getLogs(query)),
    call: (request) => retried(() => quorum.call(request)),
    getCode: (address, blockHash) => retried(() => quorum.getCode(address, blockHash)),
  }
}
