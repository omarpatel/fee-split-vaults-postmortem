/**
 * Power for the design that is actually run.
 *
 * n=40-60 arrived from a brief. This file derives it, for THIS design - paired
 * within coin, `pairsPerCoin` matched 12-hour blocks per coin, Hodges-Lehmann
 * with a percentile bootstrap, decided by a two-part committed rule - and not
 * for the between-coin trial whose textbook formula would flatter it.
 *
 * THE THING THE DERIVATION FOUND, stated here because it is the whole reason
 * pre-registration is worth doing:
 *
 *   The committed rule is "the 95% interval excludes zero AND the point estimate
 *   is at least +10%". The second half is a threshold on the ESTIMATE. If the
 *   true effect is exactly +10%, the estimate lands above it about half the time
 *   however large the study is, so the rule's power against a true +10% tends to
 *   0.5 from below and NO sample size reaches 80%. +10% is a minimum acceptable
 *   effect, not a detectable one, and the study must be described that way.
 *
 *   Power against effects that clear the threshold with room - +20% and up - is
 *   a real question with a real answer, and that is what the tables below give.
 *
 * TWO METHODS, deliberately.
 *
 *   `approximatePower` is a normal approximation. It is legitimate here because
 *   the committed rule reads only the bootstrap interval and the Hodges-Lehmann
 *   point estimate, both asymptotically normal, and it is what makes scanning a
 *   grid and inverting for an MDE cheap enough to actually do.
 *
 *   `simulateDeskPower`, in power-simulation.ts, generates paired data under a
 *   stated alternative and runs the REAL analysis path - `evaluatePairedDifferences`
 *   and `decide`, the same functions the trial will use - because the Wilcoxon
 *   signed-rank test has no closed-form power and because an approximation
 *   nobody checked is a guess with a decimal point. It lives in its own module
 *   so that prereg.ts can compute its committed power table from the analytic
 *   half without importing the analysis and closing a module cycle.
 */

import type { AnalysisPlan, PowerRegistrationSpec } from './prereg.js'
import { normalCdf, normalQuantile } from './stats.js'

export class PowerError extends Error {
  constructor(message: string) {
    super(`pilot power: ${message}`)
    this.name = 'PowerError'
  }
}

/**
 * Hodges-Lehmann efficiency relative to the sample mean under a normal
 * difference distribution: asymptotic variance pi/3 * sigma^2/n, so 3/pi.
 * Quoted rather than fitted, and conservative for the heavy-tailed differences
 * this endpoint actually produces - there the HL beats the mean.
 */
export const HL_EFFICIENCY_NORMAL = 3 / Math.PI

export interface PowerDesign {
  /** Coins enrolled and paired. The unit of inference. */
  coins: number
  /**
   * Matched 12-hour pairs per coin. In the registered design this is
   * `randomizedDays` - the draw is at the DAY level and each randomized day
   * contributes one staffed and one unstaffed block - so it is 30, not 60 and
   * not 100.
   */
  pairsPerCoin: number
  /**
   * SD of log1p(fees) within a coin across 12-hour windows, AFTER hour-of-day
   * and day-of-week are removed as strata.
   *
   * It must still include day-level shocks. The estimator strata are
   * (day-of-week x half-day) cells pooled across the whole randomized phase, so
   * a staffed Monday morning is compared against a DIFFERENT Monday morning that
   * was unstaffed. Day-level shocks are not differenced out by that contrast.
   */
  withinCoinSd: number
  /**
   * SD of the per-coin TRUE effect on the log scale. Heterogeneity: some coins
   * have a community a desk can help and some do not. More blocks per coin do
   * nothing to this term; only more coins do.
   */
  betweenCoinEffectSd: number
  alpha: number
  /** The committed business threshold on the point estimate, in percent. */
  thresholdPct: number
  ciLevel: number
  /** Efficiency of the estimator relative to the mean. See HL_EFFICIENCY_NORMAL. */
  estimatorEfficiency: number
}

export const DEFAULT_POWER_DESIGN: PowerDesign = {
  coins: 50,
  pairsPerCoin: 30,
  withinCoinSd: 1.5,
  betweenCoinEffectSd: 0.1,
  alpha: 0.05,
  thresholdPct: 10,
  ciLevel: 0.95,
  estimatorEfficiency: HL_EFFICIENCY_NORMAL,
}

