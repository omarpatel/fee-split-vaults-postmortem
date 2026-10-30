/**
 * Real JSON-RPC transport for RpcClient.
 *
 * Every response is structurally validated before it becomes a typed value. A
 * node is not a trust boundary: it can lag, fork, or lie, and the quorum layer
 * above can only compare answers it can parse. Anything malformed throws.
 */

import { RpcError } from './errors.js'
import { bigIntToHex, isHex, normalizeAddress, normalizeHash32, type Hex } from './hex.js'
import type {
  BlockRef,
  BlockTag,
  ChainWriteClient,
  LogQuery,
  NonceTag,
  PinnedCall,
  RpcClient,
  RpcLog,
  TransactionCall,
  TransactionReceipt,
} from './rpc.js'

export interface JsonRpcOptions {
  readonly endpointId: string
  readonly url: string
  readonly timeoutMs?: number
  readonly headers?: Readonly<Record<string, string>>
  /** Injectable for tests and for proxy-aware deployments. */
  readonly fetchImpl?: typeof globalThis.fetch
}

interface JsonRpcResponse {
  jsonrpc?: string
  id?: number
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

function asRecord(value: unknown, what: string, endpointId: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new RpcError(`${what} is not an object`, endpointId)
  }
  return value as Record<string, unknown>
}

function asHex(value: unknown, what: string, endpointId: string): Hex {
  if (!isHex(value)) throw new RpcError(`${what} is not hex: ${String(value)}`, endpointId)
  return value
}

export class JsonRpcClient implements RpcClient, ChainWriteClient {
  readonly endpointId: string
  private readonly url: string
  private readonly timeoutMs: number
  private readonly headers: Record<string, string>
  private readonly fetchImpl: typeof globalThis.fetch
  private nextId = 1

