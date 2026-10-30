import { describe, expect, it } from 'vitest'
import {
  assessMateriality,
  computeCoverage,
  coverageStatement,
  rankAssets,
  rollupAssets,
} from '../lib/coverage.ts'
import type { EscrowCredit } from '../lib/escrow.ts'
import { PriceBook, parseAssetEntriesFile } from '../lib/prices.ts'
import type { TokenMetadata } from '../lib/token-metadata.ts'

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const NVDA = '0x47f69ec031fb7d8dde5c33db922a29f2661cae71'
const JUNK = '0x9999999999999999999999999999999999999999'

function meta(
  address: string,
  decimals: number | null,
  symbol: string | null,
): TokenMetadata {
  return {
    address,
    decimals,
    symbol,
    name: null,
    decimalsStatus: decimals === null ? 'absent' : 'ok',
    symbolStatus: symbol === null ? 'absent' : 'ok',
    nameStatus: 'absent',
    symbolEncoding: symbol === null ? 'none' : 'string',
    nameEncoding: 'none',
    resolvedAtUnix: 1_788_000_000,
  }
}

function credit(recipient: string, asset: string, amountMinor: bigint): EscrowCredit {
  return {
    recipient,
    asset,
    assetKind: 'erc20',
    amountMinor,
    blockNumber: 1n,
    blockHash: '0x00',
    txHash: '0x00',
    logIndex: 0,
    timestampUnix: 0,
  }
}

function book(entries: Array<{ address: string; decimals: number; symbol: string; priceUsd?: number }>): PriceBook {
  const b = new PriceBook({}, 'test', 1_788_000_000)
  for (const e of entries) {
    b.registerAsset({ address: e.address, symbol: e.symbol, decimals: e.decimals }, e.priceUsd)
  }
  return b
}

describe('rollupAssets', () => {
  it('uses the RESOLVED decimals, which is the whole defect', () => {
    // 1,193,195,474,303 minor units of a 6-decimal stablecoin is $1,193,195.47.
    // The old `decimals ?? 18` printed it as 1.19e-6 and nobody noticed until a
    // 186-recipient asset outweighed a 4,450-recipient one.
    const credits = [credit('0xr1', USDG, 1_193_195_474_303n)]
    const metadata = new Map([[USDG, meta(USDG, 6, 'USDG')]])
    const rollups = rollupAssets(credits, {
      metadata,
      prices: book([{ address: USDG, decimals: 6, symbol: 'USDG', priceUsd: 1 }]),
    })
    expect(rollups[0]!.decimals).toBe(6)
    expect(rollups[0]!.valueUsd).toBeCloseTo(1_193_195.474303, 4)
    expect(rollups[0]!.valueUsd).toBeGreaterThan(1_000_000)
  })

  it('leaves value NULL when decimals are unknown, never zero and never 18-scaled', () => {
    const credits = [credit('0xr1', JUNK, 10n ** 18n)]
    const metadata = new Map([[JUNK, meta(JUNK, null, null)]])
    const rollups = rollupAssets(credits, { metadata, prices: book([]) })
    expect(rollups[0]!.decimals).toBeNull()
    expect(rollups[0]!.valueUsd).toBeNull()
    expect(rollups[0]!.priceable).toBe(false)
    expect(rollups[0]!.blockedBy).toBe('decimals+price')
  })

  it('distinguishes "no decimals" from "no price"', () => {
    const credits = [credit('0xr1', NVDA, 10n ** 18n)]
    const metadata = new Map([[NVDA, meta(NVDA, 18, 'NVDA')]])
    const rollups = rollupAssets(credits, { metadata, prices: book([]) })
    expect(rollups[0]!.blockedBy).toBe('price')
    expect(rollups[0]!.decimals).toBe(18)
  })

  it('counts distinct recipients, not credits', () => {
    const credits = [
      credit('0xr1', USDG, 1n),
      credit('0xr1', USDG, 2n),
      credit('0xr2', USDG, 3n),
    ]
    const rollups = rollupAssets(credits, {
      metadata: new Map([[USDG, meta(USDG, 6, 'USDG')]]),
      prices: book([{ address: USDG, decimals: 6, symbol: 'USDG', priceUsd: 1 }]),
    })
    expect(rollups[0]!.creditCount).toBe(3)
    expect(rollups[0]!.recipientCount).toBe(2)
    expect(rollups[0]!.totalMinor).toBe(6n)
  })
})

