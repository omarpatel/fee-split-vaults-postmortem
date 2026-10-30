/**
 * The missing-price guard.
 *
 * These tests exist because of one live run. An escrow whose credit assets had
 * no USD price printed this, and exited 0:
 *
 *     tier               gate  ever >= gate  7d median >= gate  run >= 7d  run >= 14d
 *     T1 Desk       $1000/day             0                  0          0           0
 *     T2 Campaign   $2500/day             0                  0          0           0
 *     T3 Flagship  $20000/day             0                  0          0           0
 *
 * The same window, priced, was 140 / 83 / 14. Every test below pins one of the
 * properties that makes that table impossible to print again.
 */

import { describe, expect, it } from 'vitest'
import { UNPRICED, sparkline, usd } from '../lib/format.ts'
import { EXIT_INCOMPLETE_MEASUREMENT, emit, type Report } from '../lib/report.ts'
import { PriceBook, nativeQuoteAsset, type QuoteAsset } from '../lib/prices.ts'
import {
  UnpricedSeriesError,
  aggregateDailyCredits,
  usdSeries,
  type EscrowSeriesDocument,
} from '../lib/series.ts'
import {
  isFullyPriced,
  peakDailyUsd,
  pricingCoverage,
  trailingMedianUsd,
  unpricedBannerLines,
  usdSeriesOrNull,
} from '../lib/unpriced.ts'
import { buybackPopulationRate } from '../lib/feemath.ts'
import { parsePoolList } from '../lib/geckoterminal.ts'
import { SECONDS_PER_DAY } from '../lib/time.ts'
import type { EscrowCredit } from '../lib/escrow.ts'
import { countAtGate, renderHuman, totalsByDay } from '../escrow-index.ts'
import { analyseGate, renderHuman as renderTenureReport } from '../tenure.ts'
import { TIERS } from '../../config/protocol.ts'

const GOLD: QuoteAsset = {
  address: '0x1111111111111111111111111111111111111111',
  symbol: 'GOLD',
  decimals: 18,
}
/** Deliberately absent from every price book below. */
const MYST = '0x2222222222222222222222222222222222222222'

const ALICE = '0xaaaa000000000000000000000000000000000001'
const BOB = '0xbbbb000000000000000000000000000000000002'

const WINDOW_DAYS = 3
const T0 = Date.UTC(2026, 8, 1) / 1000
const WINDOW_END = T0 + (WINDOW_DAYS - 1) * SECONDS_PER_DAY

function credit(
  recipient: string,
  asset: string,
  amountMinor: bigint,
  dayIndex: number,
): EscrowCredit {
  return {
    recipient,
    asset,
    assetKind: 'erc20',
    amountMinor,
    blockNumber: BigInt(dayIndex + 1),
    blockHash: `0x${'0'.repeat(64)}`,
    txHash: `0x${'0'.repeat(64)}`,
    logIndex: 0,
    timestampUnix: T0 + dayIndex * SECONDS_PER_DAY + 3_600,
  }
}

function build(credits: readonly EscrowCredit[], prices: PriceBook): EscrowSeriesDocument {
  return aggregateDailyCredits(credits, {
    escrow: '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e',
    chainId: 4663,
    mode: 'both',
    events: [{ mode: 'token', signature: 'CreditedToken(...)', topic0: `0x${'5d'.repeat(32)}` }],
    backend: 'rpc',
    fromBlock: 0n,
    toBlock: 100n,
    windowStartUnix: T0,
    windowEndUnix: WINDOW_END,
    prices,
  })
}

/** $2/unit: ALICE takes $2,000/day (clears T1, not T2), BOB takes $20/day. */
function pricedBook(): PriceBook {
  return new PriceBook({ GOLD: 2 }, 'test', T0, [GOLD, nativeQuoteAsset()])
}

/** The same assets with no price at all - the live failure. */
function emptyBook(): PriceBook {
  return new PriceBook({}, 'none', T0, [GOLD, nativeQuoteAsset()])
}

const ONE = 10n ** 18n

