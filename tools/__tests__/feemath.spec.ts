import { describe, expect, it } from 'vitest'
import { VENUE, creatorNetBps } from '../../config/protocol.ts'
import {
  ZeroProtocolLegError,
  buybackPopulationRate,
  decomposeSweep,
  profilePool,
  type SweepObservation,
} from '../lib/feemath.ts'
import { decodeSweep } from '../pool-fees-index.ts'
import { parseEventSignature } from '../lib/abi.ts'
import { loadFixture, toRawLogs, type PoolFeesFixture } from './helpers.ts'

const ETH = 10n ** 18n

/** Build a sweep from a known volume and configuration, the way the hook would. */
function syntheticSweep(options: {
  poolId: string
  volume: bigint
  buyback: boolean
  taxBps: number
}): SweepObservation {
  const base = (options.volume * BigInt(VENUE.hookFeeBps)) / 10_000n
  const protocol = (base * BigInt(VENUE.protocolFeeShareBps)) / 10_000n
  const remainder = base - protocol
  const buybackSpent = options.buyback ? (remainder * BigInt(VENUE.buybackBurnBps)) / 10_000n : 0n
  // Per creatorNetBps(): the creator tax is creatorTaxBps of the BASE FEE.
  const tax = (base * BigInt(options.taxBps)) / 10_000n
  return {
    poolId: options.poolId,
    protocolMinor: protocol,
    buybackSpentMinor: buybackSpent,
    creatorMinor: remainder - buybackSpent + tax,
    tokensLockedMinor: 0n,
    blockNumber: 1n,
    timestampUnix: 1_780_000_000,
  }
}

describe('decomposeSweep', () => {
  it('recovers the volume exactly from the protocol leg', () => {
    const sweep = syntheticSweep({ poolId: '0x01', volume: 1000n * ETH, buyback: false, taxBps: 0 })
    expect(decomposeSweep(sweep).impliedVolumeMinor).toBe(1000n * ETH)
  })

  it('detects buyback-off and reports the 0.70% creator rate', () => {
    const decomposed = decomposeSweep(
      syntheticSweep({ poolId: '0x01', volume: 500n * ETH, buyback: false, taxBps: 0 }),
    )
    expect(decomposed.buybackObserved).toBe(false)
    expect(decomposed.effectiveCreatorBps).toBeCloseTo(creatorNetBps(false, 0), 6)
    expect(decomposed.effectiveCreatorBps).toBeCloseTo(70, 6)
    expect(decomposed.impliedCreatorTaxBps).toBeCloseTo(0, 6)
    expect(decomposed.modelViolation).toBeUndefined()
  })

  it('detects buyback-on and reports the 0.35% creator rate', () => {
    const decomposed = decomposeSweep(
      syntheticSweep({ poolId: '0x01', volume: 1000n * ETH, buyback: true, taxBps: 0 }),
    )
    expect(decomposed.buybackObserved).toBe(true)
    expect(decomposed.observedBuybackShareBps).toBeCloseTo(VENUE.buybackBurnBps, 6)
    expect(decomposed.effectiveCreatorBps).toBeCloseTo(creatorNetBps(true, 0), 6)
    expect(decomposed.effectiveCreatorBps).toBeCloseTo(35, 6)
  })

  it('backs a known creator tax out of the residual', () => {
    for (const taxBps of [25, 100, 500, 1000]) {
      const decomposed = decomposeSweep(
        syntheticSweep({ poolId: '0x01', volume: 800n * ETH, buyback: false, taxBps }),
      )
      expect(decomposed.impliedCreatorTaxBps).toBeCloseTo(taxBps, 4)
      expect(decomposed.effectiveCreatorBps).toBeCloseTo(creatorNetBps(false, taxBps), 4)
    }
  })

  it('flags a pool whose creator leg is smaller than the split explains', () => {
    const sweep = syntheticSweep({ poolId: '0x01', volume: 100n * ETH, buyback: false, taxBps: 0 })
    sweep.creatorMinor = sweep.creatorMinor / 2n
    expect(decomposeSweep(sweep).modelViolation).toMatch(/SMALLER than the hook split explains/)
  })

  it('flags a buyback share that is not the verified 50% of the remainder', () => {
    const sweep = syntheticSweep({ poolId: '0x01', volume: 100n * ETH, buyback: true, taxBps: 0 })
    sweep.buybackSpentMinor = sweep.buybackSpentMinor / 4n
    expect(decomposeSweep(sweep).modelViolation).toMatch(/buyback share is/)
  })

  it('refuses to invent a volume from a zero protocol leg', () => {
    expect(() =>
      decomposeSweep({
        poolId: '0xdead',
        protocolMinor: 0n,
        buybackSpentMinor: 0n,
        creatorMinor: 0n,
        tokensLockedMinor: 0n,
        blockNumber: 1n,
        timestampUnix: 0,
      }),
    ).toThrow(ZeroProtocolLegError)
  })
})

