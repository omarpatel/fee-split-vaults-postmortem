/**
 * Hex and address primitives.
 *
 * Addresses are normalised to lowercase everywhere inside this package and
 * compared with addressEquals(). Checksum casing is a display concern; an
 * attribution bug caused by comparing '0xAb..' to '0xab..' would silently pay
 * one coin's fees to another coin's ledger.
 */

import { DecodeError } from './errors.js'

export type Hex = `0x${string}`

const HEX_BODY = /^[0-9a-fA-F]*$/

export function isHex(value: unknown): value is Hex {
  return typeof value === 'string' && value.startsWith('0x') && HEX_BODY.test(value.slice(2))
}

export function assertHex(value: unknown, field: string): Hex {
  if (!isHex(value)) throw new DecodeError(`${field} is not hex: ${String(value)}`)
  return value
}

export function hexToBytes(hex: Hex): Uint8Array {
  const body = hex.slice(2)
  if (body.length % 2 !== 0) throw new DecodeError(`odd-length hex: ${hex}`)
  const out = new Uint8Array(body.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new DecodeError(`invalid hex byte in ${hex}`)
    out[i] = byte
  }
  return out
}

export function bytesToHex(bytes: Uint8Array): Hex {
  let out = '0x'
  for (const byte of bytes) {
    out += (byte >> 4).toString(16) + (byte & 0x0f).toString(16)
  }
  return out as Hex
}

export function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export function hexToBigInt(hex: Hex): bigint {
  const body = hex.slice(2)
  return body.length === 0 ? 0n : BigInt(hex)
}

/** Minimal-width hex, the shape JSON-RPC quantity parameters require. */
export function bigIntToHex(value: bigint): Hex {
  if (value < 0n) throw new DecodeError(`negative quantity: ${value}`)
  return `0x${value.toString(16)}`
}

export function padLeft32(hex: Hex): Hex {
  const body = hex.slice(2)
  if (body.length > 64) throw new DecodeError(`value wider than 32 bytes: ${hex}`)
  return `0x${body.padStart(64, '0')}`
}

/** Lowercased, length-checked 20-byte address. Throws rather than coercing. */
export function normalizeAddress(value: string): string {
  const lower = value.toLowerCase()
  if (!lower.startsWith('0x') || lower.length !== 42 || !HEX_BODY.test(lower.slice(2))) {
    throw new DecodeError(`not a 20-byte address: ${value}`)
  }
  return lower
}

export function addressEquals(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** Lowercased, length-checked 32-byte value (block hashes, pool ids, topics). */
export function normalizeHash32(value: string): Hex {
  const lower = value.toLowerCase()
  if (!lower.startsWith('0x') || lower.length !== 66 || !HEX_BODY.test(lower.slice(2))) {
    throw new DecodeError(`not a 32-byte value: ${value}`)
  }
  return lower as Hex
}

/** An address as it appears in an indexed topic slot: left-padded to 32 bytes. */
export function addressToTopic(address: string): Hex {
  return `0x${'0'.repeat(24)}${normalizeAddress(address).slice(2)}` as Hex
}

export function topicToAddress(topic: Hex): string {
  const padded = normalizeHash32(topic)
  const body = padded.slice(2)
  if (body.slice(0, 24) !== '0'.repeat(24)) {
    throw new DecodeError(`topic ${topic} has dirty high bytes and is not an address`)
  }
  return `0x${body.slice(24)}`
}
