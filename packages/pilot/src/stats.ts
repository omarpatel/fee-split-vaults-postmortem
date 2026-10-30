/**
 * Statistics, implemented here rather than pulled from a library.
 *
 * The pilot's whole value is that a sceptic can reproduce it, so the tests it
 * rests on cannot be a dependency whose version drifts. Everything below is
 * deterministic given a seed: the bootstrap and the permutation draws come from
 * the seeded generator in hash.ts, never from Math.random().
 */

import { makeRng, type Rng } from './hash.js'

export class StatsError extends Error {
  constructor(message: string) {
    super(`stats: ${message}`)
    this.name = 'StatsError'
  }
}

function assertFiniteSample(values: readonly number[], label: string): void {
  if (values.length === 0) throw new StatsError(`${label} is empty`)
  for (const v of values) {
    if (!Number.isFinite(v)) throw new StatsError(`${label} contains a non-finite value`)
  }
}

export function mean(values: readonly number[]): number {
  assertFiniteSample(values, 'sample')
  let total = 0
  for (const v of values) total += v
  return total / values.length
}

/** Destructive median by quickselect. The bootstrap calls this millions of times. */
export function medianInPlace(values: number[]): number {
  const n = values.length
  if (n === 0) throw new StatsError('median of an empty sample')
  if (n % 2 === 1) return selectKth(values, (n - 1) / 2)
  const hi = selectKth(values, n / 2)
  const lo = selectKth(values, n / 2 - 1)
  return (lo + hi) / 2
}

export function median(values: readonly number[]): number {
  assertFiniteSample(values, 'sample')
  return medianInPlace([...values])
}

/** Hoare quickselect with a median-of-three pivot. */
function selectKth(a: number[], k: number): number {
  let left = 0
  let right = a.length - 1
  while (left < right) {
    const mid = (left + right) >> 1
    const pivot = medianOfThree(a[left]!, a[mid]!, a[right]!)
    let i = left
    let j = right
    while (i <= j) {
      while (a[i]! < pivot) i += 1
      while (a[j]! > pivot) j -= 1
      if (i <= j) {
        const tmp = a[i]!
        a[i] = a[j]!
        a[j] = tmp
        i += 1
        j -= 1
      }
    }
    if (k <= j) right = j
    else if (k >= i) left = i
    else return a[k]!
  }
  return a[left]!
}

function medianOfThree(x: number, y: number, z: number): number {
  if (x < y) {
    if (y < z) return y
    return x < z ? z : x
  }
  if (x < z) return x
  return y < z ? z : y
}

/** Type-7 quantile on an already sorted ascending sample. */
export function quantileSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new StatsError('quantile of an empty sample')
  if (!(p >= 0 && p <= 1)) throw new StatsError(`quantile p out of range: ${p}`)
  if (sorted.length === 1) return sorted[0]!
  const h = (sorted.length - 1) * p
  const lo = Math.floor(h)
  const hi = Math.ceil(h)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!)
}

// ---------------------------------------------------------------------------
// Normal tail
// ---------------------------------------------------------------------------

/**
 * Abramowitz & Stegun 7.1.26. Maximum absolute error 1.5e-7, which is several
 * orders of magnitude tighter than any decision this study makes.
 */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const z = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * z)
  const poly =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
  return sign * (1 - poly * Math.exp(-z * z))
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2))
}

/**
 * Inverse standard normal CDF, Acklam's rational approximation. Relative error
 * below 1.15e-9 across the whole range, which is far tighter than the third
 * significant figure any power statement is quoted to.
 *
 * The power derivation inverts the normal tail twice - once for the confidence
 * level and once for the target power - so this is not optional scaffolding.
 * Deliberately NOT refined with a Newton step against normalCdf(): that erf is
 * only accurate to 1.5e-7 and the "refinement" would make this worse.
 */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new StatsError(`normalQuantile p out of range: ${p}`)

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ]
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ]
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]

  const pLow = 0.02425
  const pHigh = 1 - pLow

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (
      ((((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
        ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1))
    )
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return (
      -((((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
        ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1))
    )
  }
  const q = p - 0.5
  const r = q * q
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  )
}

/**
 * One standard normal variate from a seeded generator, Box-Muller. Used by the
 * power simulation, which must be reproducible from the published seed alone.
 */
export function standardNormal(rng: Rng): number {
  let u = 0
  while (u === 0) u = rng.next()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next())
}

