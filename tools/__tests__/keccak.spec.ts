import { describe, expect, it } from 'vitest'
import { keccak256Utf8, toChecksumAddress } from '../lib/keccak.ts'

/**
 * Known-answer vectors. This file is the only thing standing between a subtle
 * permutation bug in the vendored Keccak and every topic filter in the repo
 * silently matching nothing - which would read as "no fees on this chain".
 */
describe('keccak256', () => {
  it('matches the standard empty-input vector', () => {
    expect(keccak256Utf8('')).toBe(
      '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    )
  })

  it('matches the "abc" vector', () => {
    expect(keccak256Utf8('abc')).toBe(
      '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
    )
  })

  it('reproduces the ERC-20 Transfer topic', () => {
    expect(keccak256Utf8('Transfer(address,address,uint256)')).toBe(
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    )
  })

  it('reproduces the ERC-20 Approval topic', () => {
    expect(keccak256Utf8('Approval(address,address,uint256)')).toBe(
      '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
    )
  })

  it('handles inputs that straddle the 136-byte rate boundary', () => {
    // Absorbing more than one block is where a padding bug shows up.
    const long = 'a'.repeat(200)
    expect(keccak256Utf8(long)).toMatch(/^0x[0-9a-f]{64}$/)
    expect(keccak256Utf8('a'.repeat(135))).not.toBe(keccak256Utf8('a'.repeat(136)))
  })
})

describe('toChecksumAddress', () => {
  it('reproduces the checksum form of the fee escrow from the protocol config', () => {
    expect(toChecksumAddress('0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e')).toBe(
      '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e',
    )
  })

  it('reproduces the checksum form of the meme hook', () => {
    expect(toChecksumAddress('0xe5e702641ea86f4ae6cc3cdaed2b886f976be044')).toBe(
      '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044',
    )
  })

  it('rejects a non-address', () => {
    expect(() => toChecksumAddress('0x1234')).toThrow(/not an address/)
  })
})
