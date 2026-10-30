/**
 * In-memory chain and RpcClient fake.
 *
 * Two FakeRpcClients over the SAME FakeChain model healthy quorum; two over
 * DIFFERENT chains model a fork or a lying provider, which is how the quorum
 * refusal path is tested. Block hashes are real keccak of (fork tag, height) so
 * a reorg genuinely changes every hash at and above the fork point.
 */

import { RpcError } from './errors.js'
import { normalizeAddress, normalizeHash32, type Hex } from './hex.js'
import { keccak256Hex } from './keccak.js'
import type { BlockRef, BlockTag, LogQuery, PinnedCall, RpcClient, RpcLog } from './rpc.js'
import { sortLogs } from './rpc.js'

export interface FakeLogInput {
  readonly address: string
  readonly topics: readonly Hex[]
  readonly data?: Hex
  readonly transactionHash?: Hex
  readonly removed?: boolean
}

interface FakeBlock {
  readonly ref: BlockRef
  readonly logs: RpcLog[]
}

export interface FakeChainOptions {
  readonly genesisUnix?: number
  readonly blockSeconds?: number
  readonly chainId?: number
}

export class FakeChain {
  private readonly blocks: FakeBlock[] = []
  private readonly orphaned = new Map<Hex, BlockRef>()
  private readonly callResults = new Map<string, Hex>()
  private forkTag = 0
  private finalizedNumber = -1n

  readonly chainId: number
  private readonly genesisUnix: number
  private readonly blockSeconds: number

  constructor(options: FakeChainOptions = {}) {
    this.chainId = options.chainId ?? 4663
    this.genesisUnix = options.genesisUnix ?? 1_757_000_000
    this.blockSeconds = options.blockSeconds ?? 2
  }

  private hashFor(blockNumber: bigint): Hex {
    return keccak256Hex(`venue-fake-block:${this.forkTag}:${blockNumber}`)
  }

  get height(): bigint {
    return BigInt(this.blocks.length - 1)
  }

  addBlock(input: { timestampUnix?: number; logs?: readonly FakeLogInput[] } = {}): BlockRef {
    const number = BigInt(this.blocks.length)
    const previous = this.blocks[this.blocks.length - 1]
    const ref: BlockRef = {
      number,
      hash: this.hashFor(number),
      parentHash: previous?.ref.hash ?? ('0x' + '00'.repeat(32)) as Hex,
      timestampUnix: input.timestampUnix ?? this.genesisUnix + Number(number) * this.blockSeconds,
    }
    const logs: RpcLog[] = (input.logs ?? []).map((log, index) => ({
      address: normalizeAddress(log.address),
      topics: log.topics.map((t) => normalizeHash32(t)),
      data: (log.data ?? '0x') as Hex,
      blockNumber: number,
      blockHash: ref.hash,
      transactionHash: log.transactionHash ?? keccak256Hex(`tx:${this.forkTag}:${number}:${index}`),
      logIndex: index,
      removed: log.removed ?? false,
    }))
    this.blocks.push({ ref, logs })
    return ref
  }

  addBlocks(count: number): void {
    for (let i = 0; i < count; i++) this.addBlock()
  }

  /**
   * Drop every block at or above blockNumber and fork. Subsequent addBlock calls
   * build the new branch; the discarded refs stay retrievable as orphans so a
   * pinned read against them can be modelled.
   */
  reorgFrom(blockNumber: bigint): void {
    const index = Number(blockNumber)
    for (const dropped of this.blocks.slice(index)) {
      this.orphaned.set(dropped.ref.hash, dropped.ref)
    }
    this.blocks.length = index
    this.forkTag++
  }

  setFinalized(blockNumber: bigint): void {
    this.finalizedNumber = blockNumber
  }

  get finalized(): bigint {
    return this.finalizedNumber
  }

  setCallResult(to: string, data: Hex, blockHash: Hex, result: Hex): void {
    this.callResults.set(`${normalizeAddress(to)}|${data.toLowerCase()}|${normalizeHash32(blockHash)}`, result)
  }

  /** Same answer at every canonical block; the common case for a stable getter. */
  setCallResultAnyBlock(to: string, data: Hex, result: Hex): void {
    this.callResults.set(`${normalizeAddress(to)}|${data.toLowerCase()}|*`, result)
  }

  lookupCall(request: PinnedCall): Hex | undefined {
    const to = normalizeAddress(request.to)
    const data = request.data.toLowerCase()
    return (
      this.callResults.get(`${to}|${data}|${normalizeHash32(request.blockHash)}`) ??
      this.callResults.get(`${to}|${data}|*`)
    )
  }

  blockAt(blockNumber: bigint): BlockRef | null {
    return this.blocks[Number(blockNumber)]?.ref ?? null
  }