  constructor(options: JsonRpcOptions) {
    this.endpointId = options.endpointId
    this.url = options.url
    this.timeoutMs = options.timeoutMs ?? 10_000
    // The primary chain-4663 provider answers 403 to requests with no
    // User-Agent (observed during the curve-shape probe); Node's fetch sends
    // none by default. Callers may override.
    this.headers = { 'content-type': 'application/json', 'user-agent': 'fee-split-vaults/0.1', ...options.headers }
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  private async send(method: string, params: readonly unknown[]): Promise<unknown> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params })

    let response: Response
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: this.headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      throw new RpcError(`${method} transport failure: ${String(cause)}`, this.endpointId)
    }

    if (!response.ok) {
      throw new RpcError(`${method} returned HTTP ${response.status}`, this.endpointId)
    }

    let payload: JsonRpcResponse
    try {
      payload = (await response.json()) as JsonRpcResponse
    } catch (cause) {
      throw new RpcError(`${method} returned unparseable JSON: ${String(cause)}`, this.endpointId)
    }

    if (payload.error) {
      // Revert data rides on `error.data` (selector + abi-encoded args). It is
      // kept in the message so an operator can match it against the contract's
      // custom errors; nothing in this package decodes it.
      const data = isHex(payload.error.data) ? ` (revert data ${payload.error.data})` : ''
      throw new RpcError(
        `${method} error ${payload.error.code ?? '?'}: ${payload.error.message ?? 'unknown'}${data}`,
        this.endpointId,
      )
    }
    if (payload.result === undefined) {
      throw new RpcError(`${method} returned no result`, this.endpointId)
    }
    return payload.result
  }

  private toBlockRef(raw: unknown, what: string): BlockRef {
    const block = asRecord(raw, what, this.endpointId)
    const number = asHex(block.number, `${what}.number`, this.endpointId)
    const timestamp = asHex(block.timestamp, `${what}.timestamp`, this.endpointId)
    return {
      number: BigInt(number),
      hash: normalizeHash32(asHex(block.hash, `${what}.hash`, this.endpointId)),
      parentHash: normalizeHash32(asHex(block.parentHash, `${what}.parentHash`, this.endpointId)),
      timestampUnix: Number(BigInt(timestamp)),
    }
  }

  async getChainId(): Promise<number> {
    const raw = await this.send('eth_chainId', [])
    return Number(BigInt(asHex(raw, 'eth_chainId', this.endpointId)))
  }

  async getBlockByTag(tag: BlockTag): Promise<BlockRef> {
    const raw = await this.send('eth_getBlockByNumber', [tag, false])
    if (raw === null) {
      throw new RpcError(`node has no ${tag} block; it may not support the tag`, this.endpointId)
    }
    return this.toBlockRef(raw, `block(${tag})`)
  }

  async getBlockByNumber(blockNumber: bigint): Promise<BlockRef | null> {
    const raw = await this.send('eth_getBlockByNumber', [bigIntToHex(blockNumber), false])
    return raw === null ? null : this.toBlockRef(raw, `block(${blockNumber})`)
  }

  async getBlockByHash(blockHash: Hex): Promise<BlockRef | null> {
    const raw = await this.send('eth_getBlockByHash', [normalizeHash32(blockHash), false])
    return raw === null ? null : this.toBlockRef(raw, `block(${blockHash})`)
  }

  async getLogs(query: LogQuery): Promise<RpcLog[]> {
    const raw = await this.send('eth_getLogs', [
      {
        fromBlock: bigIntToHex(query.fromBlock),
        toBlock: bigIntToHex(query.toBlock),
        address: query.address.map((a) => normalizeAddress(a)),
        topics: query.topics.map((topic) =>
          topic === null
            ? null
            : typeof topic === 'string'
              ? normalizeHash32(topic)
              : topic.map((t) => normalizeHash32(t)),
        ),
      },
    ])

    if (!Array.isArray(raw)) throw new RpcError('eth_getLogs did not return an array', this.endpointId)

    return raw.map((entry, index) => this.toLog(entry, `log[${index}]`, query))
  }

  private toLog(entry: unknown, what: string, range?: LogQuery): RpcLog {
    const log = asRecord(entry, what, this.endpointId)
    const topics = log.topics
    if (!Array.isArray(topics)) {
      throw new RpcError(`${what}.topics is not an array`, this.endpointId)
    }
    const blockNumber = BigInt(asHex(log.blockNumber, `${what}.blockNumber`, this.endpointId))
    if (range !== undefined && (blockNumber < range.fromBlock || blockNumber > range.toBlock)) {
      throw new RpcError(`${what} at block ${blockNumber} is outside the requested range`, this.endpointId)
    }
    return {
      address: normalizeAddress(asHex(log.address, `${what}.address`, this.endpointId)),
      topics: topics.map((t, i) => normalizeHash32(asHex(t, `${what}.topics[${i}]`, this.endpointId))),
      data: asHex(log.data, `${what}.data`, this.endpointId),
      blockNumber,
      blockHash: normalizeHash32(asHex(log.blockHash, `${what}.blockHash`, this.endpointId)),
      transactionHash: normalizeHash32(asHex(log.transactionHash, `${what}.transactionHash`, this.endpointId)),
      logIndex: Number(BigInt(asHex(log.logIndex, `${what}.logIndex`, this.endpointId))),
      removed: log.removed === true,
    }
  }

  /**
   * EIP-1898 block-hash addressing with requireCanonical. A node that has
   * reorged away from the pinned hash MUST error rather than answer from the
   * new chain, which is exactly the behaviour we want on a fork.
   */
  async call(request: PinnedCall): Promise<Hex> {
    const raw = await this.send('eth_call', [
      { to: normalizeAddress(request.to), data: request.data },
      { blockHash: normalizeHash32(request.blockHash), requireCanonical: true },
    ])
    return asHex(raw, 'eth_call result', this.endpointId)
  }

  /** Runtime bytecode at `address`, pinned by hash like `call`. `0x` for an EOA. */
  async getCode(address: string, blockHash: Hex): Promise<Hex> {
    const raw = await this.send('eth_getCode', [
      normalizeAddress(address),
      { blockHash: normalizeHash32(blockHash), requireCanonical: true },
    ])
    return asHex(raw, 'eth_getCode result', this.endpointId)
  }

  // -------------------------------------------------------------------------
  // ChainWriteClient. Every quantity is parsed as hex and refused otherwise; a
  // node that answers a fee query with a bare number is a node we do not sign
  // against.
  // -------------------------------------------------------------------------

  async getBaseFeePerGas(tag: BlockTag): Promise<bigint> {
    const raw = await this.send('eth_getBlockByNumber', [tag, false])
    if (raw === null) {
      throw new RpcError(`node has no ${tag} block; it may not support the tag`, this.endpointId)
    }
    const block = asRecord(raw, `block(${tag})`, this.endpointId)
    if (block.baseFeePerGas === undefined || block.baseFeePerGas === null) {
      throw new RpcError(`block(${tag}) carries no baseFeePerGas; node is not EIP-1559`, this.endpointId)
    }
    return BigInt(asHex(block.baseFeePerGas, `block(${tag}).baseFeePerGas`, this.endpointId))
  }

  async maxPriorityFeePerGas(): Promise<bigint> {
    const raw = await this.send('eth_maxPriorityFeePerGas', [])
    return BigInt(asHex(raw, 'eth_maxPriorityFeePerGas', this.endpointId))
  }

  async getTransactionCount(address: string, tag: NonceTag): Promise<bigint> {
    const raw = await this.send('eth_getTransactionCount', [normalizeAddress(address), tag])
    return BigInt(asHex(raw, 'eth_getTransactionCount', this.endpointId))
  }

  private toCallObject(call: TransactionCall): Record<string, string> {
    return {
      from: normalizeAddress(call.from),
      to: normalizeAddress(call.to),
      data: call.data,
      ...(call.value === undefined ? {} : { value: bigIntToHex(call.value) }),
    }
  }

  async estimateGas(call: TransactionCall): Promise<bigint> {
    const raw = await this.send('eth_estimateGas', [this.toCallObject(call), 'pending'])
    return BigInt(asHex(raw, 'eth_estimateGas', this.endpointId))
  }

  async sendRawTransaction(raw: Hex): Promise<Hex> {
    const result = await this.send('eth_sendRawTransaction', [raw])
    return normalizeHash32(asHex(result, 'eth_sendRawTransaction', this.endpointId))
  }

  async getTransactionReceipt(hash: Hex): Promise<TransactionReceipt | null> {
    const raw = await this.send('eth_getTransactionReceipt', [normalizeHash32(hash)])
    if (raw === null) return null
    const receipt = asRecord(raw, 'receipt', this.endpointId)
    const status = BigInt(asHex(receipt.status, 'receipt.status', this.endpointId))
    if (status !== 0n && status !== 1n) {
      throw new RpcError(`receipt.status is ${status}, expected 0 or 1`, this.endpointId)
    }
    const logs = receipt.logs
    if (!Array.isArray(logs)) throw new RpcError('receipt.logs is not an array', this.endpointId)
    return {
      transactionHash: normalizeHash32(asHex(receipt.transactionHash, 'receipt.transactionHash', this.endpointId)),
      status: status === 1n ? 1 : 0,
      blockNumber: BigInt(asHex(receipt.blockNumber, 'receipt.blockNumber', this.endpointId)),
      blockHash: normalizeHash32(asHex(receipt.blockHash, 'receipt.blockHash', this.endpointId)),
      gasUsed: BigInt(asHex(receipt.gasUsed, 'receipt.gasUsed', this.endpointId)),
      logs: logs.map((entry, index) => this.toLog(entry, `receipt.logs[${index}]`)),
    }
  }
}
