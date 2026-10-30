import { describe, expect, it } from 'vitest'

import { makeRng } from '../hash.js'
import {
  bootstrapHodgesLehmannPaired,
  bootstrapTwoSampleShift,
  erf,
  hodgesLehmannPaired,
  hodgesLehmannTwoSample,
  logShiftToPercent,
  mean,
  median,
  medianInPlace,
  normalCdf,
  normalQuantile,
  permutationTestTwoSample,
  quantileSorted,
  rankAverage,
  standardNormal,
  StatsError,
  wilcoxonSignedRank,
} from '../stats.js'

describe('location', () => {
  it('computes mean and median', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5)
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })

  it('refuses a non-finite sample rather than propagating NaN into a decision', () => {
    expect(() => mean([1, Number.NaN])).toThrow(StatsError)
    expect(() => median([])).toThrow(StatsError)
  })

  it('quickselect agrees with a full sort on random data', () => {
    const rng = makeRng('quickselect-check')
    for (let trial = 0; trial < 60; trial += 1) {
      const n = 1 + rng.nextInt(80)
      const values = Array.from({ length: n }, () => rng.next() * 200 - 100)
      const sorted = [...values].sort((a, b) => a - b)
      const expected =
        n % 2 === 1
          ? sorted[(n - 1) / 2]!
          : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2
      expect(medianInPlace([...values])).toBeCloseTo(expected, 12)
    }
  })

  it('interpolates quantiles on a sorted sample', () => {
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBe(2.5)
    expect(quantileSorted([1, 2, 3, 4], 0)).toBe(1)
    expect(quantileSorted([1, 2, 3, 4], 1)).toBe(4)
  })
})

describe('normal tail', () => {
  // A&S 7.1.26 is accurate to 1.5e-7 absolute, so 7 decimals is the honest bar.
  it('matches known values of erf and the standard normal cdf', () => {
    expect(erf(0)).toBeCloseTo(0, 7)
    expect(erf(1)).toBeCloseTo(0.842700792, 6)
    expect(erf(-1)).toBeCloseTo(-0.842700792, 6)
    expect(erf(2)).toBeCloseTo(0.995322265, 6)
    expect(normalCdf(0)).toBeCloseTo(0.5, 7)
    expect(normalCdf(1.959963985)).toBeCloseTo(0.975, 6)
    expect(normalCdf(-2.575829304)).toBeCloseTo(0.005, 6)
  })
})

describe('ranking', () => {
  it('averages tied ranks and reports the tie groups', () => {
    const { ranks, tieGroupSizes } = rankAverage([1, 2, 2, 3])
    expect(ranks).toEqual([1, 2.5, 2.5, 4])
    expect(tieGroupSizes).toEqual([2])
  })
})

describe('wilcoxon signed-rank', () => {
  it('is exact and hand-checkable on a small untied sample', () => {
    // All five differences positive: W+ = 15, W- = 0, and only one of the 32
    // sign assignments is at least as extreme in each direction.
    const result = wilcoxonSignedRank([1, 2, 3, 4, 5])
    expect(result.method).toBe('exact')
    expect(result.wPlus).toBe(15)
    expect(result.wMinus).toBe(0)
    expect(result.statistic).toBe(0)
    expect(result.pValue).toBeCloseTo(2 / 32, 12)
  })

  it('matches a hand-computed mixed-sign case', () => {
    // |d| ranks 1,2,3 with the rank-1 value negative: W- = 1, W+ = 5.
    // Subsets of {1,2,3} summing to 0 or 1: {} and {1}, so P(W<=1) = 2/8.
    const result = wilcoxonSignedRank([-1, 2, 3])
    expect(result.wPlus).toBe(5)
    expect(result.wMinus).toBe(1)
    expect(result.pValue).toBeCloseTo(0.5, 12)
  })

  it('drops exact zeros, which is the conservative convention', () => {
    const withZeros = wilcoxonSignedRank([0, 1, 2, 3, 4, 5, 0])
    expect(withZeros.n).toBe(7)
    expect(withZeros.nNonZero).toBe(5)
    expect(withZeros.pValue).toBeCloseTo(2 / 32, 12)
  })

  it('falls back to the tie-corrected normal approximation when ranks tie', () => {
    const result = wilcoxonSignedRank([1, 1, 2, -3, 4, 5, 6, 7])
    expect(result.method).toBe('normal_approximation')
    expect(result.hasTies).toBe(true)
    expect(result.z).toBeLessThan(0)
  })

  it('returns p = 1 when every difference is exactly zero', () => {
    const result = wilcoxonSignedRank([0, 0, 0])
    expect(result.pValue).toBe(1)
    expect(result.nNonZero).toBe(0)
  })
})

