/**
 * Event shapes and static ABI decoding.
 *
 * INTEGRATION SURFACE - READ THIS BEFORE DEPLOYING.
 *
 * The signature strings below are the Sourcify-verified Venue V2 ABI for chain
 * 4663 (factory 0x7eD598Bc…, hook 0xE5e70264…), cross-checked against a topic0
 * census recorded in tools/__tests__/fixtures/verified-event-signatures.json.
 * topic0 is derived from them by keccak at module load, never copy-pasted, so a
 * signature string and its topic can never drift apart; the census values are
 * pinned separately in config/protocol.ts VENUE.topics and VaultIndexer refuses
 * to boot if the two disagree.
 *
 * If a signature here were WRONG, the derived topic0 would match no log, the
 * query would return nothing, and the coin would measure zero fee flow. That
 * failure direction is deliberate: a wrong ABI under-credits and denies a tier,
 * it never invents a credit. Fail closed.
 *
 * Note also what is NOT decoded anywhere in this package: no name(), no symbol(),
 * no tokenURI, no string field of any kind. On-chain token metadata is
 * attacker-authored and this plane holds a cursor over real money, so the
 * indexer reads only numbers, addresses and hashes.
 */

import { DecodeError, EventShapeMismatchError } from './errors.js'
import {
  addressToTopic,
  assertHex,
  hexToBigInt,
  hexToBytes,
  normalizeAddress,
  normalizeHash32,
  padLeft32,
  topicToAddress,
  type Hex,
} from './hex.js'
import { keccak256Hex } from './keccak.js'
import type { RpcLog } from './rpc.js'

export type AbiStaticType = 'address' | 'uint256' | 'uint128' | 'uint64' | 'int256' | 'bool' | 'bytes32'

export interface EventParam {
  readonly name: string
  readonly type: AbiStaticType
  readonly indexed: boolean
}

export interface EventShape {
  readonly name: string
  readonly signature: string
  readonly topic0: Hex
  readonly params: readonly EventParam[]
  readonly indexedCount: number
}

export type DecodedValue = bigint | string | boolean
export type DecodedLog = Readonly<Record<string, DecodedValue>>

export function defineEvent(name: string, params: readonly EventParam[]): EventShape {
  const signature = `${name}(${params.map((p) => p.type).join(',')})`
  const indexedCount = params.filter((p) => p.indexed).length
  if (indexedCount > 3) throw new DecodeError(`${name} declares ${indexedCount} indexed params; max is 3`)
  return { name, signature, topic0: keccak256Hex(signature), params, indexedCount }
}

/** First 4 bytes of the keccak of a function signature. */
export function selector(signature: string): Hex {
  return keccak256Hex(signature).slice(0, 10) as Hex
}

function decodeWord(type: AbiStaticType, word: Hex, field: string): DecodedValue {
  switch (type) {
    case 'address':
      return topicToAddress(word)
    case 'bytes32':
      return normalizeHash32(word)
    case 'uint256':
    case 'uint128':
    case 'uint64':
      return hexToBigInt(word)
    case 'int256': {
      const raw = hexToBigInt(word)
      return raw >= 1n << 255n ? raw - (1n << 256n) : raw
    }
    case 'bool': {
      const raw = hexToBigInt(word)
      if (raw > 1n) throw new DecodeError(`${field} is not a canonical bool: ${word}`)
      return raw === 1n
    }
    default: {
      const exhaustive: never = type
      throw new DecodeError(`unsupported abi type ${String(exhaustive)} in ${field}`)
    }
  }
}

/**
 * Decode one log against a shape. Every structural expectation is checked and any
 * surprise throws: an unexpected topic count or a data section that is not an
 * exact multiple of 32 bytes means the deployed ABI is not the one we compiled
 * against, and guessing at that point would attribute the wrong number.
 */
export function decodeEventLog(shape: EventShape, log: RpcLog): DecodedLog {
  const topic0 = log.topics[0]
  if (topic0 === undefined || normalizeHash32(topic0) !== shape.topic0) {
    throw new DecodeError(`log topic0 ${String(topic0)} is not ${shape.name} (${shape.topic0})`)
  }
  if (log.topics.length !== shape.indexedCount + 1) {
    throw new DecodeError(
      `${shape.name} expects ${shape.indexedCount + 1} topics, log has ${log.topics.length}`,
    )
  }

  const data = assertHex(log.data, `${shape.name}.data`)
  const dataBody = data.slice(2)
  const nonIndexed = shape.params.length - shape.indexedCount
  if (dataBody.length !== nonIndexed * 64) {
    throw new DecodeError(
      `${shape.name} expects ${nonIndexed * 32} data bytes, log has ${dataBody.length / 2}`,
    )
  }

  const out: Record<string, DecodedValue> = {}
  let topicIndex = 1
  let dataIndex = 0
  for (const param of shape.params) {
    if (param.indexed) {
      const topic = log.topics[topicIndex++]
      if (topic === undefined) throw new DecodeError(`${shape.name}.${param.name}: missing topic`)
      out[param.name] = decodeWord(param.type, normalizeHash32(topic), `${shape.name}.${param.name}`)
    } else {
      const word = `0x${dataBody.slice(dataIndex * 64, dataIndex * 64 + 64)}` as Hex
      dataIndex++
      out[param.name] = decodeWord(param.type, word, `${shape.name}.${param.name}`)
    }
  }
  return out
}

