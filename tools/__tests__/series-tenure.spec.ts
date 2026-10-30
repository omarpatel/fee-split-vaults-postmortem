import { describe, expect, it } from 'vitest'
import {
  NATIVE_CREDIT_EVENT,
  RpcEscrowBackend,
  TOKEN_CREDIT_EVENT,
  resolveCreditEvent,
} from '../lib/escrow.ts'
import { NATIVE_ASSET_ADDRESS, PriceBook, nativeQuoteAsset } from '../lib/prices.ts'
import { FakeChainReader } from '../lib/rpc.ts'
import {
  ESCROW_SERIES_SCHEMA,
  aggregateDailyCredits,
  parseEscrowSeriesDocument,
  usdSeries,
  type EscrowSeriesDocument,
} from '../lib/series.ts'
import { stringifyJson, parseJson } from '../lib/json.ts'
import { SECONDS_PER_DAY } from '../lib/time.ts'
import { fullyPricedCoverage } from '../lib/unpriced.ts'
import { analyseGate, buildTenureWarnings, gateSeries, type TenureResult } from '../tenure.ts'
import { renderAssetAmount } from '../escrow-index.ts'
import { TIERS } from '../../config/protocol.ts'
import {
  loadFixture,
  toRawLogs,
  type EscrowFixture,
  type EscrowTokenFixture,
} from './helpers.ts'

const fixture = loadFixture<EscrowFixture>('escrow-credit-logs.json')
const logs = toRawLogs(fixture.logs)
const nativePlan = resolveCreditEvent(NATIVE_CREDIT_EVENT, 'native')
const nativeEvents = [
  {
    mode: 'native' as const,
    signature: nativePlan.spec.canonical,
    topic0: nativePlan.spec.topic0,
  },
]

const DURABLE = '0xaaaa000000000000000000000000000000000001'
const TEN_DAY = '0xbbbb000000000000000000000000000000000002'
const SPIKY = '0xcccc000000000000000000000000000000000003'
const DUST = '0xdddd000000000000000000000000000000000004'
const BIG = '0xeeee000000000000000000000000000000000005'

const WINDOW_END_UNIX = fixture.genesisUnix + 29 * SECONDS_PER_DAY

/** The fixture's native credits, decoded once per call through the real backend. */
async function nativeCredits(extraLogs: readonly (typeof logs)[number][] = []) {
  const all = [...logs, ...extraLogs]
  const reader = new FakeChainReader({
    chainId: 4663,
    logs: all,
    blockTimeSeconds: fixture.blockTimeSeconds,
    genesisUnix: fixture.genesisUnix,
    latestBlock: 2_600_000n,
  })
  return new RpcEscrowBackend(reader, {
    chunkBlocks: 2_600_000,
    exactTimestamps: true,
    anchorSpacing: 100_000,
  }).fetch({
    escrow: fixture.escrow,
    events: [nativePlan],
    fromBlock: 0n,
    toBlock: 2_600_000n,
    fromUnix: fixture.genesisUnix,
    toUnix: WINDOW_END_UNIX,
  })
}

function baseOptions(prices: PriceBook) {
  return {
    escrow: fixture.escrow,
    chainId: 4663,
    mode: 'native' as const,
    events: nativeEvents,
    backend: 'rpc',
    fromBlock: 0n,
    toBlock: 2_600_000n,
    windowStartUnix: fixture.genesisUnix,
    windowEndUnix: WINDOW_END_UNIX,
    prices,
  }
}