describe('hodges-lehmann', () => {
  it('is the median of the Walsh averages', () => {
    // Walsh averages of [1,2,3]: 1, 1.5, 2, 2, 2.5, 3 -> median 2.
    expect(hodgesLehmannPaired([1, 2, 3])).toBe(2)
  })

  it('is the median of all pairwise differences in the two-sample case', () => {
    // a-b over {2,4} x {1,3}: 1, -1, 3, 1 -> median 1.
    expect(hodgesLehmannTwoSample([2, 4], [1, 3])).toBe(1)
  })

  it('is robust to a single wild observation', () => {
    const clean = [1, 1.1, 0.9, 1.05, 0.95]
    const contaminated = [...clean, 500]
    expect(hodgesLehmannPaired(contaminated)).toBeLessThan(2)
    expect(mean(contaminated)).toBeGreaterThan(80)
  })
})

describe('bootstrap', () => {
  const options = { iterations: 2_000, level: 0.95, seed: 'bootstrap-test-seed' }

  it('is reproducible from its seed', () => {
    const sample = [0.2, 0.1, 0.35, -0.05, 0.4, 0.22, 0.18, 0.31]
    const a = bootstrapHodgesLehmannPaired(sample, options)
    const b = bootstrapHodgesLehmannPaired(sample, options)
    expect(b).toEqual(a)
    const c = bootstrapHodgesLehmannPaired(sample, { ...options, seed: 'another-seed' })
    expect(c.lo).not.toBe(a.lo)
    expect(c.point).toBe(a.point)
  })

  it('brackets the point estimate and excludes zero on a clearly shifted sample', () => {
    const sample = Array.from({ length: 40 }, (_, i) => 0.3 + (i % 5) * 0.01)
    const ci = bootstrapHodgesLehmannPaired(sample, options)
    expect(ci.lo).toBeLessThanOrEqual(ci.point)
    expect(ci.hi).toBeGreaterThanOrEqual(ci.point)
    expect(ci.lo).toBeGreaterThan(0)
  })

  it('covers zero on a sample centred on zero', () => {
    const rng = makeRng('null-sample')
    const sample = Array.from({ length: 50 }, () => rng.next() * 2 - 1)
    const ci = bootstrapHodgesLehmannPaired(sample, options)
    expect(ci.lo).toBeLessThan(0)
    expect(ci.hi).toBeGreaterThan(0)
  })

  it('refuses an unseeded or underpowered bootstrap', () => {
    expect(() => bootstrapHodgesLehmannPaired([1, 2], { ...options, iterations: 100 })).toThrow(
      StatsError,
    )
    expect(() => bootstrapHodgesLehmannPaired([1, 2], { ...options, seed: '' })).toThrow(StatsError)
  })

  it('resamples each arm separately in the two-sample case', () => {
    const early = [0.5, 0.6, 0.55, 0.62, 0.48, 0.51]
    const late = [0.1, 0.05, 0.12, 0.08, 0.02, 0.09]
    const ci = bootstrapTwoSampleShift(early, late, options)
    expect(ci.lo).toBeGreaterThan(0)
    expect(ci.point).toBeCloseTo(hodgesLehmannTwoSample(early, late), 12)
  })
})

