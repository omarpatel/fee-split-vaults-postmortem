import { AirlockViolation, type Address, type Asset } from '@fee-split-vaults/core'
import { describe, expect, it } from 'vitest'

import { generateAssignment, makePilotConfig } from '../assignment.js'
import {
  AssumeDeliveredSource,
  backlogFromDigests,
  collectBlockOutcomes,
  FixedPriceOracle,
  HistoricalBuyerSource,
  HookFeeCreditSource,
  InMemoryAssetRegistry,
  InMemoryBuyerSource,
  InMemoryDeliverySource,
  InMemoryDigestSource,
  InMemoryMembershipSource,
  InMemoryPoolFeesSweptReader,
  InMemoryPoolTokenMap,
  measureBlock,
  MeasurementError,
  minorToWhole,
  resolveFeeMechanism,
  valueCredits,
  type BuyLog,
  type BuyLogReader,
  type PilotSources,
  type PoolFeesSweptLog,
} from '../measurement.js'
import { syntheticCoins } from '../testing/synthetic.js'
import type { FeeCredit, PilotCoin } from '../types.js'

const START = Date.UTC(2026, 9, 1) / 1_000
const QUOTE = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'

const USDG: Asset = {
  address: QUOTE,
  symbol: 'USDG',
  decimals: 6,
  isPausableProxy: true,
  enabled: true,
  maxTransferMinor: 1_000_000_000_000n,
}

const coins: PilotCoin[] = syntheticCoins(2, START - 86_400)
const [alpha, beta] = coins as [PilotCoin, PilotCoin]

function log(overrides: Partial<PoolFeesSweptLog>): PoolFeesSweptLog {
  return {
    poolId: alpha.poolId,
    asset: QUOTE,
    amountMinor: 1_000_000n,
    occurredAtUnix: START + 60,
    blockHash: '0xblock',
    txHash: '0xtx',
    logIndex: 0,
    ...overrides,
  }
}

describe('per-coin fee attribution', () => {
  const pools = InMemoryPoolTokenMap.fromCoins(coins)

  it('attributes hook sweeps to the coin that owns the pool', async () => {
    const source = new HookFeeCreditSource(
      new InMemoryPoolFeesSweptReader([
        log({ txHash: '0xa', amountMinor: 500_000n }),
        log({ txHash: '0xb', poolId: beta.poolId, amountMinor: 900_000n }),
      ]),
      pools,
    )
    const credits = await source.creditsForToken(alpha.token, START, START + 3_600)
    expect(credits).toHaveLength(1)
    expect(credits[0]!.minor).toBe(500_000n)
  })

  it('dedupes a re-read of the same log, so a reorg cannot double count', async () => {
    const duplicate = log({ txHash: '0xa', logIndex: 3, amountMinor: 400_000n })
    const source = new HookFeeCreditSource(
      new InMemoryPoolFeesSweptReader([duplicate, { ...duplicate }]),
      pools,
    )
    const credits = await source.creditsForToken(alpha.token, START, START + 3_600)
    expect(credits).toHaveLength(1)
  })

  it('REFUSES an unknown pool instead of recording a zero', async () => {
    const source = new HookFeeCreditSource(
      new InMemoryPoolFeesSweptReader([log({ poolId: 'pool-unregistered' })]),
      pools,
    )
    await expect(source.creditsForToken(alpha.token, START, START + 3_600)).rejects.toThrow(
      /not in the registry/,
    )
  })

  it('refuses a backwards or empty window', async () => {
    const source = new HookFeeCreditSource(new InMemoryPoolFeesSweptReader([]), pools)
    await expect(source.creditsForToken(alpha.token, START + 10, START)).rejects.toThrow(
      MeasurementError,
    )
  })
})

