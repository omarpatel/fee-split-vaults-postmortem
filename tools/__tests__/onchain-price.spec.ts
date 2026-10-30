/**
 * Tests for the optional on-chain price source.
 *
 * The numbers pinned here are REAL: they are the values chain 4663 returned for
 * the WETH/USDG 100bps pool 0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca on
 * 2026-09-07, cross-checked against Kraken, Coinbase, Bitstamp and CoinGecko on
 * the same day. A regression that shifts the tick math by a decimal place has to
 * fail against a figure that was independently known to be right.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TWAP_SECONDS,
  OnchainPriceError,
  applyOnchainPrice,
  decodeTickCumulatives,
  encodeObserve,
  loadOnchainPriceConfig,
  meanTickFromCumulatives,
  priceFromTick,
  readOnchainTwapPrice,
} from '../lib/onchain-price.ts'
import { NATIVE_ASSET_ADDRESS, PriceBook } from '../lib/prices.ts'
import type { ChainReader } from '../lib/rpc.ts'

const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const POOL = '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca'

/** The two tickCumulatives the live pool returned for observe([1800, 0]). */
const LIVE_TC0 = -1158795543049n
const LIVE_TC1 = -1159152156465n

const word = (v: bigint | number): string => {
  const n = BigInt(v)
  const twos = n < 0n ? (1n << 256n) + n : n
  return twos.toString(16).padStart(64, '0')
}

/** Build an `observe()` return: (int56[] tickCumulatives, uint160[] spl). */
function encodeObserveReturn(ticks: bigint[], spl: bigint[] = [0n, 0n]): string {
  const head = `${word(64)}${word(64 + 32 + ticks.length * 32)}`
  const arr0 = `${word(ticks.length)}${ticks.map(word).join('')}`
  const arr1 = `${word(spl.length)}${spl.map(word).join('')}`
  return `0x${head}${arr0}${arr1}`
}

function readerFor(overrides: Partial<Record<string, string | Error>> = {}): ChainReader {
  const token0 = `0x${word(BigInt(WETH))}`
  const token1 = `0x${word(BigInt(USDG))}`
  return {
    chainId: async () => 4663,
    blockNumber: async () => 1n,
    getBlockHeader: async () => ({ number: 1n, timestampUnix: 0, hash: '0x' }) as never,
    getLogs: async () => [],
    call: async (_to: string, data: string) => {
      const key = data.slice(0, 10)
      const override = overrides[key]
      if (override instanceof Error) throw override
      if (typeof override === 'string') return override
      if (key === '0x0dfe1681') return token0
      if (key === '0xd21220a7') return token1
      if (key === '0x883bdbfd') return encodeObserveReturn([LIVE_TC0, LIVE_TC1])
      throw new Error(`unexpected call ${key}`)
    },
  }
}

describe('encodeObserve', () => {
  it('encodes a two-element uint32[] the way the live pool accepted', () => {
    const encoded = encodeObserve([1800, 0])
    expect(encoded.slice(0, 10)).toBe('0x883bdbfd')
    expect(encoded).toBe(`0x883bdbfd${word(32)}${word(2)}${word(1800)}${word(0)}`)
  })

  it('refuses a value that does not fit a uint32, rather than truncating it', () => {
    expect(() => encodeObserve([2 ** 32])).toThrow(OnchainPriceError)
    expect(() => encodeObserve([-1])).toThrow(OnchainPriceError)
    expect(() => encodeObserve([])).toThrow(OnchainPriceError)
  })
})

describe('decodeTickCumulatives', () => {
  it('decodes the live pool return, including the negative two’s-complement values', () => {
    expect(decodeTickCumulatives(encodeObserveReturn([LIVE_TC0, LIVE_TC1]))).toEqual([
      LIVE_TC0,
      LIVE_TC1,
    ])
  })

  it('refuses empty data rather than reporting a zero price', () => {
    expect(() => decodeTickCumulatives('0x')).toThrow(/not a Uniswap-V3-shaped pool/)
  })

  it('refuses a length that runs past the end of the return data', () => {
    const lying = `0x${word(32)}${word(9)}${word(1n)}`
    expect(() => decodeTickCumulatives(lying)).toThrow(/holds only/)
  })

  it('refuses data that is not word-aligned', () => {
    expect(() => decodeTickCumulatives('0xdeadbeef')).toThrow(/word-aligned/)
  })
})

