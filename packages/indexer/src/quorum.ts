/**
 * Two-provider quorum.
 *
 * Every read that can affect money is performed against two independent
 * endpoints and must agree exactly. There is NO fallback to a single provider
 * and no tie-break: on disagreement we do not know which endpoint is wrong, and
 * a wrong fee reading either invents budget authority or destroys a client's
 * claim. Both failures are unacceptable, so the read refuses.
 *
 * Benign lag is distinguished from disagreement: providers legitimately sit at
 * different heights, so the head is taken at the LOWER of the two heights and
 * both must agree on the hash there. That is lag-tolerant and fork-intolerant,
 * which is the correct pair of behaviours.
 */

import { ChainMismatchError, QuorumDisagreementError, RpcError } from './errors.js'
import { normalizeHash32, type Hex } from './hex.js'
import { VENUE } from './protocol.js'
import {
  assertBoundedLogQuery,
  canonicalBlock,
  canonicalLog,
  DEFAULT_QUERY_LIMITS,
  sortLogs,
  type BlockRef,
  type LogQuery,
  type PinnedCall,
  type QueryLimits,
  type RpcClient,
  type RpcLog,
} from './rpc.js'

export interface QuorumOptions {
  readonly chainId?: number
  readonly queryLimits?: QueryLimits
}

async function both<T>(
  left: () => Promise<T>,
  right: () => Promise<T>,
): Promise<readonly [T, T]> {
  const [a, b] = await Promise.allSettled([left(), right()])
  if (a.status === 'rejected') throw a.reason
  if (b.status === 'rejected') throw b.reason
  return [a.value, b.value]
}

export class QuorumRpc {
  private readonly chainId: number
  private readonly queryLimits: QueryLimits
  private chainVerified = false

  constructor(
    private readonly primary: RpcClient,
    private readonly secondary: RpcClient,
    options: QuorumOptions = {},
  ) {
    if (primary.endpointId === secondary.endpointId) {
      throw new Error('quorum requires two distinct endpoints; the same node twice is not a quorum')
    }
    this.chainId = options.chainId ?? VENUE.chainId
    this.queryLimits = options.queryLimits ?? DEFAULT_QUERY_LIMITS
  }

  get endpointIds(): readonly [string, string] {
    return [this.primary.endpointId, this.secondary.endpointId]
  }

  /** Called once before any read. A misconfigured endpoint is a silent disaster. */
  async assertChain(): Promise<void> {
    const [a, b] = await both(
      () => this.primary.getChainId(),
      () => this.secondary.getChainId(),
    )
    if (a !== this.chainId) throw new ChainMismatchError(this.chainId, a, this.primary.endpointId)
    if (b !== this.chainId) throw new ChainMismatchError(this.chainId, b, this.secondary.endpointId)
    this.chainVerified = true
  }

  get isChainVerified(): boolean {
    return this.chainVerified
  }

  private agreeBlock(method: string, a: BlockRef, b: BlockRef): BlockRef {
    const left = canonicalBlock(a)
    const right = canonicalBlock(b)
    if (left !== right) throw new QuorumDisagreementError(method, left, right)
    return a
  }

  private async agreedAtHeight(method: string, a: BlockRef, b: BlockRef): Promise<BlockRef> {
    if (a.number === b.number) return this.agreeBlock(method, a, b)

    const target = a.number < b.number ? a.number : b.number
    const [atA, atB] = await both(
      () => (a.number === target ? Promise.resolve(a) : this.primary.getBlockByNumber(target)),
      () => (b.number === target ? Promise.resolve(b) : this.secondary.getBlockByNumber(target)),
    )
    if (atA === null || atB === null) {
      throw new QuorumDisagreementError(method, `${a.number}:${atA === null ? 'null' : 'ok'}`, `${b.number}:${atB === null ? 'null' : 'ok'}`)
    }
    return this.agreeBlock(method, atA, atB)
  }

  /** Chain tip, at the lower of the two provider heights. Never grants authority. */
  async head(): Promise<BlockRef> {
    const [a, b] = await both(
      () => this.primary.getBlockByTag('latest'),
      () => this.secondary.getBlockByTag('latest'),
    )
    return this.agreedAtHeight('head', a, b)
  }

