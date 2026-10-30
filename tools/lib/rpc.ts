/**
 * JSON-RPC chain reader: narrow typed interface, HTTP implementation, and an
 * in-memory fake that tests drive from recorded fixtures.
 *
 * Reads are pinned by BLOCK HASH wherever a result is stored, per the ledger
 * rule in packages/core/src/types.ts - a reorg that changes what block 56321180
 * means must invalidate a cached answer rather than silently rewrite it.
 */

import type { HttpClient } from './http.ts'

export interface RawLog {
  address: string
  topics: string[]
  data: string
  blockNumber: bigint
  blockHash: string
  transactionHash: string
  logIndex: number
  removed: boolean
}

export interface BlockHeader {
  number: bigint
  hash: string
  timestampUnix: number
}

export interface LogFilter {
  address?: string | string[]
  /** Positional topic filter. `null` matches anything in that position. */
  topics?: Array<string | string[] | null>
  fromBlock: bigint
  toBlock: bigint
}

export interface ChainReader {
  chainId(): Promise<number>
  blockNumber(): Promise<bigint>
  getBlockHeader(block: bigint | 'latest'): Promise<BlockHeader>
  getLogs(filter: LogFilter): Promise<RawLog[]>
  /** eth_call. Returns raw hex return data, or throws on revert. */
  call(to: string, data: string, block?: bigint | 'latest'): Promise<string>
}

/**
 * One slot of a batch response.
 *
 * A batch is NOT all-or-nothing: a reverting eth_call sitting next to nine good
 * ones must not discard the nine. So a per-item failure is a VALUE here, and
 * only a batch-level failure (transport, or an endpoint that does not speak
 * batch at all) throws.
 */
export type BatchOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code: number; reverted: boolean }

/**
 * Thrown when an endpoint answers a batch request with something that is not a
 * JSON array. Callers catch this and fall back to sequential requests rather
 * than treating "no batch support" as "no data".
 */
export class BatchUnsupportedError extends Error {
  constructor(detail: string) {
    super(`endpoint did not answer a JSON-RPC batch: ${detail}`)
    this.name = 'BatchUnsupportedError'
  }
}

/**
 * A reader that can send several JSON-RPC calls in one HTTP request.
 *
 * Measured on this chain: a batch of 10 gives ~3 effective requests/second
 * against a ~1.3/s ceiling for single calls, and a batch of 25 gets 429ed. Ten
 * is therefore the default everywhere, and it is a PARAMETER, not a constant.
 */
export interface BatchChainReader extends ChainReader {
  /** Measured optimum for this endpoint. Callers may request less, never more. */
  readonly maxBatchSize: number
  callBatch(
    calls: ReadonlyArray<{ to: string; data: string }>,
    block?: bigint | 'latest',
  ): Promise<Array<BatchOutcome<string>>>
  getLogsBatch(filters: readonly LogFilter[]): Promise<Array<BatchOutcome<RawLog[]>>>
  getBlockHeadersBatch(blocks: readonly bigint[]): Promise<Array<BatchOutcome<BlockHeader>>>
}

/**
 * A reader that can also fetch RUNTIME CODE.
 *
 * Deliberately a separate interface from ChainReader rather than a method added
 * to it. eth_getCode answers a different kind of question from eth_call - not
 * "what does this contract say" but "is there a contract here at all, and what
 * does its dispatch table contain" - and only the two prospect tools ask it. A
 * reader that cannot answer it is still a perfectly good reader for everything
 * else, so the capability is opt-in and checked with supportsCode().
 *
 * The return is the raw hex string exactly as the endpoint gave it: '0x' for an
 * account with no code. Callers must not shorten that to a boolean, because an
 * EIP-7702 delegation designator is 23 bytes of code on an account that is still
 * a signable EOA, and 'has code' would classify it as a contract.
 */
export interface CodeChainReader extends ChainReader {
  getCode(address: string, block?: bigint | 'latest'): Promise<string>
  getCodeBatch(
    addresses: readonly string[],
    block?: bigint | 'latest',
  ): Promise<Array<BatchOutcome<string>>>
}

