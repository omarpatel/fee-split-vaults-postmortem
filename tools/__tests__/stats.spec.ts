import { describe, expect, it } from 'vitest'
import {
  extractSpells,
  histogram,
  littlesLawCheck,
  quantiles,
  survivalCurve,
  trailingMedian,
  valueCounts,
  type Spell,
} from '../lib/stats.ts'
import { SECONDS_PER_DAY } from '../lib/time.ts'

const DAY = SECONDS_PER_DAY
const day = (n: number): number => n * DAY

function series(values: readonly number[], from = 0): Array<{ dayUnix: number; value: number }> {
  return values.map((value, i) => ({ dayUnix: day(from + i), value }))
}

describe('quantiles', () => {
  it('interpolates percentiles over a sorted sample', () => {
    const q = quantiles([1, 2, 3, 4, 5])
    expect(q.median).toBe(3)
    expect(q.p25).toBe(2)
    expect(q.p75).toBe(4)
    expect(q.mean).toBe(3)
    expect(q.sum).toBe(15)
  })

  it('returns zeros for an empty sample instead of NaN', () => {
    const q = quantiles([])
    expect(q.count).toBe(0)
    expect(q.median).toBe(0)
    expect(Number.isNaN(q.mean)).toBe(false)
  })
})

describe('trailingMedian', () => {
  it('is unmoved by a single wash-volume day, which is why the protocol uses it', () => {
    const steady = [100, 100, 100, 100, 100, 100, 100]
    const washed = [100, 100, 100, 100, 100, 100, 1_000_000]
    expect(trailingMedian(steady, 7)).toBe(100)
    expect(trailingMedian(washed, 7)).toBe(100)
    // A mean would have moved by four orders of magnitude.
    const mean = washed.reduce((a, b) => a + b, 0) / washed.length
    expect(mean).toBeGreaterThan(100_000)
  })
})

describe('extractSpells', () => {
  const window = { windowStartDayUnix: day(0), windowEndDayUnix: day(9) }

  it('cuts a single interior run and marks it uncensored at both ends', () => {
    const spells = extractSpells('a', series([0, 0, 5, 5, 5, 0, 0, 0, 0, 0]), 1, window)
    expect(spells).toHaveLength(1)
    expect(spells[0]!.days).toBe(3)
    expect(spells[0]!.leftCensored).toBe(false)
    expect(spells[0]!.rightCensored).toBe(false)
  })

  it('marks a run touching the window start as left-censored', () => {
    const spells = extractSpells('a', series([5, 5, 0, 0, 0, 0, 0, 0, 0, 0]), 1, window)
    expect(spells[0]!.leftCensored).toBe(true)
    expect(spells[0]!.rightCensored).toBe(false)
  })

  it('marks a run touching the window end as right-censored', () => {
    const spells = extractSpells('a', series([0, 0, 0, 0, 0, 0, 0, 0, 5, 5]), 1, window)
    expect(spells[0]!.rightCensored).toBe(true)
  })

  it('splits on a gap by default and bridges it when a gap is allowed', () => {
    const values = series([5, 5, 0, 5, 5, 0, 0, 0, 0, 0])
    expect(extractSpells('a', values, 1, window)).toHaveLength(2)
    const bridged = extractSpells('a', values, 1, { ...window, allowGapDays: 1 })
    expect(bridged).toHaveLength(1)
    expect(bridged[0]!.days).toBe(5)
  })

  it('treats a zero-filled day as below the gate, not as missing', () => {
    // The failure this guards: if absent days were skipped rather than zeroed,
    // every dormant stretch would vanish and tenure would be hugely overstated.
    expect(extractSpells('a', series([5, 0, 5]), 1, window)).toHaveLength(2)
  })
})

