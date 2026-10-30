/**
 * Minimal ABI encode/decode for the static types these probes actually read.
 *
 * Deliberately narrow. Dynamic types (string, bytes, arrays, tuples) are NOT
 * decoded: every event and getter in scope here is a flat list of static words,
 * and silently mis-decoding a dynamic head as a value would corrupt a money
 * figure. Anything unsupported throws.
 */

import { bytesToHex, hexToBytes, keccak256Utf8 } from './keccak.ts'

export type AbiType =
  | 'address'
  | 'bool'
  | 'bytes32'
  | `uint${number}`
  | `int${number}`
  | 'uint'
  | 'int'

export interface AbiParam {
  type: string
  name?: string
  indexed: boolean
}

export interface EventSpec {
  /** Event name as written. */
  name: string
  inputs: AbiParam[]
  /** Canonical `Name(type,type)` form, which is what gets hashed. */
  canonical: string
  /** keccak(canonical). topics[0] for a non-anonymous event. */
  topic0: string
}

const STATIC_WORD_TYPES =
  /^(address|bool|bytes32|bytes([1-9]|[12][0-9]|3[0-2])|uint(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?|int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?)$/

function normalizeType(raw: string): string {
  // Solidity canonical form expands the `uint`/`int` aliases.
  if (raw === 'uint') return 'uint256'
  if (raw === 'int') return 'int256'
  return raw
}

/**
 * Parse a human-readable event signature. Both forms are accepted:
 *
 *   PoolFeesSwept(bytes32,uint256,uint256,uint256,uint256)
 *   PoolFeesSwept(bytes32 indexed poolId, uint256 protocol, uint256 buybackSpent, ...)
 *
 * The second form is what the CLIs take, because indexed-ness changes where a
 * value is read from and getting it wrong silently shifts every field.
 */
export function parseEventSignature(signature: string): EventSpec {
  const match = /^\s*(?:event\s+)?([A-Za-z_$][\w$]*)\s*\((.*)\)\s*$/s.exec(signature)
  if (!match) throw new Error(`not an event signature: ${signature}`)
  const name = match[1]!
  const body = match[2]!.trim()

  const inputs: AbiParam[] = []
  if (body.length > 0) {
    for (const rawPart of body.split(',')) {
      const part = rawPart.trim()
      if (part.length === 0) throw new Error(`empty parameter in: ${signature}`)
      const tokens = part.split(/\s+/)
      const type = normalizeType(tokens[0]!)
      if (!STATIC_WORD_TYPES.test(type)) {
        throw new Error(
          `unsupported ABI type "${type}" in ${signature}; this decoder handles static word types only`,
        )
      }
      const rest = tokens.slice(1)
      const indexed = rest.includes('indexed')
      const named = rest.filter((t) => t !== 'indexed' && t !== 'memory' && t !== 'calldata')
      inputs.push({ type, indexed, ...(named[0] !== undefined ? { name: named[0] } : {}) })
    }
  }

  const indexedCount = inputs.filter((i) => i.indexed).length
  if (indexedCount > 3) {
    throw new Error(`${name} declares ${indexedCount} indexed params; EVM allows at most 3`)
  }

  const canonical = `${name}(${inputs.map((i) => i.type).join(',')})`
  return { name, inputs, canonical, topic0: keccak256Utf8(canonical) }
}

/** topics[0] for a non-anonymous event, from either signature form. */
export function eventTopic(signature: string): string {
  return parseEventSignature(signature).topic0
}

/** 4-byte selector for a function signature, e.g. `feeBps()`. */
export function functionSelector(signature: string): string {
  const match = /^\s*(?:function\s+)?([A-Za-z_$][\w$]*)\s*\((.*?)\)/s.exec(signature)
  if (!match) throw new Error(`not a function signature: ${signature}`)
  const args = match[2]!
    .split(',')
    .map((s) => s.trim().split(/\s+/)[0] ?? '')
    .filter((s) => s.length > 0)
    .map(normalizeType)
  return keccak256Utf8(`${match[1]!}(${args.join(',')})`).slice(0, 10)
}

export type AbiValue = bigint | boolean | string

function wordAt(data: Uint8Array, index: number): Uint8Array {
  const start = index * 32
  if (start + 32 > data.length) {
    throw new Error(`ABI data too short: need word ${index}, have ${data.length} bytes`)
  }
  return data.subarray(start, start + 32)
}

function wordToBigUint(word: Uint8Array): bigint {
  let out = 0n
  for (const b of word) out = (out << 8n) | BigInt(b)
  return out
}

function decodeWord(type: string, word: Uint8Array): AbiValue {
  if (type === 'address') {
    // Upper 12 bytes must be zero; a non-zero pad means we are mis-aligned.
    for (let i = 0; i < 12; i++) {
      if (word[i] !== 0) throw new Error('address word has dirty high bytes; decode is misaligned')
    }
    return bytesToHex(word.subarray(12)).toLowerCase()
  }
  if (type === 'bool') {
    const v = wordToBigUint(word)
    if (v > 1n) throw new Error('bool word is neither 0 nor 1; decode is misaligned')
    return v === 1n
  }
  if (type.startsWith('bytes')) return bytesToHex(word)
  if (type.startsWith('uint')) return wordToBigUint(word)
  if (type.startsWith('int')) {
    const bits = BigInt(Number.parseInt(type.slice(3) || '256', 10))
    const raw = wordToBigUint(word)
    const limit = 1n << (bits - 1n)
    return raw >= limit ? raw - (1n << bits) : raw
  }
  throw new Error(`unsupported ABI type: ${type}`)
}

/** Decode a flat list of static return words. */
export function decodeStaticReturn(types: readonly string[], returnData: string): AbiValue[] {
  const data = hexToBytes(returnData)
  return types.map((type, i) => decodeWord(normalizeType(type), wordAt(data, i)))
}

export interface DecodedEvent {
  /** Positional values in declaration order. */
  values: AbiValue[]
  /** Values by parameter name, for the named signature form. */
  byName: Record<string, AbiValue>
}

/**
 * Decode a log against a parsed event spec. FAILS CLOSED: a topic count or data
 * length that does not match the spec throws rather than returning partial data,
 * because a partially decoded fee event is a wrong number, not a missing one.
 */
export function decodeEventLog(
  spec: EventSpec,
  topics: readonly string[],
  data: string,
): DecodedEvent {
  const indexed = spec.inputs.filter((i) => i.indexed)
  if (topics.length !== indexed.length + 1) {
    throw new Error(
      `${spec.name}: expected ${indexed.length + 1} topics for this signature, log has ${topics.length}`,
    )
  }
  if ((topics[0] ?? '').toLowerCase() !== spec.topic0) {
    throw new Error(`${spec.name}: topic0 mismatch (log ${topics[0]}, spec ${spec.topic0})`)
  }

  const body = hexToBytes(data)
  const nonIndexedCount = spec.inputs.length - indexed.length
  if (body.length !== nonIndexedCount * 32) {
    throw new Error(
      `${spec.name}: expected ${nonIndexedCount * 32} data bytes, log has ${body.length}`,
    )
  }

  const values: AbiValue[] = []
  const byName: Record<string, AbiValue> = {}
  let topicCursor = 1
  let dataCursor = 0
  for (const input of spec.inputs) {
    const word = input.indexed
      ? hexToBytes(topics[topicCursor++] ?? '0x')
      : wordAt(body, dataCursor++)
    if (word.length !== 32) throw new Error(`${spec.name}: topic is not 32 bytes`)
    const value = decodeWord(input.type, word)
    values.push(value)
    if (input.name !== undefined) byName[input.name] = value
  }
  return { values, byName }
}

/** Left-pad an address to a 32-byte topic, for topic filtering. */
export function addressTopic(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{40}$/.test(clean)) throw new Error(`not an address: ${address}`)
  return `0x${'0'.repeat(24)}${clean}`
}

export function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value)
}

export function normalizeAddress(value: string): string {
  if (!isAddress(value)) throw new Error(`not an address: ${value}`)
  return value.toLowerCase()
}

/** ABI-encode a call with only static address/uint arguments. */
export function encodeCall(signature: string, args: readonly AbiValue[] = []): string {
  const selector = functionSelector(signature)
  let out = selector
  for (const arg of args) {
    if (typeof arg === 'bigint') {
      if (arg < 0n) throw new Error('negative arguments are not supported by this encoder')
      out += arg.toString(16).padStart(64, '0')
    } else if (typeof arg === 'boolean') {
      out += (arg ? 1n : 0n).toString(16).padStart(64, '0')
    } else if (isAddress(arg)) {
      out += arg.toLowerCase().replace(/^0x/, '').padStart(64, '0')
    } else if (/^0x[0-9a-fA-F]{64}$/.test(arg)) {
      out += arg.slice(2).toLowerCase()
    } else {
      throw new Error(`cannot encode argument: ${String(arg)}`)
    }
  }
  return out
}