describe('meanTickFromCumulatives', () => {
  it('reproduces the live mean tick', () => {
    // (-1159152156465 - -1158795543049) / 1800 = -198118.564..., floored.
    expect(meanTickFromCumulatives(LIVE_TC1 - LIVE_TC0, 1800)).toBe(-198119)
  })

  it('FLOORS a negative delta instead of truncating it, matching OracleLibrary', () => {
    // -5/2 truncates to -2 but floors to -3. Every WETH/USDG tick is negative,
    // so a truncating implementation is wrong on essentially every reading.
    expect(meanTickFromCumulatives(-5n, 2)).toBe(-3)
    expect(meanTickFromCumulatives(-4n, 2)).toBe(-2)
    expect(meanTickFromCumulatives(5n, 2)).toBe(2)
  })

  it('refuses a non-positive window', () => {
    expect(() => meanTickFromCumulatives(-5n, 0)).toThrow(OnchainPriceError)
    expect(() => meanTickFromCumulatives(-5n, 1.5)).toThrow(OnchainPriceError)
  })
})

describe('priceFromTick', () => {
  it('prices the live WETH/USDG tick within a dollar of the off-chain venues', () => {
    // Kraken/Coinbase/Bitstamp/CoinGecko put ETH at $2,489-2,490 at this time.
    const price = priceFromTick(-198119, 18, 6, true)
    expect(price).toBeGreaterThan(2450)
    expect(price).toBeLessThan(2530)
  })

  it('APPLIES THE DECIMAL GAP: dropping it is the 10^12 USDG error', () => {
    const correct = priceFromTick(-198119, 18, 6, true)
    const ifDecimalsIgnored = priceFromTick(-198119, 6, 6, true)
    expect(correct / ifDecimalsIgnored).toBeCloseTo(1e12, -6)
    expect(ifDecimalsIgnored).toBeLessThan(1e-6)
  })

  it('inverts when the base is token1', () => {
    const asToken0 = priceFromTick(-198119, 18, 6, true)
    const asToken1 = priceFromTick(-198119, 18, 6, false)
    expect(asToken1).toBeCloseTo(1 / asToken0, 12)
  })
})

describe('readOnchainTwapPrice', () => {
  it('returns the live price with provenance and the standing caveats attached', async () => {
    const quote = await readOnchainTwapPrice(readerFor(), {
      pool: POOL,
      base: { address: WETH, symbol: 'WETH', decimals: 18 },
      quote: { address: USDG, symbol: 'USDG', decimals: 6, pegUsd: 1 },
      twapSeconds: 1800,
    })
    expect(quote.priceUsd).toBeGreaterThan(2450)
    expect(quote.priceUsd).toBeLessThan(2530)
    expect(quote.source).toContain('onchain-twap:v3:')
    expect(quote.source).toContain('WETH/USDG@peg1')
    expect(quote.meanTick).toBe(-198119)
    // The peg assumption and the WETH-is-not-ETH substitution must always be said.
    expect(quote.warnings.join(' ')).toMatch(/ASSUMED peg/)
    expect(quote.warnings.join(' ')).toMatch(/not the native asset/)
  })

  it('REFUSES a pool that holds a different pair', async () => {
    const wrong = readerFor({ '0xd21220a7': `0x${word(BigInt('0x' + '11'.repeat(20)))}` })
    await expect(
      readOnchainTwapPrice(wrong, {
        pool: POOL,
        base: { address: WETH, symbol: 'WETH', decimals: 18 },
        quote: { address: USDG, symbol: 'USDG', decimals: 6, pegUsd: 1 },
      }),
    ).rejects.toThrow(/not the pair it was configured as/)
  })

  it('REFUSES rather than falling back to spot when observe() reverts', async () => {
    const reverting = readerFor({ '0x883bdbfd': new Error('execution reverted: OLD') })
    await expect(
      readOnchainTwapPrice(reverting, {
        pool: POOL,
        base: { address: WETH, symbol: 'WETH', decimals: 18 },
        quote: { address: USDG, symbol: 'USDG', decimals: 6, pegUsd: 1 },
      }),
    ).rejects.toThrow(/NOT falling back to slot0 spot/)
  })

  it('REFUSES a reading outside an explicit sanity band', async () => {
    await expect(
      readOnchainTwapPrice(readerFor(), {
        pool: POOL,
        base: { address: WETH, symbol: 'WETH', decimals: 18 },
        quote: { address: USDG, symbol: 'USDG', decimals: 6, pegUsd: 1 },
        sanityBandUsd: { min: 10, max: 100 },
      }),
    ).rejects.toThrow(/outside the configured sanity band/)
  })
})