// ---------------------------------------------------------------------------
// Ranks
// ---------------------------------------------------------------------------

export interface RankResult {
  ranks: number[]
  /** Sizes of each tie group with more than one member. Drives the variance fix. */
  tieGroupSizes: number[]
}

/** Average ranks for ties, ascending. */
export function rankAverage(values: readonly number[]): RankResult {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i)
  const ranks = new Array<number>(values.length).fill(0)
  const tieGroupSizes: number[] = []

  let start = 0
  while (start < order.length) {
    let end = start + 1
    while (end < order.length && order[end]!.v === order[start]!.v) end += 1
    const groupSize = end - start
    const averageRank = (start + 1 + end) / 2
    for (let k = start; k < end; k += 1) ranks[order[k]!.i] = averageRank
    if (groupSize > 1) tieGroupSizes.push(groupSize)
    start = end
  }
  return { ranks, tieGroupSizes }
}

// ---------------------------------------------------------------------------
// Wilcoxon signed-rank
// ---------------------------------------------------------------------------

export interface WilcoxonResult {
  /** Pairs supplied. */
  n: number
  /** Pairs after dropping exact zeros, per the Wilcoxon convention. */
  nNonZero: number
  wPlus: number
  wMinus: number
  statistic: number
  pValue: number
  method: 'exact' | 'normal_approximation'
  hasTies: boolean
  z?: number
}

const EXACT_MAX_N = 25

/**
 * Two-sided Wilcoxon signed-rank test.
 *
 * Exact by full enumeration of the null distribution when the sample is small
 * and untied; otherwise the normal approximation with the tie correction and a
 * continuity correction. Zeros are dropped, which is the conservative choice.
 */
export function wilcoxonSignedRank(differences: readonly number[]): WilcoxonResult {
  assertFiniteSample(differences, 'differences')
  const nonZero = differences.filter((d) => d !== 0)
  const nNonZero = nonZero.length
  if (nNonZero === 0) {
    return {
      n: differences.length,
      nNonZero: 0,
      wPlus: 0,
      wMinus: 0,
      statistic: 0,
      pValue: 1,
      method: 'exact',
      hasTies: false,
    }
  }

  const absolute = nonZero.map(Math.abs)
  const { ranks, tieGroupSizes } = rankAverage(absolute)
  let wPlus = 0
  let wMinus = 0
  for (let i = 0; i < nonZero.length; i += 1) {
    if (nonZero[i]! > 0) wPlus += ranks[i]!
    else wMinus += ranks[i]!
  }
  const statistic = Math.min(wPlus, wMinus)
  const hasTies = tieGroupSizes.length > 0

  if (!hasTies && nNonZero <= EXACT_MAX_N) {
    return {
      n: differences.length,
      nNonZero,
      wPlus,
      wMinus,
      statistic,
      pValue: exactTwoSidedP(nNonZero, statistic),
      method: 'exact',
      hasTies,
    }
  }

  const mu = (nNonZero * (nNonZero + 1)) / 4
  let variance = (nNonZero * (nNonZero + 1) * (2 * nNonZero + 1)) / 24
  for (const t of tieGroupSizes) variance -= (t ** 3 - t) / 48
  if (variance <= 0) {
    return {
      n: differences.length,
      nNonZero,
      wPlus,
      wMinus,
      statistic,
      pValue: 1,
      method: 'normal_approximation',
      hasTies,
    }
  }
  const continuity = 0.5
  const z = (statistic - mu + continuity) / Math.sqrt(variance)
  const pValue = Math.min(1, 2 * normalCdf(z))

  return {
    n: differences.length,
    nNonZero,
    wPlus,
    wMinus,
    statistic,
    pValue,
    method: 'normal_approximation',
    hasTies,
    z,
  }
}

