/**
 * ERC-20 metadata, read from the chain, cached forever, and NEVER defaulted.
 *
 * WHY THIS FILE EXISTS. A live ERC-20 escrow run found credits in 263 distinct
 * assets, every symbol "UNKNOWN", and decimals silently defaulted to 18. The
 * totals gave it away: one asset with 4,450 recipients summed to 1.19e-6 while
 * another with 186 recipients summed to 1.31e+4. Both cannot be right, and the
 * reason is that `decimals ?? 18` turns a six-decimal stablecoin into a
 * rounding error and prints it with a straight face.
 *
 * THE RULE HERE. Every field is `T | null`, and null means UNKNOWN, not zero
 * and not a default. An unknown decimals makes the asset UNPRICEABLE, which
 * flows through to the false-zero handling in prices.ts and to the coverage
 * statement in coverage.ts. A measurement that cannot be made is reported as
 * not made.
 *
 * THREE THINGS THE CHAIN ACTUALLY DOES, all of which are handled:
 *   1. `symbol()` returning a proper ABI string (the ERC-20 spec).
 *   2. `symbol()` returning a raw bytes32 (MKR and every token of that era).
 *   3. no `symbol()` at all - the call reverts or returns 0x.
 * Only the third is "absent". The first two are data, and mistaking (2) for
 * (3) loses real tokens.
 *
 * CACHING. decimals/symbol/name are immutable for any sane token, so entries
 * are cached with no expiry. But a TRANSPORT failure is not a fact about the
 * token, so a read that failed for RPC reasons is never written to the cache -
 * otherwise one flaky minute would permanently mark a token unknown.
 */

import { functionSelector } from './abi.ts'
import type { Cache } from './cache.ts'
import { cacheKey } from './cache.ts'
import { hexToBytes } from './keccak.ts'
import type { BatchOutcome, ChainReader } from './rpc.ts'
import { BatchUnsupportedError, isDeterministicCallFailure, supportsBatch } from './rpc.ts'

export const TOKEN_METADATA_SCHEMA = 'token-metadata-1'

/** Measured on this chain: 10 calls per request is the point before 429s. */
export const DEFAULT_METADATA_BATCH_SIZE = 10

export const SELECTOR_DECIMALS = functionSelector('decimals()')
export const SELECTOR_SYMBOL = functionSelector('symbol()')
export const SELECTOR_NAME = functionSelector('name()')

/**
 * Why a field holds what it holds.
 *   ok           - decoded from the chain.
 *   absent       - the getter reverted or returned 0x. The token has none.
 *   undecodable  - it returned bytes we refuse to guess at.
 *   error        - the READ failed (transport, rate limit). We learned nothing,
 *                  so this is never cached and a retry is worthwhile.
 */
export type FieldStatus = 'ok' | 'absent' | 'undecodable' | 'error'

export type StringEncoding = 'string' | 'bytes32' | 'none'

export interface TokenMetadata {
  address: string
  /** null is UNKNOWN. Callers must not substitute 18. */
  decimals: number | null
  symbol: string | null
  name: string | null
  decimalsStatus: FieldStatus
  symbolStatus: FieldStatus
  nameStatus: FieldStatus
  symbolEncoding: StringEncoding
  nameEncoding: StringEncoding
  resolvedAtUnix: number
}

/** True when nothing about this token is still merely un-read. */
export function isComplete(meta: TokenMetadata): boolean {
  return (
    meta.decimalsStatus !== 'error' && meta.symbolStatus !== 'error' && meta.nameStatus !== 'error'
  )
}