describe('rankAssets', () => {
  it('ranks priced assets by value, then unpriced by recipient count', () => {
    const credits = [
      credit('0xr1', USDG, 1_000_000n), // $1 at 6dp
      credit('0xr2', NVDA, 10n ** 18n),
      credit('0xr3', NVDA, 10n ** 18n),
      credit('0xr4', NVDA, 10n ** 18n),
      credit('0xr5', JUNK, 10n ** 18n),
    ]
    const metadata = new Map([
      [USDG, meta(USDG, 6, 'USDG')],
      [NVDA, meta(NVDA, 18, 'NVDA')],
      [JUNK, meta(JUNK, 18, 'JUNK')],
    ])
    const ranked = rankAssets(
      rollupAssets(credits, {
        metadata,
        prices: book([{ address: USDG, decimals: 6, symbol: 'USDG', priceUsd: 1 }]),
      }),
    )
    // Priced first regardless of how many recipients an unpriced asset has.
    expect(ranked[0]!.address).toBe(USDG)
    expect(ranked[0]!.priceable).toBe(true)
    // Then unpriced, most recipients first.
    expect(ranked[1]!.address).toBe(NVDA)
    expect(ranked[2]!.address).toBe(JUNK)
  })
})

describe('computeCoverage', () => {
  const credits = [
    credit('0xa', USDG, 1_000_000n),
    credit('0xb', USDG, 2_000_000n),
    credit('0xb', NVDA, 10n ** 18n),
    credit('0xc', NVDA, 10n ** 18n),
    credit('0xd', JUNK, 10n ** 18n),
  ]
  const metadata = new Map([
    [USDG, meta(USDG, 6, 'USDG')],
    [NVDA, meta(NVDA, 18, 'NVDA')],
    [JUNK, meta(JUNK, null, null)],
  ])
  const prices = book([{ address: USDG, decimals: 6, symbol: 'USDG', priceUsd: 1 }])
  const report = computeCoverage(credits, rollupAssets(credits, { metadata, prices }))

  it('reports coverage on all three bases', () => {
    expect(report.assets).toEqual({ total: 3, priced: 1, share: 1 / 3 })
    expect(report.credits).toEqual({ total: 5, priced: 2, share: 2 / 5 })
    expect(report.value.pricedUsd).toBeCloseTo(3, 9)
  })

  it('separates recipients whose totals are UNDERSTATED from those that are complete', () => {
    // 0xa is fully priced; 0xb holds one priced and one unpriced asset, so its
    // total is understated and it can silently fall below a tier gate; 0xc and
    // 0xd are entirely unpriced.
    expect(report.recipients.total).toBe(4)
    expect(report.recipients.fullyPriced).toBe(1)
    expect(report.recipients.partiallyUnpriced).toBe(1)
    expect(report.recipients.fullyUnpriced).toBe(2)
  })

  it('counts why each asset is unpriceable', () => {
    expect(report.value.assetsMissingDecimals).toBe(1)
    expect(report.value.assetsMissingPrice).toBe(1)
  })

  it('names the unpriced assets to price next, most recipients first', () => {
    expect(report.priceNext.map((r) => r.address)).toEqual([NVDA, JUNK])
  })

  it('states the coverage in the one sentence that may be quoted', () => {
    expect(report.statement).toContain('40.0% of credits')
    expect(report.statement).toContain('UNPRICED')
    expect(report.statement).toContain('never counted as zero')
  })

  it('says so plainly when everything is priced', () => {
    const all = [credit('0xa', USDG, 1_000_000n)]
    const only = computeCoverage(
      all,
      rollupAssets(all, {
        metadata: new Map([[USDG, meta(USDG, 6, 'USDG')]]),
        prices,
      }),
    )
    expect(only.statement).toContain('All 1 assets are priced')
  })

  it('handles an empty credit set without dividing by zero', () => {
    const empty = computeCoverage([], [])
    expect(empty.credits.share).toBe(1)
    expect(coverageStatement(empty)).toContain('nothing to price')
  })
})