function creditsForBoth(asset: string = GOLD.address): EscrowCredit[] {
  const out: EscrowCredit[] = []
  for (let day = 0; day < WINDOW_DAYS; day++) {
    out.push(credit(ALICE, asset, 1_000n * ONE, day))
    out.push(credit(BOB, asset, 10n * ONE, day))
  }
  return out
}

const RENDER = { minUsd: 0, top: 25 }

// ---------------------------------------------------------------------------
// The marker itself
// ---------------------------------------------------------------------------

describe('the unknown marker', () => {
  it('never renders an unknown USD figure as a zero', () => {
    for (const value of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(usd(value)).toBe(UNPRICED)
    }
    expect(UNPRICED).not.toMatch(/0/)
    expect(usd(0)).toBe('$0.00')
    // A real zero and an unknown must never render the same way.
    expect(usd(0)).not.toBe(usd(null))
  })

  it('draws an unpriced day in a sparkline as "?", not as an idle day', () => {
    expect(sparkline([0, 0, 0], 3)).toBe('   ')
    expect(sparkline([null, null, null], 3)).toBe('???')
    // One unknown day inside an otherwise busy series stays visible.
    expect(sparkline([10, null, 10], 3)).toBe('@?@')
  })
})

// ---------------------------------------------------------------------------
// Coverage accounting
// ---------------------------------------------------------------------------

describe('pricingCoverage', () => {
  it('counts assets, recipients and raw credit events exactly', () => {
    const document = build(creditsForBoth(), emptyBook())
    const coverage = pricingCoverage(document)
    expect(coverage.complete).toBe(false)
    expect(coverage.exact).toBe(true)
    expect(coverage.assetsSeen).toBe(1)
    expect(coverage.assetsUnpriced).toBe(1)
    expect(coverage.recipientsTotal).toBe(2)
    expect(coverage.recipientsUnpriced).toBe(2)
    expect(coverage.creditsTotal).toBe(2 * WINDOW_DAYS)
    expect(coverage.creditsUnpriced).toBe(2 * WINDOW_DAYS)
    expect(coverage.unpricedCreditShare).toBe(1)
  })

  it('reports a partially priced population as incomplete, not as priced', () => {
    const credits = [...creditsForBoth(), credit(BOB, MYST, 5n * ONE, 1)]
    const coverage = pricingCoverage(build(credits, pricedBook()))
    expect(coverage.complete).toBe(false)
    expect(coverage.assetsSeen).toBe(2)
    expect(coverage.assetsUnpriced).toBe(1)
    // ALICE is fully priced; only BOB is contaminated.
    expect(coverage.recipientsUnpriced).toBe(1)
    expect(coverage.creditsUnpriced).toBe(1)
  })

  it('says so when it is fully priced', () => {
    const coverage = pricingCoverage(build(creditsForBoth(), pricedBook()))
    expect(coverage.complete).toBe(true)
    expect(coverage.recipientsUnpriced).toBe(0)
  })

  it('reconstructs coverage from a stored document and labels it inexact', () => {
    const document = build(creditsForBoth(), emptyBook())
    const { pricing: _dropped, ...legacy } = document as EscrowSeriesDocument & {
      pricing?: unknown
    }
    const coverage = pricingCoverage(legacy as EscrowSeriesDocument)
    expect(coverage.exact).toBe(false)
    expect(coverage.complete).toBe(false)
    expect(coverage.recipientsUnpriced).toBe(2)
  })

  it('puts the size of the failure in the banner', () => {
    const text = unpricedBannerLines(pricingCoverage(build(creditsForBoth(), emptyBook()))).join('\n')
    expect(text).toMatch(/NOT A MEASUREMENT OF THE MARKET/)
    expect(text).toMatch(/1 of 1 credit asset\(s\) have no USD price/)
    expect(text).toMatch(/2 of 2 recipients \(100\.0%\)/)
    expect(text).toMatch(/6 of 6 raw credit events \(100\.0%\)/)
  })
})

// ---------------------------------------------------------------------------
// Per-recipient figures
// ---------------------------------------------------------------------------