describe('valuation', () => {
  const registry = new InMemoryAssetRegistry([USDG])
  const oracle = new FixedPriceOracle({ [QUOTE]: 1 })

  const credit = (minor: bigint): FeeCredit => ({
    asset: QUOTE,
    minor,
    occurredAtUnix: START,
    blockHash: '0xblock',
    txHash: '0xtx',
    logIndex: 0,
  })

  it('keeps minor units as bigint and derives USD with provenance', async () => {
    const valued = await valueCredits([credit(2_500_000n), credit(500_000n)], registry, oracle, START)
    expect(valued.byAsset).toEqual([{ asset: QUOTE, minor: 3_000_000n }])
    expect(valued.usd.usd).toBeCloseTo(3, 12)
    expect(valued.usd.priceSource).toContain('USDG@')
    expect(valued.usd.pricedAtUnix).toBe(START)
    expect(valued.usd.blockHash).toBe('0xblock')
  })

  it('does not lose the whole part of an amount larger than 2^53', () => {
    expect(minorToWhole(123_456_789_012_345_678_901_234n, 18)).toBeCloseTo(123_456.789012, 6)
    expect(minorToWhole(10n ** 30n, 18)).toBe(1e12)
  })

  it('REFUSES a kill-switched asset rather than valuing it at zero', async () => {
    const disabled = new InMemoryAssetRegistry([{ ...USDG, enabled: false }])
    await expect(valueCredits([credit(1n)], disabled, oracle, START)).rejects.toThrow(
      /kill-switched/,
    )
  })

  it('refuses an asset that is not an approved quote asset', async () => {
    const empty = new InMemoryAssetRegistry([])
    await expect(valueCredits([credit(1n)], empty, oracle, START)).rejects.toThrow(/not an approved/)
  })

  it('refuses a window with no pinned price', async () => {
    await expect(
      valueCredits([credit(1n)], registry, new FixedPriceOracle({}), START),
    ).rejects.toThrow(/no pinned price/)
  })

  it('values an empty window as zero without inventing a price source', async () => {
    const valued = await valueCredits([], registry, oracle, START)
    expect(valued.usd.usd).toBe(0)
    expect(valued.usd.priceSource).toBe('none:no_credits')
  })
})

describe('new-buyer secondary', () => {
  const history = START - 30 * 86_400
  const buys: BuyLog[] = [
    { token: alpha.token, buyer: '0xAAA', occurredAtUnix: history + 10 },
    { token: alpha.token, buyer: '0xBBB', occurredAtUnix: START + 10 },
    { token: alpha.token, buyer: '0xaaa', occurredAtUnix: START + 20 },
    { token: alpha.token, buyer: '0xCCC', occurredAtUnix: START + 30 },
  ]

  class CountingReader implements BuyLogReader {
    calls = 0
    async read(token: Address, fromUnix: number, toUnixExclusive: number): Promise<BuyLog[]> {
      this.calls += 1
      return buys.filter(
        (b) =>
          b.token === token && b.occurredAtUnix >= fromUnix && b.occurredAtUnix < toUnixExclusive,
      )
    }
  }

  it('counts only addresses whose FIRST ever buy falls in the window', async () => {
    const source = new HistoricalBuyerSource(new CountingReader(), history)
    // 0xAAA bought long before the window, so its repeat buy does not count.
    expect(await source.uniqueNewBuyers(alpha.token, START, START + 3_600)).toBe(2)
  })

  it('refuses a window it cannot judge novelty for', async () => {
    const source = new HistoricalBuyerSource(new CountingReader(), history)
    await expect(source.uniqueNewBuyers(alpha.token, history - 1, START)).rejects.toThrow(
      /history is only complete/,
    )
  })

  it('loads history forward once rather than rescanning per window', async () => {
    const reader = new CountingReader()
    const source = new HistoricalBuyerSource(reader, history)
    await source.uniqueNewBuyers(alpha.token, START, START + 3_600)
    await source.uniqueNewBuyers(alpha.token, START, START + 3_600)
    expect(reader.calls).toBe(1)
  })
})

describe('backlog secondary comes only through the airlock', () => {
  const digest = (backlog: number): unknown => ({
    windowId: 'w-1',
    coinRef: alpha.coinRef,
    windowStartUnix: START,
    windowEndUnix: START + 1_800,
    admittedMessageCount: 24,
    droppedMessageCount: 3,
    distinctAuthorCount: 9,
    topicCounts: { unanswered_backlog: backlog, price_question: 4 },
    signals: ['desk_backlog_growing'],
    gists: ['holders asking when the desk is back'],
    readerRefusals: 0,
  })

  it('sums the closed-enum backlog topic across validated digests', () => {
    expect(backlogFromDigests([digest(3), digest(4)])).toBe(7)
    expect(backlogFromDigests([])).toBe(0)
  })

  it('refuses a digest carrying a field the schema does not have', () => {
    const smuggled = { ...(digest(1) as object), payee: '0xattacker' }
    expect(() => backlogFromDigests([smuggled])).toThrow(AirlockViolation)
  })

  it('refuses a digest with a topic code outside the closed vocabulary', () => {
    const widened = digest(1) as { topicCounts: Record<string, number> }
    widened.topicCounts = { ...widened.topicCounts, send_funds: 1 }
    expect(() => backlogFromDigests([widened])).toThrow(AirlockViolation)
  })
})