export function supportsCode(reader: ChainReader): reader is CodeChainReader {
  const candidate = reader as Partial<CodeChainReader>
  return typeof candidate.getCode === 'function' && typeof candidate.getCodeBatch === 'function'
}

export function supportsBatch(reader: ChainReader): reader is BatchChainReader {
  const candidate = reader as Partial<BatchChainReader>
  return (
    typeof candidate.callBatch === 'function' &&
    typeof candidate.getLogsBatch === 'function' &&
    typeof candidate.getBlockHeadersBatch === 'function'
  )
}

/** Endpoint messages that mean "this call cannot ever succeed", not "try again". */
export function isDeterministicCallFailure(message: string): boolean {
  return /revert|invalid opcode|out of gas|execution failed|invalid jump|stack underflow/i.test(
    message,
  )
}

export class RpcError extends Error {
  readonly code: number
  readonly method: string

  constructor(message: string, code: number, method: string) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.method = method
  }
}

/** Reverts and "execution reverted" are EXPECTED for absent getters, not bugs. */
export class CallRevertedError extends RpcError {}

interface JsonRpcResponse {
  id?: number
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

function hexToBigint(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new Error(`${field}: expected hex quantity, got ${JSON.stringify(value)}`)
  }
  return value === '0x' ? 0n : BigInt(value)
}

function toBlockTag(block: bigint | 'latest'): string {
  return block === 'latest' ? 'latest' : `0x${block.toString(16)}`
}

export class HttpChainReader implements BatchChainReader {
  #nextId = 1
  #chainId: number | undefined
  /** Round-robins across endpoints so one flaky provider cannot stall a scan. */
  #urlCursor = 0
  readonly #http: HttpClient
  readonly #urls: readonly string[]
  readonly maxBatchSize: number

  constructor(http: HttpClient, urls: readonly string[], maxBatchSize = 10) {
    if (urls.length === 0) throw new Error('HttpChainReader needs at least one RPC URL')
    if (maxBatchSize < 1) throw new Error('maxBatchSize must be at least 1')
    this.#http = http
    this.#urls = urls
    this.maxBatchSize = maxBatchSize
  }

