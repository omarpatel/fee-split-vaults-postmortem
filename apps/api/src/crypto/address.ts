/**
 * Addresses, hex, and the one hash function the whole control plane uses.
 *
 * keccak256 is imported from @fee-split-vaults/indexer rather than reimplemented:
 * that copy is validated against published vectors plus 561 cross-checks
 * against Node's own SHA3-256 driving the identical sponge, and two
 * implementations of keccak in one repository is two chances to be wrong.
 */

import { keccak256 } from '@fee-split-vaults/indexer'
import type { Address } from '@fee-split-vaults/core'
import { publicKeyBytes, type Point } from './secp256k1.js'

export class HexError extends Error {
  constructor(message: string) {
    super(`hex: ${message}`)
    this.name = 'HexError'
  }
}

export function hexToBytes(hex: string): Uint8Array {
  const raw = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex
  if (raw.length % 2 !== 0) throw new HexError('odd-length hex string')
  if (!/^[0-9a-fA-F]*$/.test(raw)) throw new HexError('non-hex character')
  const out = new Uint8Array(raw.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(raw.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '0x'
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

export function keccakHex(bytes: Uint8Array): string {
  return bytesToHex(keccak256(bytes))
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

/** Last 20 bytes of keccak(pubkey.x || pubkey.y). Lowercase, never checksummed. */
export function addressFromPublicKey(point: Point): Address {
  const hash = keccak256(publicKeyBytes(point))
  return bytesToHex(hash.subarray(12))
}

/** Structural check only. It does NOT prove the address exists or is a contract. */
export function isAddress(value: unknown): value is Address {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
}

export function normalizeAddress(value: string): Address {
  if (!isAddress(value)) throw new HexError(`not an address: ${value}`)
  return value.toLowerCase()
}

export function isBytes32(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
}

export function addressesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

// ---------------------------------------------------------------------------
// ABI encoding, only the static-word cases the consent struct needs
// ---------------------------------------------------------------------------

export function encodeUint(value: bigint | number): Uint8Array {
  const v = typeof value === 'number' ? BigInt(value) : value
  if (v < 0n) throw new HexError('negative uint')
  const out = new Uint8Array(32)
  let rest = v
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  if (rest !== 0n) throw new HexError('uint exceeds 32 bytes')
  return out
}

export function encodeAddress(value: string): Uint8Array {
  const bytes = hexToBytes(normalizeAddress(value))
  const out = new Uint8Array(32)
  out.set(bytes, 12)
  return out
}

export function encodeBytes32(value: string): Uint8Array {
  if (!isBytes32(value)) throw new HexError(`not a bytes32: ${value}`)
  return hexToBytes(value)
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