  blockByHash(blockHash: Hex): { ref: BlockRef; canonical: boolean } | null {
    const normalized = normalizeHash32(blockHash)
    const canonical = this.blocks.find((b) => b.ref.hash === normalized)
    if (canonical) return { ref: canonical.ref, canonical: true }
    const orphan = this.orphaned.get(normalized)
    return orphan ? { ref: orphan, canonical: false } : null
  }

  head(): BlockRef {
    const last = this.blocks[this.blocks.length - 1]
    if (!last) throw new Error('fake chain has no blocks')
    return last.ref
  }

  logsInRange(fromBlock: bigint, toBlock: bigint): RpcLog[] {
    const out: RpcLog[] = []
    for (let n = fromBlock; n <= toBlock; n++) {
      const block = this.blocks[Number(n)]
      if (block) out.push(...block.logs)
    }
    return out
  }
}

function topicMatches(logTopics: readonly Hex[], filters: LogQuery['topics']): boolean {
  for (let position = 0; position < filters.length; position++) {
    const filter = filters[position]
    if (filter === null || filter === undefined) continue
    const actual = logTopics[position]
    if (actual === undefined) return false
    const accepted = typeof filter === 'string' ? [filter] : filter
    if (!accepted.some((candidate) => normalizeHash32(candidate) === actual)) return false
  }
  return true
}

export interface FakeRpcOptions {
  /** Report a head this many blocks behind the chain tip. Models provider lag. */
  readonly headLagBlocks?: number
  /** Serve orphaned blocks by hash, as an archive node would. */
  readonly serveOrphanBlocks?: boolean
}

export class FakeRpcClient implements RpcClient {
  private failuresRemaining = 0
  private failureMessage = 'injected failure'
  private headLagBlocks: number
  private readonly serveOrphanBlocks: boolean

  constructor(
    private readonly chain: FakeChain,
    readonly endpointId: string,
    options: FakeRpcOptions = {},
  ) {
    this.headLagBlocks = options.headLagBlocks ?? 0
    this.serveOrphanBlocks = options.serveOrphanBlocks ?? false
  }

  /** Make the next n reads throw, to exercise the fail-closed paths. */
  failNext(count: number, message = 'injected failure'): void {
    this.failuresRemaining = count
    this.failureMessage = message
  }

  setHeadLag(blocks: number): void {
    this.headLagBlocks = blocks
  }

  private guard(method: string): void {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--
      throw new RpcError(`${method}: ${this.failureMessage}`, this.endpointId)
    }
  }

  async getChainId(): Promise<number> {
    this.guard('eth_chainId')
    return this.chain.chainId
  }

  async getBlockByTag(tag: BlockTag): Promise<BlockRef> {
    this.guard('eth_getBlockByNumber')
    if (tag === 'finalized') {
      const finalized = this.chain.finalized
      if (finalized < 0n) throw new RpcError('no finalized block', this.endpointId)
      const ref = this.chain.blockAt(finalized)
      if (!ref) throw new RpcError('finalized block missing', this.endpointId)
      return ref
    }
    const target = this.chain.height - BigInt(this.headLagBlocks)
    const ref = this.chain.blockAt(target < 0n ? 0n : target)
    if (!ref) throw new RpcError('no head block', this.endpointId)
    return ref
  }

  async getBlockByNumber(blockNumber: bigint): Promise<BlockRef | null> {
    this.guard('eth_getBlockByNumber')
    return this.chain.blockAt(blockNumber)
  }

  async getBlockByHash(blockHash: Hex): Promise<BlockRef | null> {
    this.guard('eth_getBlockByHash')
    const found = this.chain.blockByHash(blockHash)
    if (!found) return null
    if (!found.canonical && !this.serveOrphanBlocks) return null
    return found.ref
  }

  async getLogs(query: LogQuery): Promise<RpcLog[]> {
    this.guard('eth_getLogs')
    const addresses = new Set(query.address.map((a) => normalizeAddress(a)))
    const matched = this.chain
      .logsInRange(query.fromBlock, query.toBlock)
      .filter((log) => addresses.has(log.address) && topicMatches(log.topics, query.topics))
    return sortLogs(matched)
  }

  /** Mirrors EIP-1898 requireCanonical: a pinned read on a forked-away block fails. */
  async call(request: PinnedCall): Promise<Hex> {
    this.guard('eth_call')
    const block = this.chain.blockByHash(request.blockHash)
    if (!block || !block.canonical) {
      throw new RpcError(`block ${request.blockHash} is not canonical`, this.endpointId)
    }
    const result = this.chain.lookupCall(request)
    if (result === undefined) {
      throw new RpcError(`no fake result configured for ${request.to} ${request.data}`, this.endpointId)
    }
    return result
  }
}
