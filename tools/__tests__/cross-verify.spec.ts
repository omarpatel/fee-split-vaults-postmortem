/**
 * cross-verify: sampling, comparison and the statistical bounds.
 *
 * Nothing here touches a network. The two "endpoints" are two FakeChainReaders
 * holding deliberately different log sets, which is the only way to test that
 * the detector actually detects - a live pair that happens to agree would test
 * nothing at all.
 */

import { describe, expect, it } from 'vitest'
import {
  agreementBound,
  apportion,
  assertNoSharedCache,
  binomialCdf,
  boundaryBlockList,
  boundaryRegions,
  binomialUpperBound,
  bloomFromLogs,
  checkBlockBloom,
  clientBuild,
  clientFamily,
  compareHeaders,
  describeFleet,
  summarizeBloomChecks,
  summarizeFleet,
  compareLogSets,
  COMPARED_HEADER_FIELDS,
  interpretBounds,
  logTupleDigest,
  logTupleKey,
  mulberry32,
  planSampleWindows,
  sampleWithoutReplacement,
  seedFromString,
  strataFromDayBoundaries,
  tileWindow,
  toLogTuple,
  totalBlocks,
  type RawBlock,
  type Stratum,
} from '../lib/cross-verify.ts'
import { scanLogs } from '../lib/logscan.ts'
import { FakeChainReader, type RawLog } from '../lib/rpc.ts'
import { VENUE } from '../../config/protocol.ts'
import { loadFixture } from './helpers.ts'

// ---------------------------------------------------------------------------

/** Block 50419076 - the measured window's first block - captured live. */
interface BloomFixture {
  blockNumber: string
  logsBloom: string
  logCount: number
  logs: Array<{ address: string; topics: string[] }>
}
const BLOOM_FIXTURE = loadFixture<BloomFixture>('block-logs-bloom.json')

// ---------------------------------------------------------------------------

const TOPIC_CREDITED = '0x4e45da441832cf53bdaa69235704fc0575e68210f459ee1562911024b12967d5'
const TOPIC_CREDITED_TOKEN = '0x5d104c62f50449fadfe6f4013c8f36588d32737f94b5ac9b83ddad33b3e1ffdf'
const ESCROW = '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e'

