/**
 * The chain read boundary.
 *
 * Two invariants are enforced here rather than left to caller discipline:
 *
 * 1. PINNED READS. PinnedCall carries a blockHash and has no field capable of
 *    holding a block number. A read against a number is a read against whatever
 *    the node decides that number means right now, which after a reorg is a
 *    different chain. There is no way to express that read through this type.
 *
 * 2. BOUNDED QUERIES. assertBoundedLogQuery refuses any filter that would scan
 *    the launch firehose. Venue is permissionless and running roughly 25,000
 *    launches a day; we index only the vault set our own consent issuance
 *    produced. A query against the factory or the hook must additionally be
 *    narrowed by an indexed-topic allowlist naming our tokens or pool ids.
 */

import { UnboundedQueryError } from './errors.js'
import { normalizeAddress, normalizeHash32, type Hex } from './hex.js'
import { VENUE } from './protocol.js'

export interface BlockRef {
  readonly number: bigint
  readonly hash: Hex
  readonly parentHash: Hex
  readonly timestampUnix: number
}

/**
 * 'finalized' is the only tag budget authority may rest on. 'latest' is used to
 * detect reorgs and to schedule work, never to grant spending power.
 */
export type BlockTag = 'latest' | 'finalized'

export type TopicFilter = Hex | readonly Hex[] | null

export interface LogQuery {
  readonly fromBlock: bigint
  readonly toBlock: bigint
  readonly address: readonly string[]
  readonly topics: readonly TopicFilter[]
}

export interface RpcLog {
  readonly address: string
  readonly topics: readonly Hex[]
  readonly data: Hex
  readonly blockNumber: bigint
  readonly blockHash: Hex
  readonly transactionHash: Hex
  readonly logIndex: number
  /** Set by nodes that stream removals after a reorg. Treated as a rollback. */
  readonly removed: boolean
}

/** A read pinned to one block hash. There is deliberately no blockNumber field. */
export interface PinnedCall {
  readonly to: string
  readonly data: Hex
  readonly blockHash: Hex
}

/**
 * The narrow surface this package needs from a chain. Anything wider (send,
 * sign, estimate, subscribe) is deliberately absent: the ingestion plane reads
 * untrusted chain state and therefore holds no keys and no write path.
 */
export interface RpcClient {
  readonly endpointId: string
  getChainId(): Promise<number>
  getBlockByTag(tag: BlockTag): Promise<BlockRef>
  getBlockByNumber(blockNumber: bigint): Promise<BlockRef | null>
  getBlockByHash(blockHash: Hex): Promise<BlockRef | null>
  getLogs(query: LogQuery): Promise<RpcLog[]>
  /** MUST reject if the pinned hash is not canonical (EIP-1898 requireCanonical). */
  call(request: PinnedCall): Promise<Hex>
  /**
   * Runtime bytecode, pinned like `call`. Optional because the ingestion
   * plane never needs it; the diligence probe's selector scan does, and the
   * quorum refuses the read when an endpoint cannot serve it.
   */
  getCode?(address: string, blockHash: Hex): Promise<Hex>
}

/** Which nonce a write should claim. 'pending' includes the sender's own in-flight txs. */
export type NonceTag = 'latest' | 'pending'

/** A write-side call: gas estimation and simulation run against the pending state. */
export interface TransactionCall {
  readonly from: string
  readonly to: string
  readonly data: Hex
  readonly value?: bigint
}

export interface TransactionReceipt {
  readonly transactionHash: Hex
  /** 1 = executed, 0 = reverted. Anything else the node says is a malformed receipt. */
  readonly status: 0 | 1
  readonly blockNumber: bigint
  readonly blockHash: Hex
  readonly gasUsed: bigint
  readonly logs: readonly RpcLog[]
}

/**
 * The write-side surface, kept OUT of RpcClient on purpose. The ingestion plane
 * (quorum, fakes, watchers) types against RpcClient and must stay unable to
 * send. Only the settlement adapter, which holds the operator key, types
 * against this, and it talks to a single JsonRpcClient: quorum is a read-side
 * concept, a broadcast is idempotent by nonce and needs no second opinion.
 */
