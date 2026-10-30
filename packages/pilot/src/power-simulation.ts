/**
 * Monte Carlo power, driving the real analysis path.
 *
 * Split from power.ts so that prereg.ts can compute its committed power table
 * from the analytic function without importing the analysis, which would close
 * a module cycle. Everything here is seeded from published material: a third
 * party holding the plan can reproduce every figure exactly.
 *
 * WHY A SIMULATION AT ALL, when the committed rule has a usable normal
 * approximation. Two reasons. The Wilcoxon signed-rank test has no closed-form
 * power and the report prints its p-value, so its behaviour under the registered
 * alternative should be known rather than assumed. And an approximation that was
 * never checked against the estimator it approximates is a guess with a decimal
 * point on it - so this drives `evaluatePairedDifferences` and `decide`, the
 * same two functions the real trial will call, bootstrap and all.
 */

import { decide, evaluatePairedDifferences, type CoinDifference, type Verdict } from './analysis.js'
import { makeRng } from './hash.js'
import { assertPowerDesign, pctToLogShift, PowerError, type PowerDesign } from './power.js'
import type { AnalysisPlan } from './prereg.js'
import { standardNormal } from './stats.js'

export interface SimulationOptions {
  seed: string
  trials: number
  /**
   * The bootstrap size used INSIDE the simulation. Smaller than the plan's
   * 10,000 because the simulation runs the bootstrap `trials` times over; the
   * registered value is committed so the figure stays reproducible.
   */
  bootstrapIterations: number
}

export const DEFAULT_SIMULATION: SimulationOptions = {
  seed: 'vault-pilot-power/v1',
  trials: 400,
  bootstrapIterations: 1_000,
}

export interface SimulatedPower {
  trials: number
  trueEffectPct: number
  design: PowerDesign
  options: SimulationOptions
  /** Fraction of trials the committed rule said PROCEED. The number that matters. */
  rulePower: number
  /** Fraction whose bootstrap interval excluded zero. */
  ciPower: number
  /** Fraction whose point estimate cleared the threshold. */
  thresholdPower: number
  /** Fraction the Wilcoxon signed-rank test rejected at plan alpha. No closed form. */
  wilcoxonPower: number
  /** Median Hodges-Lehmann point estimate across trials, as a percentage. */
  medianEstimatePct: number
  verdicts: Record<Verdict, number>
}

/**
 * Monte Carlo power, running the actual analysis functions.
 *
 * Data model, stated so it can be argued with rather than trusted: coin i has a
 * true log-scale effect delta + N(0, betweenCoinEffectSd^2), and its observed
 * paired difference adds N(0, 2*sd^2/pairsPerCoin) - the sampling error of a
 * mean of `pairsPerCoin` paired 12-hour windows. That is the same variance
 * decomposition `coinDifferenceSd` uses, so agreement between this and
 * `approximatePower` checks the INFERENCE, not the generative model. The
 * generative model itself is an assumption and the document says so.
 */
export function simulateDeskPower(
  design: PowerDesign,
  trueEffectPct: number,
  plan: AnalysisPlan,
  options: SimulationOptions = DEFAULT_SIMULATION,
): SimulatedPower {
  assertPowerDesign(design)
  if (!Number.isInteger(options.trials) || options.trials < 1) {
    throw new PowerError('the power simulation needs at least one trial')
  }
  if (!options.seed) throw new PowerError('the power simulation must be seeded to be reproducible')

  // The simulation drives the real estimator, so it drives the real plan - with
  // the bootstrap size and the bootstrap SEED swapped for the simulation's own,
  // and both swaps registered.
  //
  // The seed swap matters more than it looks. A pilot's bootstrap seed is
  // per-pilot; leaving it in would make the registered power figures a property
  // of one pilot id rather than of the DESIGN, so the same plan committed for a
  // second pilot would quote power numbers it could not reproduce.
  //
  // `minCoins` is lowered to the simulated coin count for the same reason a
  // power calculation is not an enrolment check: a run at n=30 is asking what
  // 30 coins can see, not whether 30 coins satisfies the enrolment floor.
  const simPlan: AnalysisPlan = {
    ...plan,
    estimator: {
      ...plan.estimator,
      ci: {
        ...plan.estimator.ci,
        iterations: options.bootstrapIterations,
        seed: `${options.seed}|bootstrap`,
      },
    },
    decisionRule: { ...plan.decisionRule, minCoins: Math.min(plan.decisionRule.minCoins, design.coins) },
  }

  const delta = pctToLogShift(trueEffectPct)
  const pairSd = Math.sqrt((2 * design.withinCoinSd ** 2) / design.pairsPerCoin)
  const threshold = design.thresholdPct

  let ruleHits = 0
  let ciHits = 0
  let thresholdHits = 0
  let wilcoxonHits = 0
  const estimates: number[] = []
  const verdicts: Record<Verdict, number> = {
    PROCEED_TO_PHASE_1: 0,
    DO_NOT_PROCEED: 0,
    INCONCLUSIVE_UNDERPOWERED: 0,
    COMPROMISED_DELIVERY: 0,
  }

  for (let t = 0; t < options.trials; t += 1) {
    const rng = makeRng(`${options.seed}|trial|${t}|${design.coins}|${design.withinCoinSd}|${trueEffectPct}`)
    const perCoin: CoinDifference[] = []
    for (let i = 0; i < design.coins; i += 1) {
      const coinEffect = delta + design.betweenCoinEffectSd * standardNormal(rng)
      perCoin.push({
        coinRef: `sim-${String(i).padStart(4, '0')}`,
        difference: coinEffect + pairSd * standardNormal(rng),
        pairedStrata: 14,
        staffedBlocks: design.pairsPerCoin,
        unstaffedBlocks: design.pairsPerCoin,
      })
    }

    const endpoint = evaluatePairedDifferences(
      'fees_log1p',
      'primary',
      perCoin,
      simPlan,
      `${options.seed}|boot|${t}`,
    )
    const decision = decide(endpoint, simPlan)

    verdicts[decision.verdict] += 1
    if (decision.proceed) ruleHits += 1
    if (decision.ciExcludesZero) ciHits += 1
    if (decision.pointEstimatePct >= threshold) thresholdHits += 1
    if (endpoint.wilcoxon.pValue < design.alpha) wilcoxonHits += 1
    estimates.push(decision.pointEstimatePct)
  }

  estimates.sort((a, b) => a - b)
  const mid = estimates.length >> 1
  const medianEstimatePct =
    estimates.length % 2 === 1
      ? estimates[mid]!
      : (estimates[mid - 1]! + estimates[mid]!) / 2

  return {
    trials: options.trials,
    trueEffectPct,
    design,
    options,
    rulePower: ruleHits / options.trials,
    ciPower: ciHits / options.trials,
    thresholdPower: thresholdHits / options.trials,
    wilcoxonPower: wilcoxonHits / options.trials,
    medianEstimatePct,
    verdicts,
  }
}
