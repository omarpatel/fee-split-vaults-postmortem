/**
 * Hex and byte helpers for the browser. Deliberately dependency-free and
 * deliberately not shared with packages/indexer: that package is a Node service
 * and pulling it into a browser bundle would drag an RPC client along with it.
 */

export type Hex = `0x${string}`

const HEX_ALPHABET = '0123456789abcdef'

export function isHex(value: string, byteLength?: number): value is Hex {
  if (!/^0x[0-9a-fA-F]*$/.test(value)) return false
  if ((value.length - 2) % 2 !== 0) return false
  if (byteLength !== undefined && value.length - 2 !== byteLength * 2) return false
  return true
}

export function hexToBytes(value: string): Uint8Array {
  if (!isHex(value)) throw new Error(`not a hex string: ${value}`)
  const body = value.slice(2)
  const out = new Uint8Array(body.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function bytesToHex(bytes: Uint8Array): Hex {
  let out = '0x'
  for (const byte of bytes) {
    out += HEX_ALPHABET[byte >> 4]
    out += HEX_ALPHABET[byte & 0x0f]
  }
  return out as Hex
}

export function utf8ToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Lowercase, 0x-prefixed, length-checked. Fails closed on anything else. */
export function normalizeAddress(value: string): Hex {
  const trimmed = value.trim()
  if (!isHex(trimmed, 20)) throw new Error(`not a 20-byte address: ${value}`)
  return trimmed.toLowerCase() as Hex
}

/** Display form: 0x1234…cdef. Never used for comparison. */
export function shortenAddress(value: string, lead = 6, tail = 4): string {
  if (value.length <= lead + tail + 2) return value
  return `${value.slice(0, 2 + lead)}…${value.slice(-tail)}`
}