export function requireBigInt(decoded: DecodedLog, field: string): bigint {
  const value = decoded[field]
  if (typeof value !== 'bigint') throw new DecodeError(`${field} is not a number`)
  return value
}

export function requireAddress(decoded: DecodedLog, field: string): string {
  const value = decoded[field]
  if (typeof value !== 'string') throw new DecodeError(`${field} is not an address`)
  return normalizeAddress(value)
}

export function requireHash32(decoded: DecodedLog, field: string): Hex {
  const value = decoded[field]
  if (typeof value !== 'string') throw new DecodeError(`${field} is not a 32-byte value`)
  return normalizeHash32(value)
}

// ---------------------------------------------------------------------------
// Venue V2 events this package consumes
// ---------------------------------------------------------------------------

/**
 * Pre-graduation trades. Emitted by the PER-LAUNCH curve contract, so the log's
 * emitter address IS the per-coin attribution key - the one place in this system
 * where attribution is free.
 *
 * The curves are not verified on Sourcify. The signature (two indexed addresses,
 * four data words) was recovered by keccak preimage search against the observed
 * topic0; the parameter NAMES below are pinned from live chain evidence, not
 * source: 175 logs across 27 curves, each joined to its transaction, the
 * memecoin / quote ERC-20 transfers of the same receipt and the trader's native
 * balance delta (tools/artifacts/CURVE-SHAPE.md; raw logs in
 * tools/__tests__/fixtures/curve-trade-live-logs.json, asserted by
 * __tests__/curve-shape.spec.ts).
 *
 *   sender     msg.sender of the curve call: the EOA, or a router / wallet contract
 *   trader     who the memecoin is minted to (buy) or burned from (sell)
 *   amountIn   buy: gross quote paid (tx.value / quote Transfer);  sell: memecoin sold
 *   amountOut  buy: memecoin received;  sell: NET quote paid to trader
 *   fee        the curve fee on the gross quote: 1.00% (hookFeeBps), higher inside
 *              the anti-snipe window
 *   creatorTax gross quote * creatorTaxBps / 10_000, exact on every observed log
 *
 * Sell gross = amountOut + fee + creatorTax. A shape with any other names refuses
 * attribution (curveTradeShapePinned) rather than reading a money figure out of a
 * positional word.
 */
export const CURVE_BUY = defineEvent('CurveBuy', [
  { name: 'sender', type: 'address', indexed: true },
  { name: 'trader', type: 'address', indexed: true },
  { name: 'amountIn', type: 'uint256', indexed: false },
  { name: 'amountOut', type: 'uint256', indexed: false },
  { name: 'fee', type: 'uint256', indexed: false },
  { name: 'creatorTax', type: 'uint256', indexed: false },
])

export const CURVE_SELL = defineEvent('CurveSell', [
  { name: 'sender', type: 'address', indexed: true },
  { name: 'trader', type: 'address', indexed: true },
  { name: 'amountIn', type: 'uint256', indexed: false },
  { name: 'amountOut', type: 'uint256', indexed: false },
  { name: 'fee', type: 'uint256', indexed: false },
  { name: 'creatorTax', type: 'uint256', indexed: false },
])

/**
 * The names a curve trade must carry before an amount may be read from it.
 * attributeCurveLog refuses any shape that lacks one; renaming a param back to
 * a positional word switches attribution off, never onto a guess.
 */
export const CURVE_TRADE_FIELDS = ['trader', 'amountIn', 'amountOut', 'fee', 'creatorTax'] as const

export function curveTradeShapePinned(shape: EventShape): boolean {
  return CURVE_TRADE_FIELDS.every((field) => shape.params.some((param) => param.name === field))
}

/**
 * Post-graduation fee attribution. Emitted by the shared hook and keyed by
 * poolId, which is the ONLY per-coin identifier available after graduation:
 * escrow credits commingle by (recipient, quoteAsset) and carry no coin. The
 * event carries no asset either; the quote asset comes from the coin binding.
 */