describe('survivalCurve', () => {
  const spell = (days: number, rightCensored = false): Spell => ({
    subject: 's',
    startDayUnix: day(0),
    endDayUnix: day(days - 1),
    days,
    leftCensored: false,
    rightCensored,
  })

  it('computes Kaplan-Meier survival with no censoring', () => {
    // Four spells: 1, 2, 3, 4 days. S(1) = 3/4, S(2) = 1/2, S(3) = 1/4, S(4) = 0.
    const curve = survivalCurve([spell(1), spell(2), spell(3), spell(4)])
    const at = (d: number): number => curve.points.find((p) => p.day === d)!.survival
    expect(at(1)).toBeCloseTo(0.75, 10)
    expect(at(2)).toBeCloseTo(0.5, 10)
    expect(at(3)).toBeCloseTo(0.25, 10)
    expect(at(4)).toBeCloseTo(0, 10)
    expect(curve.medianDays).toBe(2)
  })

  it('does not count a censored spell as an ending', () => {
    // Two spells of 2 days, one ended and one still running. S(2) = 1/2, not 0.
    const curve = survivalCurve([spell(2), spell(2, true)])
    expect(curve.points.find((p) => p.day === 2)!.survival).toBeCloseTo(0.5, 10)
    expect(curve.censoredSpells).toBe(1)
    expect(curve.completedSpells).toBe(1)
  })

  it('leaves the median undefined when survival never reaches 0.5', () => {
    const curve = survivalCurve([spell(5, true), spell(6, true), spell(7, true)])
    expect(curve.medianDays).toBeUndefined()
  })

  it('reports a restricted mean that is a lower bound on the naive mean when all spells are censored', () => {
    const curve = survivalCurve([spell(10, true), spell(10, true)])
    expect(curve.naiveMeanDays).toBe(10)
    // Nothing ended, so S(t) stays at 1 and the area out to 10 is 10.
    expect(curve.restrictedMeanDays).toBeCloseTo(10, 10)
    expect(curve.completedMeanDays).toBe(0)
  })

  it('shows the direction of the naive-mean bias against a known truth', () => {
    // True lengths 4 and 4, but the window cut the second at 2.
    const curve = survivalCurve([spell(4), spell(2, true)])
    expect(curve.naiveMeanDays).toBe(3)
    expect(curve.naiveMeanDays).toBeLessThan(4)
  })
})

describe("littlesLaw", () => {
  it('recovers mean tenure from a stationary population', () => {
    // One arrival per day, each lasting exactly 5 days, over a 40-day window.
    const spells: Spell[] = []
    for (let start = 0; start + 4 <= 39; start++) {
      spells.push({
        subject: `s${start}`,
        startDayUnix: day(start),
        endDayUnix: day(start + 4),
        days: 5,
        leftCensored: start === 0,
        rightCensored: start + 4 === 39,
      })
    }
    const curve = survivalCurve(spells)
    const check = littlesLawCheck(spells, {
      windowStartDayUnix: day(0),
      windowEndDayUnix: day(39),
      curve,
    })
    expect(check.arrivalsPerDay).toBeGreaterThan(0.8)
    expect(check.impliedMeanTenureDays).toBeGreaterThan(4)
    expect(check.impliedMeanTenureDays).toBeLessThan(6)
    expect(check.meanAgeOfStandingStockDays).toBeGreaterThan(0)
  })

  it('flags a non-stationary population instead of quietly averaging it', () => {
    // Everything arrives on day 0 and never leaves: L is large, lambda is tiny.
    const spells: Spell[] = Array.from({ length: 50 }, (_, i) => ({
      subject: `s${i}`,
      startDayUnix: day(0),
      endDayUnix: day(29),
      days: 30,
      leftCensored: true,
      rightCensored: true,
    }))
    const curve = survivalCurve(spells)
    const check = littlesLawCheck(spells, {
      windowStartDayUnix: day(0),
      windowEndDayUnix: day(29),
      curve,
    })
    expect(check.arrivalsPerDay).toBe(0)
    expect(check.impliedMeanTenureDays).toBeUndefined()
    expect(check.notes.join(' ')).toMatch(/too thin/)
  })
})

describe('histogram and valueCounts', () => {
  it('bins values into half-open ranges with the last bin closed', () => {
    const bins = histogram([0, 1, 5, 9, 10], [0, 5, 10])
    expect(bins[0]!.count).toBe(2)
    expect(bins[1]!.count).toBe(3)
    expect(bins[0]!.share).toBeCloseTo(0.4, 10)
  })

  it('tallies exact values in descending frequency', () => {
    const counts = valueCounts([0, 0, 0, 100, 100, 500])
    expect(counts[0]).toEqual({ value: 0, count: 3, share: 0.5 })
    expect(counts[1]!.value).toBe(100)
  })
})
