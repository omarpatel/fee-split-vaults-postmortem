import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { bytesToHex, utf8ToBytes } from '../hex.js'
import { _sponge256, keccak256Hex } from '../keccak.js'

describe('keccak256', () => {
  it('matches published Keccak-256 vectors', () => {
    expect(keccak256Hex('')).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
    expect(keccak256Hex('abc')).toBe('0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45')
    expect(keccak256Hex('The quick brown fox jumps over the lazy dog')).toBe(
      '0x4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15',
    )
  })

  it('matches the canonical ERC-20 Transfer topic0', () => {
    expect(keccak256Hex('Transfer(address,address,uint256)')).toBe(
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    )
  })

  /**
   * The permutation, the absorb loop and every padding edge case (including the
   * rate-1 case where the pad byte and the 0x80 terminator share a byte) are
   * validated against Node's own SHA3-256 by running the identical sponge with
   * FIPS 202 padding. Keccak-256 differs from SHA3-256 ONLY in that pad byte.
   */
  it('agrees with Node SHA3-256 across every length up to four blocks', () => {
    for (let length = 0; length <= 560; length++) {
      const input = new Uint8Array(length)
      for (let i = 0; i < length; i++) input[i] = (i * 37 + 11) & 0xff

      const ours = bytesToHex(_sponge256(input, 0x06))
      const theirs = `0x${createHash('sha3-256').update(input).digest('hex')}`
      expect(ours, `length ${length}`).toBe(theirs)
    }
  })

  it('is not SHA3-256 (the pad byte is the whole difference)', () => {
    const input = utf8ToBytes('venue')
    const sha3 = `0x${createHash('sha3-256').update(input).digest('hex')}`
    expect(keccak256Hex(input)).not.toBe(sha3)
  })
})