/** P(W <= w) under the null, doubled. Counts subsets of {1..n} by rank sum. */
function exactTwoSidedP(n: number, w: number): number {
  const maxSum = (n * (n + 1)) / 2
  const counts = new Float64Array(maxSum + 1)
  counts[0] = 1
  for (let i = 1; i <= n; i += 1) {
    for (let s = maxSum; s >= i; s -= 1) {
      counts[s] = counts[s]! + counts[s - i]!
    }
  }
  let atOrBelow = 0
  const limit = Math.min(maxSum, Math.floor(w))
  for (let s = 0; s <= limit; s += 1) atOrBelow += counts[s]!
  const total = 2 ** n
  return Math.min(1, (2 * atOrBelow) / total)
}

// ---------------------------------------------------------------------------
// Hodges-Lehmann
// ---------------------------------------------------------------------------

/** Median of the Walsh averages. The paired location estimate the plan commits to. */
export function hodgesLehmannPaired(differences: readonly number[]): number {
  assertFiniteSample(differences, 'differences')
  const n = differences.length
  const walsh = new Array<number>((n * (n + 1)) / 2)
  fillWalsh(differences, walsh)
  return medianInPlace(walsh)
}

function fillWalsh(values: readonly number[], out: number[]): void {
  const n = values.length
  let k = 0
  for (let i = 0; i < n; i += 1) {
    const vi = values[i]!
    for (let j = i; j < n; j += 1) {
      out[k] = (vi + values[j]!) / 2
      k += 1
    }
  }
}

/** Median of all pairwise a_i - b_j. The two-sample shift estimate. */
export function hodgesLehmannTwoSample(a: readonly number[], b: readonly number[]): number {
  assertFiniteSample(a, 'sample a')
  assertFiniteSample(b, 'sample b')
  const out = new Array<number>(a.length * b.length)
  fillPairwiseDifferences(a, b, out)
  return medianInPlace(out)
}

function fillPairwiseDifferences(
  a: readonly number[],
  b: readonly number[],
  out: number[],
): void {
  let k = 0
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i]!
    for (let j = 0; j < b.length; j += 1) {
      out[k] = ai - b[j]!
      k += 1
    }
  }
}

// ---------------------------------------------------------------------------
// Bootstrap and permutation
// ---------------------------------------------------------------------------

export interface BootstrapCi {
  point: number
  lo: number
  hi: number
  level: number
  iterations: number
  method: 'bootstrap_percentile'
  seed: string
}

export interface BootstrapOptions {
  iterations: number
  level: number
  seed: string
}

/**
 * Percentile bootstrap of the paired Hodges-Lehmann estimate. Resampling is at
 * the COIN level, because the coin is the unit that was randomized and blocks
 * within a coin are not independent.
 */
export function bootstrapHodgesLehmannPaired(
  differences: readonly number[],
  options: BootstrapOptions,
): BootstrapCi {
  assertFiniteSample(differences, 'differences')
  validateBootstrapOptions(options)
  const n = differences.length
  const rng = makeRng(options.seed)
  const walsh = new Array<number>((n * (n + 1)) / 2)
  const resample = new Array<number>(n)
  const estimates = new Array<number>(options.iterations)

  for (let b = 0; b < options.iterations; b += 1) {
    for (let i = 0; i < n; i += 1) resample[i] = differences[rng.nextInt(n)]!
    fillWalsh(resample, walsh)
    estimates[b] = medianInPlace(walsh)
  }

  return finishPercentileCi(hodgesLehmannPaired(differences), estimates, options)
}

/**
 * Percentile bootstrap of a two-sample shift, resampling each arm separately so
 * the arm sizes are preserved.
 */