  #nextUrl(): string {
    const url = this.#urls[this.#urlCursor % this.#urls.length]!
    this.#urlCursor++
    return url
  }

  async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const url = this.#nextUrl()
    const response = await this.#http.request({
      url,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.#nextId++, method, params }),
      label: method,
    })
    if (response.status < 200 || response.status >= 300) {
      throw new RpcError(`${method}: HTTP ${response.status}: ${response.body.slice(0, 300)}`, 0, method)
    }
    let parsed: JsonRpcResponse
    try {
      parsed = JSON.parse(response.body) as JsonRpcResponse
    } catch {
      throw new RpcError(`${method}: non-JSON response: ${response.body.slice(0, 200)}`, 0, method)
    }
    if (parsed.error) {
      const message = parsed.error.message ?? 'unknown RPC error'
      const code = parsed.error.code ?? 0
      if (/revert|invalid opcode|out of gas/i.test(message)) {
        throw new CallRevertedError(`${method}: ${message}`, code, method)
      }
      throw new RpcError(`${method}: ${message}`, code, method)
    }
    return parsed.result as T
  }

  async chainId(): Promise<number> {
    if (this.#chainId === undefined) {
      this.#chainId = Number(hexToBigint(await this.rpc<string>('eth_chainId', []), 'eth_chainId'))
    }
    return this.#chainId
  }

  async blockNumber(): Promise<bigint> {
    return hexToBigint(await this.rpc<string>('eth_blockNumber', []), 'eth_blockNumber')
  }

  async getBlockHeader(block: bigint | 'latest'): Promise<BlockHeader> {
    const raw = await this.rpc<Record<string, unknown> | null>('eth_getBlockByNumber', [
      toBlockTag(block),
      false,
    ])
    if (raw === null) throw new RpcError(`block ${String(block)} not found`, 0, 'eth_getBlockByNumber')
    return {
      number: hexToBigint(raw.number, 'block.number'),
      hash: String(raw.hash),
      timestampUnix: Number(hexToBigint(raw.timestamp, 'block.timestamp')),
    }
  }

  /**
   * Send several calls in ONE HTTP request.
   *
   * Responses may come back in any order, so they are matched by id, never by
   * position: a batch reassembled positionally would silently pair one token's
   * decimals with another token's address.
   */
  async rpcBatch(
    requests: ReadonlyArray<{ method: string; params: unknown[] }>,
  ): Promise<Array<BatchOutcome<unknown>>> {
    if (requests.length === 0) return []
    const ids = requests.map(() => this.#nextId++)
    const payload = requests.map((request, i) => ({
      jsonrpc: '2.0',
      id: ids[i]!,
      method: request.method,
      params: request.params,
    }))
    const label = `batch:${requests[0]!.method}x${requests.length}`
    const response = await this.#http.request({
      url: this.#nextUrl(),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      label,
      // One HTTP request, but N units of work as far as the endpoint is
      // concerned. Pace it accordingly or the configured rate is a fiction.
      weight: requests.length,
    })
    if (response.status < 200 || response.status >= 300) {
      throw new RpcError(`${label}: HTTP ${response.status}: ${response.body.slice(0, 300)}`, 0, label)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(response.body)
    } catch {
      throw new BatchUnsupportedError(`non-JSON response: ${response.body.slice(0, 200)}`)
    }
    if (!Array.isArray(parsed)) {
      // A single object here usually means "batch not supported" - and it may
      // even carry a plausible-looking result for ONE of the calls. Refuse it.
      throw new BatchUnsupportedError(
        `expected an array of ${requests.length} responses, got ${typeof parsed}: ${response.body.slice(0, 200)}`,
      )
    }
    const byId = new Map<number, JsonRpcResponse>()
    for (const entry of parsed as JsonRpcResponse[]) {
      if (typeof entry?.id === 'number') byId.set(entry.id, entry)
    }
    return ids.map((id, i) => {
      const entry = byId.get(id)
      if (entry === undefined) {
        return {
          ok: false as const,
          error: `${requests[i]!.method}: no response with id ${id} in the batch`,
          code: 0,
          reverted: false,
        }
      }
      if (entry.error) {
        const message = entry.error.message ?? 'unknown RPC error'
        return {
          ok: false as const,
          error: `${requests[i]!.method}: ${message}`,
          code: entry.error.code ?? 0,
          reverted: isDeterministicCallFailure(message),
        }
      }
      return { ok: true as const, value: entry.result }
    })
  }

  async getLogs(filter: LogFilter): Promise<RawLog[]> {
    const raw = await this.rpc<unknown[]>('eth_getLogs', [logFilterParams(filter)])
    return raw.map(parseRawLog)
  }

  async getLogsBatch(filters: readonly LogFilter[]): Promise<Array<BatchOutcome<RawLog[]>>> {
    const outcomes = await this.rpcBatch(
      filters.map((filter) => ({ method: 'eth_getLogs', params: [logFilterParams(filter)] })),
    )
    return outcomes.map((outcome) => {
      if (!outcome.ok) return outcome
      if (!Array.isArray(outcome.value)) {
        return {
          ok: false as const,
          error: `eth_getLogs: expected an array, got ${typeof outcome.value}`,
          code: 0,
          reverted: false,
        }
      }
      try {
        return { ok: true as const, value: outcome.value.map(parseRawLog) }
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
          code: 0,
          reverted: false,
        }
      }
    })
  }

  /**
   * Headers in one request.
   *
   * The 30-day run's timestamp anchor ladder is ~12,800 headers - twenty-five
   * times the log scan's own request count. Left unbatched, the ladder IS the
   * runtime.
   */
  async getBlockHeadersBatch(blocks: readonly bigint[]): Promise<Array<BatchOutcome<BlockHeader>>> {
    const outcomes = await this.rpcBatch(
      blocks.map((block) => ({ method: 'eth_getBlockByNumber', params: [toBlockTag(block), false] })),
    )
    return outcomes.map((outcome, i) => {
      if (!outcome.ok) return outcome
      if (outcome.value === null || typeof outcome.value !== 'object') {
        return {
          ok: false as const,
          error: `block ${blocks[i]!.toString()} not found`,
          code: 0,
          reverted: false,
        }
      }
      try {
        const raw = outcome.value as Record<string, unknown>
        return {
          ok: true as const,
          value: {
            number: hexToBigint(raw.number, 'block.number'),
            hash: String(raw.hash),
            timestampUnix: Number(hexToBigint(raw.timestamp, 'block.timestamp')),
          },
        }
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
          code: 0,
          reverted: false,
        }
      }
    })
  }

  async call(to: string, data: string, block: bigint | 'latest' = 'latest'): Promise<string> {
    return this.rpc<string>('eth_call', [{ to, data }, toBlockTag(block)])
  }

  /**
   * Runtime code at an address.
   *
   * NOTE FOR ANY CALLER TEMPTED BY A HISTORICAL BLOCK: this chain's public
   * endpoints keep no archive state, so eth_getCode at anything but a recent
   * block returns "metadata is not found". A code-presence bisect is therefore
   * impossible here and a classification is always a CURRENT reading.
   */
  async getCode(address: string, block: bigint | 'latest' = 'latest'): Promise<string> {
    return this.rpc<string>('eth_getCode', [address, toBlockTag(block)])
  }

  async getCodeBatch(
    addresses: readonly string[],
    block: bigint | 'latest' = 'latest',
  ): Promise<Array<BatchOutcome<string>>> {
    const outcomes = await this.rpcBatch(
      addresses.map((address) => ({ method: 'eth_getCode', params: [address, toBlockTag(block)] })),
    )
    return outcomes.map((outcome) => {
      if (!outcome.ok) return outcome
      if (typeof outcome.value !== 'string') {
        // "Did not answer in a shape we understand" is not "this address is an
        // EOA". Falling back to '0x' here would silently promote a locked
        // distributor into a prospect list, so it stays an error.
        return {
          ok: false as const,
          error: `eth_getCode: expected hex code, got ${typeof outcome.value}`,
          code: 0,
          reverted: false,
        }
      }
      return { ok: true as const, value: outcome.value }
    })
  }

  async callBatch(
    calls: ReadonlyArray<{ to: string; data: string }>,
    block: bigint | 'latest' = 'latest',
  ): Promise<Array<BatchOutcome<string>>> {
    const outcomes = await this.rpcBatch(
      calls.map((c) => ({ method: 'eth_call', params: [{ to: c.to, data: c.data }, toBlockTag(block)] })),
    )
    return outcomes.map((outcome) => {
      if (!outcome.ok) return outcome
      if (typeof outcome.value !== 'string') {
        return {
          ok: false as const,
          error: `eth_call: expected hex return data, got ${typeof outcome.value}`,
          code: 0,
          // A non-string result is a shape problem, not a revert: an ERC-20
          // getter that "did not answer in a way we understand" must not be
          // recorded as "this token has no symbol()".
          reverted: false,
        }
      }
      return { ok: true as const, value: outcome.value }
    })
  }
}

