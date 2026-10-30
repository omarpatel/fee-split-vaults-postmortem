/**
 * The curve math, checked against values nobody in this repository chose.
 *
 * A round-trip test (sign, then recover, then compare to what I signed with)
 * proves my signer and my recoverer agree with each other and nothing else.
 * The PUBLISHED private-key-to-address vectors are the independent check: if
 * point multiplication, the public-key encoding, keccak, or the last-20-bytes
 * rule were wrong, these would not come out.
 */
import { describe, expect, it } from 'vitest'
import {
  G,
  bigIntTo32Bytes,
  isOnCurve,
  parseSignature,
  publicKeyFromPrivate,
  recoverPublicKey,
  signRecoverable,
} from '../crypto/secp256k1.js'
import { addressFromPublicKey, bytesToHex, hexToBytes, keccakHex, utf8 } from '../crypto/address.js'

/** Widely published secp256k1 private-key-to-Ethereum-address pairs. */
const VECTORS: ReadonlyArray<[bigint, string]> = [
  [1n, '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'],
  [2n, '0x2b5ad5c4795c026514f8317c7a215e218dccd6cf'],
  [3n, '0x6813eb9362372eef6200f3b1dbc3f819671cba69'],
]

describe('secp256k1 point arithmetic', () => {
  it('derives the published addresses from the published private keys', () => {
    for (const [key, address] of VECTORS) {
      expect(addressFromPublicKey(publicKeyFromPrivate(key))).toBe(address)
    }
  })

  it('keeps every derived point on the curve', () => {
    for (const [key] of VECTORS) {
      expect(isOnCurve(publicKeyFromPrivate(key))).toBe(true)
    }
    expect(isOnCurve(G)).toBe(true)
  })

  it('keccak256 of the empty input matches the published digest', () => {
    expect(keccakHex(new Uint8Array(0))).toBe(
      '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    )
  })

  it('keccak256("abc") matches the published digest', () => {
    expect(keccakHex(utf8('abc'))).toBe(
      '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
    )
  })
})

describe('signature recovery', () => {
  const digest = hexToBytes(keccakHex(utf8('a consent digest stand-in')))

  it('recovers the signer of a signature it produced', () => {
    for (const [key, address] of VECTORS) {
      const sig = signRecoverable(digest, key, 0x9f8e7d6c5b4a39281726354453627180n)
      expect(addressFromPublicKey(recoverPublicKey(digest, sig))).toBe(address)
    }
  })

  it('recovers a DIFFERENT signer for a different digest', () => {
    const other = hexToBytes(keccakHex(utf8('a different consent')))
    const [entry] = VECTORS
    if (entry === undefined) throw new Error('fixture')
    const sig = signRecoverable(digest, entry[0], 0x11223344556677889900aabbccddeeffn)
    expect(addressFromPublicKey(recoverPublicKey(other, sig))).not.toBe(entry[1])
  })

  it('refuses a high-s signature rather than normalising it', () => {
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
    const [entry] = VECTORS
    if (entry === undefined) throw new Error('fixture')
    const low = signRecoverable(digest, entry[0], 0x2468ace02468ace02468ace02468ace0n)
    const high = new Uint8Array(65)
    high.set(bigIntTo32Bytes(low.r), 0)
    high.set(bigIntTo32Bytes(N - low.s), 32)
    high[64] = 27 + (low.recovery ^ 1)
    expect(() => parseSignature(high)).toThrow(/high-s/)
  })

  it('refuses a signature of the wrong length, a zero r, and a bad recovery id', () => {
    expect(() => parseSignature(new Uint8Array(64))).toThrow(/65 bytes/)
    const zeroR = new Uint8Array(65)
    zeroR[64] = 27
    expect(() => parseSignature(zeroR)).toThrow(/r out of range/)
    const badV = new Uint8Array(65).fill(1)
    badV[64] = 9
    expect(() => parseSignature(badV)).toThrow(/recovery id/)
  })
})

describe('hex helpers', () => {
  it('round-trips', () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 255])
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes)
  })

  it('refuses an odd-length or non-hex string', () => {
    expect(() => hexToBytes('0xabc')).toThrow(/odd-length/)
    expect(() => hexToBytes('0xzz')).toThrow(/non-hex/)
  })
})