async function buildDocument(options?: { price?: number }): Promise<EscrowSeriesDocument> {
  const reader = new FakeChainReader({
    chainId: 4663,
    logs,
    blockTimeSeconds: fixture.blockTimeSeconds,
    genesisUnix: fixture.genesisUnix,
    latestBlock: 2_600_000n,
  })
  const backend = new RpcEscrowBackend(reader, {
    chunkBlocks: 2_600_000,
    exactTimestamps: true,
    anchorSpacing: 100_000,
  })
  const credits = await backend.fetch({
    escrow: fixture.escrow,
    events: [nativePlan],
    fromBlock: 0n,
    toBlock: 2_600_000n,
    fromUnix: fixture.genesisUnix,
    toUnix: fixture.genesisUnix + 29 * SECONDS_PER_DAY,
  })
  // Native credits price from ETH, not WETH: the escrow's native event carries
  // its value in msg.value and names no token at all.
  const prices = new PriceBook(
    { ETH: options?.price ?? fixture.priceUsdEth },
    'test-fixture',
    fixture.genesisUnix,
    [nativeQuoteAsset()],
  )
  return aggregateDailyCredits(credits, {
    escrow: fixture.escrow,
    chainId: 4663,
    mode: 'native',
    events: nativeEvents,
    backend: 'rpc',
    fromBlock: 0n,
    toBlock: 2_600_000n,
    windowStartUnix: fixture.genesisUnix,
    windowEndUnix: fixture.genesisUnix + 29 * SECONDS_PER_DAY,
    prices,
  })
}