export interface ChainWriteClient {
  readonly endpointId: string
  getChainId(): Promise<number>
  getBlockByTag(tag: BlockTag): Promise<BlockRef>
  getBlockByNumber(blockNumber: bigint): Promise<BlockRef | null>
  call(request: PinnedCall): Promise<Hex>
  /** EIP-1559 base fee of the block at `tag`. Refuses on a node that reports none. */
  getBaseFeePerGas(tag: BlockTag): Promise<bigint>
  maxPriorityFeePerGas(): Promise<bigint>
  getTransactionCount(address: string, tag: NonceTag): Promise<bigint>
  estimateGas(call: TransactionCall): Promise<bigint>
  /** Returns the tx hash the node computed; the caller compares it with its own. */
  sendRawTransaction(raw: Hex): Promise<Hex>
  getTransactionReceipt(hash: Hex): Promise<TransactionReceipt | null>
}

export interface QueryLimits {
  readonly maxAddressesPerQuery: number
  readonly maxTopicValuesPerQuery: number
  readonly maxBlockSpan: bigint
}

export const DEFAULT_QUERY_LIMITS: QueryLimits = {
  maxAddressesPerQuery: 400,
  maxTopicValuesPerQuery: 400,
  maxBlockSpan: 2_000n,
}

/**
 * Contracts every launch on the chain touches. A query naming one of these is
 * only admissible if an indexed topic slot narrows it to our own coins.
 */
export const FIREHOSE_CONTRACTS: ReadonlySet<string> = new Set(
  [VENUE.contracts.v2Factory, VENUE.contracts.v2MemeHook].map((a) => a.toLowerCase()),
)

export function assertBoundedLogQuery(
  query: LogQuery,
  limits: QueryLimits = DEFAULT_QUERY_LIMITS,
): void {
  if (query.toBlock < query.fromBlock) {
    throw new UnboundedQueryError(`toBlock ${query.toBlock} precedes fromBlock ${query.fromBlock}`)
  }
  const span = query.toBlock - query.fromBlock + 1n
  if (span > limits.maxBlockSpan) {
    throw new UnboundedQueryError(`span of ${span} blocks exceeds ${limits.maxBlockSpan}`)
  }

  if (query.address.length === 0) {
    throw new UnboundedQueryError('address filter is empty; that is a whole-chain scan')
  }
  if (query.address.length > limits.maxAddressesPerQuery) {
    throw new UnboundedQueryError(
      `${query.address.length} addresses exceeds ${limits.maxAddressesPerQuery}; chunk the watch set`,
    )
  }

  const touchesFirehose = query.address.some((a) => FIREHOSE_CONTRACTS.has(normalizeAddress(a)))
  if (!touchesFirehose) return

  // A shared contract is only readable through an allowlist of OUR identifiers.
  const identifierSlot = query.topics[1]
  if (identifierSlot === null || identifierSlot === undefined) {
    throw new UnboundedQueryError(
      'query names a shared Venue contract with no indexed-identifier filter; ' +
        'that is the ~25k/day launch firehose, not our watch set',
    )
  }
  const values = typeof identifierSlot === 'string' ? [identifierSlot] : identifierSlot
  if (values.length === 0) {
    throw new UnboundedQueryError('indexed-identifier allowlist is empty')
  }
  if (values.length > limits.maxTopicValuesPerQuery) {
    throw new UnboundedQueryError(
      `${values.length} indexed identifiers exceeds ${limits.maxTopicValuesPerQuery}; chunk the watch set`,
    )
  }
}

/** Stable identity of a log. Used for dedupe and for quorum comparison. */
export function logKey(log: RpcLog): string {
  return `${log.transactionHash.toLowerCase()}:${log.logIndex}`
}

/**
 * Canonical serialisation for quorum comparison. Two providers agree only if
 * every field agrees, including block hash - two nodes on different forks
 * return the same log content at different block hashes, and that must not pass.
 */
export function canonicalLog(log: RpcLog): string {
  return [
    normalizeAddress(log.address),
    log.topics.map((t) => normalizeHash32(t)).join(','),
    log.data.toLowerCase(),
    log.blockNumber.toString(),
    normalizeHash32(log.blockHash),
    normalizeHash32(log.transactionHash),
    log.logIndex.toString(),
    String(log.removed),
  ].join('|')
}

export function canonicalBlock(block: BlockRef): string {
  return [
    block.number.toString(),
    normalizeHash32(block.hash),
    normalizeHash32(block.parentHash),
    block.timestampUnix.toString(),
  ].join('|')
}

export function sortLogs(logs: readonly RpcLog[]): RpcLog[] {
  return [...logs].sort(
    (a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex,
  )
}
