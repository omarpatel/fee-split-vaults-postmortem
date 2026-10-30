import { describe, expect, it } from 'vitest'
import { parseEventSignature } from '../lib/abi.ts'
import {
  GT_LIMITS,
  GeckoTerminalClient,
  parsePoolList,
  stripNetworkPrefix,
} from '../lib/geckoterminal.ts'
import { FakeHttpClient, jsonResponse } from '../lib/http.ts'
import { backOutFeeRate, judgeAgreement, pickDeclaredTotalFeeBps } from '../fee-bps-probe.ts'
import { makeGateCount, type CoinRow } from '../addressable-market.ts'
import {
  computeEconomics,
  computeSteadyState,
  stopOrGoVerdict,
  type RepriceInputs,
} from '../reprice.ts'
import {
  QUALIFICATION_FLOOR_MONTHLY_USD,
  TERMS,
  TIERS,
  creatorNetBps,
  volumeForQf,
} from '../../config/protocol.ts'
import { loadFixture, loadFixtureText, toRawLogs, type CurveFixture } from './helpers.ts'

// ---------------------------------------------------------------------------
// GeckoTerminal
// ---------------------------------------------------------------------------

describe('geckoterminal parsing', () => {
  it('strips the network prefix from token and dex ids', () => {
    expect(stripNetworkPrefix('robinhood_0xabc')).toBe('0xabc')
    expect(stripNetworkPrefix('venue-v2-dex')).toBe('venue-v2-dex')
    expect(stripNetworkPrefix(undefined)).toBe('')
  })

  it('reads volume, reserve and the base token from a recorded page', () => {
    const pools = parsePoolList(loadFixtureText('gt-dex-pools-volume-p1.json'), 'venue-v2-dex')
    expect(pools).toHaveLength(20)
    expect(pools[0]!.volumeUsd24h).toBe(2_000_000)
    expect(pools[0]!.baseTokenAddress).toMatch(/^0x[0-9a-f]{40}$/)
    expect(pools[0]!.dexId).toBe('venue-v2-dex')
    expect(pools[0]!.createdAtUnix).toBeGreaterThan(1_700_000_000)
  })

  it('throws on a JSON:API errors block instead of returning an empty market', () => {
    expect(() => parsePoolList('{"errors":[{"title":"network not found"}]}', 'x')).toThrow(
      /network not found/,
    )
  })
})