describe('aggregateDailyCredits', () => {
  it('sums the two credits recorded per active day into one daily figure', async () => {
    const document = await buildDocument()
    const durable = document.recipients.find((r) => r.recipient === DURABLE)!
    // 0.15 ETH/day at $3200 = $480/day.
    expect(durable.days.every((d) => (d.usd ?? 0) === 480)).toBe(true)
    expect(durable.days[0]!.creditCount).toBe(2)
  })

  it('keys native credits by the NATIVE sentinel, never by the depositor', async () => {
    const document = await buildDocument()
    // The regression: the depositor address in every fixture log must not appear
    // anywhere in the asset space, and there must be exactly one asset.
    expect(Object.keys(document.assetKinds)).toEqual([NATIVE_ASSET_ADDRESS])
    expect(document.assetKinds[NATIVE_ASSET_ADDRESS]).toBe('native')
    expect(document.assetSymbols[NATIVE_ASSET_ADDRESS]).toBe('ETH')
    expect(Object.keys(document.priceUsdByAsset)).not.toContain(fixture.depositor)
    for (const recipient of document.recipients) {
      expect(Object.keys(recipient.totalByAssetMinor)).toEqual([NATIVE_ASSET_ADDRESS])
    }
    expect(document.unpricedAssets).toEqual([])
    expect(document.assetTotals).toHaveLength(1)
    expect(document.assetTotals[0]!.kind).toBe('native')
    expect(document.assetTotals[0]!.credits).toBe(fixture.logs.length)
  })

  it('prices the native asset from ETH, and from WETH only as a warned alias', async () => {
    const credits = await nativeCredits()
    const ethBook = new PriceBook({ ETH: 3200 }, 'env', 0, [nativeQuoteAsset()])
    expect(ethBook.priceOf(NATIVE_ASSET_ADDRESS)).toBe(3200)
    expect(ethBook.aliasWarnings()).toEqual([])

    const wethOnly = new PriceBook({ WETH: 3200 }, 'env', 0, [nativeQuoteAsset()])
    expect(wethOnly.priceOf(NATIVE_ASSET_ADDRESS)).toBe(3200)
    expect(wethOnly.aliasWarnings()).toHaveLength(1)
    expect(wethOnly.aliasWarnings()[0]).toMatch(/VENUE_PRICE_USD_ETH is not set/)
    expect(wethOnly.aliasWarnings()[0]).toMatch(/NOT the same asset/)

    // And the alias really does produce the same USD figures, so nobody has to
    // choose between "n/a everywhere" and an undocumented substitution.
    const viaEth = aggregateDailyCredits(credits, baseOptions(ethBook))
    const viaWeth = aggregateDailyCredits(credits, baseOptions(wethOnly))
    expect(viaWeth.recipients[0]!.totalUsd).toBe(viaEth.recipients[0]!.totalUsd)
  })

  it('leaves the native asset UNPRICED when only an unrelated symbol is set', async () => {
    const credits = await nativeCredits()
    const book = new PriceBook({ USDG: 1 }, 'env', 0, [nativeQuoteAsset()])
    const document = aggregateDailyCredits(credits, baseOptions(book))
    expect(document.unpricedAssets).toEqual([NATIVE_ASSET_ADDRESS])
    expect(document.recipients[0]!.totalUsd).toBeNull()
  })

  it('ZERO-FILLS inactive days rather than skipping them', async () => {
    const document = await buildDocument()
    const spiky = document.recipients.find((r) => r.recipient === SPIKY)!
    expect(spiky.days).toHaveLength(document.windowDays)
    expect(spiky.days[0]!.usd).toBe(0)
    expect(spiky.days[5]!.usd).toBe(1600)
    expect(spiky.days[8]!.usd).toBe(0)
    // Without zero-fill the two spells would collapse into one continuous run.
    expect(spiky.activeDays).toBe(5)
  })

  it('keeps minor units as exact decimal strings, never as JSON numbers', async () => {
    const document = await buildDocument()
    const durable = document.recipients.find((r) => r.recipient === DURABLE)!
    const amount = durable.days[0]!.byAssetMinor[NATIVE_ASSET_ADDRESS]
    expect(amount).toBe('150000000000000000')
    const roundTripped = parseJson<EscrowSeriesDocument>(stringifyJson(document))
    const durableAgain = roundTripped.recipients.find((r) => r.recipient === DURABLE)!
    expect(durableAgain.days[0]!.byAssetMinor).toEqual(durable.days[0]!.byAssetMinor)
  })

  it('emits null USD, not a partial sum, for an unpriced asset', async () => {
    const credits = await nativeCredits()
    const emptyBook = new PriceBook({}, 'none', 0, [nativeQuoteAsset()])
    const document = aggregateDailyCredits(credits, baseOptions(emptyBook))
    expect(document.unpricedAssets).toEqual([NATIVE_ASSET_ADDRESS])
    const durable = document.recipients.find((r) => r.recipient === DURABLE)!
    expect(durable.days[0]!.usd).toBeNull()
    expect(durable.totalUsd).toBeNull()
  })

  it('round-trips through the document validator', async () => {
    const document = await buildDocument()
    const text = stringifyJson({ meta: {}, result: document })
    expect(parseEscrowSeriesDocument(parseJson(text)).escrow).toBe(document.escrow)
  })

  it('rejects a document whose amounts arrived as JSON numbers', () => {
    const bad = {
      schema: ESCROW_SERIES_SCHEMA,
      recipients: [{ recipient: '0x1', days: [{ byAssetMinor: { '0xweth': 1.5 } }] }],
    }
    expect(() => parseEscrowSeriesDocument(bad)).toThrow(/refusing to read a JSON number/)
  })

  it('rejects a document from a different schema version', () => {
    expect(() => parseEscrowSeriesDocument({ schema: 'something-else' })).toThrow(/Re-run escrow-index/)
  })

  it('REJECTS a v1 document, whose per-asset keys were depositors', () => {
    // A -1 document keyed byAssetMinor by indexed param 1, which for the native
    // event is the depositor. Reading one as if those keys were assets is the
    // whole defect, so it must not parse at all.
    expect(() =>
      parseEscrowSeriesDocument({
        schema: 'escrow-daily-credits-1',
        recipients: [
          {
            recipient: '0xaaaa000000000000000000000000000000000001',
            days: [{ byAssetMinor: { '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044': '1' } }],
          },
        ],
      }),
    ).toThrow(/escrow-daily-credits-2/)
  })
})

/**
 * The merged mode. A run against one credit event silently undercounts, and a
 * human being expected to remember to add up two artifacts is a defect - so the
 * arithmetic of the merge is pinned here.
 */
