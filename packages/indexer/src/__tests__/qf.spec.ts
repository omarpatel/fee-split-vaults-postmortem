import { describe, expect, it } from 'vitest'
import { MissingPriceError } from '../errors.js'
import { StaticPriceOracle } from '../prices.js'
import { computeQf, finalizedCreditByAsset, median } from '../qf.js'
import { TIERS } from '../protocol.js'
import {
  ASSETS,
  assetsWith,
  binding,
  DAY,
  posting,
  dailyDollarPins,
  PRICE_ONE_DOLLAR,
  usdg,
  USDG,
  addr,
} from './helpers.js'

const prices = new StaticPriceOracle(dailyDollarPins(0, 12))

/** now = start of day 10, so days 3..9 are the trailing seven complete days. */
const NOW = 10 * DAY

function onDay(day: number, wholeUsd: number, overrides = {}) {
  return posting({
    occurredAtUnix: day * DAY + 3_600,
    creditedMinor: usdg(wholeUsd),
    finalized: true,
    ...overrides,
  })
}

describe('median', () => {
  it('takes the middle value, and the mean of the middle pair when even', () => {
    expect(median([5])).toBe(5)
    expect(median([1, 2, 3])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([])).toBe(0)
  })
})

describe('computeQf', () => {
  const base = { binding: binding({ coverageStartUnix: 0 }), assets: ASSETS, prices }

  it('resists a one-day wash spike that a mean would reward', () => {
    // Six silent days and one enormous day. A mean says $10,000/day, which
    // clears T2 ($2,500) outright. The median says $0 and grants nothing.
    const postings = [
      onDay(3, 0),
      onDay(4, 0),
      onDay(5, 0),
      onDay(6, 0),
      onDay(7, 0),
      onDay(8, 0),
      onDay(9, 70_000),
    ]

    const result = computeQf({
      ...base,
      postings,
      options: { nowUnix: NOW, gateQfPerDay: TIERS.T2.gateQfPerDay },
    })

    expect(result.measurement.qfPerDay).toBe(0)
    expect(result.meanUsdNotForGating).toBeCloseTo(10_000, 6)
    expect(result.measurement.qfPerDay).toBeLessThan(TIERS.T1.gateQfPerDay)
    expect(result.measurement.qfPerDay).toBeLessThan(TIERS.T2.gateQfPerDay)
    // One qualifying day is one sustained day, nowhere near T2's fourteen.
    expect(result.measurement.sustainedDays).toBe(1)
    expect(result.measurement.sustainedDays).toBeLessThan(TIERS.T2.sustainedDays)
  })

  it('rewards genuinely sustained flow', () => {
    const postings = [3, 4, 5, 6, 7, 8, 9].map((day) => onDay(day, 3_000))

    const result = computeQf({
      ...base,
      postings,
      options: { nowUnix: NOW, gateQfPerDay: TIERS.T1.gateQfPerDay },
    })

    expect(result.measurement.qfPerDay).toBeCloseTo(3_000, 6)
    expect(result.measurement.observedDays).toBe(7)
    expect(result.measurement.sustainedDays).toBe(7)
    expect(result.measurement.qfPerDay).toBeGreaterThan(TIERS.T1.gateQfPerDay)
  })

  it('is not fooled by half a week of flow either', () => {
    // Four good days out of seven still leaves the median inside the good days,
    // but three zero days pull it down to the fourth value, not the average.
    const postings = [
      onDay(3, 0),
      onDay(4, 0),
      onDay(5, 0),
      onDay(6, 4_000),
      onDay(7, 4_000),
      onDay(8, 4_000),
      onDay(9, 4_000),
    ]
    const result = computeQf({
      ...base,
      postings,
      options: { nowUnix: NOW, gateQfPerDay: TIERS.T1.gateQfPerDay },
    })
    expect(result.measurement.qfPerDay).toBeCloseTo(4_000, 6)
    expect(result.meanUsdNotForGating).toBeCloseTo(16_000 / 7, 6)
    expect(result.measurement.sustainedDays).toBe(4)
  })

  it('counts finalized postings only', () => {
    const postings = [3, 4, 5, 6, 7, 8, 9].map((day) => onDay(day, 3_000, { finalized: false }))
    const result = computeQf({
      ...base,
      postings,
      options: { nowUnix: NOW, gateQfPerDay: 0 },
    })
    expect(result.measurement.qfPerDay).toBe(0)
    expect(result.excluded.unfinalized).toBe(7)
  })

  it('excludes the anti-snipe windfall that would otherwise clear T3 on day one', () => {
    const postings = [
      ...[3, 4, 5, 6, 7, 8].map((day) => onDay(day, 0)),
      onDay(9, 500_000, { classification: 'anti_snipe_window' }),
    ]
    const result = computeQf({
      ...base,
      postings,
      options: { nowUnix: NOW, gateQfPerDay: TIERS.T3.gateQfPerDay },
    })
    expect(result.measurement.qfPerDay).toBe(0)
    expect(result.excluded.antiSnipe).toBe(1)
  })

  it('grants no authority on an asset the kill switch has disabled', () => {
    const postings = [3, 4, 5, 6, 7, 8, 9].map((day) => onDay(day, 3_000))
    const result = computeQf({
      ...base,
      assets: assetsWith({ enabled: false }),
      postings,
      options: { nowUnix: NOW, gateQfPerDay: 0 },
    })
    expect(result.measurement.qfPerDay).toBe(0)
    expect(result.excluded.disabledAsset).toBe(7)
    expect(result.warnings.join(' ')).toContain('kill switch')
  })

  it('excludes credits denominated in the launch token itself', () => {
    const token = addr(0x100)
    const postings = [3, 4, 5, 6, 7, 8, 9].map((day) =>
      onDay(day, 3_000, { asset: token }),
    )
    const result = computeQf({
      ...base,
      postings,
      options: { nowUnix: NOW, gateQfPerDay: 0 },
    })
    expect(result.measurement.qfPerDay).toBe(0)
    expect(result.excluded.launchToken).toBe(7)
  })

  it('reports observedDays below seven rather than assuming zero-fee history', () => {
    const result = computeQf({
      ...base,
      binding: binding({ coverageStartUnix: 7 * DAY }),
      postings: [onDay(8, 3_000), onDay(9, 3_000)],
      options: { nowUnix: NOW, gateQfPerDay: TIERS.T1.gateQfPerDay },
    })
    // Days 7, 8 and 9 are observed; days 3-6 predate coverage and are unknown.
    expect(result.measurement.observedDays).toBe(3)
    expect(result.dailyUsd).toHaveLength(3)
    expect(result.measurement.observedDays).toBeLessThan(7)
  })

  it('refuses to value a credit it has no price for', () => {
    expect(() =>
      computeQf({
        ...base,
        prices: new StaticPriceOracle([]),
        postings: [onDay(9, 3_000)],
        options: { nowUnix: NOW, gateQfPerDay: 0 },
      }),
    ).toThrow(MissingPriceError)
  })

  it('refuses a price that has gone stale rather than reusing it', () => {
    expect(() =>
      computeQf({
        ...base,
        prices: new StaticPriceOracle([{ ...PRICE_ONE_DOLLAR, pricedAtUnix: 0 }]),
        postings: [onDay(9, 3_000)],
        options: { nowUnix: NOW, gateQfPerDay: 0, maxPriceAgeSeconds: 60 },
      }),
    ).toThrow(MissingPriceError)
  })

  it('carries per-asset minor units and price provenance', () => {
    const result = computeQf({
      ...base,
      postings: [onDay(9, 1_500)],
      options: { nowUnix: NOW, gateQfPerDay: 0 },
    })
    const entry = result.measurement.perAsset.find((e) => e.asset === USDG.address.toLowerCase())
    expect(entry?.creditedMinor).toBe(usdg(1_500))
    expect(entry?.usd.usd).toBeCloseTo(1_500, 6)
    expect(entry?.usd.priceSource).toBe('test-pin')
    expect(entry?.usd.blockHash).toBeDefined()
  })
})

describe('finalizedCreditByAsset', () => {
  it('draws budget authority from finalized postings only', () => {
    const vault = addr(0x200)
    const totals = finalizedCreditByAsset(
      [
        posting({ creditedMinor: usdg(10), finalized: true }),
        posting({ creditedMinor: usdg(90), finalized: false }),
      ],
      vault,
    )
    expect(totals.get(USDG.address.toLowerCase())).toBe(usdg(10))
  })
})