describe('applyOnchainPrice precedence', () => {
  const config = {
    pool: POOL,
    twapSeconds: 1800,
    base: { address: WETH, symbol: 'WETH', decimals: 18 },
    quote: { address: USDG, symbol: 'USDG', decimals: 6, pegUsd: 1 },
  }

  it('fills the native price when VENUE_PRICE_USD_ETH is unset', async () => {
    const prices = new PriceBook({}, 'test', 0, [
      { address: NATIVE_ASSET_ADDRESS, symbol: 'ETH', decimals: 18 },
    ])
    const result = await applyOnchainPrice({
      reader: readerFor(),
      prices,
      config,
      pinnedBySymbol: {},
    })
    expect(result.applied).toBe(true)
    expect(prices.priceOf(NATIVE_ASSET_ADDRESS)).toBeCloseTo(result.quote.priceUsd, 6)
  })

  it('leaves a pinned price in place but REPORTS THE DISCREPANCY', async () => {
    const prices = new PriceBook({ ETH: 3200 }, 'test', 0, [
      { address: NATIVE_ASSET_ADDRESS, symbol: 'ETH', decimals: 18 },
    ])
    const result = await applyOnchainPrice({
      reader: readerFor(),
      prices,
      config,
      pinnedBySymbol: { ETH: 3200 },
    })
    expect(result.applied).toBe(false)
    // The pinned value still governs every figure...
    expect(prices.priceOf(NATIVE_ASSET_ADDRESS)).toBe(3200)
    // ...but the run says, in words, that it is ~28% above the chain.
    const text = result.warnings.join(' ')
    expect(text).toMatch(/PRICE CROSS-CHECK/)
    expect(text).toMatch(/\+2[0-9]\.\d% against the chain/)
    expect(text).toMatch(/material to threshold counts/)
  })
})

describe('loadOnchainPriceConfig', () => {
  const base = {
    VENUE_ONCHAIN_PRICE_POOL: POOL,
    VENUE_ONCHAIN_PRICE_QUOTE: USDG,
    VENUE_ONCHAIN_PRICE_QUOTE_DECIMALS: '6',
    VENUE_ONCHAIN_PRICE_QUOTE_SYMBOL: 'USDG',
  } as NodeJS.ProcessEnv

  it('is OFF unless a pool is named', () => {
    expect(loadOnchainPriceConfig({}, { wethAddress: WETH })).toBeUndefined()
    expect(loadOnchainPriceConfig({ VENUE_ONCHAIN_PRICE_POOL: '  ' }, { wethAddress: WETH })).toBeUndefined()
  })

  it('defaults the TWAP window and the base to WETH', () => {
    const config = loadOnchainPriceConfig(base, { wethAddress: WETH })
    expect(config?.twapSeconds).toBe(DEFAULT_TWAP_SECONDS)
    expect(config?.base.address).toBe(WETH)
    expect(config?.quote.pegUsd).toBe(1)
  })

  it('REFUSES to assume decimals, because assuming 18 for USDG is a 10^12 error', () => {
    const { VENUE_ONCHAIN_PRICE_QUOTE_DECIMALS: _omitted, ...without } = base
    expect(() => loadOnchainPriceConfig(without, { wethAddress: WETH })).toThrow(/must be set/)
  })

  it('REFUSES a missing or malformed quote address rather than guessing a side', () => {
    const { VENUE_ONCHAIN_PRICE_QUOTE: _omitted, ...without } = base
    expect(() => loadOnchainPriceConfig(without, { wethAddress: WETH })).toThrow(/VENUE_ONCHAIN_PRICE_QUOTE/)
    expect(() =>
      loadOnchainPriceConfig({ ...base, VENUE_ONCHAIN_PRICE_QUOTE: 'usdg' }, { wethAddress: WETH }),
    ).toThrow(/VENUE_ONCHAIN_PRICE_QUOTE/)
  })

  it('refuses a non-address pool and a non-positive TWAP window', () => {
    expect(() =>
      loadOnchainPriceConfig({ ...base, VENUE_ONCHAIN_PRICE_POOL: 'nope' }, { wethAddress: WETH }),
    ).toThrow(/must be an address/)
    expect(() =>
      loadOnchainPriceConfig({ ...base, VENUE_ONCHAIN_PRICE_TWAP_SECONDS: '0' }, { wethAddress: WETH }),
    ).toThrow(/positive integer/)
  })
})