export function assertPowerDesign(design: PowerDesign): void {
  if (!Number.isInteger(design.coins) || design.coins < 2) {
    throw new PowerError('at least two coins are needed to have a paired comparison at all')
  }
  if (!Number.isInteger(design.pairsPerCoin) || design.pairsPerCoin < 1) {
    throw new PowerError('pairsPerCoin must be a positive integer')
  }
  if (!(design.withinCoinSd > 0)) throw new PowerError('withinCoinSd must be positive')
  if (!(design.betweenCoinEffectSd >= 0)) {
    throw new PowerError('betweenCoinEffectSd must be zero or positive')
  }
  if (!(design.alpha > 0 && design.alpha < 1)) throw new PowerError('alpha out of range')
  if (!(design.ciLevel > 0 && design.ciLevel < 1)) throw new PowerError('ciLevel out of range')
  if (!(design.estimatorEfficiency > 0 && design.estimatorEfficiency <= 1)) {
    throw new PowerError('estimatorEfficiency must lie in (0, 1]')
  }
}

/** A percentage effect on fees as a shift on the log1p scale. */
export function pctToLogShift(pct: number): number {
  if (!(pct > -100)) throw new PowerError(`effect ${pct}% is not on the multiplicative scale`)
  return Math.log1p(pct / 100)
}

/** The inverse. Matches `logShiftToPercent` in stats.ts. */
export function logShiftToPct(shift: number): number {
  return (Math.exp(shift) - 1) * 100
}

/**
 * SD of ONE coin's difference, which is the quantity the coin-level test sees.
 *
 * Each of `pairsPerCoin` pairs contributes a staffed minus an unstaffed window,
 * variance 2*sd^2; averaging them divides by the pair count. The per-coin true
 * effect adds its own variance, and no amount of averaging within a coin touches
 * that term - which is exactly why the floor on n is set by heterogeneity rather
 * than by noise once the coin has enough blocks.
 */
export function coinDifferenceSd(design: PowerDesign): number {
  assertPowerDesign(design)
  const within = (2 * design.withinCoinSd ** 2) / design.pairsPerCoin
  return Math.sqrt(within + design.betweenCoinEffectSd ** 2)
}

/** Standard error of the coin-level location estimate across `coins` coins. */
export function estimateStandardError(design: PowerDesign): number {
  return coinDifferenceSd(design) / Math.sqrt(design.coins * design.estimatorEfficiency)
}

export interface ApproximatePower {
  /** P(the 95% interval excludes zero). The significance half of the rule. */
  ciPower: number
  /** P(the point estimate clears the committed threshold). The business half. */
  thresholdPower: number
  /** P(both). This is the power of the decision the pilot will actually make. */
  rulePower: number
  standardError: number
  coinDifferenceSd: number
  trueEffectPct: number
}

/**
 * Normal approximation to the committed rule.
 *
 * Both halves of the rule are functions of the SAME statistic: the interval
 * excludes zero exactly when |HL| > z*SE, and the threshold is met exactly when
 * HL >= delta_threshold. So the rule fires when HL >= max(z*SE, delta_threshold)
 * and its power is one normal tail, not a product of two - treating them as
 * independent would overstate the study badly.
 */
export function approximatePower(design: PowerDesign, trueEffectPct: number): ApproximatePower {
  assertPowerDesign(design)
  const se = estimateStandardError(design)
  const z = normalQuantile(1 - (1 - design.ciLevel) / 2)
  const delta = pctToLogShift(trueEffectPct)
  const threshold = pctToLogShift(design.thresholdPct)
  const gate = Math.max(z * se, threshold)

  return {
    ciPower: 1 - normalCdf((z * se - delta) / se) + normalCdf((-z * se - delta) / se),
    thresholdPower: 1 - normalCdf((threshold - delta) / se),
    rulePower: 1 - normalCdf((gate - delta) / se),
    standardError: se,
    coinDifferenceSd: coinDifferenceSd(design),
    trueEffectPct,
  }
}

export type PowerCriterion = 'rule' | 'ci_only'

function powerFor(design: PowerDesign, effectPct: number, criterion: PowerCriterion): number {
  const p = approximatePower(design, effectPct)
  return criterion === 'rule' ? p.rulePower : p.ciPower
}

export interface MinimumDetectableEffect {
  effectPct: number
  targetPower: number
  criterion: PowerCriterion
  achievedPower: number
  design: PowerDesign
}

/**
 * The smallest true effect this design detects at `targetPower`.
 *
 * Bisection rather than an inverted formula: under the `rule` criterion the
 * power function has a kink where z*SE crosses the threshold, and a closed-form
 * inverse would have to case-split around it for no benefit.
 */