describe('assessMateriality', () => {
  it('calls the tail MATERIAL on the priced head alone, with no assumption about the rest', () => {
    const verdict = assessMateriality({
      erc20PricedUsd: 600_000,
      nativeUsd: 6_240_000,
      creditCoverageShare: 0.2,
    })
    expect(verdict.verdict).toBe('material')
    expect(verdict.ratioLowerBound).toBeCloseTo(0.0962, 4)
    expect(verdict.statement).toContain('LOWER BOUND')
    expect(verdict.statement).toContain('NOT a defensible measurement basis')
  })

  it('calls it DUST only when coverage is high enough to bound the remainder', () => {
    const verdict = assessMateriality({
      erc20PricedUsd: 10_000,
      nativeUsd: 6_240_000,
      creditCoverageShare: 0.97,
    })
    expect(verdict.verdict).toBe('dust')
    expect(verdict.statement).toContain('defensible basis')
  })

  it('refuses to call it either way when too little of the tail is priced', () => {
    // The honest default. A tool that talks itself out of "undetermined" is
    // how a native-only figure gets published as complete.
    const verdict = assessMateriality({
      erc20PricedUsd: 10_000,
      nativeUsd: 6_240_000,
      creditCoverageShare: 0.3,
    })
    expect(verdict.verdict).toBe('undetermined')
    expect(verdict.statement).toContain('Do NOT publish a native-only figure as complete')
  })

  it('is undetermined with no native baseline rather than dividing by zero', () => {
    const verdict = assessMateriality({
      erc20PricedUsd: 500_000,
      nativeUsd: 0,
      creditCoverageShare: 1,
    })
    expect(verdict.verdict).toBe('undetermined')
    expect(verdict.ratioLowerBound).toBe(0)
  })
})

describe('parseAssetEntriesFile', () => {
  it('accepts an entry with only an address and a price, resolving decimals elsewhere', () => {
    const entries = parseAssetEntriesFile([{ address: USDG, priceUsd: 1 }])
    expect(entries).toEqual([{ address: USDG, priceUsd: 1 }])
  })

  it('rejects the same address twice, which would be a silent coin flip', () => {
    expect(() =>
      parseAssetEntriesFile([
        { address: USDG, priceUsd: 1 },
        { address: USDG.toUpperCase().replace('0X', '0x'), priceUsd: 2 },
      ]),
    ).toThrow(/twice/)
  })

  it('rejects a non-positive price rather than treating it as free', () => {
    expect(() => parseAssetEntriesFile([{ address: USDG, priceUsd: 0 }])).toThrow(/positive/)
  })

  it('rejects decimals outside the range that can scale an amount safely', () => {
    expect(() => parseAssetEntriesFile([{ address: USDG, decimals: 255 }])).toThrow(/0\.\.36/)
  })
})

describe('PriceBook address pinning', () => {
  it('prefers an address-pinned price over a symbol match', () => {
    // Across 263 live assets, symbols collide: VLAD appears 6 times and TRUMP 5.
    // Matching by symbol would price one issuer's token at another's rate.
    const b = new PriceBook({ TRUMP: 999 }, 'env', 0)
    b.registerAsset({ address: JUNK, symbol: 'TRUMP', decimals: 18 }, 0.25)
    expect(b.priceOf(JUNK)).toBe(0.25)
  })

  it('still falls back to the symbol price when nothing is pinned', () => {
    const b = new PriceBook({ TRUMP: 999 }, 'env', 0)
    b.registerAsset({ address: JUNK, symbol: 'TRUMP', decimals: 18 })
    expect(b.priceOf(JUNK)).toBe(999)
  })
})
