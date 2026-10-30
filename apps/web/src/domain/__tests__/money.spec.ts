import { describe, expect, it } from 'vitest'

import {
  applyBps,
  formatBps,
  formatUnits,
  formatUsd,
  formatUsdCompact,
  MoneyError,
  parseUnits,
  usdToCents,
} from '../money.js'

describe('usdToCents', () => {
  it('converts at the boundary and only at the boundary', () => {
    expect(usdToCents(0)).toBe(0n)
    expect(usdToCents(1)).toBe(100n)
    expect(usdToCents(299)).toBe(29_900n)
    expect(usdToCents(1_234.56)).toBe(123_456n)
  })

  it('survives the binary-floating-point cases that break naive rounding', () => {
    expect(usdToCents(0.1 + 0.2)).toBe(30n)
    expect(usdToCents(1.005)).toBe(usdToCents(Number((1.005).toFixed(10))))
    expect(usdToCents(8.615)).toBe(BigInt((8.615).toFixed(2).replace('.', '')))
  })

  it('handles negatives symmetrically', () => {
    expect(usdToCents(-12.34)).toBe(-1_234n)
    expect(usdToCents(-0.01)).toBe(-1n)
  })

  it('refuses a non-finite amount rather than producing a plausible zero', () => {
    expect(() => usdToCents(Number.NaN)).toThrow(MoneyError)
    expect(() => usdToCents(Number.POSITIVE_INFINITY)).toThrow(MoneyError)
  })
})

describe('minor-unit parsing and formatting', () => {
  it('round-trips through 18 decimals without a float anywhere', () => {
    const wei = parseUnits('1.234567890123456789', 18)
    expect(wei).toBe(1_234_567_890_123_456_789n)
    expect(formatUnits(wei, 18)).toBe('1.234567890123456789')
  })

  it('handles six-decimal stablecoin amounts', () => {
    expect(parseUnits('1250.5', 6)).toBe(1_250_500_000n)
    expect(formatUnits(1_250_500_000n, 6)).toBe('1,250.5')
  })

  it('refuses more precision than the asset has, instead of truncating silently', () => {
    expect(() => parseUnits('1.1234567', 6)).toThrow(MoneyError)
  })

  it('refuses anything that is not a decimal amount', () => {
    for (const bad of ['', '.', '-', 'abc', '1.2.3', '0x10']) {
      expect(() => parseUnits(bad, 18)).toThrow(MoneyError)
    }
  })

  it('groups thousands and trims trailing zeros', () => {
    expect(formatUnits(1_000_000_000_000_000_000n, 18)).toBe('1')
    expect(formatUnits(1_234_567_000_000_000_000_000n, 18, 4)).toBe('1,234.567')
  })

  it('formats negatives with the sign outside the grouping', () => {
    expect(formatUnits(-1_500_000n, 6)).toBe('-1.5')
  })
})

describe('USD formatting', () => {
  it('always shows two decimals', () => {
    expect(formatUsd(0n)).toBe('$0.00')
    expect(formatUsd(5n)).toBe('$0.05')
    expect(formatUsd(29_900n)).toBe('$299.00')
    expect(formatUsd(123_456_789n)).toBe('$1,234,567.89')
  })

  it('formats negatives with the sign before the currency symbol', () => {
    expect(formatUsd(-1_234n)).toBe('-$12.34')
  })

  it('compacts large figures without inventing precision', () => {
    expect(formatUsdCompact(45_000n)).toBe('$450.00')
    expect(formatUsdCompact(1_240_000n)).toBe('$12.4k')
    expect(formatUsdCompact(500_000_000n)).toBe('$5M')
    expect(formatUsdCompact(220_500_00n)).toBe('$220.5k')
  })
})

describe('bps arithmetic', () => {
  it('floors, exactly as Solidity does', () => {
    expect(applyBps(9_999n, 1_000)).toBe(999n)
    expect(applyBps(1n, 1_000)).toBe(0n)
    expect(applyBps(10_000n, 10_000)).toBe(10_000n)
  })

  it('refuses a fractional or negative bps', () => {
    expect(() => applyBps(100n, 10.5)).toThrow(MoneyError)
    expect(() => applyBps(100n, -1)).toThrow(MoneyError)
  })

  it('renders the rates this product actually quotes', () => {
    expect(formatBps(1_000)).toBe('10%')
    expect(formatBps(2_000)).toBe('20%')
    expect(formatBps(100)).toBe('1%')
    expect(formatBps(70)).toBe('0.7%')
    expect(formatBps(35)).toBe('0.35%')
    expect(formatBps(0)).toBe('0%')
    expect(formatBps(71.5)).toBe('0.715%')
  })
})