export function bootstrapTwoSampleShift(
  a: readonly number[],
  b: readonly number[],
  options: BootstrapOptions,
  statistic: (x: readonly number[], y: readonly number[]) => number = hodgesLehmannTwoSample,
): BootstrapCi {
  assertFiniteSample(a, 'sample a')
  assertFiniteSample(b, 'sample b')
  validateBootstrapOptions(options)
  const rng = makeRng(options.seed)
  const ra = new Array<number>(a.length)
  const rb = new Array<number>(b.length)
  const estimates = new Array<number>(options.iterations)

  for (let i = 0; i < options.iterations; i += 1) {
    for (let k = 0; k < a.length; k += 1) ra[k] = a[rng.nextInt(a.length)]!
    for (let k = 0; k < b.length; k += 1) rb[k] = b[rng.nextInt(b.length)]!
    estimates[i] = statistic(ra, rb)
  }

  return finishPercentileCi(statistic(a, b), estimates, options)
}

function validateBootstrapOptions(options: BootstrapOptions): void {
  if (!Number.isInteger(options.iterations) || options.iterations < 1_000) {
    throw new StatsError('bootstrap iterations must be an integer of at least 1000')
  }
  if (!(options.level > 0 && options.level < 1)) {
    throw new StatsError(`confidence level out of range: ${options.level}`)
  }
  if (!options.seed) throw new StatsError('bootstrap seed is required for reproducibility')
}

function finishPercentileCi(
  point: number,
  estimates: number[],
  options: BootstrapOptions,
): BootstrapCi {
  estimates.sort((x, y) => x - y)
  const alpha = 1 - options.level
  return {
    point,
    lo: quantileSorted(estimates, alpha / 2),
    hi: quantileSorted(estimates, 1 - alpha / 2),
    level: options.level,
    iterations: options.iterations,
    method: 'bootstrap_percentile',
    seed: options.seed,
  }
}

export interface PermutationResult {
  observed: number
  pValue: number
  iterations: number
  seed: string
}

/**
 * Two-sided permutation test on the cohort labels. This is the inference that
 * matches a randomized between-coin design: the null is the randomization
 * itself, so it needs no distributional assumption.
 */
export function permutationTestTwoSample(
  a: readonly number[],
  b: readonly number[],
  statistic: (x: readonly number[], y: readonly number[]) => number,
  options: { iterations: number; seed: string },
): PermutationResult {
  assertFiniteSample(a, 'sample a')
  assertFiniteSample(b, 'sample b')
  if (!Number.isInteger(options.iterations) || options.iterations < 1_000) {
    throw new StatsError('permutation iterations must be an integer of at least 1000')
  }
  if (!options.seed) throw new StatsError('permutation seed is required for reproducibility')

  const observed = statistic(a, b)
  const pooled = [...a, ...b]
  const rng = makeRng(options.seed)
  const nA = a.length
  let atLeastAsExtreme = 0

  for (let i = 0; i < options.iterations; i += 1) {
    shuffleInPlace(pooled, rng)
    const permutedA = pooled.slice(0, nA)
    const permutedB = pooled.slice(nA)
    if (Math.abs(statistic(permutedA, permutedB)) >= Math.abs(observed) - 1e-12) {
      atLeastAsExtreme += 1
    }
  }

  return {
    observed,
    // The +1 keeps the p-value from ever being exactly zero, which it is not.
    pValue: (1 + atLeastAsExtreme) / (1 + options.iterations),
    iterations: options.iterations,
    seed: options.seed,
  }
}

function shuffleInPlace(values: number[], rng: Rng): void {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = rng.nextInt(i + 1)
    const tmp = values[i]!
    values[i] = values[j]!
    values[j] = tmp
  }
}

/**
 * A log-scale location shift expressed as a percentage change.
 *
 * The primary endpoint is log1p(fees), so exp(shift) - 1 is the multiplicative
 * effect exactly in the log limit and to within the log1p offset at small fee
 * levels. exp is monotone, so a confidence interval transforms exactly.
 */
export function logShiftToPercent(shift: number): number {
  return (Math.exp(shift) - 1) * 100
}
