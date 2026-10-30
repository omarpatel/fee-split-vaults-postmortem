import { describe, expect, it } from 'vitest'
import { SignalsUnavailableError } from '../errors.js'
import type { TradeObservation } from '../model.js'
import { StaticPriceOracle } from '../prices.js'
import {
  computeQualificationSignals,
  InMemoryHolderSource,
  InMemoryTradeSource,
  InMemoryVolumeSource,
  PostingsVolumeSource,
  type ExternalVolumeObserver,
  type HolderSnapshot,
  type VolumeSample,
} from '../signals.js'
import { addr, binding, DAY, hash32, posting, usdg, USDG } from './helpers.js'

const NOW = 30 * DAY
const TOKEN = addr(0x100)
const DEPLOYER = addr(0xdeb)

function trade(overrides: Partial<TradeObservation> = {}): TradeObservation {
  return {
    token: TOKEN,
    trader: addr(1),
    side: 'buy',
    asset: USDG.address,
    quoteVolumeMinor: 100n,
    occurredAtUnix: NOW - DAY,
    blockHash: hash32(1),
    finalized: true,
    ...overrides,
  }
}

function snapshot(overrides: Partial<HolderSnapshot> = {}): HolderSnapshot {
  return {
    token: TOKEN,
    blockHash: hash32(9),
    blockNumber: 100n,
    takenAtUnix: NOW - 60,
    totalSupplyMinor: 1_000n,
    deployer: DEPLOYER,
    balances: [
      { holder: DEPLOYER, balanceMinor: 100n },
      ...Array.from({ length: 12 }, (_, i) => ({ holder: addr(0x500 + i), balanceMinor: 50n })),
    ],
    ...overrides,
  }
}

function sample(overrides: Partial<VolumeSample> = {}): VolumeSample {
  return {
    token: TOKEN,
    windowSeconds: 7 * DAY,
    totalVolumeUsd: 1_000,
    venuePoolVolumeUsd: 250,
    source: 'test-aggregator',
    sampledAtUnix: NOW - 60,
    ...overrides,
  }
}

function sources(input: {
  trades?: readonly TradeObservation[]
  holders?: HolderSnapshot
  volume?: VolumeSample
  coverageFrom?: number
}) {
  const trades = new InMemoryTradeSource()
  trades.put(TOKEN, {
    trades: input.trades ?? [],
    coverage: { fromUnix: input.coverageFrom ?? NOW - 30 * DAY, toUnix: NOW },
  })
  const holders = new InMemoryHolderSource()
  holders.put(input.holders ?? snapshot())
  const volume = new InMemoryVolumeSource()
  volume.put(input.volume ?? sample())
  return { trades, holders, volume }
}

const coin = binding({ token: TOKEN, launchedAtUnix: NOW - 10 * DAY })
const options = { nowUnix: NOW }

describe('computeQualificationSignals', () => {
  it('counts breadth by distinct buyer, not by trade count', async () => {
    const trades = [
      trade({ trader: addr(0x11) }),
      trade({ trader: addr(0x11) }),
      trade({ trader: addr(0x11) }),
      trade({ trader: addr(0x12) }),
    ]
    const signals = await computeQualificationSignals({ binding: coin, ...sources({ trades }), options })
    expect(signals.uniqueBuyers7d).toBe(2)
  })

  it('ignores unfinalized trades', async () => {
    const trades = [trade({ trader: addr(0x11), finalized: false })]
    const signals = await computeQualificationSignals({ binding: coin, ...sources({ trades }), options })
    expect(signals.uniqueBuyers7d).toBe(0)
  })

  it('scores a round-tripping washer as self-trade volume', async () => {
    // 0x11 buys and sells; 0x12 only buys. The washer's whole volume counts.
    const trades = [
      trade({ trader: addr(0x11), side: 'buy', quoteVolumeMinor: 300n }),
      trade({ trader: addr(0x11), side: 'sell', quoteVolumeMinor: 300n }),
      trade({ trader: addr(0x12), side: 'buy', quoteVolumeMinor: 400n }),
    ]
    const signals = await computeQualificationSignals({ binding: coin, ...sources({ trades }), options })
    expect(signals.selfTradeSharePct).toBeCloseTo(60, 6)
  })

  it('measures concentration on circulating supply, excluding structural holders', async () => {
    const signals = await computeQualificationSignals({ binding: coin, ...sources({}), options })
    // Deployer 100 plus the nine largest others at 50 each, over 1,000 supply.
    // The deployer counts toward concentration AND is reported on its own.
    expect(signals.top10HolderSharePct).toBeCloseTo(55, 6)
    expect(signals.deployerSupplySharePct).toBeCloseTo(10, 6)
  })

  it('excludes the launch locker and vault from concentration', async () => {
    const withStructural = snapshot({
      balances: [
        { holder: coin.vault, balanceMinor: 800n },
        { holder: DEPLOYER, balanceMinor: 100n },
        { holder: addr(0x501), balanceMinor: 100n },
      ],
    })
    const signals = await computeQualificationSignals({
      binding: coin,
      ...sources({ holders: withStructural }),
      options,
    })
    // The vault's 800 is structural and drops out; deployer 100 + holder 100 remain.
    expect(signals.top10HolderSharePct).toBeCloseTo(20, 6)
  })

  it('reports the Venue-pool share of total volume', async () => {
    const signals = await computeQualificationSignals({ binding: coin, ...sources({}), options })
    expect(signals.venuePoolVolumeSharePct).toBeCloseTo(25, 6)
    expect(signals.coinAgeDays).toBeCloseTo(10, 6)
  })

  it('refuses when no trade source can vouch for a post-graduation coin', async () => {
    const s = sources({})
    const empty = new InMemoryTradeSource()
    await expect(
      computeQualificationSignals({ binding: coin, ...s, trades: empty, options }),
    ).rejects.toThrow(SignalsUnavailableError)
  })

  it('refuses when trade coverage does not span the window', async () => {
    await expect(
      computeQualificationSignals({
        binding: coin,
        ...sources({ coverageFrom: NOW - 2 * DAY }),
        options,
      }),
    ).rejects.toThrow(/does not span/)
  })

  it('refuses a stale holder snapshot rather than reporting old concentration', async () => {
    await expect(
      computeQualificationSignals({
        binding: coin,
        ...sources({ holders: snapshot({ takenAtUnix: NOW - 10 * DAY }) }),
        options,
      }),
    ).rejects.toThrow(/holder snapshot is/)
  })

  it('refuses a stale volume sample', async () => {
    await expect(
      computeQualificationSignals({
        binding: coin,
        ...sources({ volume: sample({ sampledAtUnix: NOW - 10 * DAY }) }),
        options,
      }),
    ).rejects.toThrow(/volume sample is/)
  })

  it('refuses an incoherent volume sample instead of reporting over 100%', async () => {
    await expect(
      computeQualificationSignals({
        binding: coin,
        ...sources({ volume: sample({ totalVolumeUsd: 10, venuePoolVolumeUsd: 100 }) }),
        options,
      }),
    ).rejects.toThrow(/exceeds total/)
  })

  it('refuses a zero total supply rather than dividing by it', async () => {
    await expect(
      computeQualificationSignals({
        binding: coin,
        ...sources({ holders: snapshot({ totalSupplyMinor: 0n }) }),
        options,
      }),
    ).rejects.toThrow(/total supply/)
  })
})