describe('GeckoTerminalClient.enumerateDex', () => {
  function client(): { client: GeckoTerminalClient; http: FakeHttpClient } {
    const http = new FakeHttpClient([
      {
        match: (req) => req.url.includes('sort=h24_volume_usd_desc') && req.url.includes('page=1'),
        respond: jsonResponse(loadFixtureText('gt-dex-pools-volume-p1.json')),
      },
      {
        match: (req) => req.url.includes('sort=h24_volume_usd_desc') && req.url.includes('page=2'),
        respond: jsonResponse(loadFixtureText('gt-dex-pools-volume-p2.json')),
      },
      {
        match: (req) => req.url.includes('sort=pool_created_at_desc') && req.url.includes('page=1'),
        respond: jsonResponse(loadFixtureText('gt-dex-pools-created-p1.json')),
      },
    ])
    return {
      http,
      client: new GeckoTerminalClient({
        baseUrl: 'https://api.geckoterminal.com/api/v2',
        network: 'robinhood',
        http,
      }),
    }
  }

  it('UNIONS across sort orders to see pools no single sort exposes', async () => {
    const { client: gt } = client()
    const volumeOnly = await gt.enumerateDex('venue-v2-dex', ['h24_volume_usd_desc'])
    expect(volumeOnly.pools.size).toBe(32)

    const unioned = await gt.enumerateDex('venue-v2-dex', [
      'h24_volume_usd_desc',
      'pool_created_at_desc',
    ])
    // The created-at sort surfaces five pools the volume sort never reached.
    expect(unioned.pools.size).toBe(37)
    expect(unioned.coverage.perSortCounts.h24_volume_usd_desc).toBe(32)
    expect(unioned.coverage.perSortCounts.pool_created_at_desc).toBe(10)
  })

  it('stops a sort at a short page rather than paging into nothing', async () => {
    const { client: gt, http } = client()
    await gt.enumerateDex('venue-v2-dex', ['h24_volume_usd_desc'])
    // Page 2 came back with 12 < 20 rows, so page 3 was never requested.
    expect(http.requests.filter((r) => r.url.includes('page=3'))).toHaveLength(0)
  })

  it('records which sorts surfaced each pool, for coverage diagnostics', async () => {
    const { client: gt } = client()
    const unioned = await gt.enumerateDex('venue-v2-dex', [
      'h24_volume_usd_desc',
      'pool_created_at_desc',
    ])
    const shared = [...unioned.pools.values()].find((p) => p.seenVia.length > 1)
    expect(shared).toBeDefined()
  })

  it('reports hitPageCap so a truncated enumeration is never quoted as complete', async () => {
    // A dex that fills every page it is asked for must be flagged as undercounted.
    const http = new FakeHttpClient([
      { match: '/pools', respond: jsonResponse(loadFixtureText('gt-dex-pools-volume-p1.json')) },
    ])
    const gt = new GeckoTerminalClient({
      baseUrl: 'https://api.geckoterminal.com/api/v2',
      network: 'robinhood',
      http,
    })
    const result = await gt.enumerateDex('venue-v2-dex', ['h24_volume_usd_desc'], GT_LIMITS.maxPage)
    expect(result.coverage.hitPageCap).toBe(true)
    expect(result.coverage.pagesFetched).toBe(GT_LIMITS.maxPage)
  })

  it('computes a Venue-pool volume share that exposes the headline overstatement', async () => {
    const http = new FakeHttpClient([
      { match: '/tokens/', respond: jsonResponse(loadFixtureText('gt-token-pools.json')) },
    ])
    const gt = new GeckoTerminalClient({
      baseUrl: 'https://api.geckoterminal.com/api/v2',
      network: 'robinhood',
      http,
    })
    const pools = await gt.tokenPools('0xc0ffee0000000000000000000000000000000000')
    const total = pools.reduce((sum, p) => sum + p.volumeUsd24h, 0)
    const venue = pools
      .filter((p) => p.dexId === 'venue-v2-dex')
      .reduce((sum, p) => sum + p.volumeUsd24h, 0)
    expect(total).toBe(244_000_000)
    expect(venue).toBe(2_000_000)
    // Headline volume overstates fee-bearing volume by 122x, as Phase 0 saw.
    expect(total / venue).toBeCloseTo(122, 6)
  })
})