describe('merged native + ERC-20 series', () => {
  const tokenFixture = loadFixture<EscrowTokenFixture>('escrow-credit-token-logs.json')
  const tokenLogs = toRawLogs(tokenFixture.logs)
  const tokenPlan = resolveCreditEvent(TOKEN_CREDIT_EVENT, 'token')
  const mergedEvents = [
    ...nativeEvents,
    { mode: 'token' as const, signature: tokenPlan.spec.canonical, topic0: tokenPlan.spec.topic0 },
  ]

  async function fetchWith(events: Array<typeof nativePlan | typeof tokenPlan>) {
    const all = [...logs, ...tokenLogs]
    const reader = new FakeChainReader({
      chainId: 4663,
      logs: all,
      blockTimeSeconds: fixture.blockTimeSeconds,
      genesisUnix: fixture.genesisUnix,
      latestBlock: 2_600_000n,
    })
    return new RpcEscrowBackend(reader, {
      chunkBlocks: 2_600_000,
      exactTimestamps: true,
      anchorSpacing: 100_000,
    }).fetch({
      escrow: fixture.escrow,
      events,
      fromBlock: 0n,
      toBlock: 2_600_000n,
      fromUnix: fixture.genesisUnix,
      toUnix: WINDOW_END_UNIX,
    })
  }

  function book(): PriceBook {
    return new PriceBook(
      { ETH: fixture.priceUsdEth, ...tokenFixture.priceUsdBySymbol },
      'test-fixture',
      fixture.genesisUnix,
      [nativeQuoteAsset(), ...tokenFixture.assets],
    )
  }

  function documentFor(
    credits: Awaited<ReturnType<typeof fetchWith>>,
    mode: 'native' | 'token' | 'both',
  ) {
    return aggregateDailyCredits(credits, {
      ...baseOptions(book()),
      mode,
      events: mode === 'both' ? mergedEvents : mode === 'native' ? nativeEvents : mergedEvents.slice(1),
    })
  }

  it('merged per-recipient USD equals native USD plus token USD, day by day', async () => {
    const nativeDoc = documentFor(await fetchWith([nativePlan]), 'native')
    const tokenDoc = documentFor(await fetchWith([tokenPlan]), 'token')
    const mergedDoc = documentFor(await fetchWith([nativePlan, tokenPlan]), 'both')

    const dayUsd = (doc: EscrowSeriesDocument, recipient: string, day: number): number => {
      const row = doc.recipients.find((r) => r.recipient === recipient)
      return row?.days[day]?.usd ?? 0
    }
    const everyone = new Set([
      ...nativeDoc.recipients.map((r) => r.recipient),
      ...tokenDoc.recipients.map((r) => r.recipient),
    ])
    expect(new Set(mergedDoc.recipients.map((r) => r.recipient))).toEqual(everyone)

    for (const recipient of everyone) {
      for (let day = 0; day < mergedDoc.windowDays; day++) {
        expect(dayUsd(mergedDoc, recipient, day)).toBeCloseTo(
          dayUsd(nativeDoc, recipient, day) + dayUsd(tokenDoc, recipient, day),
          8,
        )
      }
    }
    expect(mergedDoc.totalCredits).toBe(nativeDoc.totalCredits + tokenDoc.totalCredits)
  })

  it('merged minor units are summed per asset, never across assets', async () => {
    const mergedDoc = documentFor(await fetchWith([nativePlan, tokenPlan]), 'both')
    const durable = mergedDoc.recipients.find((r) => r.recipient === DURABLE)!
    // DURABLE is credited in BOTH: native every day, plus 3 TKA total.
    expect(durable.totalByAssetMinor[NATIVE_ASSET_ADDRESS]).toBe('4500000000000000000')
    expect(durable.totalByAssetMinor[tokenFixture.assets[0]!.address]).toBe('3000000000000000000')
    // 30 days x 0.15 ETH x $3200 = $14,400, plus 3 TKA x $10 = $30.
    expect(durable.totalUsd).toBeCloseTo(14_400 + 30, 8)
  })

  it('keeps native and ERC-20 distinguishable in the per-asset breakdown', async () => {
    const mergedDoc = documentFor(await fetchWith([nativePlan, tokenPlan]), 'both')
    expect(mergedDoc.mode).toBe('both')
    expect(mergedDoc.events.map((e) => e.mode)).toEqual(['native', 'token'])
    expect(mergedDoc.eventSignature).toContain(' + ')

    const kinds = mergedDoc.assetTotals.map((a) => `${a.kind}:${a.symbol}`)
    expect(kinds).toContain('native:ETH')
    expect(kinds).toContain('erc20:TKA')
    expect(kinds).toContain('erc20:TKB')
    expect(mergedDoc.assetKinds[NATIVE_ASSET_ADDRESS]).toBe('native')
    expect(mergedDoc.assetKinds[tokenFixture.assets[0]!.address]).toBe('erc20')

    // TKB is a 6-decimal asset: 6 TKB at $2 is $12, not $12e-12.
    const tkb = mergedDoc.assetTotals.find((a) => a.symbol === 'TKB')!
    expect(tkb.decimals).toBe(6)
    expect(tkb.totalMinor).toBe('6000000')
    expect(tkb.totalUsd).toBeCloseTo(12, 8)
    expect(tkb.recipients).toBe(1)
    expect(tkb.credits).toBe(2)
  })

  it('renders a tiny nonzero amount as something other than "0"', async () => {
    // A live ERC-20 asset totalled 1533009606778 minor units. Under the assumed
    // 18 decimals a 4-decimal format rounds that to "0", which reads as "this
    // asset moved nothing" - the same unknown-becomes-zero bug the UNPRICED
    // marker exists to stop, one column over.
    expect(renderAssetAmount('1533009606778', 18)).not.toBe('0')
    expect(renderAssetAmount('1', 18)).not.toBe('0')
    expect(renderAssetAmount('0', 18)).toBe('0')
    expect(renderAssetAmount('1000000000000000000', 18)).toBe('1')
    expect(renderAssetAmount('6000000', 6)).toBe('6')
  })

  it('a single-event scan is a strict UNDERCOUNT of the merged one', async () => {
    const nativeDoc = documentFor(await fetchWith([nativePlan]), 'native')
    const mergedDoc = documentFor(await fetchWith([nativePlan, tokenPlan]), 'both')
    const totalUsd = (doc: EscrowSeriesDocument): number =>
      doc.recipients.reduce((sum, r) => sum + (r.totalUsd ?? 0), 0)
    expect(totalUsd(mergedDoc)).toBeGreaterThan(totalUsd(nativeDoc))
    expect(mergedDoc.recipients.length).toBeGreaterThan(nativeDoc.recipients.length)
  })
})