function logFilterParams(filter: LogFilter): Record<string, unknown> {
  const params: Record<string, unknown> = {
    fromBlock: toBlockTag(filter.fromBlock),
    toBlock: toBlockTag(filter.toBlock),
  }
  if (filter.address !== undefined) params.address = filter.address
  if (filter.topics !== undefined) params.topics = filter.topics
  return params
}

function parseRawLog(entry: unknown): RawLog {
  const log = entry as Record<string, unknown>
  return {
    address: String(log.address).toLowerCase(),
    topics: (log.topics as string[]).map((t) => t.toLowerCase()),
    data: String(log.data ?? '0x'),
    blockNumber: hexToBigint(log.blockNumber, 'log.blockNumber'),
    blockHash: String(log.blockHash),
    transactionHash: String(log.transactionHash),
    logIndex: Number(hexToBigint(log.logIndex, 'log.logIndex')),
    removed: log.removed === true,
  }
}

/**
 * In-memory ChainReader. Fixtures are plain arrays of logs and headers, so a
 * test that asserts a fee-rate distribution is asserting our decoding, not a
 * live endpoint's mood.
 */
export class FakeChainReader implements BatchChainReader {
  /** Set to make getLogs fail above a result count, exercising range narrowing. */
  maxLogsPerCall: number | undefined
  readonly getLogsCalls: LogFilter[] = []
  readonly callResponses = new Map<string, string | Error>()
  /** One entry per batch actually issued, holding its size. */
  readonly batchCalls: number[] = []
  /** Set to make every batch throw, exercising the sequential fallback. */
  batchUnsupported = false
  maxBatchSize = 10
  readonly options: {
    chainId: number
    logs: RawLog[]
    headers?: BlockHeader[]
    latestBlock?: bigint
    /** Seconds per block, used to synthesise headers not explicitly provided. */
    blockTimeSeconds?: number
    genesisUnix?: number
  }