describe('PostingsVolumeSource', () => {
  const vault = addr(0x200)
  const prices = new StaticPriceOracle([{ asset: USDG.address, usdPerWholeUnit: 1, source: 'pin', pricedAtUnix: NOW - DAY }])
  const day = [
    // A curve buy of 500 USDG and a pool sweep whose 1% hook fee implies 300 USDG of volume.
    posting({ vault, token: TOKEN, asset: USDG.address, volumeMinor: usdg(500), occurredAtUnix: NOW - 3_600, finalized: true }),
    posting({
      vault,
      token: TOKEN,
      asset: USDG.address,
      side: 'sweep',
      source: 'pool_fees_swept',
      phase: 'post_graduation',
      volumeMinor: 0n,
      grossFeeMinor: usdg(3),
      occurredAtUnix: NOW - 7_200,
      finalized: true,
    }),
    // Unfinalized money is not volume, and yesterday's is outside the window.
    posting({ vault, token: TOKEN, asset: USDG.address, volumeMinor: usdg(9_999), occurredAtUnix: NOW - 60, finalized: false }),
    posting({ vault, token: TOKEN, asset: USDG.address, volumeMinor: usdg(9_999), occurredAtUnix: NOW - 2 * DAY, finalized: true }),
  ]
  function source(coin = binding({ token: TOKEN, vault }), external?: ExternalVolumeObserver): PostingsVolumeSource {
    return new PostingsVolumeSource({
      binding: async () => coin,
      postings: async (_vault, fromUnix, toUnix) => day.filter((p) => p.occurredAtUnix >= fromUnix && p.occurredAtUnix < toUnix),
      prices,
      decimals: () => USDG.decimals,
      ...(external === undefined ? {} : { external }),
      nowUnix: () => NOW,
    })
  }

  it('before graduation the curve is the only venue: venue volume from postings IS the total, sweeps priced by the hook fee', async () => {
    const sample = await source().sample(TOKEN, 7 * DAY)
    expect(sample).toMatchObject({ windowSeconds: DAY, totalVolumeUsd: 800, venuePoolVolumeUsd: 800, sampledAtUnix: NOW })
    expect(sample?.source).toContain('pre-graduation')
  })

  it('after graduation the total comes from the aggregator, and without one the sample refuses', async () => {
    const graduated = binding({ token: TOKEN, vault, graduatedAtUnix: NOW - DAY })
    expect(await source(graduated).sample(TOKEN, 7 * DAY)).toBeUndefined()
    const observed = await source(graduated, {
      volume24hUsd: async () => ({ totalVolumeUsd: 4_000, source: 'dexscreener:abc', observedAtUnix: NOW - 10 }),
    }).sample(TOKEN, 7 * DAY)
    expect(observed).toMatchObject({ totalVolumeUsd: 4_000, venuePoolVolumeUsd: 800, sampledAtUnix: NOW - 10 })
    // An aggregator that lists no pair is nothing to measure, not zero.
    expect(await source(graduated, { volume24hUsd: async () => undefined }).sample(TOKEN, 7 * DAY)).toBeUndefined()
  })

  it('refuses a window shorter than its 24h resolution, an unbound token and an asset with no decimals', async () => {
    expect(await source().sample(TOKEN, 3_600)).toBeUndefined()
    const unbound = new PostingsVolumeSource({
      binding: async () => undefined,
      postings: async () => [],
      prices,
      decimals: () => USDG.decimals,
      nowUnix: () => NOW,
    })
    expect(await unbound.sample(TOKEN, 7 * DAY)).toBeUndefined()
    const noDecimals = new PostingsVolumeSource({
      binding: async () => binding({ token: TOKEN, vault }),
      postings: async () => day,
      prices,
      decimals: () => undefined,
      nowUnix: () => NOW,
    })
    expect(await noDecimals.sample(TOKEN, 7 * DAY)).toBeUndefined()
  })
})