/** The only question pricing actually asks: can this asset be converted at all? */
export function hasKnownDecimals(meta: TokenMetadata | undefined): boolean {
  return meta !== undefined && meta.decimals !== null
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Longest string we will accept from an untrusted token contract.
 *
 * A "symbol" longer than this is not a symbol, it is an attempt to make a
 * report unreadable. Live names on this chain run to ~50 bytes ("Trump Media &
 * Technology Group - Robinhood Token"), so the cap has real headroom.
 */
const MAX_STRING_BYTES = 256

const utf8 = new TextDecoder('utf-8', { fatal: false })

/**
 * Decode token-supplied bytes to a display string.
 *
 * NOT ASCII-only. Live tokens here return names like "NVIDIA • Robinhood
 * Token" - a legitimate UTF-8 bullet - and rejecting those loses the name of a
 * real asset. What IS stripped is control characters: C0, DEL and C1. A symbol
 * carrying a newline or a terminal escape would corrupt every report it is
 * pasted into, and no honest token needs one.
 */
function decodeDisplayString(bytes: Uint8Array): string | null {
  const decoded = utf8.decode(bytes)
  let out = ''
  for (const char of decoded) {
    const code = char.codePointAt(0)!
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue
    out += char
  }
  const trimmed = out.trim()
  return trimmed.length === 0 ? null : trimmed
}

export interface DecodedString {
  value: string | null
  status: FieldStatus
  encoding: StringEncoding
}

/**
 * Decode a `symbol()` / `name()` return.
 *
 * Handles the ABI string form and the bytes32 form, and refuses everything
 * else. Note the ordering: a 32-byte return CANNOT be an ABI string (which
 * needs at least an offset word and a length word), so 32 bytes means bytes32
 * and nothing else.
 */
export function decodeErc20String(returnData: string): DecodedString {
  let bytes: Uint8Array
  try {
    bytes = hexToBytes(returnData)
  } catch {
    return { value: null, status: 'undecodable', encoding: 'none' }
  }
  if (bytes.length === 0) return { value: null, status: 'absent', encoding: 'none' }

  if (bytes.length === 32) {
    // bytes32: right-padded with NULs.
    let end = 32
    while (end > 0 && bytes[end - 1] === 0) end--
    if (end === 0) return { value: null, status: 'absent', encoding: 'bytes32' }
    const value = decodeDisplayString(bytes.subarray(0, end))
    return value === null
      ? { value: null, status: 'undecodable', encoding: 'bytes32' }
      : { value, status: 'ok', encoding: 'bytes32' }
  }

  if (bytes.length >= 64) {
    let offset: number
    let length: number
    try {
      offset = Number(wordToBigUint(bytes.subarray(0, 32)))
      // A head word that big is not an offset; bail before allocating on it.
      if (offset < 32 || offset + 32 > bytes.length) {
        return { value: null, status: 'undecodable', encoding: 'none' }
      }
      length = Number(wordToBigUint(bytes.subarray(offset, offset + 32)))
    } catch {
      return { value: null, status: 'undecodable', encoding: 'none' }
    }
    if (length === 0) return { value: null, status: 'absent', encoding: 'string' }
    if (length > MAX_STRING_BYTES || offset + 32 + length > bytes.length) {
      return { value: null, status: 'undecodable', encoding: 'string' }
    }
    const value = decodeDisplayString(bytes.subarray(offset + 32, offset + 32 + length))
    return value === null
      ? { value: null, status: 'undecodable', encoding: 'string' }
      : { value, status: 'ok', encoding: 'string' }
  }

  return { value: null, status: 'undecodable', encoding: 'none' }
}

export interface DecodedDecimals {
  value: number | null
  status: FieldStatus
}

/**
 * Decode a `decimals()` return.
 *
 * Range-checked at 0..36 deliberately: a token reporting 255 decimals would
 * make 10**255 the scale and quietly zero every amount it touches. That is
 * "undecodable", not "255".
 */
export function decodeErc20Decimals(returnData: string): DecodedDecimals {
  let bytes: Uint8Array
  try {
    bytes = hexToBytes(returnData)
  } catch {
    return { value: null, status: 'undecodable' }
  }
  if (bytes.length === 0) return { value: null, status: 'absent' }
  if (bytes.length < 32) return { value: null, status: 'undecodable' }
  const raw = wordToBigUint(bytes.subarray(0, 32))
  if (raw > 36n) return { value: null, status: 'undecodable' }
  return { value: Number(raw), status: 'ok' }
}

function wordToBigUint(word: Uint8Array): bigint {
  let out = 0n
  for (const b of word) out = (out << 8n) | BigInt(b)
  return out
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export interface TokenMetadataResolverOptions {
  chainId: number
  cache?: Cache
  /** eth_calls per JSON-RPC batch. 10 is the measured optimum on this chain. */
  batchSize?: number
  /** Pinned to a block so a re-run reproduces exactly. Defaults to latest. */
  block?: bigint | 'latest'
  now?: () => number
  onProgress?: (message: string) => void
}

export interface ResolverStats {
  requested: number
  fromCache: number
  readFromChain: number
  batches: number
  calls: number
  /** Tokens with at least one field we could not read at all. Retry these. */
  incomplete: number
  batchFallbacks: number
}

interface PendingCall {
  address: string
  field: 'decimals' | 'symbol' | 'name'
}

export class TokenMetadataResolver {
  readonly #reader: ChainReader
  readonly #options: TokenMetadataResolverOptions
  readonly #now: () => number
  readonly #batchSize: number
  #batchUsable: boolean
  #stats: ResolverStats = {
    requested: 0,
    fromCache: 0,
    readFromChain: 0,
    batches: 0,
    calls: 0,
    incomplete: 0,
    batchFallbacks: 0,
  }

  constructor(reader: ChainReader, options: TokenMetadataResolverOptions) {
    this.#reader = reader
    this.#options = options
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000))
    this.#batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_METADATA_BATCH_SIZE))
    this.#batchUsable = supportsBatch(reader) && this.#batchSize > 1
  }

  get stats(): ResolverStats {
    return { ...this.#stats }
  }

  #cacheId(address: string): string {
    return cacheKey({ kind: 'tokenMetadata', chainId: this.#options.chainId, address })
  }

  /**
   * Resolve every address, cache-first.
   *
   * Returns a Map keyed by lowercase address with an entry for EVERY address
   * asked for - including the ones that resolved to nothing, because "we asked
   * and the token has no symbol()" and "we never asked" are different facts and
   * the report distinguishes them.
   */
  async resolve(addresses: readonly string[]): Promise<Map<string, TokenMetadata>> {
    const wanted = [...new Set(addresses.map((a) => a.toLowerCase()))]
    this.#stats.requested += wanted.length
    const out = new Map<string, TokenMetadata>()

    const misses: string[] = []
    for (const address of wanted) {
      const cached = await this.#options.cache?.get<TokenMetadata>(
        this.#cacheId(address),
        TOKEN_METADATA_SCHEMA,
      )
      if (cached !== undefined && isComplete(cached)) {
        this.#stats.fromCache++
        out.set(address, cached)
      } else {
        misses.push(address)
      }
    }
    if (misses.length === 0) return out

    this.#options.onProgress?.(
      `token metadata: ${out.size} cached, ${misses.length} to read from chain`,
    )

    // One flat call list, chunked at the batch size. Chunking by CALL rather
    // than by token keeps every request the same measured size instead of
    // rounding to a multiple of three.
    const pending: PendingCall[] = []
    for (const address of misses) {
      pending.push(
        { address, field: 'decimals' },
        { address, field: 'symbol' },
        { address, field: 'name' },
      )
    }

    const results = new Map<string, Map<PendingCall['field'], BatchOutcome<string>>>()
    for (const address of misses) results.set(address, new Map())

    for (let i = 0; i < pending.length; i += this.#batchSize) {
      const slice = pending.slice(i, i + this.#batchSize)
      const outcomes = await this.#issue(slice)
      for (const [j, outcome] of outcomes.entries()) {
        const call = slice[j]!
        results.get(call.address)!.set(call.field, outcome)
      }
      this.#options.onProgress?.(
        `token metadata: ${Math.min(i + this.#batchSize, pending.length)}/${pending.length} calls`,
      )
    }

    for (const address of misses) {
      const fields = results.get(address)!
      const meta = assembleMetadata(address, fields, this.#now())
      this.#stats.readFromChain++
      if (isComplete(meta)) {
        await this.#options.cache?.set(this.#cacheId(address), TOKEN_METADATA_SCHEMA, meta)
      } else {
        // Deliberately NOT cached: we did not learn anything about this token,
        // and writing it would make one bad minute permanent.
        this.#stats.incomplete++
      }
      out.set(address, meta)
    }
    return out
  }

  async #issue(slice: readonly PendingCall[]): Promise<Array<BatchOutcome<string>>> {
    const calls = slice.map((call) => ({
      to: call.address,
      data: selectorFor(call.field),
    }))
    this.#stats.calls += calls.length
    if (this.#batchUsable && supportsBatch(this.#reader)) {
      try {
        this.#stats.batches++
        return await this.#reader.callBatch(calls, this.#options.block ?? 'latest')
      } catch (error) {
        if (error instanceof BatchUnsupportedError) {
          // Fall through to sequential for the rest of the run. This endpoint
          // does not speak batch and re-discovering that per chunk is waste.
          this.#batchUsable = false
          this.#stats.batchFallbacks++
          this.#options.onProgress?.(`token metadata: batch unsupported, falling back: ${error.message}`)
        } else {
          throw error
        }
      }
    }
    const out: Array<BatchOutcome<string>> = []
    for (const call of calls) {
      try {
        out.push({ ok: true, value: await this.#reader.call(call.to, call.data, this.#options.block ?? 'latest') })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        out.push({ ok: false, error: message, code: 0, reverted: isDeterministicCallFailure(message) })
      }
    }
    return out
  }
}

function selectorFor(field: PendingCall['field']): string {
  if (field === 'decimals') return SELECTOR_DECIMALS
  if (field === 'symbol') return SELECTOR_SYMBOL
  return SELECTOR_NAME
}

function assembleMetadata(
  address: string,
  fields: ReadonlyMap<PendingCall['field'], BatchOutcome<string>>,
  nowUnix: number,
): TokenMetadata {
  const decimals = fields.get('decimals')
  const symbol = fields.get('symbol')
  const name = fields.get('name')

  const decimalsDecoded = decimals === undefined
    ? { value: null, status: 'error' as FieldStatus }
    : decimals.ok
      ? decodeErc20Decimals(decimals.value)
      // A revert means the token genuinely has no decimals(). Any other RPC
      // error means we do not know, which is a DIFFERENT answer.
      : { value: null, status: (decimals.reverted ? 'absent' : 'error') as FieldStatus }

  const symbolDecoded = decodeStringField(symbol)
  const nameDecoded = decodeStringField(name)

  return {
    address,
    decimals: decimalsDecoded.value,
    symbol: symbolDecoded.value,
    name: nameDecoded.value,
    decimalsStatus: decimalsDecoded.status,
    symbolStatus: symbolDecoded.status,
    nameStatus: nameDecoded.status,
    symbolEncoding: symbolDecoded.encoding,
    nameEncoding: nameDecoded.encoding,
    resolvedAtUnix: nowUnix,
  }
}

function decodeStringField(outcome: BatchOutcome<string> | undefined): DecodedString {
  if (outcome === undefined) return { value: null, status: 'error', encoding: 'none' }
  if (outcome.ok) return decodeErc20String(outcome.value)
  return {
    value: null,
    status: outcome.reverted ? 'absent' : 'error',
    encoding: 'none',
  }
}

/** Counts for the human report: how much of the asset set actually resolved. */
export interface MetadataSummary {
  total: number
  decimalsKnown: number
  decimalsAbsent: number
  decimalsUnreadable: number
  symbolKnown: number
  symbolFromBytes32: number
  nameKnown: number
  incomplete: number
}

export function summarizeMetadata(
  metadata: ReadonlyMap<string, TokenMetadata>,
): MetadataSummary {
  const summary: MetadataSummary = {
    total: metadata.size,
    decimalsKnown: 0,
    decimalsAbsent: 0,
    decimalsUnreadable: 0,
    symbolKnown: 0,
    symbolFromBytes32: 0,
    nameKnown: 0,
    incomplete: 0,
  }
  for (const meta of metadata.values()) {
    if (meta.decimalsStatus === 'ok') summary.decimalsKnown++
    else if (meta.decimalsStatus === 'absent') summary.decimalsAbsent++
    else summary.decimalsUnreadable++
    if (meta.symbolStatus === 'ok') summary.symbolKnown++
    if (meta.symbolEncoding === 'bytes32' && meta.symbolStatus === 'ok') summary.symbolFromBytes32++
    if (meta.nameStatus === 'ok') summary.nameKnown++
    if (!isComplete(meta)) summary.incomplete++
  }
  return summary
}