  constructor(options: {
    chainId: number
    logs: RawLog[]
    headers?: BlockHeader[]
    latestBlock?: bigint
    blockTimeSeconds?: number
    genesisUnix?: number
  }) {
    this.options = options
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async chainId(): Promise<number> {
    return this.options.chainId
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async blockNumber(): Promise<bigint> {
    if (this.options.latestBlock !== undefined) return this.options.latestBlock
    return this.options.logs.reduce((max, l) => (l.blockNumber > max ? l.blockNumber : max), 0n)
  }

  async getBlockHeader(block: bigint | 'latest'): Promise<BlockHeader> {
    const target = block === 'latest' ? await this.blockNumber() : block
    const found = this.options.headers?.find((h) => h.number === target)
    if (found) return found
    const spacing = this.options.blockTimeSeconds ?? 1
    const genesis = this.options.genesisUnix ?? 0
    return {
      number: target,
      hash: `0x${target.toString(16).padStart(64, '0')}`,
      timestampUnix: genesis + Number(target) * spacing,
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getLogs(filter: LogFilter): Promise<RawLog[]> {
    this.getLogsCalls.push(filter)
    const addresses =
      filter.address === undefined
        ? undefined
        : new Set(
            (Array.isArray(filter.address) ? filter.address : [filter.address]).map((a) =>
              a.toLowerCase(),
            ),
          )
    const matched = this.options.logs.filter((log) => {
      if (log.blockNumber < filter.fromBlock || log.blockNumber > filter.toBlock) return false
      if (addresses !== undefined && !addresses.has(log.address.toLowerCase())) return false
      if (filter.topics !== undefined) {
        for (const [i, wanted] of filter.topics.entries()) {
          if (wanted === null || wanted === undefined) continue
          const actual = log.topics[i]
          if (actual === undefined) return false
          const options = Array.isArray(wanted) ? wanted : [wanted]
          if (!options.some((o) => o.toLowerCase() === actual.toLowerCase())) return false
        }
      }
      return true
    })
    if (this.maxLogsPerCall !== undefined && matched.length > this.maxLogsPerCall) {
      throw new RpcError('query returned more than 10000 results', -32005, 'eth_getLogs')
    }
    return matched
  }

  /**
   * Fixture code by address. An address absent from this map has NO fixture,
   * which getCode reports as an error rather than as '0x' - the same discipline
   * the live reader keeps, so a test cannot accidentally assert on a default.
   */
  readonly codeResponses = new Map<string, string | Error>()

  // eslint-disable-next-line @typescript-eslint/require-await
  async getCode(address: string): Promise<string> {
    const response = this.codeResponses.get(address.toLowerCase())
    if (response === undefined) {
      throw new RpcError(`eth_getCode: no fixture for ${address}`, 0, 'eth_getCode')
    }
    if (response instanceof Error) throw response
    return response
  }

  async getCodeBatch(addresses: readonly string[]): Promise<Array<BatchOutcome<string>>> {
    if (this.batchUnsupported) throw new BatchUnsupportedError('FakeChainReader.batchUnsupported')
    if (addresses.length > this.maxBatchSize) {
      throw new RpcError(
        `batch of ${addresses.length} exceeds ${this.maxBatchSize}`,
        429,
        'eth_getCode',
      )
    }
    this.batchCalls.push(addresses.length)
    const out: Array<BatchOutcome<string>> = []
    for (const address of addresses) {
      try {
        out.push({ ok: true, value: await this.getCode(address) })
      } catch (error) {
        out.push({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          code: 0,
          reverted: false,
        })
      }
    }
    return out
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async call(to: string, data: string): Promise<string> {
    const key = `${to.toLowerCase()}:${data.toLowerCase()}`
    const response = this.callResponses.get(key) ?? this.callResponses.get(data.toLowerCase())
    if (response === undefined) {
      throw new CallRevertedError(`eth_call: execution reverted (no fixture for ${key})`, 3, 'eth_call')
    }
    if (response instanceof Error) throw response
    return response
  }

  async callBatch(
    calls: ReadonlyArray<{ to: string; data: string }>,
    block?: bigint | 'latest',
  ): Promise<Array<BatchOutcome<string>>> {
    void block
    if (this.batchUnsupported) throw new BatchUnsupportedError('FakeChainReader.batchUnsupported')
    if (calls.length > this.maxBatchSize) {
      throw new RpcError(`batch of ${calls.length} exceeds ${this.maxBatchSize}`, 429, 'eth_call')
    }
    this.batchCalls.push(calls.length)
    const out: Array<BatchOutcome<string>> = []
    for (const c of calls) {
      try {
        out.push({ ok: true, value: await this.call(c.to, c.data) })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        out.push({
          ok: false,
          error: message,
          code: error instanceof RpcError ? error.code : 0,
          reverted: isDeterministicCallFailure(message),
        })
      }
    }
    return out
  }

  async getBlockHeadersBatch(blocks: readonly bigint[]): Promise<Array<BatchOutcome<BlockHeader>>> {
    if (this.batchUnsupported) throw new BatchUnsupportedError('FakeChainReader.batchUnsupported')
    if (blocks.length > this.maxBatchSize) {
      throw new RpcError(
        `batch of ${blocks.length} exceeds ${this.maxBatchSize}`,
        429,
        'eth_getBlockByNumber',
      )
    }
    this.batchCalls.push(blocks.length)
    const out: Array<BatchOutcome<BlockHeader>> = []
    for (const block of blocks) {
      try {
        out.push({ ok: true, value: await this.getBlockHeader(block) })
      } catch (error) {
        out.push({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          code: 0,
          reverted: false,
        })
      }
    }
    return out
  }

  async getLogsBatch(filters: readonly LogFilter[]): Promise<Array<BatchOutcome<RawLog[]>>> {
    if (this.batchUnsupported) throw new BatchUnsupportedError('FakeChainReader.batchUnsupported')
    if (filters.length > this.maxBatchSize) {
      throw new RpcError(`batch of ${filters.length} exceeds ${this.maxBatchSize}`, 429, 'eth_getLogs')
    }
    this.batchCalls.push(filters.length)
    const out: Array<BatchOutcome<RawLog[]>> = []
    for (const filter of filters) {
      try {
        out.push({ ok: true, value: await this.getLogs(filter) })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        out.push({
          ok: false,
          error: message,
          code: error instanceof RpcError ? error.code : 0,
          reverted: false,
        })
      }
    }
    return out
  }
}