function log(block: number, logIndex: number, overrides: Partial<RawLog> = {}): RawLog {
  return {
    address: ESCROW,
    topics: [TOPIC_CREDITED, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`],
    data: `0x${block.toString(16).padStart(64, '0')}`,
    blockNumber: BigInt(block),
    blockHash: `0x${block.toString(16).padStart(64, '0')}`,
    transactionHash: `0x${'ab'.repeat(31)}${logIndex.toString(16).padStart(2, '0')}`,
    logIndex,
    removed: false,
    ...overrides,
  }
}

function series(from: number, to: number, perBlock = 2): RawLog[] {
  const out: RawLog[] = []
  for (let b = from; b <= to; b++) for (let i = 0; i < perBlock; i++) out.push(log(b, i))
  return out
}

// ---------------------------------------------------------------------------
// Deterministic sampling
// ---------------------------------------------------------------------------

describe('seeded sampling', () => {
  it('mulberry32 is deterministic and stable across calls', () => {
    const a = mulberry32(12345)
    const b = mulberry32(12345)
    const seqA = Array.from({ length: 8 }, () => a())
    const seqB = Array.from({ length: 8 }, () => b())
    expect(seqA).toEqual(seqB)
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true)
    // Two different seeds must not produce the same stream.
    expect(seqA).not.toEqual(Array.from({ length: 8 }, mulberry32(12346)))
  })

  it('seedFromString is stable and separates similar strings', () => {
    expect(seedFromString('venue-cross-verify-1')).toBe(seedFromString('venue-cross-verify-1'))
    expect(seedFromString('venue-cross-verify-1')).not.toBe(seedFromString('venue-cross-verify-2'))
  })

  it('sampleWithoutReplacement returns k distinct sorted indices in range', () => {
    const rand = mulberry32(seedFromString('x'))
    const picked = sampleWithoutReplacement(1000, 25, rand)
    expect(picked).toHaveLength(25)
    expect(new Set(picked).size).toBe(25)
    expect(picked.every((i) => i >= 0 && i < 1000)).toBe(true)
    expect([...picked].sort((a, b) => a - b)).toEqual(picked)
  })

  it('sampleWithoutReplacement caps k at n rather than looping forever', () => {
    const picked = sampleWithoutReplacement(5, 50, mulberry32(1))
    expect(picked).toEqual([0, 1, 2, 3, 4])
  })
})

describe('apportion', () => {
  it('gives every stratum its floor before weighting', () => {
    const seats = apportion(10, [100, 1, 1], { minPer: 2, capacities: [99, 99, 99] })
    expect(seats.every((s) => s >= 2)).toBe(true)
    expect(seats.reduce((a, b) => a + b, 0)).toBe(10)
    expect(seats[0]).toBeGreaterThan(seats[1]!)
  })

  it('never exceeds a stratum capacity', () => {
    const seats = apportion(20, [1, 1], { minPer: 0, capacities: [3, 4] })
    expect(seats).toEqual([3, 4])
  })

  it('spreads evenly when every weight is zero, rather than piling on index 0', () => {
    const seats = apportion(6, [0, 0, 0], { minPer: 0, capacities: [10, 10, 10] })
    expect(seats.reduce((a, b) => a + b, 0)).toBe(6)
    expect(Math.max(...seats) - Math.min(...seats)).toBeLessThanOrEqual(1)
  })

  it('is deterministic for the same inputs', () => {
    const args = [37, [3, 9, 1, 5, 2], { minPer: 1, capacities: [50, 50, 50, 50, 50] }] as const
    expect(apportion(...args)).toEqual(apportion(...args))
  })
})

describe('planSampleWindows', () => {
  const strata: Stratum[] = [
    { label: 'day-a', fromBlock: 0n, toBlock: 99_999n, weight: 1 },
    { label: 'day-b', fromBlock: 100_000n, toBlock: 199_999n, weight: 4 },
    { label: 'day-c', fromBlock: 200_000n, toBlock: 299_999n, weight: 0.25 },
  ]

  it('is reproducible for a seed', () => {
    const opts = { strata, windowBlocks: 5000, windowCount: 12, seed: 'abc' as const }
    const a = planSampleWindows(opts)
    const b = planSampleWindows(opts)
    expect(a.windows).toEqual(b.windows)
  })

  it('changes with the seed', () => {
    const a = planSampleWindows({ strata, windowBlocks: 5000, windowCount: 12, seed: 'abc' })
    const b = planSampleWindows({ strata, windowBlocks: 5000, windowCount: 12, seed: 'xyz' })
    expect(a.windows).not.toEqual(b.windows)
  })

  it('draws non-overlapping windows that stay inside their stratum', () => {
    const plan = planSampleWindows({
      strata,
      windowBlocks: 5000,
      windowCount: 20,
      seed: 's',
      minPerStratum: 2,
    })
    for (const w of plan.windows) {
      const stratum = strata.find((s) => s.label === w.stratum)!
      expect(w.fromBlock).toBeGreaterThanOrEqual(stratum.fromBlock)
      expect(w.toBlock).toBeLessThanOrEqual(stratum.toBlock)
      expect(w.toBlock - w.fromBlock + 1n).toBe(5000n)
    }
    const sorted = [...plan.windows].sort((a, b) => Number(a.fromBlock - b.fromBlock))
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.fromBlock).toBeGreaterThan(sorted[i - 1]!.toBlock)
    }
  })

  it('guarantees the floor to the quietest stratum, so a low weight never means zero coverage', () => {
    const plan = planSampleWindows({
      strata,
      windowBlocks: 5000,
      windowCount: 20,
      seed: 's',
      minPerStratum: 2,
      allocation: 'proportional',
    })
    for (const row of plan.strata) expect(row.windowsAllocated).toBeGreaterThanOrEqual(2)
  })

  it('gives each stratum its own PRNG stream, so adding a day does not reshuffle the others', () => {
    // A shared stream would make the sample silently non-reproducible the moment
    // the window gained or lost a day - the exact trap this guards.
    const two = planSampleWindows({
      strata: strata.slice(0, 2),
      windowBlocks: 5000,
      windowCount: 8,
      seed: 's',
      minPerStratum: 4,
      allocation: 'uniform',
    })
    const three = planSampleWindows({
      strata,
      windowBlocks: 5000,
      windowCount: 12,
      seed: 's',
      minPerStratum: 4,
      allocation: 'uniform',
    })
    const dayAfromTwo = two.windows.filter((w) => w.stratum === 'day-a').map((w) => w.fromBlock)
    const dayAfromThree = three.windows.filter((w) => w.stratum === 'day-a').map((w) => w.fromBlock)
    expect(dayAfromThree).toEqual(dayAfromTwo)
  })

  it('notes a shortfall instead of silently returning fewer windows', () => {
    const plan = planSampleWindows({
      strata: [{ label: 'tiny', fromBlock: 0n, toBlock: 9_999n, weight: 1 }],
      windowBlocks: 5000,
      windowCount: 10,
      seed: 's',
      minPerStratum: 0,
    })
    expect(plan.windows).toHaveLength(2)
    expect(plan.notes.join(' ')).toMatch(/could place 2/)
  })

  it('drops a partial trailing slot rather than comparing a short window', () => {
    const plan = planSampleWindows({
      strata: [{ label: 'ragged', fromBlock: 0n, toBlock: 12_499n, weight: 1 }],
      windowBlocks: 5000,
      windowCount: 5,
      seed: 's',
      minPerStratum: 0,
    })
    expect(plan.windows).toHaveLength(2)
    expect(plan.windows.every((w) => w.toBlock - w.fromBlock + 1n === 5000n)).toBe(true)
  })
})

describe('strataFromDayBoundaries', () => {
  it('cuts a window into per-day strata and clips to the window', () => {
    const strata = strataFromDayBoundaries(
      [
        { iso: '2026-08-31T00:00:00.000Z', block: '100' },
        { iso: '2026-09-01T00:00:00.000Z', block: '200' },
        { iso: '2026-09-02T00:00:00.000Z', block: '300' },
      ],
      { fromBlock: 150n, toBlock: 250n },
    )
    expect(strata).toEqual([
      { label: '2026-08-31', fromBlock: 150n, toBlock: 199n, weight: 0 },
      { label: '2026-09-01', fromBlock: 200n, toBlock: 250n, weight: 0 },
    ])
  })

  it('carries measured weights through by day label', () => {
    const strata = strataFromDayBoundaries(
      [
        { iso: '2026-08-31T00:00:00.000Z', block: '0' },
        { iso: '2026-09-01T00:00:00.000Z', block: '100' },
      ],
      { fromBlock: 0n, toBlock: 99n },
      new Map([['2026-08-31', 0.42]]),
    )
    expect(strata[0]!.weight).toBe(0.42)
  })
})

// ---------------------------------------------------------------------------
// Log comparison - the detector itself
// ---------------------------------------------------------------------------

describe('compareLogSets', () => {
  it('reports identical for byte-identical servings', () => {
    const logs = series(100, 120)
    const diff = compareLogSets(logs, logs.map((l) => ({ ...l })))
    expect(diff.identical).toBe(true)
    expect(diff.orderIdentical).toBe(true)
    expect(diff.matched).toBe(logs.length)
    expect(diff.mismatchedLogCount).toBe(0)
    expect(diff.mismatchedBlockCount).toBe(0)
  })

  it('DETECTS a log the secondary dropped - the failure this tool exists for', () => {
    const primary = series(100, 110)
    const secondary = primary.filter((l) => !(l.blockNumber === 105n && l.logIndex === 1))
    const diff = compareLogSets(primary, secondary)
    expect(diff.identical).toBe(false)
    expect(diff.onlyInPrimaryCount).toBe(1)
    expect(diff.onlyInSecondaryCount).toBe(0)
    expect(diff.mismatchedLogCount).toBe(1)
    expect(diff.mismatchedBlockCount).toBe(1)
    expect(diff.firstDivergenceKey).toBe('105:1')
    expect(diff.onlyInPrimary[0]!.blockNumber).toBe(105n)
  })

  it('detects a log only the secondary has', () => {
    const primary = series(100, 102)
    const secondary = [...primary, log(101, 9)]
    const diff = compareLogSets(primary, secondary)
    expect(diff.identical).toBe(false)
    expect(diff.onlyInSecondaryCount).toBe(1)
    expect(diff.firstDivergenceKey).toBe('101:9')
  })

  it.each([
    ['data', { data: `0x${'ff'.repeat(32)}` }],
    ['topics', { topics: [TOPIC_CREDITED_TOKEN, `0x${'11'.repeat(32)}`] }],
    ['address', { address: `0x${'99'.repeat(20)}` }],
    ['transactionHash', { transactionHash: `0x${'cd'.repeat(32)}` }],
  ])('detects a %s divergence at the same (block, logIndex)', (field, override) => {
    const primary = series(200, 202)
    const secondary = primary.map((l) =>
      l.blockNumber === 201n && l.logIndex === 0 ? { ...l, ...override } : l,
    )
    const diff = compareLogSets(primary, secondary)
    expect(diff.identical).toBe(false)
    expect(diff.countPrimary).toBe(diff.countSecondary)
    expect(diff.fieldDivergences.map((d) => d.field)).toContain(field)
    expect(diff.mismatchedLogCount).toBe(1)
  })

  it('counts a position differing in several fields as ONE mismatched log', () => {
    const primary = [log(300, 0)]
    const secondary = [
      log(300, 0, { data: '0xdead', address: `0x${'99'.repeat(20)}`, transactionHash: '0xbeef' }),
    ]
    const diff = compareLogSets(primary, secondary)
    expect(diff.fieldDivergenceCount).toBe(3)
    expect(diff.mismatchedLogCount).toBe(1)
    expect(diff.mismatchedBlockCount).toBe(1)
  })

  it('separates an ordering difference from a content difference', () => {
    const primary = series(400, 402)
    const secondary = [...primary].reverse()
    const diff = compareLogSets(primary, secondary)
    expect(diff.identical).toBe(true) // same set
    expect(diff.orderIdentical).toBe(false) // different serving order
  })

  it('flags a position served twice by one endpoint', () => {
    const primary = series(500, 501)
    const secondary = [...primary, log(500, 0)]
    const diff = compareLogSets(primary, secondary)
    expect(diff.duplicateKeysSecondary).toContain('500:0')
    expect(diff.identical).toBe(false)
  })

  it('orders firstDivergenceKey numerically, not lexically', () => {
    // '9:0' sorts AFTER '10:0' lexically. A lexical comparison would name the
    // wrong block as the first divergence and send a reader to the wrong place.
    const primary = [log(9, 0), log(10, 0)]
    const secondary = [log(10, 0)]
    expect(compareLogSets(primary, secondary).firstDivergenceKey).toBe('9:0')
  })

  it('keeps full counts when the reported tuple lists are truncated', () => {
    const primary = series(600, 699, 1)
    const diff = compareLogSets(primary, [], { maxReported: 5 })
    expect(diff.onlyInPrimary).toHaveLength(5)
    expect(diff.onlyInPrimaryCount).toBe(100)
    expect(diff.mismatchedLogCount).toBe(100)
  })

  it('is case-insensitive about hex, so a client casing difference is not a defect', () => {
    const primary = [log(700, 0)]
    const secondary = [
      log(700, 0, {
        address: ESCROW.toUpperCase().replace('0X', '0x'),
        topics: [TOPIC_CREDITED.toUpperCase().replace('0X', '0x'), `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`],
      }),
    ]
    expect(compareLogSets(primary, secondary).identical).toBe(true)
  })
})

describe('log tuple helpers', () => {
  it('keys by position and digests every compared field', () => {
    const tuple = toLogTuple(log(1234, 7))
    expect(logTupleKey(tuple)).toBe('1234:7')
    expect(logTupleDigest(tuple)).toContain('1234|7|')
    expect(logTupleDigest(tuple)).not.toBe(logTupleDigest(toLogTuple(log(1234, 7, { data: '0x01' }))))
  })
})

// ---------------------------------------------------------------------------
// Two endpoints, driven through the real scanner
// ---------------------------------------------------------------------------

describe('two endpoints through scanLogs', () => {
  const options = (chunkBlocks: number) => ({
    address: ESCROW,
    topics: [[TOPIC_CREDITED, TOPIC_CREDITED_TOKEN]] as Array<string | string[] | null>,
    fromBlock: 1000n,
    toBlock: 1999n,
    chunkBlocks,
    batchSize: 1,
  })

  it('agrees when both nodes hold the same logs, even at different chunk sizes', async () => {
    const logs = series(1000, 1999, 2)
    const a = new FakeChainReader({ chainId: 4663, logs })
    const b = new FakeChainReader({ chainId: 4663, logs: logs.map((l) => ({ ...l })) })
    const [primary, secondary] = [
      await scanLogs(a, options(500)),
      await scanLogs(b, options(100)),
    ]
    const diff = compareLogSets(primary, secondary)
    expect(diff.countPrimary).toBe(2000)
    expect(diff.identical).toBe(true)
    // Different chunk sizes must not change what is served.
    expect(diff.orderIdentical).toBe(true)
  })

  it('catches a node that silently drops a run of logs', async () => {
    const full = series(1000, 1999, 2)
    const holed = full.filter((l) => l.blockNumber < 1500n || l.blockNumber > 1510n)
    const a = new FakeChainReader({ chainId: 4663, logs: full })
    const b = new FakeChainReader({ chainId: 4663, logs: holed })
    const diff = compareLogSets(await scanLogs(a, options(500)), await scanLogs(b, options(500)))
    expect(diff.identical).toBe(false)
    expect(diff.onlyInPrimaryCount).toBe(22)
    expect(diff.mismatchedBlockCount).toBe(11)
    expect(diff.firstDivergenceKey).toBe('1500:0')
  })

  it('survives the halving path on a result-capped endpoint and still agrees', async () => {
    const logs = series(1000, 1999, 2)
    const a = new FakeChainReader({ chainId: 4663, logs })
    const b = new FakeChainReader({ chainId: 4663, logs: logs.map((l) => ({ ...l })) })
    // The secondary refuses anything over 200 results, forcing scanLogs to
    // narrow. A narrowed scan that lost logs would show up as a mismatch here.
    b.maxLogsPerCall = 200
    const diff = compareLogSets(await scanLogs(a, options(1000)), await scanLogs(b, options(1000)))
    expect(diff.identical).toBe(true)
    expect(diff.countSecondary).toBe(2000)
  })
})

// ---------------------------------------------------------------------------
// Header comparison
// ---------------------------------------------------------------------------

function block(overrides: Partial<Record<string, unknown>> = {}): RawBlock {
  return {
    number: '0x3018f04',
    hash: `0x${'aa'.repeat(32)}`,
    parentHash: `0x${'bb'.repeat(32)}`,
    timestamp: '0x6a9a1c3f',
    stateRoot: `0x${'cc'.repeat(32)}`,
    transactionsRoot: `0x${'dd'.repeat(32)}`,
    receiptsRoot: `0x${'ee'.repeat(32)}`,
    logsBloom: `0x${'00'.repeat(256)}`,
    gasUsed: '0x5208',
    transactions: ['0x01', '0x02'],
    ...overrides,
  }
}

describe('compareHeaders', () => {
  it('passes identical headers on every compared field', () => {
    const diff = compareHeaders(50419076n, block(), block())
    expect(diff.identical).toBe(true)
    expect(diff.fields).toHaveLength(COMPARED_HEADER_FIELDS.length)
    expect(diff.transactionCountPrimary).toBe(2)
    expect(diff.transactionCountSecondary).toBe(2)
  })

  it('flags a block-hash mismatch - the two nodes disagree about the chain', () => {
    const diff = compareHeaders(50419076n, block(), block({ hash: `0x${'ff'.repeat(32)}` }))
    expect(diff.identical).toBe(false)
    expect(diff.fields.find((f) => f.field === 'hash')!.equal).toBe(false)
  })

  it.each(['parentHash', 'timestamp', 'receiptsRoot', 'logsBloom'] as const)(
    'flags a %s mismatch',
    (field) => {
      const diff = compareHeaders(1n, block(), block({ [field]: `0x${'12'.repeat(32)}` }))
      expect(diff.identical).toBe(false)
      expect(diff.fields.find((f) => f.field === field)!.equal).toBe(false)
    },
  )

  it('normalises hex quantities so cosmetic padding is not a defect', () => {
    const diff = compareHeaders(1n, block({ timestamp: '0x0006a9a1c3f' }), block({ timestamp: '0x6A9A1C3F' }))
    expect(diff.fields.find((f) => f.field === 'timestamp')!.equal).toBe(true)
  })

  it('treats a missing block on one side as a mismatch, never as agreement', () => {
    const diff = compareHeaders(1n, block(), null)
    expect(diff.identical).toBe(false)
    expect(diff.missingSecondary).toBe(true)
    expect(diff.transactionCountSecondary).toBeNull()
  })

  it('treats a field only one node reports as a disagreement', () => {
    const withoutRoot = block()
    delete withoutRoot.receiptsRoot
    const diff = compareHeaders(1n, block(), withoutRoot)
    expect(diff.identical).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The bounds - what a clean sample actually proves
// ---------------------------------------------------------------------------

describe('binomial bounds', () => {
  it('matches the rule of three at zero failures', () => {
    // 95% upper bound with 0/n failures is 1 - 0.05^(1/n), which is ~3/n.
    for (const n of [100, 1000, 44_000]) {
      const bound = binomialUpperBound(n, 0, 0.95)
      expect(bound).toBeCloseTo(1 - Math.pow(0.05, 1 / n), 12)
      expect(bound).toBeGreaterThan(2.9 / n)
      expect(bound).toBeLessThan(3.1 / n)
    }
  })

  it('tightens as the sample grows', () => {
    const bounds = [10, 100, 1000, 10_000].map((n) => binomialUpperBound(n, 0, 0.95))
    for (let i = 1; i < bounds.length; i++) expect(bounds[i]!).toBeLessThan(bounds[i - 1]!)
  })

  it('is a genuine Clopper-Pearson bound when failures occur', () => {
    // The defining property: P(X <= k) at the returned p equals 1 - confidence.
    for (const [n, k] of [
      [10, 1],
      [100, 3],
      [5000, 12],
    ] as const) {
      const p = binomialUpperBound(n, k, 0.95)
      expect(binomialCdf(k, n, p)).toBeCloseTo(0.05, 6)
    }
    expect(binomialUpperBound(10, 1, 0.95)).toBeCloseTo(0.3942, 3)
  })

  it('refuses to claim anything from an empty sample', () => {
    expect(binomialUpperBound(0, 0, 0.95)).toBe(1)
    expect(binomialUpperBound(5, 5, 0.95)).toBe(1)
  })

  it('widens with a higher confidence level', () => {
    expect(binomialUpperBound(1000, 0, 0.99)).toBeGreaterThan(binomialUpperBound(1000, 0, 0.95))
  })
})

describe('agreementBound', () => {
  it('reports coverage and the implied affected count', () => {
    const bound = agreementBound({
      unit: 'log',
      trials: 1000,
      mismatches: 0,
      populationSize: 1_000_000,
    })
    expect(bound.coverage).toBeCloseTo(0.001, 9)
    expect(bound.impliedMaxAffected).toBe(Math.ceil(1_000_000 * bound.upperBoundRate))
    expect(bound.impliedMaxAffected).toBeGreaterThan(0)
  })

  it('leaves the implied count unknown rather than zero when the population is unknown', () => {
    const bound = agreementBound({ unit: 'log', trials: 10, mismatches: 0 })
    expect(bound.impliedMaxAffected).toBeNull()
    expect(bound.coverage).toBeNull()
  })
})

describe('interpretBounds', () => {
  const bounds = (windows: number, windowBlocks: number, logs: number) => ({
    perLog: agreementBound({ unit: 'log', trials: logs, mismatches: 0, populationSize: 1_300_000 }),
    perBlock: agreementBound({
      unit: 'block',
      trials: windows * windowBlocks,
      mismatches: 0,
      populationSize: 5_969_973,
    }),
    perWindow: agreementBound({
      unit: 'window',
      trials: windows,
      mismatches: 0,
      populationSize: Math.floor(5_969_973 / windowBlocks),
    }),
    windowBlocks,
  })

  it('expresses the clustered bound in WINDOWS x windowBlocks, not via the per-block rate', () => {
    // Regression: an earlier version converted the clustered bound using the
    // per-block bound, understating it by the sampling ratio - it printed
    // "~2,236 blocks" where the honest figure was over a million. That is the
    // one arithmetic slip that would make this report materially false.
    const b = bounds(40, 5000, 44_000)
    const lines = interpretBounds({ ...b, clientPrimary: null, clientSecondary: null })
    const clustered = lines.find((l) => l.includes('SHAPE 3'))!
    const expectedBlocks = b.perWindow.impliedMaxAffected! * 5000
    expect(clustered).toContain(expectedBlocks.toLocaleString())
    expect(expectedBlocks).toBeGreaterThan(b.perBlock.impliedMaxAffected!)
  })

  it('names the clustered bound as the one to quote', () => {
    const lines = interpretBounds({ ...bounds(40, 5000, 44_000), clientPrimary: null, clientSecondary: null })
    expect(lines.find((l) => l.includes('SHAPE 3'))).toMatch(/BOUND TO QUOTE/)
  })

  it('calls out common-mode risk when both endpoints run the same client family', () => {
    const lines = interpretBounds({
      ...bounds(40, 5000, 44_000),
      clientPrimary: 'nitro/v3.11.4-rc.3-7d5ac27/linux-arm64/go1.25.14',
      clientSecondary: 'nitro/v3.11.2-3599aca/linux-amd64/go1.25.11',
    })
    const line = lines.find((l) => l.includes('CLIENT'))!
    expect(line).toMatch(/SAME CLIENT FAMILY/)
    expect(line).toMatch(/NO sample size here can detect it/)
  })

  it('says so when the clients differ, which is the stronger check', () => {
    const lines = interpretBounds({
      ...bounds(40, 5000, 44_000),
      clientPrimary: 'nitro/v3.11.4/linux-arm64',
      clientSecondary: 'erigon/v2.60.0/linux-amd64',
    })
    expect(lines.join(' ')).toMatch(/different client families/i)
  })

  it('leads with the disagreement when mismatches were found', () => {
    const b = bounds(40, 5000, 44_000)
    const lines = interpretBounds({
      ...b,
      perLog: agreementBound({ unit: 'log', trials: 44_000, mismatches: 7, populationSize: 1_300_000 }),
      perWindow: agreementBound({ unit: 'window', trials: 40, mismatches: 2, populationSize: 1193 }),
      clientPrimary: null,
      clientSecondary: null,
    })
    expect(lines[0]).toMatch(/DISAGREE/)
  })
})

describe('clientFamily', () => {
  it.each([
    ['nitro/v3.11.4-rc.3-7d5ac27/linux-arm64/go1.25.14', 'nitro'],
    ['nitro/v3.11.2-3599aca/linux-amd64/go1.25.11', 'nitro'],
    ['erigon/v2.60.0/linux-amd64/go1.22', 'erigon'],
    ['Geth/v1.14.0-stable/linux-amd64/go1.22', 'geth'],
  ])('%s -> %s', (version, family) => {
    expect(clientFamily(version)).toBe(family)
  })
})

// ---------------------------------------------------------------------------
// Fleet detection
//
// Measured on chain 4663: rpc.mainnet.chain.robinhood.com answers from at
// least two machines - the same nitro build on linux-amd64 and linux-arm64.
// One probe cannot see that, and reporting one draw as "the endpoint's
// version" overstates what was learned.
// ---------------------------------------------------------------------------

const POOL_ARM = 'nitro/v3.11.4-rc.3-7d5ac27/linux-arm64/go1.25.14'
const POOL_AMD = 'nitro/v3.11.4-rc.3-7d5ac27/linux-amd64/go1.25.14'

describe('clientBuild', () => {
  it('drops the platform tuple so two arches of one build compare equal', () => {
    expect(clientBuild(POOL_ARM)).toBe('nitro/v3.11.4-rc.3-7d5ac27')
    expect(clientBuild(POOL_ARM)).toBe(clientBuild(POOL_AMD))
  })

  it('returns a version without a platform tuple unchanged', () => {
    expect(clientBuild('nitro')).toBe('nitro')
  })
})

describe('summarizeFleet', () => {
  it('reports one node when every probe agrees', () => {
    const fleet = summarizeFleet([POOL_ARM, POOL_ARM, POOL_ARM])
    expect(fleet.heterogeneous).toBe(false)
    expect(fleet.versions).toEqual([POOL_ARM])
    expect(fleet.samples).toBe(3)
  })

  it('DETECTS the real chain-4663 pool: one build, two architectures', () => {
    const fleet = summarizeFleet([POOL_ARM, POOL_AMD, POOL_ARM, POOL_ARM, POOL_AMD])
    expect(fleet.heterogeneous).toBe(true)
    expect(fleet.versions).toHaveLength(2)
    expect(fleet.builds).toEqual(['nitro/v3.11.4-rc.3-7d5ac27'])
    expect(fleet.sameBuildDifferentPlatform).toBe(true)
    expect(fleet.families).toEqual(['nitro'])
  })

  it('separates a genuine build spread from a mere platform spread', () => {
    const fleet = summarizeFleet([POOL_ARM, 'nitro/v3.11.2-3599aca/linux-amd64/go1.25.11'])
    expect(fleet.heterogeneous).toBe(true)
    expect(fleet.builds).toHaveLength(2)
    expect(fleet.sameBuildDifferentPlatform).toBe(false)
  })

  it('ignores empty probe results rather than counting them as a build', () => {
    const fleet = summarizeFleet([POOL_ARM, '', POOL_ARM])
    expect(fleet.samples).toBe(2)
    expect(fleet.versions).toEqual([POOL_ARM])
  })

  it('survives an endpoint that answered nothing', () => {
    const fleet = summarizeFleet([])
    expect(fleet.samples).toBe(0)
    expect(fleet.heterogeneous).toBe(false)
    expect(fleet.versions).toEqual([])
  })
})

describe('describeFleet', () => {
  it('stays SILENT when one version was seen, rather than claiming a single node', () => {
    // Absence of evidence for a pool is not evidence of a single node.
    expect(describeFleet('primary', 'rpc.example', summarizeFleet([POOL_ARM, POOL_ARM]))).toBeNull()
  })

  it('states BOTH halves for a same-build pool: weaker single-node risk, unchanged common mode', () => {
    const note = describeFleet(
      'primary',
      'rpc.mainnet.chain.robinhood.com',
      summarizeFleet([POOL_ARM, POOL_AMD]),
    )
    expect(note).toContain('LOAD-BALANCED POOL, NOT ONE NODE')
    expect(note).toContain('rpc.mainnet.chain.robinhood.com')
    // The half that would be easy to omit, and is the reason the pool does not
    // help: identical code on different silicon fails identically.
    expect(note).toMatch(/buys NOTHING against a defect in the build itself/)
    expect(note).toContain('overstates that risk')
  })

  it('does not claim a platform-only spread when the builds genuinely differ', () => {
    const note = describeFleet(
      'secondary',
      'rpc.example',
      summarizeFleet([POOL_ARM, 'erigon/v2.60.0/linux-amd64/go1.22']),
    )
    expect(note).toContain('LOAD-BALANCED POOL')
    expect(note).not.toContain('differ only')
  })
})

// ---------------------------------------------------------------------------
// logsBloom verification
//
// The fixture is a REAL chain-4663 block: 50419076, the first block of the
// measured window, with its real header bloom and its 89 real logs. A
// hand-made bloom would only prove the code agrees with itself.
// ---------------------------------------------------------------------------

describe('bloomFromLogs / checkBlockBloom', () => {
  const BLOCK = 50419076n

  it('reproduces the real header bloom of a real block from its real logs', () => {
    const check = checkBlockBloom(BLOCK, BLOOM_FIXTURE.logsBloom, BLOOM_FIXTURE.logs)
    expect(check.matches).toBe(true)
    expect(check.logCount).toBe(BLOOM_FIXTURE.logs.length)
    expect(check.computedBloom.toLowerCase()).toBe(BLOOM_FIXTURE.logsBloom.toLowerCase())
  })

  it('is order-independent and returns a 256-byte filter', () => {
    const forwards = bloomFromLogs(BLOOM_FIXTURE.logs)
    const backwards = bloomFromLogs([...BLOOM_FIXTURE.logs].reverse())
    expect(forwards).toBe(backwards)
    expect(forwards).toMatch(/^0x[0-9a-f]{512}$/)
  })

  it('CATCHES a whole contract dropped from the block - the defect this repo fears', () => {
    // A node whose log index is short for one contract. Measured live: caught
    // in every case tested, and it is caught here.
    const escrow = VENUE.contracts.v2FeeEscrow.toLowerCase()
    const withoutEscrow = BLOOM_FIXTURE.logs.filter((l) => l.address.toLowerCase() !== escrow)
    expect(withoutEscrow.length).toBeLessThan(BLOOM_FIXTURE.logs.length)
    expect(checkBlockBloom(BLOCK, BLOOM_FIXTURE.logsBloom, withoutEscrow).matches).toBe(false)
  })

  it('catches an added log that was never in the block', () => {
    const extra = [
      ...BLOOM_FIXTURE.logs,
      {
        address: '0x000000000000000000000000000000000000dead',
        topics: ['0x' + 'ab'.repeat(32)],
      },
    ]
    expect(checkBlockBloom(BLOCK, BLOOM_FIXTURE.logsBloom, extra).matches).toBe(false)
  })

  it('is WEAK against one dropped log, and the test says so out loud', () => {
    // Measured live on three blocks: only 22.9%-34.1% of single-log drops are
    // caught, because a surviving log usually sets the same bits. This asserts
    // the weakness rather than hiding it - a future change that claimed higher
    // power would be wrong, not an improvement.
    let caught = 0
    for (let i = 0; i < BLOOM_FIXTURE.logs.length; i++) {
      const short = BLOOM_FIXTURE.logs.filter((_, j) => j !== i)
      if (!checkBlockBloom(BLOCK, BLOOM_FIXTURE.logsBloom, short).matches) caught++
    }
    const rate = caught / BLOOM_FIXTURE.logs.length
    expect(rate).toBeGreaterThan(0.15)
    expect(rate).toBeLessThan(0.6)
  })

  it('reports a missing header as a FAILED check, never as a pass', () => {
    const check = checkBlockBloom(BLOCK, null, BLOOM_FIXTURE.logs)
    expect(check.matches).toBe(false)
    expect(check.error).toMatch(/could not be verified/)
    expect(check.headerBloom).toBeNull()
  })

  it('treats an empty block as verifiable rather than skipping it', () => {
    const empty = '0x' + '00'.repeat(256)
    expect(checkBlockBloom(BLOCK, empty, []).matches).toBe(true)
  })
})

describe('summarizeBloomChecks', () => {
  const pass = { blockNumber: '1', logCount: 3, headerBloom: '0xaa', computedBloom: '0xaa', matches: true }
  const fail = { blockNumber: '2', logCount: 3, headerBloom: '0xaa', computedBloom: '0xbb', matches: false }

  it('says the common-mode thing when every block verifies', () => {
    const s = summarizeBloomChecks([pass, pass])
    expect(s.matched).toBe(2)
    expect(s.failed).toBe(0)
    expect(s.notes.join(' ')).toContain('COMMON-MODE')
  })

  it('calls a failure disqualifying and does not bury it in caveats', () => {
    const s = summarizeBloomChecks([pass, fail])
    expect(s.failed).toBe(1)
    expect(s.notes[0]).toMatch(/does NOT reproduce/)
    expect(s.notes[0]).toMatch(/disqualifying/)
  })

  it('always states the power caveat, including on a clean run', () => {
    expect(summarizeBloomChecks([pass]).notes.join(' ')).toMatch(/superset filter/)
  })

  it('returns nothing to say for an empty check set', () => {
    expect(summarizeBloomChecks([]).notes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

describe('assertNoSharedCache', () => {
  it('refuses a scan cache, because the cache key omits the endpoint', () => {
    // Without this, the secondary would be answered from the primary's own
    // cached logs and every comparison in this tool would pass unconditionally.
    expect(() => assertNoSharedCache({ address: ESCROW, cache: {} })).toThrow(/refuses a scan cache/)
  })

  it('passes an uncached scan through unchanged', () => {
    const options = { address: ESCROW, fromBlock: 1n, toBlock: 2n }
    expect(assertNoSharedCache(options)).toBe(options)
  })
})

describe('boundaryRegions', () => {
  it('returns the first and last N blocks of a long window', () => {
    const regions = boundaryRegions({ fromBlock: 50419076n, toBlock: 56389048n }, 25)
    expect(regions).toEqual([
      { region: 'head', window: { fromBlock: 50419076n, toBlock: 50419100n } },
      { region: 'tail', window: { fromBlock: 56389024n, toBlock: 56389048n } },
    ])
  })

  it('collapses to ONE region when head and tail would overlap', () => {
    // Comparing an overlapping range twice would report agreement it never
    // independently observed, and inflate the boundary count.
    const regions = boundaryRegions({ fromBlock: 100n, toBlock: 130n }, 25)
    expect(regions).toEqual([{ region: 'head', window: { fromBlock: 100n, toBlock: 130n } }])
  })

  it('collapses at the exact boundary where the two regions touch', () => {
    expect(boundaryRegions({ fromBlock: 0n, toBlock: 49n }, 25)).toHaveLength(1)
    expect(boundaryRegions({ fromBlock: 0n, toBlock: 50n }, 25)).toHaveLength(2)
  })

  it('returns nothing for a non-positive request or an empty window', () => {
    expect(boundaryRegions({ fromBlock: 10n, toBlock: 20n }, 0)).toEqual([])
    expect(boundaryRegions({ fromBlock: 20n, toBlock: 10n }, 5)).toEqual([])
  })

  it('lists every boundary block once, ascending', () => {
    const blocks = boundaryBlockList({ fromBlock: 1000n, toBlock: 1999n }, 3)
    expect(blocks).toEqual([1000n, 1001n, 1002n, 1997n, 1998n, 1999n])
    expect(new Set(blocks.map(String)).size).toBe(blocks.length)
  })

  it('does not double-count a block when the regions collapse', () => {
    const blocks = boundaryBlockList({ fromBlock: 0n, toBlock: 9n }, 25)
    expect(blocks).toHaveLength(10)
    expect(new Set(blocks.map(String)).size).toBe(10)
  })
})

describe('tileWindow', () => {
  it('tiles exactly, with no gap and no overlap', () => {
    const tiles = tileWindow({ fromBlock: 1000n, toBlock: 5999n }, 1000)
    expect(tiles).toHaveLength(5)
    expect(tiles[0]).toEqual({ fromBlock: 1000n, toBlock: 1999n })
    for (let i = 1; i < tiles.length; i++) {
      expect(tiles[i]!.fromBlock).toBe(tiles[i - 1]!.toBlock + 1n)
    }
    expect(tiles.at(-1)!.toBlock).toBe(5999n)
    expect(totalBlocks(tiles)).toBe(5000)
  })

  it('clips a ragged tail to the window rather than overrunning it', () => {
    const tiles = tileWindow({ fromBlock: 0n, toBlock: 2499n }, 1000)
    expect(tiles.at(-1)).toEqual({ fromBlock: 2000n, toBlock: 2499n })
    expect(totalBlocks(tiles)).toBe(2500)
  })
})