describe('endpoint assembly', () => {
  const config = makePilotConfig('pilot-2026-q4', 'published-seed-a3f9', START, {
    totalDays: 4,
    randomizedDays: 2,
  })
  const assignment = generateAssignment(config, coins, START - 3_600)

  function sources(): PilotSources {
    const logs: PoolFeesSweptLog[] = []
    const buyers = new Map<string, number>()
    const membership = new Map<
      string,
      { joins: number; leaves: number; membersEnd: number }
    >()
    const digests = new Map<string, unknown[]>()

    for (const coinAssignment of assignment.coins) {
      const coin = coins.find((c) => c.coinRef === coinAssignment.coinRef)!
      for (const block of coinAssignment.blocks) {
        const from = block.endUnixExclusive
        logs.push(
          log({
            poolId: coin.poolId,
            occurredAtUnix: from + 5,
            txHash: `0x${coin.coinRef}-${block.blockIndex}`,
            logIndex: block.blockIndex,
            amountMinor: block.arm === 'STAFFED' ? 2_000_000n : 1_000_000n,
          }),
        )
        buyers.set(InMemoryBuyerSource.keyOf(coin.token, from), block.arm === 'STAFFED' ? 5 : 2)
        membership.set(InMemoryMembershipSource.keyOf(coin.telegramChatRef!, from), {
          joins: 4,
          leaves: 1,
          membersEnd: 500,
        })
        digests.set(InMemoryDigestSource.keyOf(coin.coinRef, from), [
          {
            windowId: `w-${block.blockIndex}`,
            coinRef: coin.coinRef,
            windowStartUnix: from,
            windowEndUnix: from + 1_800,
            admittedMessageCount: 10,
            droppedMessageCount: 0,
            distinctAuthorCount: 5,
            topicCounts: { unanswered_backlog: block.arm === 'STAFFED' ? 1 : 6 },
            signals: [],
            gists: [],
            readerRefusals: 0,
          },
        ])
      }
    }

    return {
      fees: new HookFeeCreditSource(
        new InMemoryPoolFeesSweptReader(logs),
        InMemoryPoolTokenMap.fromCoins(coins),
      ),
      buyers: new InMemoryBuyerSource(buyers),
      membership: new InMemoryMembershipSource(membership),
      digests: new InMemoryDigestSource(digests),
      assets: new InMemoryAssetRegistry([USDG]),
      prices: new FixedPriceOracle({ [QUOTE]: 1 }),
      delivery: new AssumeDeliveredSource(),
    }
  }

  it('measures the 12 hours FOLLOWING each randomized block', async () => {
    const dataset = await collectBlockOutcomes(assignment, coins, sources(), START + 10 * 86_400)

    expect(dataset.outcomes).toHaveLength(2 * 2 * 2)
    for (const outcome of dataset.outcomes) {
      expect(outcome.phase).toBe('RANDOMIZED')
      expect(outcome.followWindowEndUnixExclusive - outcome.followWindowStartUnix).toBe(12 * 3_600)
      expect(outcome.primaryLog1pFeesUsd).toBeCloseTo(
        Math.log1p(outcome.arm === 'STAFFED' ? 2 : 1),
        12,
      )
      expect(outcome.feesMinorByAsset[0]!.minor).toBe(
        outcome.arm === 'STAFFED' ? 2_000_000n : 1_000_000n,
      )
      expect(outcome.unansweredBacklog).toBe(outcome.arm === 'STAFFED' ? 1 : 6)
      expect(outcome.uniqueNewBuyers).toBe(outcome.arm === 'STAFFED' ? 5 : 2)
    }
    expect(dataset.assignmentHash).toBe(assignment.assignmentHash)
    expect(dataset.firstObservationUnix).toBe(START + 12 * 3_600)
  })

  it('records the following block as a diagnostic, since the windows overlap it', async () => {
    const dataset = await collectBlockOutcomes(assignment, coins, sources(), START + 10 * 86_400)
    const first = dataset.outcomes.find((o) => o.blockIndex === 0)!
    const second = dataset.outcomes.find(
      (o) => o.blockIndex === 1 && o.coinRef === first.coinRef,
    )!
    expect(first.nextBlockArm).toBe(second.arm)
    expect(first.nextBlockArm).not.toBe(first.arm)
  })

  it('refuses to measure a coin that is not enrolled', async () => {
    await expect(
      collectBlockOutcomes(assignment, [alpha], sources(), START + 10 * 86_400),
    ).rejects.toThrow(/unenrolled/)
  })

  it('records the integrity facts the registered exclusions read', async () => {
    const dataset = await collectBlockOutcomes(assignment, coins, sources(), START + 10 * 86_400)
    for (const outcome of dataset.outcomes) {
      const coin = coins.find((c) => c.coinRef === outcome.coinRef)!
      expect(outcome.integrity.secondsSinceLaunch).toBe(
        outcome.followWindowStartUnix - coin.launchedAtUnix,
      )
      expect(outcome.integrity.valuationComplete).toBe(true)
      expect(outcome.integrity.antiSnipeUsd).toBe(0)
      expect(outcome.integrity.feeMechanism).toBe('POST_GRADUATION_SWEEP')
      expect(outcome.integrity.deliveredAsAssigned).toBe(true)
      // One credit per window in this fixture, so it is all of it.
      expect(outcome.integrity.largestCreditShare).toBeCloseTo(1, 9)
    }
  })

  it('attributes a credit inside the anti-snipe window to the windfall subtotal', async () => {
    const launched = coins.map((c) => ({ ...c, launchedAtUnix: START + 12 * 3_600 }))
    const base = sources()
    const withWindfall: PilotSources = {
      ...base,
      fees: new HookFeeCreditSource(
        new InMemoryPoolFeesSweptReader([
          // Two seconds after launch: the 99%-at-t=0 tax, on ordinary rails.
          log({
            poolId: launched[0]!.poolId,
            occurredAtUnix: START + 12 * 3_600 + 2,
            txHash: '0xsnipe',
            logIndex: 99,
            amountMinor: 900_000_000n,
          }),
        ]),
        InMemoryPoolTokenMap.fromCoins(launched),
      ),
    }
    const outcome = await measureBlock(
      launched[0]!,
      assignment.coins[0]!.blocks[0]!,
      null,
      withWindfall,
    )
    expect(outcome.integrity.antiSnipeUsd).toBeCloseTo(900, 9)
    expect(outcome.feesUsd.usd).toBeCloseTo(900, 9)
    expect(outcome.integrity.secondsSinceLaunch).toBe(0)
  })

  it('records a paused quote asset as UNMEASURED rather than as zero fees', async () => {
    const paused: PilotSources = {
      ...sources(),
      assets: new InMemoryAssetRegistry([{ ...USDG, enabled: false }]),
    }
    const outcome = await measureBlock(alpha, assignment.coins[0]!.blocks[0]!, null, paused)
    expect(outcome.integrity.valuationComplete).toBe(false)
    // NaN, not zero. The registered exclusion removes it; a failure to exclude
    // it aborts the analysis instead of averaging in a fee level that never was.
    expect(Number.isNaN(outcome.primaryLog1pFeesUsd)).toBe(true)
    expect(outcome.feesUsd.priceSource).toContain('unmeasured:')
  })

  it('still aborts collection outright when the caller asks it to', async () => {
    const paused: PilotSources = {
      ...sources(),
      assets: new InMemoryAssetRegistry([{ ...USDG, enabled: false }]),
    }
    await expect(
      measureBlock(alpha, assignment.coins[0]!.blocks[0]!, null, paused, {
        haltOnUnvaluedWindow: true,
      }),
    ).rejects.toThrow(/kill-switched/)
  })

  it('carries a delivery failure through to the outcome', async () => {
    const undelivered: PilotSources = {
      ...sources(),
      delivery: new InMemoryDeliverySource(
        new Set([InMemoryDeliverySource.keyOf(alpha.coinRef, 0)]),
      ),
    }
    const outcome = await measureBlock(alpha, assignment.coins[0]!.blocks[0]!, null, undelivered)
    expect(outcome.integrity.deliveredAsAssigned).toBe(false)
  })
})

