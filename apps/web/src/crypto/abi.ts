/**
 * The narrow slice of ABI encoding this app needs: static 32-byte words, and
 * the packed concatenation CREATE2 uses.
 *
 * Only static types appear here on purpose. Every struct this app hashes
 * (`Consent`, `EIP712Domain`) is made entirely of value types, so the head/tail
 * machinery of dynamic ABI encoding is not needed and its absence removes a
 * whole class of encoding bug from a security-relevant path.
 */

import { concatBytes, hexToBytes, isHex } from './hex.js'

const WORD = 32

export class AbiEncodingError extends Error {
  constructor(message: string) {
    super(`abi: ${message}`)
    this.name = 'AbiEncodingError'
  }
}

/** Left-pad a big-endian unsigned integer into one 32-byte word. */
export function wordFromUint(value: bigint, bits: number): Uint8Array {
  if (bits <= 0 || bits > 256 || bits % 8 !== 0) {
    throw new AbiEncodingError(`unsupported uint width ${bits}`)
  }
  if (value < 0n) throw new AbiEncodingError('uint cannot be negative')
  if (value >= 1n << BigInt(bits)) throw new AbiEncodingError(`value overflows uint${bits}`)

  const out = new Uint8Array(WORD)
  let rest = value
  for (let i = WORD - 1; i >= 0 && rest > 0n; i--) {
    out[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return out
}

/** Left-pad a 20-byte address into one 32-byte word. */
export function wordFromAddress(value: string): Uint8Array {
  if (!isHex(value, 20)) throw new AbiEncodingError(`not a 20-byte address: ${value}`)
  const out = new Uint8Array(WORD)
  out.set(hexToBytes(value), WORD - 20)
  return out
}

/** A bytes32 occupies exactly one word, unpadded. */
export function wordFromBytes32(value: string): Uint8Array {
  if (!isHex(value, 32)) throw new AbiEncodingError(`not a 32-byte value: ${value}`)
  return hexToBytes(value)
}

/** `abi.encode(...)` for an all-static argument list. */
export function encodeStaticWords(words: Uint8Array[]): Uint8Array {
  for (const word of words) {
    if (word.length !== WORD) throw new AbiEncodingError('encodeStaticWords takes 32-byte words')
  }
  return concatBytes(...words)
}