export const POOL_FEES_SWEPT = defineEvent('PoolFeesSwept', [
  { name: 'poolId', type: 'bytes32', indexed: true },
  { name: 'protocolAmount', type: 'uint256', indexed: false },
  { name: 'buybackAmount', type: 'uint256', indexed: false },
  { name: 'creatorAmount', type: 'uint256', indexed: false },
  { name: 'tokensLocked', type: 'uint256', indexed: false },
])

/**
 * The hook's poolId -> memecoin binding, emitted at graduation. memecoin is NOT
 * indexed, so this cannot be queried by token; it is queried by the poolId
 * derived from getLaunchedToken() and the memecoin field confirms the join.
 */
export const POOL_REGISTERED = defineEvent('PoolRegistered', [
  { name: 'poolId', type: 'bytes32', indexed: true },
  { name: 'memecoin', type: 'address', indexed: false },
  { name: 'quoteToken', type: 'address', indexed: false },
  { name: 'creator', type: 'address', indexed: false },
])

/** Binds token -> curve and names the quote asset. Carries NO poolId. */
export const TOKEN_LAUNCHED = defineEvent('TokenLaunched', [
  { name: 'token', type: 'address', indexed: true },
  { name: 'curve', type: 'address', indexed: true },
  { name: 'deployer', type: 'address', indexed: true },
  { name: 'pairToken', type: 'address', indexed: false },
  { name: 'launchConfigId', type: 'uint256', indexed: false },
  { name: 'graduationThreshold', type: 'uint256', indexed: false },
])

/**
 * The Venue owner's timelocked override of any coin's fee recipient. The
 * timelock is the entire response window, so this is alerted at PROPOSAL time.
 * The proposal lapses if not executed by expiresAt.
 */
export const CREATOR_FEE_RECIPIENT_CHANGE_PROPOSED = defineEvent(
  'CreatorFeeRecipientChangeProposed',
  [
    { name: 'token', type: 'address', indexed: true },
    { name: 'currentRecipient', type: 'address', indexed: true },
    { name: 'proposedRecipient', type: 'address', indexed: true },
    { name: 'effectiveAt', type: 'uint256', indexed: false },
    { name: 'expiresAt', type: 'uint256', indexed: false },
  ],
)

export const CREATOR_FEE_RECIPIENT_CHANGE_CANCELLED = defineEvent(
  'CreatorFeeRecipientChangeCancelled',
  [
    { name: 'token', type: 'address', indexed: true },
    { name: 'proposedRecipient', type: 'address', indexed: true },
  ],
)

/**
 * Recipiency actually moved: the self-service transfer by the CURRENT recipient
 * (immediate, no timelock) and the executed owner override both land here. If
 * our vault is the current recipient the self-service path should be impossible
 * without our key, so seeing it is a compromise indication, not a routine event.
 */
export const CREATOR_FEE_RECIPIENT_UPDATED = defineEvent('CreatorFeeRecipientUpdated', [
  { name: 'token', type: 'address', indexed: true },
  { name: 'previousRecipient', type: 'address', indexed: true },
  { name: 'newRecipient', type: 'address', indexed: true },
])

export const VENUE_EVENTS = {
  CURVE_BUY,
  CURVE_SELL,
  POOL_FEES_SWEPT,
  POOL_REGISTERED,
  TOKEN_LAUNCHED,
  CREATOR_FEE_RECIPIENT_CHANGE_PROPOSED,
  CREATOR_FEE_RECIPIENT_CHANGE_CANCELLED,
  CREATOR_FEE_RECIPIENT_UPDATED,
} as const

export type VenueEventName = keyof typeof VENUE_EVENTS

/**
 * Startup guard. Give it the topic0 values observed on the deployed, verified
 * contracts and it refuses to boot on any drift, converting a silent "zero fees
 * observed" into a loud refusal. Every event must be pinned: an unpinned event
 * is an unverified one.
 */