describe('the fee mechanism, which changes underneath a coin at graduation', () => {
  const credit = (source?: 'curve_event' | 'pool_fees_swept'): FeeCredit => ({
    asset: QUOTE,
    minor: 1n,
    occurredAtUnix: START,
    blockHash: '0xb',
    txHash: '0xt',
    logIndex: 0,
    ...(source ? { source } : {}),
  })

  it('reads the rail off the credits when they say which one carried them', () => {
    expect(resolveFeeMechanism([credit('curve_event')], alpha, START)).toBe('PRE_GRADUATION_CURVE')
    expect(resolveFeeMechanism([credit('pool_fees_swept')], alpha, START)).toBe(
      'POST_GRADUATION_SWEEP',
    )
  })

  it('flags a window that saw BOTH rails, which is the graduation boundary itself', () => {
    expect(resolveFeeMechanism([credit('curve_event'), credit('pool_fees_swept')], alpha, START)).toBe(
      'MIXED',
    )
  })

  it('falls back to the graduation timestamp when the credits carry no label', () => {
    const graduated = { ...alpha, graduatedAtUnix: START }
    expect(resolveFeeMechanism([credit()], graduated, START + 1)).toBe('POST_GRADUATION_SWEEP')
    expect(resolveFeeMechanism([credit()], graduated, START - 1)).toBe('MIXED')
    expect(resolveFeeMechanism([credit()], alpha, START)).toBe('PRE_GRADUATION_CURVE')
  })

  it('reports an empty window as carrying no mechanism at all', () => {
    expect(resolveFeeMechanism([], alpha, START)).toBe('NONE')
  })
})