  /**
   * The only head budget authority may rest on. Taken at the lower of the two
   * finalized heights, so a provider that finalises optimistically cannot pull
   * unfinalised money into the spendable set.
   */
  async finalized(): Promise<BlockRef> {
    const [a, b] = await both(
      () => this.primary.getBlockByTag('finalized'),
      () => this.secondary.getBlockByTag('finalized'),
    )
    return this.agreedAtHeight('finalized', a, b)
  }

  async blockByNumber(blockNumber: bigint): Promise<BlockRef | null> {
    const [a, b] = await both(
      () => this.primary.getBlockByNumber(blockNumber),
      () => this.secondary.getBlockByNumber(blockNumber),
    )
    if (a === null && b === null) return null
    if (a === null || b === null) {
      throw new QuorumDisagreementError(
        `blockByNumber(${blockNumber})`,
        a === null ? 'null' : canonicalBlock(a),
        b === null ? 'null' : canonicalBlock(b),
      )
    }
    return this.agreeBlock(`blockByNumber(${blockNumber})`, a, b)
  }

  async blockByHash(blockHash: Hex): Promise<BlockRef | null> {
    const hash = normalizeHash32(blockHash)
    const [a, b] = await both(
      () => this.primary.getBlockByHash(hash),
      () => this.secondary.getBlockByHash(hash),
    )
    if (a === null && b === null) return null
    if (a === null || b === null) {
      throw new QuorumDisagreementError(
        `blockByHash(${hash})`,
        a === null ? 'null' : canonicalBlock(a),
        b === null ? 'null' : canonicalBlock(b),
      )
    }
    return this.agreeBlock(`blockByHash(${hash})`, a, b)
  }

  /**
   * Bounded by construction: the query is checked against the firehose rules
   * before either provider is contacted, so an unbounded scan never leaves the
   * process.
   */
  async getLogs(query: LogQuery): Promise<RpcLog[]> {
    assertBoundedLogQuery(query, this.queryLimits)

    const [a, b] = await both(
      () => this.primary.getLogs(query),
      () => this.secondary.getLogs(query),
    )
    const left = sortLogs(a)
    const right = sortLogs(b)

    if (left.length !== right.length) {
      throw new QuorumDisagreementError(
        `getLogs(${query.fromBlock}-${query.toBlock})`,
        `${left.length} logs`,
        `${right.length} logs`,
      )
    }
    for (let i = 0; i < left.length; i++) {
      const leftEntry = left[i]
      const rightEntry = right[i]
      if (leftEntry === undefined || rightEntry === undefined) {
        throw new QuorumDisagreementError(`getLogs(${query.fromBlock}-${query.toBlock})`, 'missing', 'missing')
      }
      const leftLog = canonicalLog(leftEntry)
      const rightLog = canonicalLog(rightEntry)
      if (leftLog !== rightLog) {
        throw new QuorumDisagreementError(`getLogs(${query.fromBlock}-${query.toBlock})`, leftLog, rightLog)
      }
    }
    return left
  }

  /** Hash-pinned by the type of PinnedCall; there is no block-number variant. */
  async call(request: PinnedCall): Promise<Hex> {
    const [a, b] = await both(
      () => this.primary.call(request),
      () => this.secondary.call(request),
    )
    if (a.toLowerCase() !== b.toLowerCase()) {
      throw new QuorumDisagreementError(`call(${request.to})`, a, b)
    }
    return a
  }

  /** Bytecode at a pinned block, agreed byte for byte by both providers. */
  async getCode(address: string, blockHash: Hex): Promise<Hex> {
    const read = (client: RpcClient): Promise<Hex> => {
      if (client.getCode === undefined) {
        return Promise.reject(new RpcError(`endpoint cannot serve eth_getCode`, client.endpointId))
      }
      return client.getCode(address, blockHash)
    }
    const [a, b] = await both(
      () => read(this.primary),
      () => read(this.secondary),
    )
    if (a.toLowerCase() !== b.toLowerCase()) {
      throw new QuorumDisagreementError(`getCode(${address})`, a, b)
    }
    return a
  }
}