/**
 * A threshold chosen against the RECORDED population rather than against a tier
 * gate. analyseGate buckets recipients around whatever number it is handed, and
 * the tests below are about the bucketing, so the threshold is derived from the
 * recipient it is meant to sit just under. A commercial gate written in here
 * ties a spell-analysis test to a parameter that moves for unrelated reasons -
 * which is exactly what happened when the T1 gate went from $250 to $1,000/day
 * and two of these tests started asserting censoring on an empty cohort.
 */
function dailyRateOf(document: EscrowSeriesDocument, recipient: string): number {
  const row = document.recipients.find((r) => r.recipient === recipient)!
  return Math.max(...usdSeries(row).map((point) => point.value))
}

/** Just under a recipient's daily credit, so that recipient is above the line. */
function justBelow(dailyUsd: number): number {
  return dailyUsd * 0.9
}

describe('gateSeries', () => {
  it('median7 smooths a single spike that daily would count as a gate crossing', () => {
    const raw = [0, 0, 0, 0, 0, 0, 10_000].map((value, i) => ({ dayUnix: i * SECONDS_PER_DAY, value }))
    expect(gateSeries(raw, 'daily')[6]!.value).toBe(10_000)
    expect(gateSeries(raw, 'median7')[6]!.value).toBe(0)
  })
})