export function minimumDetectableEffectPct(
  design: PowerDesign,
  targetPower = 0.8,
  criterion: PowerCriterion = 'rule',
): MinimumDetectableEffect {
  assertPowerDesign(design)
  if (!(targetPower > 0 && targetPower < 1)) {
    throw new PowerError(`target power out of range: ${targetPower}`)
  }

  let lo = 0
  let hi = 10
  // Grow the bracket rather than assume one: a 1000% MDE is a real answer for a
  // design this small at a large SD, and silently clamping it would hide that.
  for (let i = 0; i < 40 && powerFor(design, hi, criterion) < targetPower; i += 1) hi *= 2
  if (powerFor(design, hi, criterion) < targetPower) {
    throw new PowerError(
      `no effect below ${hi}% reaches ${targetPower} power under this design; the design is not usable`,
    )
  }
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2
    if (powerFor(design, mid, criterion) < targetPower) lo = mid
    else hi = mid
  }
  return {
    effectPct: hi,
    targetPower,
    criterion,
    achievedPower: powerFor(design, hi, criterion),
    design,
  }
}

export interface RequiredCoins {
  /** Null when no sample size reaches the target. That is a real answer. */
  coins: number | null
  reachable: boolean
  targetEffectPct: number
  targetPower: number
  criterion: PowerCriterion
  /** Power at the cap, when unreachable. Shows HOW unreachable. */
  powerAtCap: number
  cap: number
  reason: string
}

/**
 * Coins needed to detect `targetEffectPct` at `targetPower`.
 *
 * MONOTONICITY, which the binary search below depends on and which does NOT hold
 * everywhere. Under the `rule` criterion, power rises with n only when the true
 * effect exceeds the threshold. At a true effect exactly ON the threshold it
 * rises to one half and stops; BELOW the threshold it rises, turns over, and
 * falls to zero, because more coins means a tighter interval around a point
 * estimate that is genuinely under the bar. That is the correct behaviour of a
 * threshold rule, not a defect in it - a bigger study SHOULD be less likely to
 * act on an effect that is too small to be worth acting on.
 *
 * So the unreachable case is checked FIRST, at the cap, and the search runs only
 * in the region where power is monotone. `reachable: false` is a real answer and
 * the reason says which kind of unreachable it is.
 */
export function requiredCoins(
  design: PowerDesign,
  targetEffectPct: number,
  targetPower = 0.8,
  criterion: PowerCriterion = 'rule',
  cap = 5_000,
): RequiredCoins {
  assertPowerDesign(design)
  const at = (coins: number): number => powerFor({ ...design, coins }, targetEffectPct, criterion)

  const powerAtCap = at(cap)
  const base = {
    targetEffectPct,
    targetPower,
    criterion,
    powerAtCap,
    cap,
  }
  if (powerAtCap < targetPower) {
    const structural = criterion === 'rule' && targetEffectPct <= design.thresholdPct
    return {
      ...base,
      coins: null,
      reachable: false,
      reason: structural
        ? `the committed rule requires the POINT ESTIMATE to clear +${design.thresholdPct}%, so at a ` +
          `true effect of +${targetEffectPct}% enrolling more coins does not help and eventually ` +
          'hurts; no sample size reaches the target'
        : `power is still ${powerAtCap.toFixed(3)} at ${cap} coins; the within-coin variance ` +
          'assumption defeats this design',
    }
  }

  let lo = 2
  let hi = cap
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (at(mid) >= targetPower) hi = mid
    else lo = mid + 1
  }
  return { ...base, coins: lo, reachable: true, reason: 'binary search on the normal approximation' }
}

export interface PowerTableRow {
  coins: number
  withinCoinSd: number
  trueEffectPct: number
  ciPower: number
  thresholdPower: number
  rulePower: number
}

/** The grid the pre-registration document publishes. Pure and deterministic. */
export function powerTable(
  design: PowerDesign,
  coinCounts: readonly number[],
  sdGrid: readonly number[],
  effectsPct: readonly number[],
): PowerTableRow[] {
  const rows: PowerTableRow[] = []
  for (const coins of coinCounts) {
    for (const withinCoinSd of sdGrid) {
      for (const trueEffectPct of effectsPct) {
        const p = approximatePower({ ...design, coins, withinCoinSd }, trueEffectPct)
        rows.push({
          coins,
          withinCoinSd,
          trueEffectPct,
          ciPower: p.ciPower,
          thresholdPower: p.thresholdPower,
          rulePower: p.rulePower,
        })
      }
    }
  }
  return rows
}

/** Rebuild the design the committed plan registered, so the two cannot drift. */
export function powerDesignFromPlan(plan: AnalysisPlan, coins?: number): PowerDesign {
  const spec: PowerRegistrationSpec = plan.power
  return {
    coins: coins ?? spec.enrolledCoinsMin,
    pairsPerCoin: spec.pairsPerCoin,
    withinCoinSd: spec.plannedWithinCoinSd,
    betweenCoinEffectSd: spec.plannedBetweenCoinEffectSd,
    alpha: spec.alpha,
    thresholdPct: plan.decisionRule.minFeeEffectPct,
    ciLevel: plan.decisionRule.ciLevel,
    estimatorEfficiency: spec.estimatorEfficiency,
  }
}