export function assertPinnedTopics(pinned: Readonly<Record<VenueEventName, string>>): void {
  for (const name of Object.keys(VENUE_EVENTS) as VenueEventName[]) {
    const shape = VENUE_EVENTS[name]
    const expected = pinned[name]
    if (typeof expected !== 'string') {
      throw new EventShapeMismatchError(shape.name, '<unpinned>', shape.topic0)
    }
    const normalized = normalizeHash32(expected)
    if (normalized !== shape.topic0) {
      throw new EventShapeMismatchError(shape.name, normalized, shape.topic0)
    }
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * factory.getLaunchedToken(address) -> LaunchedToken. The one read this package
 * makes: it names who the protocol currently pays for a token (word 3) and the
 * pool key material from which the post-graduation poolId is derived.
 */
export const GET_LAUNCHED_TOKEN_SELECTOR = selector('getLaunchedToken(address)')

/** The factory's LaunchedToken struct, a static tuple of 15 words. */
export interface LaunchedToken {
  readonly token: string
  readonly curve: string
  readonly deployer: string
  readonly creatorFeeRecipient: string
  readonly pairToken: string
  readonly graduationThreshold: bigint
  readonly poolFee: number
  readonly tickSpacing: number
  readonly creatorTaxBps: number
  readonly buybackEnabled: boolean
  readonly phase: number
  readonly sweptQuote: bigint
  readonly sweptTokens: bigint
  readonly sweptAt: bigint
  readonly exists: boolean
}

const LAUNCHED_TOKEN_WORDS = 15

export function encodeAddressArgCall(fnSelector: Hex, address: string): Hex {
  const arg = padLeft32(`0x${normalizeAddress(address).slice(2)}` as Hex)
  return `${fnSelector}${arg.slice(2)}` as Hex
}

function boundedUint(word: Hex, bits: number, field: string): number {
  const raw = hexToBigInt(word)
  if (raw >= 1n << BigInt(bits)) throw new DecodeError(`${field} exceeds uint${bits}: ${word}`)
  return Number(raw)
}

function boundedInt(word: Hex, bits: number, field: string): number {
  const raw = hexToBigInt(word)
  const signed = raw >= 1n << 255n ? raw - (1n << 256n) : raw
  const limit = 1n << BigInt(bits - 1)
  if (signed >= limit || signed < -limit) throw new DecodeError(`${field} exceeds int${bits}: ${word}`)
  return Number(signed)
}

export function decodeLaunchedToken(returnData: Hex): LaunchedToken {
  const hex = assertHex(returnData, 'getLaunchedToken result')
  const body = hex.slice(2)
  if (body.length !== LAUNCHED_TOKEN_WORDS * 64) {
    throw new DecodeError(
      `getLaunchedToken expects ${LAUNCHED_TOKEN_WORDS} words, got ${body.length / 64}`,
    )
  }
  const word = (index: number): Hex => `0x${body.slice(index * 64, index * 64 + 64)}` as Hex

  return {
    token: topicToAddress(word(0)),
    curve: topicToAddress(word(1)),
    deployer: topicToAddress(word(2)),
    creatorFeeRecipient: topicToAddress(word(3)),
    pairToken: topicToAddress(word(4)),
    graduationThreshold: hexToBigInt(word(5)),
    poolFee: boundedUint(word(6), 24, 'getLaunchedToken.poolFee'),
    tickSpacing: boundedInt(word(7), 24, 'getLaunchedToken.tickSpacing'),
    creatorTaxBps: boundedUint(word(8), 16, 'getLaunchedToken.creatorTaxBps'),
    buybackEnabled: decodeWord('bool', word(9), 'getLaunchedToken.buybackEnabled') === true,
    phase: boundedUint(word(10), 8, 'getLaunchedToken.phase'),
    sweptQuote: hexToBigInt(word(11)),
    sweptTokens: hexToBigInt(word(12)),
    sweptAt: hexToBigInt(word(13)),
    exists: decodeWord('bool', word(14), 'getLaunchedToken.exists') === true,
  }
}

// ---------------------------------------------------------------------------
// Derived identifiers
// ---------------------------------------------------------------------------

export interface PoolKeyInput {
  readonly token: string
  readonly pairToken: string
  /** uint24 */
  readonly fee: number
  /** int24 */
  readonly tickSpacing: number
  readonly hooks: string
}

/**
 * Uniswap v4 PoolId: keccak256(abi.encode(PoolKey)), with the two currencies
 * ordered numerically. This is a CANDIDATE only. It becomes the binding's
 * poolId once a PoolRegistered log under this id names our token as memecoin;
 * until then no PoolFeesSwept is attributed to it.
 */
export function derivePoolId(input: PoolKeyInput): Hex {
  const token = normalizeAddress(input.token)
  const pair = normalizeAddress(input.pairToken)
  const [currency0, currency1] = hexToBigInt(token as Hex) < hexToBigInt(pair as Hex) ? [token, pair] : [pair, token]
  if (!Number.isInteger(input.fee) || input.fee < 0 || input.fee >= 1 << 24) {
    throw new DecodeError(`pool fee ${input.fee} is not a uint24`)
  }
  if (!Number.isInteger(input.tickSpacing) || input.tickSpacing >= 1 << 23 || input.tickSpacing < -(1 << 23)) {
    throw new DecodeError(`tick spacing ${input.tickSpacing} is not an int24`)
  }
  const tick = input.tickSpacing < 0 ? (1n << 256n) + BigInt(input.tickSpacing) : BigInt(input.tickSpacing)
  const words = [
    addressToTopic(currency0),
    addressToTopic(currency1),
    padLeft32(`0x${input.fee.toString(16)}`),
    padLeft32(`0x${tick.toString(16)}`),
    addressToTopic(input.hooks),
  ]
  return keccak256Hex(hexToBytes(`0x${words.map((w) => w.slice(2)).join('')}`))
}