describe('per-recipient USD figures', () => {
  it('returns null, never 0, for an unpriced peak and trailing median', () => {
    const unpriced = build(creditsForBoth(), emptyBook())
    const alice = unpriced.recipients.find((r) => r.recipient === ALICE)!
    expect(alice.totalUsd).toBeNull()
    expect(peakDailyUsd(alice)).toBeNull()
    expect(trailingMedianUsd(alice, 7)).toBeNull()
    expect(isFullyPriced(alice)).toBe(false)

    const priced = build(creditsForBoth(), pricedBook())
    const alicePriced = priced.recipients.find((r) => r.recipient === ALICE)!
    expect(peakDailyUsd(alicePriced)).toBe(2_000)
    expect(trailingMedianUsd(alicePriced, 7)).toBe(2_000)
    expect(isFullyPriced(alicePriced)).toBe(true)
  })

  it('refuses to hand an unpriced series to a gate test', () => {
    const unpriced = build(creditsForBoth(), emptyBook())
    const alice = unpriced.recipients.find((r) => r.recipient === ALICE)!
    expect(() => usdSeries(alice)).toThrow(UnpricedSeriesError)
    // The renderer-facing version keeps the gaps instead of zero-filling them.
    expect(usdSeriesOrNull(alice).map((p) => p.value)).toEqual([null, null, null])
  })

  it('sums a day to null rather than to a partial total', () => {
    const credits = [...creditsForBoth(), credit(BOB, MYST, 5n * ONE, 1)]
    const days = totalsByDay(build(credits, pricedBook()))
    expect(days[0]!.usd).toBe(2_020)
    // Day 1 contains BOB's unpriced credit: the escrow-wide total is unknown,
    // not $2,020 with the unknown part quietly dropped.
    expect(days[1]!.usd).toBeNull()
    expect(days[2]!.usd).toBe(2_020)
  })
})

// ---------------------------------------------------------------------------
// The gate counts
// ---------------------------------------------------------------------------