describe('analyseGate', () => {
  it('finds the durable cohort at the T1 gate', async () => {
    const document = await buildDocument()
    const gate = analyseGate(document, {
      id: 'T1',
      label: 'T1 Desk',
      gateQfPerDay: TIERS.T1.gateQfPerDay,
      sustainedDaysRequired: TIERS.T1.sustainedDays,
      qfDefinition: 'daily',
      allowGapDays: 0,
    })

    // The recorded population is durable ($480/day), ten-day ($320), spiky
    // ($1,600 then $1,280), big ($3,200) and dust ($3.20). At the $1,000 gate
    // only spiky and big clear it, where at the old $250 gate four of the five
    // did - which is the whole reason the gate move needed measuring rather
    // than guessing: raising it thins the addressable population, and this
    // fixture is where that shows up.
    //
    // everAbove is recounted here independently of analyseGate, so the two
    // implementations have to agree; the sustain counts are the fixture's own
    // facts and are stated outright.
    const everAbove = document.recipients.filter((r) =>
      usdSeries(r).some((point) => point.value >= TIERS.T1.gateQfPerDay),
    )
    expect(gate.cohort.everAbove).toBe(everAbove.length)
    expect(gate.cohort.sustained7).toBe(1) // big only: spiky's runs are shorter
    expect(gate.cohort.sustained14).toBe(1)
    expect(gate.cohort.sustained7).toBeLessThanOrEqual(gate.cohort.everAbove)
    expect(gate.cohort.sustained14).toBeLessThanOrEqual(gate.cohort.sustained7)
    expect(gate.spells.total).toBe(3)
  })

  it('marks the always-on recipient as censored at both edges', async () => {
    const document = await buildDocument()
    // Censoring is a property of the SPELL analysis, not of any commercial gate,
    // so the threshold here is derived from the always-on recipient itself: half
    // its constant daily credit, which it is above on every day of the window by
    // construction. Pinning this to the T1 gate is what broke it - the durable
    // recipient pays $480/day and stopped clearing the gate when it moved to
    // $1,000, leaving the test asserting censoring on an empty cohort.
    const durable = document.recipients.find((r) => r.recipient === DURABLE)!
    const alwaysOnDaily = usdSeries(durable)[0]!.value
    const gate = analyseGate(document, {
      id: 'T1',
      label: 'T1',
      gateQfPerDay: alwaysOnDaily / 2,
      sustainedDaysRequired: 7,
      qfDefinition: 'daily',
      allowGapDays: 0,
    })
    expect(gate.spells.leftCensored).toBeGreaterThanOrEqual(1)
    expect(gate.spells.rightCensored).toBeGreaterThanOrEqual(1)
    expect(gate.cohort.standingAtWindowEnd).toBe(1)
  })

  it('separates the two spells of the spiky recipient', async () => {
    const document = await buildDocument()
    const spiky = document.recipients.find((r) => r.recipient === SPIKY)!
    expect(usdSeries(spiky).filter((p) => p.value > 0)).toHaveLength(5)
    const gate = analyseGate(document, {
      id: 'x',
      label: 'x',
      gateQfPerDay: justBelow(dailyRateOf(document, TEN_DAY)),
      sustainedDaysRequired: 7,
      qfDefinition: 'daily',
      allowGapDays: 0,
    })
    const spikySpells = gate.survival.points.reduce((n, p) => n + p.ended + p.censored, 0)
    expect(spikySpells).toBe(gate.spells.total)
    expect(gate.spells.total).toBe(5)
  })

  it('excludes the T2 gate’s sub-threshold coins', async () => {
    const document = await buildDocument()
    const gate = analyseGate(document, {
      id: 'T2',
      label: 'T2 Campaign',
      gateQfPerDay: TIERS.T2.gateQfPerDay,
      sustainedDaysRequired: TIERS.T2.sustainedDays,
      qfDefinition: 'daily',
      allowGapDays: 0,
    })
    // Only the $3200/day recipient clears $2500/day. Its spell runs days 10-25,
    // ending INSIDE the window, so it is uncensored and the KM median is its
    // exact 16-day length rather than "longer than we can see".
    expect(gate.cohort.everAbove).toBe(1)
    expect(gate.cohort.sustained14).toBe(1)
    expect(gate.spells.rightCensored).toBe(0)
    expect(gate.survival.medianDays).toBe(16)
    expect(gate.cohort.standingAtWindowEnd).toBe(0)
  })

  it('reports the dust recipient as invisible at every gate', async () => {
    const document = await buildDocument()
    const dust = document.recipients.find((r) => r.recipient === DUST)!
    // "Every gate" means every gate the protocol publishes, so it is measured
    // against the lowest paid tier's gate rather than against a number.
    expect(Math.max(...dust.days.map((d) => d.usd ?? 0))).toBeLessThan(TIERS.T1.gateQfPerDay)
  })

  it('bridges a one-day dropout when a gap is allowed', async () => {
    const document = await buildDocument()
    const overSpiky = justBelow(dailyRateOf(document, TEN_DAY))
    const strict = analyseGate(document, {
      id: 'a',
      label: 'a',
      gateQfPerDay: overSpiky,
      sustainedDaysRequired: 7,
      qfDefinition: 'daily',
      allowGapDays: 0,
    })
    const lenient = analyseGate(document, {
      id: 'a',
      label: 'a',
      gateQfPerDay: overSpiky,
      sustainedDaysRequired: 7,
      qfDefinition: 'daily',
      allowGapDays: 20,
    })
    // The spiky recipient's two spells merge once a long gap is tolerated.
    expect(lenient.spells.total).toBeLessThan(strict.spells.total)
  })

  it('recovers the ten-day recipient’s exact completed spell length', async () => {
    const document = await buildDocument()
    const gate = analyseGate(document, {
      id: 'a',
      label: 'a',
      gateQfPerDay: justBelow(dailyRateOf(document, TEN_DAY)),
      sustainedDaysRequired: 7,
      qfDefinition: 'daily',
      allowGapDays: 0,
    })
    // Just under the ten-day recipient's own daily credit, so it contributes a
    // completed 10-day spell; assert it appears as an ending at exactly day 10.
    const atTen = gate.survival.points.find((p) => p.day === 10)
    expect(atTen?.ended).toBe(1)
    expect(document.recipients.find((r) => r.recipient === TEN_DAY)!.activeDays).toBe(10)
  })
})