describe('makeGateCount', () => {
  const coin = (venueVolume: number): CoinRow => ({
    token: `0x${venueVolume.toString(16).padStart(40, '0')}`,
    poolCount: 1,
    poolsWithUnknownVolume: 0,
    venueVolumeUsd24h: venueVolume,
    totalObservedVolumeUsd24h: undefined,
    venuePoolVolumeShare: undefined,
    reserveUsd: 0,
    qfBuybackOffUsd: (venueVolume * creatorNetBps(false, 0)) / 10_000,
    qfBuybackOnUsd: (venueVolume * creatorNetBps(true, 0)) / 10_000,
    qfBlendedUsd: undefined,
    poolAddresses: [],
    newestPoolCreatedAtUnix: undefined,
  })

  it('reports a 2x volume swing between the two buyback branches', () => {
    const gate = makeGateCount('T1', 'T1', TIERS.T1.gateQfPerDay, [], 0, undefined)
    expect(gate.volumeNeededBuybackOn / gate.volumeNeededBuybackOff).toBeCloseTo(2, 6)
    expect(gate.volumeNeededBuybackOff).toBeCloseTo(volumeForQf(TIERS.T1.gateQfPerDay, false, 0), 6)
  })

  it('counts fewer coins above the gate when buyback is on', () => {
    // Placed relative to the two branch requirements rather than at dollar
    // figures: the point is that one coin sits BETWEEN them, and where "between"
    // is depends on the gate. Buyback halves the creator rate, so a coin needs
    // twice the volume to clear the same gate with it on.
    const needOff = volumeForQf(TIERS.T1.gateQfPerDay, false, 0)
    const needOn = volumeForQf(TIERS.T1.gateQfPerDay, true, 0)
    const coins = [
      coin(Math.round(needOff * 1.2)), // clears with buyback off only
      coin(Math.round(needOn * 1.2)), // clears on either branch
      coin(Math.round(needOff * 0.3)), // clears neither
    ]
    const gate = makeGateCount('T1', 'T1', TIERS.T1.gateQfPerDay, coins, 0, undefined)
    expect(gate.countBuybackOff).toBe(2)
    expect(gate.countBuybackOn).toBe(1)
    expect(gate.countBlended).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// fee-bps-probe
// ---------------------------------------------------------------------------

describe('backOutFeeRate', () => {
  const fixture = loadFixture<CurveFixture>('curve-buy-logs.json')
  const spec = parseEventSignature(
    'CurveBuy(address indexed buyer, address indexed token, uint256 quoteIn, uint256 tokensOut, uint256 fee)',
  )

  it('recovers the exact 100 bps the recorded trades were built at', () => {
    const reading = backOutFeeRate(spec, toRawLogs(fixture.logs), {
      quoteField: 'quoteIn',
      feeField: 'fee',
      maxTrades: 10_000,
    })
    expect(reading.trades).toBe(250)
    expect(reading.modeBps).toBe(fixture.expectedBps)
    expect(reading.modeShare).toBe(1)
    expect(reading.bpsOfGross.median).toBeCloseTo(100, 6)
  })

  it('reports the of-net reading too, so a gross/net ambiguity is visible', () => {
    const reading = backOutFeeRate(spec, toRawLogs(fixture.logs), {
      quoteField: 'quoteIn',
      feeField: 'fee',
      maxTrades: 10_000,
    })
    // fee/(quote-fee) is slightly higher than fee/quote by construction.
    expect(reading.bpsOfNet.median).toBeGreaterThan(reading.bpsOfGross.median)
    expect(reading.bpsOfNet.median).toBeCloseTo(101.01, 1)
  })

  it('honours the trade cap', () => {
    const reading = backOutFeeRate(spec, toRawLogs(fixture.logs), {
      quoteField: 'quoteIn',
      feeField: 'fee',
      maxTrades: 10,
    })
    expect(reading.trades).toBe(10)
  })

  it('skips undecodable logs instead of aborting the whole sample', () => {
    const logs = [...toRawLogs(fixture.logs).slice(0, 5), { topics: ['0xdead'], data: '0x' }]
    const reading = backOutFeeRate(spec, logs, {
      quoteField: 'quoteIn',
      feeField: 'fee',
      maxTrades: 100,
    })
    expect(reading.trades).toBe(5)
  })
})

describe('judgeAgreement', () => {
  it('AGREES when both readings match within tolerance over enough trades', () => {
    const verdict = judgeAgreement({ declaredBps: 100, empiricalBps: 100, trades: 250, toleranceBps: 1 })
    expect(verdict.verdict).toBe('AGREE')
    expect(verdict.deltaBps).toBe(0)
  })

  it('DISAGREES and quantifies how wrong the derived figures are', () => {
    const verdict = judgeAgreement({ declaredBps: 100, empiricalBps: 30, trades: 500, toleranceBps: 1 })
    expect(verdict.verdict).toBe('DISAGREE')
    expect(verdict.reasoning).toMatch(/3\.33x/)
  })

  it('fails closed to INSUFFICIENT_DATA when no getter answered', () => {
    const verdict = judgeAgreement({
      declaredBps: undefined,
      empiricalBps: 100,
      trades: 500,
      toleranceBps: 1,
    })
    expect(verdict.verdict).toBe('INSUFFICIENT_DATA')
    expect(verdict.reasoning).toMatch(/remains an INFERENCE for V2/)
  })

  it('fails closed on a thin trade sample rather than declaring agreement', () => {
    const verdict = judgeAgreement({ declaredBps: 100, empiricalBps: 100, trades: 3, toleranceBps: 1 })
    expect(verdict.verdict).toBe('INSUFFICIENT_DATA')
  })
})

describe('pickDeclaredTotalFeeBps', () => {
  it('prefers hookFeeBps over the vaguer getters', () => {
    const picked = pickDeclaredTotalFeeBps([
      { target: '0xa', signature: 'fee()', selector: '0x1', meaning: '', ok: true, value: '3000' },
      { target: '0xa', signature: 'hookFeeBps()', selector: '0x2', meaning: '', ok: true, value: '100' },
    ])
    expect(picked.bps).toBe(100)
    expect(picked.source).toContain('hookFeeBps()')
  })

  it('reports no source when every getter reverted', () => {
    const picked = pickDeclaredTotalFeeBps([
      { target: '0xa', signature: 'feeBps()', selector: '0x1', meaning: '', ok: false, error: 'reverted' },
    ])
    expect(picked.bps).toBeUndefined()
    expect(picked.source).toBe('no getter answered')
  })
})

// ---------------------------------------------------------------------------
// reprice
// ---------------------------------------------------------------------------

/**
 * The SHIPPED scenario: the rate, gate and dial the repo actually publishes,
 * read from config rather than restated. That is what makes the assertions
 * below worth anything - they check the arithmetic that the reprice decision
 * was made on, so if someone moves a published parameter into a position this
 * tool would have refused, these tests say so.
 */
function baseInputs(overrides: Partial<RepriceInputs> = {}): RepriceInputs {
  return {
    tenureDays: 12.9,
    buybackOnRate: 0.5,
    operatorBps: TERMS.operatorBps,
    qfPerDayUsd: TIERS.T1.gateQfPerDay,
    tier: 'T1',
    cogsPerDayUsd: TIERS.T1.cogsPerDay,
    budgetBps: TERMS.budgetBpsDefault,
    fixedCostMonthlyUsd: 12_000,
    cacUsd: 0,
    onboardingCostUsd: 0,
    clientsAboveGate: undefined,
    winRate: 0.1,
    goThreshold: 20,
    stopThreshold: 40,
    ...overrides,
  }
}

describe('computeEconomics', () => {
  it('blends the creator rate between the two branches', () => {
    expect(computeEconomics(baseInputs({ buybackOnRate: 0 })).blendedCreatorBps).toBeCloseTo(70, 6)
    expect(computeEconomics(baseInputs({ buybackOnRate: 1 })).blendedCreatorBps).toBeCloseTo(35, 6)
    expect(computeEconomics(baseInputs({ buybackOnRate: 0.5 })).blendedCreatorBps).toBeCloseTo(52.5, 6)
  })

  it('doubles required volume when every pool runs buyback', () => {
    const off = computeEconomics(baseInputs({ buybackOnRate: 0 }))
    const on = computeEconomics(baseInputs({ buybackOnRate: 1 }))
    expect(on.requiredVolumePerDayUsd / off.requiredVolumePerDayUsd).toBeCloseTo(2, 6)
  })

  it('computes contribution net of the tier COGS', () => {
    const inputs = baseInputs()
    const revenue = (inputs.qfPerDayUsd * inputs.operatorBps) / 10_000
    const economics = computeEconomics(inputs)
    expect(economics.operatorRevenuePerClientDayUsd).toBeCloseTo(revenue, 6)
    expect(economics.contributionPerClientDayUsd).toBeCloseTo(revenue - TIERS.T1.cogsPerDay, 6)
  })

  it('leaves a T1 client at the published gate and rate contributing positively', () => {
    // The claim the gate move was made on, checked against config rather than
    // trusted from a comment: at the shipped rate a client sitting exactly on
    // the T1 gate must out-earn the tier's own cost to serve. At the old
    // $250/day gate this assertion was FALSE - $12.50 of revenue against
    // $13.00 of COGS - and that is precisely why the gate moved.
    const economics = computeEconomics(baseInputs())
    expect(economics.contributionPerClientDayUsd).toBeGreaterThan(0)
  })

  it('flags a client sitting exactly at the qualification floor as clearing it', () => {
    // Placed ON the floor by construction. The base scenario used to land there
    // by coincidence - the old T1 gate at the default dial was exactly $1,500 a
    // month - and when the gate moved this test was quietly checking a client
    // four times above the floor against a boundary claim.
    const budgetBps = TERMS.budgetBpsDefault
    const qfAtFloor = (QUALIFICATION_FLOOR_MONTHLY_USD * 10_000) / (budgetBps * 30)
    const onTheFloor = computeEconomics(baseInputs({ qfPerDayUsd: qfAtFloor, budgetBps }))
    expect(onTheFloor.monthlyBudgetUsd).toBeCloseTo(QUALIFICATION_FLOOR_MONTHLY_USD, 6)
    expect(onTheFloor.clearsQualificationFloor).toBe(true)

    // And a hair under it does not, so the check is a floor and not a formality.
    const under = computeEconomics(baseInputs({ qfPerDayUsd: qfAtFloor * 0.999, budgetBps }))
    expect(under.clearsQualificationFloor).toBe(false)
  })

  it('subtracts acquisition and onboarding from lifetime value', () => {
    const economics = computeEconomics(baseInputs({ cacUsd: 100, onboardingCostUsd: 50 }))
    expect(economics.lifetimeValuePerClientUsd).toBeCloseTo(
      economics.lifetimeContributionPerClientUsd - 150,
      6,
    )
    expect(economics.paybackDays).toBeCloseTo(150 / economics.contributionPerClientDayUsd, 6)
  })
})

describe('computeSteadyState', () => {
  it("derives the acquisition rate from Little's Law", () => {
    const inputs = baseInputs({ tenureDays: 7 })
    const steady = computeSteadyState(inputs, computeEconomics(inputs))
    // L / W * 7 = weekly signings needed to hold the book.
    expect(steady.requiredWeeklyAcquisitions).toBeCloseTo(
      (steady.breakEvenConcurrentClients / 7) * 7,
      6,
    )
  })

  it('multiplies the sales problem as tenure shrinks, without changing break-even', () => {
    const long = baseInputs({ tenureDays: 56 })
    const short = baseInputs({ tenureDays: 2.14 })
    const longSteady = computeSteadyState(long, computeEconomics(long))
    const shortSteady = computeSteadyState(short, computeEconomics(short))
    expect(shortSteady.breakEvenConcurrentClients).toBeCloseTo(
      longSteady.breakEvenConcurrentClients,
      6,
    )
    expect(shortSteady.requiredWeeklyAcquisitions / longSteady.requiredWeeklyAcquisitions).toBeCloseTo(
      56 / 2.14,
      4,
    )
  })

  it('returns an infinite break-even when contribution is negative', () => {
    const inputs = baseInputs({ operatorBps: 100 })
    const steady = computeSteadyState(inputs, computeEconomics(inputs))
    expect(steady.breakEvenConcurrentClients).toBe(Number.POSITIVE_INFINITY)
    expect(steady.requiredWeeklyAcquisitions).toBe(Number.POSITIVE_INFINITY)
  })

  it('skips the feasibility check when the standing population is unknown', () => {
    const inputs = baseInputs()
    const steady = computeSteadyState(inputs, computeEconomics(inputs))
    expect(steady.acquisitionFeasibilityRatio).toBeUndefined()
  })
})

describe('stopOrGoVerdict', () => {
  const judge = (overrides: Partial<RepriceInputs>) => {
    const inputs = baseInputs(overrides)
    const economics = computeEconomics(inputs)
    return stopOrGoVerdict(inputs, economics, computeSteadyState(inputs, economics))
  }

  it('STOPS when a client loses money at any scale', () => {
    const verdict = judge({ operatorBps: 100 })
    expect(verdict.verdict).toBe('STOP')
    expect(verdict.headline).toMatch(/No client count fixes this/)
  })

  /**
   * The monthly fixed cost that puts break-even at a chosen client count, for
   * the base scenario. Break-even is fixedCost/30 divided by contribution per
   * client-day, so a fixed cost aimed at a target count is the only way to sit
   * a verdict test deliberately inside or outside the band. The three tests
   * below used tuned dollar figures instead, and every one of them landed in a
   * different band once contribution per client rose with the new gate.
   */
  const fixedCostForBreakEven = (clients: number, overrides: Partial<RepriceInputs> = {}) => {
    const inputs = baseInputs(overrides)
    return clients * computeEconomics(inputs).contributionPerClientDayUsd * 30
  }

  it('STOPS when break-even needs more than the stop threshold of clients', () => {
    const verdict = judge({ fixedCostMonthlyUsd: fixedCostForBreakEven(60) })
    expect(verdict.verdict).toBe('STOP')
  })

  it('GOES when break-even is at or below the go threshold and nothing else fails', () => {
    const verdict = judge({ fixedCostMonthlyUsd: fixedCostForBreakEven(10) })
    expect(verdict.verdict).toBe('GO')
    expect(verdict.checks.every((c) => c.passed)).toBe(true)
  })

  it('is MARGINAL inside the 20-40 band', () => {
    const verdict = judge({ fixedCostMonthlyUsd: fixedCostForBreakEven(30) })
    expect(verdict.verdict).toBe('MARGINAL')
    expect(verdict.headline).toMatch(/inside the 20-40 band/)
  })

  it('STOPS a client that cannot fund its cheapest deliverable', () => {
    // A hair under the floor, by construction rather than at a dollar figure.
    const budgetBps = TERMS.budgetBpsDefault
    const qfAtFloor = (QUALIFICATION_FLOOR_MONTHLY_USD * 10_000) / (budgetBps * 30)
    const verdict = judge({ qfPerDayUsd: qfAtFloor * 0.99, budgetBps, operatorBps: 2000 })
    expect(verdict.verdict).toBe('STOP')
    expect(verdict.headline).toMatch(/below the .* floor/)
  })

  it('STOPS when the market cannot supply the required signing rate', () => {
    const verdict = judge({ operatorBps: 2000, clientsAboveGate: 5, tenureDays: 30 })
    expect(verdict.verdict).toBe('STOP')
    expect(verdict.headline).toMatch(/does not produce enough qualifying coins/)
  })

  it('passes the feasibility check when the market is deep enough', () => {
    const verdict = judge({ operatorBps: 2000, clientsAboveGate: 2000, tenureDays: 12.9 })
    expect(verdict.verdict).toBe('GO')
  })

  it('names every condition it tested, so a GO is auditable', () => {
    const verdict = judge({ operatorBps: 2000, clientsAboveGate: 2000 })
    const names = verdict.checks.map((c) => c.name)
    expect(names).toContain('client contribution is positive')
    expect(names).toContain('lifetime value per client is positive')
    expect(names).toContain('client clears the qualification floor')
    expect(names).toContain('required acquisition rate is physically available')
  })

  it('is total: every combination returns one of the three verdicts', () => {
    for (const operatorBps of [1, 100, 500, 1000, 2000, 9000]) {
      for (const tenureDays of [0.5, 2.14, 12.9, 56]) {
        for (const qfPerDayUsd of [10, 250, 2500, 20_000]) {
          const verdict = judge({ operatorBps, tenureDays, qfPerDayUsd, clientsAboveGate: 100 })
          expect(['GO', 'MARGINAL', 'STOP']).toContain(verdict.verdict)
          expect(verdict.headline.length).toBeGreaterThan(0)
        }
      }
    }
  })
})