describe('countAtGate', () => {
  it('counts a fully priced population', () => {
    const counts = countAtGate(build(creditsForBoth(), pricedBook()), TIERS.T1.gateQfPerDay)
    expect(counts.refused).toBe(false)
    expect(counts.unpricedRecipients).toBe(0)
    expect(counts.pricedRecipients).toBe(2)
    expect(counts.everAbove).toBe(1) // ALICE at $2,000/day; BOB at $20/day
    expect(counts.median7dAbove).toBe(1)
  })

  it('REFUSES rather than returning zeros when the population is unpriced', () => {
    const counts = countAtGate(build(creditsForBoth(), emptyBook()), TIERS.T1.gateQfPerDay)
    expect(counts.refused).toBe(true)
    expect(counts.unpricedRecipients).toBe(2)
    expect(counts.pricedRecipients).toBe(0)
  })

  it('refuses when even ONE member of the population is unpriced', () => {
    const credits = [...creditsForBoth(), credit(BOB, MYST, 5n * ONE, 1)]
    const counts = countAtGate(build(credits, pricedBook()), TIERS.T1.gateQfPerDay)
    // ALICE still clears the gate, so the subset count is a real 1 - but it is
    // a LOWER BOUND on the population, and `refused` is what stops it being
    // printed as a count.
    expect(counts.everAbove).toBe(1)
    expect(counts.unpricedRecipients).toBe(1)
    expect(counts.refused).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The rendered report - the actual defect
// ---------------------------------------------------------------------------

describe('escrow-index human report', () => {
  it('cannot print the table of zeros that started all this', () => {
    const report = renderHuman(build(creditsForBoth(), emptyBook()), RENDER)

    // 1. No USD figure anywhere renders as a zero.
    expect(report).not.toMatch(/\$0\.00/)
    expect(report).not.toMatch(/\$0(?!\.)/)

    // 2. The gate rows carry the marker, not a count.
    const t1 = report.split('\n').find((l) => l.includes('T1 ') && l.includes('$1000/day'))!
    expect(t1).toContain(UNPRICED)
    expect(t1).not.toMatch(/\s0\s/)

    // 3. The refusal is explained where the numbers would have been.
    expect(report).toMatch(/REFUSED, NOT ZERO/)
    expect(report).toMatch(/2 of 2 recipients have at least one day/)

    // 4. The banner leads the report, before any table.
    expect(report.indexOf('NOT A MEASUREMENT OF THE MARKET')).toBeGreaterThanOrEqual(0)
    expect(report.indexOf('NOT A MEASUREMENT OF THE MARKET')).toBeLessThan(
      report.indexOf('Population against the tier gates'),
    )
  })

  it('never contradicts itself inside a recipient row', () => {
    const report = renderHuman(build(creditsForBoth(), emptyBook()), RENDER)
    const row = report.split('\n').find((l) => l.includes('0xaaaa00'))!
    // The old row said "n/a" for the total and "$0.00" for peak/day and the 7d
    // median, in that order, on this line. Now every one of them is the marker.
    expect(row.match(new RegExp(UNPRICED, 'g'))!.length).toBeGreaterThanOrEqual(3)
    expect(row).not.toContain('$')
  })

  it('ranks by credit count when totals cannot be ranked', () => {
    const report = renderHuman(build(creditsForBoth(), emptyBook()), RENDER)
    expect(report).toMatch(/recipients by CREDIT COUNT/)
    expect(report).not.toMatch(/recipients by window total/)
  })

  it('does not silently drop unpriced recipients through --min-usd', () => {
    const report = renderHuman(build(creditsForBoth(), emptyBook()), { minUsd: 1_000, top: 25 })
    // Both recipients have an unknown total. Filtering them out because
    // `(totalUsd ?? 0) >= 1000` is false is the same bug one layer up.
    expect(report).toContain('0xaaaa00')
    expect(report).toContain('0xbbbb00')
  })

  it('still prints real counts, and no banner, when everything is priced', () => {
    const report = renderHuman(build(creditsForBoth(), pricedBook()), RENDER)
    expect(report).not.toMatch(/NOT A MEASUREMENT OF THE MARKET/)
    expect(report).not.toMatch(/REFUSED/)
    expect(report).not.toContain(UNPRICED)
    const t1 = report.split('\n').find((l) => l.includes('T1 ') && l.includes('$1000/day'))!
    expect(t1).toMatch(/\s1\s/)
    expect(report).toMatch(/recipients by window total/)
  })

  it('marks the escrow-wide mean unknown rather than averaging the priced part', () => {
    const credits = [...creditsForBoth(), credit(BOB, MYST, 5n * ONE, 1)]
    const report = renderHuman(build(credits, pricedBook()), RENDER)
    expect(report).toMatch(new RegExp(`mean ${UNPRICED}/day`))
    expect(report).toMatch(/1 of 3 days contain unpriced credits/)
  })
})

// ---------------------------------------------------------------------------
// tenure
// ---------------------------------------------------------------------------

describe('tenure gate analysis', () => {
  it('excludes unpriced recipients from a cohort instead of counting them as below the gate', () => {
    const credits = [...creditsForBoth(), credit(BOB, MYST, 5n * ONE, 1)]
    const gate = analyseGate(build(credits, pricedBook()), {
      id: 'T1',
      label: 'T1 Desk',
      gateQfPerDay: TIERS.T1.gateQfPerDay,
      sustainedDaysRequired: TIERS.T1.sustainedDays,
      qfDefinition: 'daily',
      allowGapDays: 0,
    })
    expect(gate.cohort.excludedUnpriced).toBe(1)
    expect(gate.cohort.populationFullyPriced).toBe(false)
    expect(gate.cohort.everAbove).toBe(1)
  })

  it('reports a fully priced population as a real cohort', () => {
    const gate = analyseGate(build(creditsForBoth(), pricedBook()), {
      id: 'T1',
      label: 'T1 Desk',
      gateQfPerDay: TIERS.T1.gateQfPerDay,
      sustainedDaysRequired: TIERS.T1.sustainedDays,
      qfDefinition: 'daily',
      allowGapDays: 0,
    })
    expect(gate.cohort.excludedUnpriced).toBe(0)
    expect(gate.cohort.populationFullyPriced).toBe(true)
    expect(gate.cohort.everAbove).toBe(1)
  })

  it('does not throw on an entirely unpriced document; it reports an empty priced subset', () => {
    const gate = analyseGate(build(creditsForBoth(), emptyBook()), {
      id: 'T1',
      label: 'T1 Desk',
      gateQfPerDay: TIERS.T1.gateQfPerDay,
      sustainedDaysRequired: TIERS.T1.sustainedDays,
      qfDefinition: 'daily',
      allowGapDays: 0,
    })
    expect(gate.cohort.excludedUnpriced).toBe(2)
    expect(gate.cohort.everAbove).toBe(0)
    expect(gate.cohort.populationFullyPriced).toBe(false)
  })
})

describe('tenure human report', () => {
  function tenureResult(document: EscrowSeriesDocument, gates: string[] = ['T1', 'T2', 'T3']) {
    const coverage = pricingCoverage(document)
    return {
      source: {
        escrow: document.escrow,
        eventSignature: document.eventSignature,
        backend: document.backend,
        recipients: document.recipients.length,
        totalCredits: document.totalCredits,
      },
      windowStartDayUnix: document.windowStartDayUnix,
      windowEndDayUnix: document.windowEndDayUnix,
      windowDays: document.windowDays,
      qfDefinition: 'daily' as const,
      allowGapDays: 0,
      v2AgeDaysAtWindowEnd: 34,
      measurabilityCeilingDays: WINDOW_DAYS,
      pricing: coverage,
      gates: gates.map((id) =>
        analyseGate(document, {
          id,
          label: `${id} gate`,
          gateQfPerDay: TIERS[id as 'T1' | 'T2' | 'T3'].gateQfPerDay,
          sustainedDaysRequired: TIERS[id as 'T1' | 'T2' | 'T3'].sustainedDays,
          qfDefinition: 'daily',
          allowGapDays: 0,
        }),
      ),
    }
  }

  it('refuses every cohort and tenure figure when the population is unpriced', () => {
    const report = renderTenureReport(tenureResult(build(creditsForBoth(), emptyBook())), 5)
    expect(report).toMatch(/NOT A MEASUREMENT OF THE MARKET/)
    expect(report).toMatch(/REFUSED\. 2 of 2 recipients could not be valued/)
    // No tenure statistic renders as a measured zero.
    expect(report).not.toMatch(/\s0\.00\s/)
    expect(report).not.toMatch(/\$0\.00/)
    const t1 = report.split('\n').find((l) => l.startsWith('  T1 gate'))!
    expect(t1).toContain(UNPRICED)
  })

  it('says n/a, not 0.00, for a tenure averaged over no spells at all', () => {
    // Priced population, and nobody clears T3 ($20,000/day): the COHORT is a
    // real, measured zero, but the MEAN of its spells does not exist. Printing
    // 0.00 there feeds a zero into "reprice.ts --tenure-days", which is the
    // line this very report ends with.
    const report = renderTenureReport(tenureResult(build(creditsForBoth(), pricedBook()), ['T3']), 5)
    const section = (title: string): string =>
      report.split(title)[1]!.split('\n').filter((l) => l.startsWith('  T3 gate'))[0]!

    const estimates = section('Tenure estimates, days')
    expect(estimates).not.toMatch(/\s0\.00\s/)
    expect(estimates).not.toMatch(/\s0\.0\s/)
    expect(estimates).toMatch(/n\/a/)

    // Little's Law keeps its genuine zeros - a standing stock of 0.00 above the
    // gate IS the measurement - while the tenure columns beside them stay n/a.
    const little = section("Little's Law cross-check")
    expect(little).toMatch(/\s0\.00\s/)
    expect(little).toMatch(/n\/a\s+n\/a/)

    // "mean QF standing" over an empty standing stock is n/a, not $0.00.
    const cohort = section('Cohort sizes')
    expect(cohort).not.toMatch(/\$0\.00/)
    expect(cohort).toMatch(/n\/a/)
    expect(report).not.toContain(UNPRICED)
  })
})

// ---------------------------------------------------------------------------
// The exit code
// ---------------------------------------------------------------------------

describe('emit', () => {
  function captureStdout(): { text: () => string; restore: () => void } {
    const original = process.stdout.write.bind(process.stdout)
    let buffer = ''
    process.stdout.write = ((chunk: string | Uint8Array) => {
      buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      return true
    }) as typeof process.stdout.write
    return {
      text: () => buffer,
      restore: () => {
        process.stdout.write = original
      },
    }
  }

  function report(complete: boolean): Report<{ ok: boolean }> {
    return {
      meta: {
        tool: 'test-tool',
        schemaVersion: 'test-1',
        generatedAtUnix: 0,
        config: {},
        io: { httpRequests: 0, cacheHits: 0, cacheMisses: 0 },
        warnings: [],
        methodLimits: [],
        measurementComplete: complete,
        ...(complete ? {} : { incompleteReasons: ['no price for anything'] }),
      },
      result: { ok: complete },
    }
  }

  it('exits non-zero when the run could not measure its population', async () => {
    const previous: typeof process.exitCode = process.exitCode
    const captured = captureStdout()
    try {
      await emit(report(false), { json: false, human: () => 'body' })
    } finally {
      captured.restore()
      process.exitCode = previous
    }
    expect(captured.text()).toMatch(/MEASUREMENT INCOMPLETE/)
    expect(captured.text()).toMatch(/no price for anything/)
    expect(EXIT_INCOMPLETE_MEASUREMENT).not.toBe(0)
  })

  it('sets the exit code in --json mode too, where nothing is printed to read', async () => {
    const previous: typeof process.exitCode = process.exitCode
    const captured = captureStdout()
    let observed: typeof process.exitCode
    try {
      await emit(report(false), { json: true, human: () => 'body' })
      observed = process.exitCode
    } finally {
      captured.restore()
      process.exitCode = previous
    }
    expect(observed).toBe(EXIT_INCOMPLETE_MEASUREMENT)
  })

  it('leaves a complete run alone', async () => {
    const previous: typeof process.exitCode = process.exitCode
    process.exitCode = 0
    const captured = captureStdout()
    let observed: typeof process.exitCode
    try {
      await emit(report(true), { json: false, human: () => 'body' })
      observed = process.exitCode
    } finally {
      captured.restore()
      process.exitCode = previous
    }
    expect(observed).toBe(0)
    expect(captured.text()).not.toMatch(/MEASUREMENT INCOMPLETE/)
  })
})

// ---------------------------------------------------------------------------
// The same defect class elsewhere
// ---------------------------------------------------------------------------

describe('other tables that could turn a missing input into a zero', () => {
  it('flags an empty buyback population as unmeasured rather than 0% buyback-on', () => {
    const rate = buybackPopulationRate([])
    expect(rate.measured).toBe(false)
    expect(rate.volumeWeightMeasured).toBe(false)
    // The arithmetic identities are still there for anyone who wants them; the
    // flag is what stops a renderer quoting them as a finding.
    expect(Number.isNaN(rate.buybackOnShareVolumeWeighted)).toBe(false)
  })

  it('marks a pool whose 24h volume the aggregator omitted as unknown, not as $0/day', () => {
    const body = JSON.stringify({
      data: [
        {
          id: 'robinhood_0xpool',
          attributes: { address: '0xPOOL', name: 'A/B', reserve_in_usd: '10' },
          relationships: {},
        },
      ],
    })
    const [pool] = parsePoolList(body, 'venue-v2-dex')
    expect(pool!.volumeKnown).toBe(false)
    // The numeric field is 0 only so arithmetic works; volumeKnown is what any
    // gate count has to consult before treating it as a measurement.
    expect(pool!.volumeUsd24h).toBe(0)

    const withVolume = JSON.stringify({
      data: [
        {
          id: 'robinhood_0xpool',
          attributes: { address: '0xPOOL', volume_usd: { h24: '0' } },
          relationships: {},
        },
      ],
    })
    const [zeroVolumePool] = parsePoolList(withVolume, 'venue-v2-dex')
    // A REPORTED zero is a measurement and stays one.
    expect(zeroVolumePool!.volumeKnown).toBe(true)
    expect(zeroVolumePool!.volumeUsd24h).toBe(0)
  })
})