describe('buildTenureWarnings', () => {
  it('always leads with the V2 measurability ceiling', () => {
    const result: TenureResult = {
      source: { escrow: '0x0', eventSignature: 'E()', backend: 'rpc', recipients: 5, totalCredits: 10 },
      pricing: fullyPricedCoverage(5, 10, 1),
      windowStartDayUnix: 0,
      windowEndDayUnix: 29 * SECONDS_PER_DAY,
      windowDays: 30,
      qfDefinition: 'daily',
      allowGapDays: 0,
      v2AgeDaysAtWindowEnd: 33,
      measurabilityCeilingDays: 30,
      gates: [],
    }
    expect(buildTenureWarnings(result)[0]).toMatch(/ONLY ~33 DAYS OLD/)
    expect(buildTenureWarnings(result)[0]).toMatch(/does not exist yet/)
  })

  it('calls out a gate whose spells are mostly censored', async () => {
    const document = await buildDocument()
    const gate = analyseGate(document, {
      id: 'T2',
      label: 'T2 Campaign',
      gateQfPerDay: TIERS.T2.gateQfPerDay,
      sustainedDaysRequired: 14,
      qfDefinition: 'daily',
      allowGapDays: 0,
    })
    const result: TenureResult = {
      source: { escrow: '0x0', eventSignature: 'E()', backend: 'rpc', recipients: 5, totalCredits: 10 },
      pricing: fullyPricedCoverage(5, 10, 1),
      windowStartDayUnix: document.windowStartDayUnix,
      windowEndDayUnix: document.windowEndDayUnix,
      windowDays: document.windowDays,
      qfDefinition: 'daily',
      allowGapDays: 0,
      v2AgeDaysAtWindowEnd: 33,
      measurabilityCeilingDays: 30,
      gates: [gate],
    }
    const warnings = buildTenureWarnings(result).join(' ')
    expect(warnings).toMatch(/anecdote/)
  })
})