describe('buybackPopulationRate', () => {
  it('separates the count-weighted rate from the volume-weighted one', () => {
    // One huge buyback-ON pool and nine tiny OFF pools: 10% by count, ~99% by volume.
    const profiles = [
      profilePool('0xbig', [
        syntheticSweep({ poolId: '0xbig', volume: 1_000_000n * ETH, buyback: true, taxBps: 0 }),
      ]),
      ...Array.from({ length: 9 }, (_, i) =>
        profilePool(`0xsmall${i}`, [
          syntheticSweep({ poolId: `0xsmall${i}`, volume: 1000n * ETH, buyback: false, taxBps: 0 }),
        ]),
      ),
    ]
    const rate = buybackPopulationRate(profiles)
    expect(rate.buybackOnShareUnweighted).toBeCloseTo(0.1, 6)
    expect(rate.buybackOnShareVolumeWeighted).toBeGreaterThan(0.99)
    // The blended creator rate must follow the VOLUME, since that is where fees are.
    expect(rate.blendedCreatorBpsVolumeWeighted).toBeLessThan(36)
    expect(rate.blendedCreatorBpsUnweighted).toBeGreaterThan(66)
  })

  it('returns zeros rather than NaN for an empty population', () => {
    const rate = buybackPopulationRate([])
    expect(rate.pools).toBe(0)
    expect(Number.isNaN(rate.buybackOnShareVolumeWeighted)).toBe(false)
  })
})

describe('profilePool', () => {
  it('marks a pool ON if any sweep spent, and exposes the mid-window flip', () => {
    const profile = profilePool('0xflip', [
      syntheticSweep({ poolId: '0xflip', volume: 100n * ETH, buyback: false, taxBps: 0 }),
      syntheticSweep({ poolId: '0xflip', volume: 100n * ETH, buyback: true, taxBps: 0 }),
    ])
    expect(profile.buybackEnabled).toBe(true)
    expect(profile.buybackSweepShare).toBeCloseTo(0.5, 6)
  })
})

describe('decoding recorded PoolFeesSwept logs', () => {
  const fixture = loadFixture<PoolFeesFixture>('pool-fees-swept-logs.json')
  const spec = parseEventSignature(
    'PoolFeesSwept(bytes32 indexed poolId, uint256 protocol, uint256 buybackSpent, uint256 creator, uint256 tokensLocked)',
  )

  it('reproduces every pool’s ground-truth volume, buyback flag and tax', async () => {
    const logs = toRawLogs(fixture.sweepLogs)
    const byPool = new Map<string, SweepObservation[]>()
    for (const log of logs) {
      const sweep = await decodeSweep(spec, log, async () => 0)
      const list = byPool.get(sweep.poolId)
      if (list === undefined) byPool.set(sweep.poolId, [sweep])
      else list.push(sweep)
    }

    expect(byPool.size).toBe(fixture.groundTruth.length)
    for (const truth of fixture.groundTruth) {
      const profile = profilePool(truth.poolId.toLowerCase(), byPool.get(truth.poolId.toLowerCase()) ?? [])
      expect(profile.sweeps).toBe(truth.sweeps)
      expect(profile.buybackEnabled).toBe(truth.buybackEnabled)
      expect(profile.totalImpliedVolumeMinor).toBe(BigInt(truth.volumeMinor))
      expect(profile.impliedCreatorTaxBps).toBeCloseTo(truth.creatorTaxBps, 3)
      expect(profile.effectiveCreatorBps).toBeCloseTo(
        creatorNetBps(truth.buybackEnabled, truth.creatorTaxBps),
        3,
      )
      expect(profile.modelViolations).toEqual([])
    }
  })

  it('measures the population rate the fixture was built to represent', async () => {
    const logs = toRawLogs(fixture.sweepLogs)
    const byPool = new Map<string, SweepObservation[]>()
    for (const log of logs) {
      const sweep = await decodeSweep(spec, log, async () => 0)
      const list = byPool.get(sweep.poolId)
      if (list === undefined) byPool.set(sweep.poolId, [sweep])
      else list.push(sweep)
    }
    const profiles = [...byPool].map(([poolId, sweeps]) => profilePool(poolId, sweeps))
    const rate = buybackPopulationRate(profiles)
    // Two of four pools run buyback, and they carry 1300 of 2000 units of
    // volume - so the count-weighted and volume-weighted answers differ, which
    // is exactly the distinction the tool exists to surface.
    expect(rate.buybackOnPools).toBe(2)
    expect(rate.buybackOnShareUnweighted).toBeCloseTo(0.5, 6)
    expect(rate.buybackOnShareVolumeWeighted).toBeCloseTo(1300 / 2000, 4)
  })
})
