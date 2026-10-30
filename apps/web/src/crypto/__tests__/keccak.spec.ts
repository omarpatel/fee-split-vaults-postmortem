import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { bytesToHex, utf8ToBytes } from '../hex.js'
import { _sponge256, keccak256 } from '../keccak.js'

/**
 * A hand-written hash needs an independent check or it is a guess. The
 * permutation, the absorb loop and the multi-block path are validated by
 * driving the same sponge with the SHA3-256 pad byte and comparing against
 * Node's own SHA3-256 across every input length from 0 through several blocks.
 */

describe('keccak-256', () => {
  it('matches the published vectors', () => {
    expect(bytesToHex(keccak256(new Uint8Array()))).toBe(
      '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    )
    expect(bytesToHex(keccak256(utf8ToBytes('abc')))).toBe(
      '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
    )
    expect(bytesToHex(keccak256(utf8ToBytes('testing')))).toBe(
      '0x5f16f4c7f149ac4f9510d9cf8cf384038ad348b3bcdc01915f95de12df9d1b02',
    )
  })

  it('agrees with an independent SHA3-256 at every length across the block boundary', () => {
    for (let length = 0; length <= 300; length++) {
      const input = new Uint8Array(length)
      for (let i = 0; i < length; i++) input[i] = (i * 37 + 11) & 0xff

      const ours = bytesToHex(_sponge256(input, 0x06))
      const theirs = `0x${createHash('sha3-256').update(input).digest('hex')}`
      expect(ours, `length ${length}`).toBe(theirs)
    }
  })

  it('handles the rate-1 case where the pad byte and the terminator share a byte', () => {
    const input = new Uint8Array(135).fill(0xab)
    expect(bytesToHex(_sponge256(input, 0x06))).toBe(
      `0x${createHash('sha3-256').update(input).digest('hex')}`,
    )
  })

  it('handles an input that is exactly one block', () => {
    const input = new Uint8Array(136).fill(0x5c)
    expect(bytesToHex(_sponge256(input, 0x06))).toBe(
      `0x${createHash('sha3-256').update(input).digest('hex')}`,
    )
  })

  it('does not mutate its input', () => {
    const input = utf8ToBytes('leave me alone')
    const copy = Uint8Array.from(input)
    keccak256(input)
    expect(input).toEqual(copy)
  })
})