describe('permutation test', () => {
  const contrast = (x: readonly number[], y: readonly number[]): number => mean(x) - mean(y)

  it('finds nothing when the labels carry no information', () => {
    const rng = makeRng('permutation-null')
    const pooled = Array.from({ length: 40 }, () => rng.next())
    const result = permutationTestTwoSample(pooled.slice(0, 20), pooled.slice(20), contrast, {
      iterations: 2_000,
      seed: 'perm-null',
    })
    expect(result.pValue).toBeGreaterThan(0.2)
  })

  it('detects a clean separation', () => {
    const a = Array.from({ length: 20 }, (_, i) => 1 + i * 0.01)
    const b = Array.from({ length: 20 }, (_, i) => -1 + i * 0.01)
    const result = permutationTestTwoSample(a, b, contrast, { iterations: 2_000, seed: 'perm-alt' })
    expect(result.pValue).toBeLessThan(0.01)
    expect(result.observed).toBeCloseTo(2, 9)
  })

  it('never reports a p-value of exactly zero', () => {
    const a = Array.from({ length: 15 }, () => 10)
    const b = Array.from({ length: 15 }, () => -10)
    const result = permutationTestTwoSample(a, b, contrast, { iterations: 1_000, seed: 'perm-sep' })
    expect(result.pValue).toBeGreaterThan(0)
  })
})

describe('log-scale reporting', () => {
  it('converts a log shift into the multiplicative effect', () => {
    expect(logShiftToPercent(Math.log(1.25))).toBeCloseTo(25, 9)
    expect(logShiftToPercent(0)).toBeCloseTo(0, 12)
    expect(logShiftToPercent(Math.log(0.8))).toBeCloseTo(-20, 9)
  })
})

describe('the normal tail the power derivation inverts', () => {
  it('matches the textbook quantiles a power calculation actually uses', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 6)
    expect(normalQuantile(0.8)).toBeCloseTo(0.8416212, 6)
    expect(normalQuantile(0.9)).toBeCloseTo(1.2815516, 6)
    expect(normalQuantile(0.5)).toBeCloseTo(0, 12)
  })

  it('is antisymmetric', () => {
    for (const p of [0.001, 0.01, 0.2, 0.45]) {
      expect(normalQuantile(p)).toBeCloseTo(-normalQuantile(1 - p), 9)
    }
  })

  it('inverts normalCdf to the accuracy of the weaker of the two', () => {
    // normalCdf carries the A&S erf error of 1.5e-7, which the inversion divides
    // by the density - so the round trip is loosest in the tail, not here.
    for (const z of [-3, -1.5, -0.4, 0.4, 1.5, 3]) {
      expect(normalQuantile(normalCdf(z))).toBeCloseTo(z, 4)
    }
  })

  it('refuses a probability outside the open unit interval', () => {
    for (const p of [0, 1, -0.1, 1.1, Number.NaN]) {
      expect(() => normalQuantile(p)).toThrow(StatsError)
    }
  })
})

describe('the seeded normal variate the power simulation draws', () => {
  it('has the right first two moments', () => {
    const rng = makeRng('normal-moments')
    const draws = Array.from({ length: 20_000 }, () => standardNormal(rng))
    expect(mean(draws)).toBeCloseTo(0, 1)
    const variance = draws.reduce((a, x) => a + x * x, 0) / draws.length
    expect(variance).toBeCloseTo(1, 1)
  })

  it('is reproducible from the seed, which the registered power figures depend on', () => {
    const first = Array.from({ length: 5 }, () => standardNormal(makeRng('fixed')))
    const second = Array.from({ length: 5 }, () => standardNormal(makeRng('fixed')))
    expect(second).toEqual(first)
  })
})
