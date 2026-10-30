/**
 * Pre-registration.
 *
 * The plan is hash-committed BEFORE data collection and the hash is verified at
 * analysis time. If the plan changed, the analysis refuses to run. This is the
 * only mechanism that makes a positive result from a small pilot worth
 * anything: without it, hour-of-day and day-of-week stop being stratification
 * variables and become the two knobs a motivated analyst turns until the coin
 * desk looks profitable.
 *
 * Consequently `adjustmentCovariates` is required to be empty and the analysis
 * refuses any covariate that is not a registered stratification variable.
 */

import { preRegistrationDocumentHash } from './document.js'
import { hashObject } from './hash.js'
import {
  HL_EFFICIENCY_NORMAL as HODGES_LEHMANN_EFFICIENCY,
  minimumDetectableEffectPct,
  powerTable,
  type PowerDesign,
} from './power.js'
import type { ExclusionRuleId, SensitivityAnalysisId } from './types.js'

export type StratificationName = 'hour_of_day' | 'day_of_week'

export const REGISTERED_STRATIFICATION: readonly StratificationName[] = [
  'hour_of_day',
  'day_of_week',
] as const

export interface EndpointSpec {
  id: string
  role: 'primary' | 'secondary'
  description: string
  transform: 'log1p' | 'identity' | 'rate'
  /** Every endpoint is measured over the 12 hours FOLLOWING the block. */
  window: 'following_block_span'
}

export interface StratificationSpec {
  name: StratificationName
  /** Fixed. A stratification variable may never be re-declared as an adjustment. */
  role: 'stratification'
}

export interface DecisionRuleSpec {
  ciLevel: number
  requireCiExcludesZero: boolean
  /** Minimum point estimate on fees, in percent per staffed block. */
  minFeeEffectPct: number
  minCoins: number
  minPairedStrataPerCoin: number
  /** Emitted VERBATIM when the rule is not met. Committed in advance. */
  failureStatement: string
  /** Emitted verbatim when the rule is met. */
  successStatement: string
  /** Emitted verbatim when the study is too small to answer the question. */
  underpoweredStatement: string
  /**
   * Emitted verbatim when the desk failed to deliver the assigned arm on more
   * than `maxUndeliveredStaffedShare` of staffed blocks. This can only ever
   * WITHHOLD a proceed; there is no path by which it manufactures one.
   */
  deliveryCompromisedStatement: string
}

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

/**
 * Every exclusion the code knows how to apply must appear in the committed
 * plan. A plan missing one does not validate, so it cannot be hashed, so it
 * cannot be committed - which is the only way to make "we forgot the anti-snipe
 * windfall" a build failure rather than a footnote in the write-up.
 */
export const REQUIRED_EXCLUSION_RULES: readonly ExclusionRuleId[] = [
  'non_randomized_phase',
  'unvalued_window',
  'launch_window_anti_snipe',
  'graduation_mechanism_change',
  'recipient_change',
] as const

export const REQUIRED_SENSITIVITY_ANALYSES: readonly SensitivityAnalysisId[] = [
  'per_protocol_delivery',
  'whale_dominated_window',
] as const

export interface ExclusionRuleSpec {
  id: ExclusionRuleId
  /** Fixed. A sensitivity analysis is a different type and never lands here. */
  scope: 'primary'
  /** The physical process that puts non-desk money into the endpoint. */
  mechanism: string
  /** Exactly what is dropped. Written so a third party can re-derive the set. */
  rule: string
  /** Why this shape and this N, in advance, before anyone has seen a number. */
  justification: string
}

/**
 * The numbers the exclusion engine reads. Committed, so they cannot be retuned
 * once someone has seen which choice helps.
 */
export interface ExclusionParameters {
  /**
   * Hours after a coin's launch whose follow-windows are dropped outright. 24,
   * for the reasons in the registered justification: sweeps are aggregated so
   * the windfall's CREDIT time is not its trade time, and dropping a whole
   * 24-hour day-pair preserves the exact hour-of-day balance the assignment
   * generator guarantees.
   */
  launchExclusionHours: number
  /** Hours after an observed graduation whose windows are dropped. */
  graduationExclusionHours: number
  /**
   * The classifier's anti-snipe window, seconds since launch. Matches the
   * indexer's ANTI_SNIPE_WINDOW_SECONDS: the tax decays over ~3s and block
   * timestamps have second granularity, so the window is padded, not cut fine.
   */
  antiSnipeWindowSeconds: number
  /** Drop the sibling block of the same 24-hour day, not the single block. */
  dropWholeDayPair: boolean
  /** Share of STAFFED blocks that may go undelivered before the trial is compromised. */
  maxUndeliveredStaffedShare: number
  /** A window one credit accounts for at or above this share is FLAGGED, never dropped. */
  whaleShareThreshold: number
}

export interface SensitivityAnalysisSpec {
  id: SensitivityAnalysisId
  /** Fixed. This is the whole point of the type: it cannot move the verdict. */
  gatesDecision: false
  description: string
  /** Why this is a sensitivity rather than an exclusion. */
  justification: string
}

// ---------------------------------------------------------------------------
// Power
// ---------------------------------------------------------------------------

export interface PowerCurvePoint {
  coins: number
  withinCoinSd: number
  trueEffectPct: number
  /** Power of the COMMITTED DECISION RULE, not of a bare significance test. */
  rulePower: number
}

export interface PowerSpotCheck {
  coins: number
  withinCoinSd: number
  trueEffectPct: number
  /** Empirical, from the simulation that runs the actual analysis function. */
  simulatedRulePower: number
  /** Empirical rejection rate of the Wilcoxon signed-rank test at plan alpha. */
  simulatedWilcoxonPower: number
}

/**
 * The committed power analysis.
 *
 * It exists because n=40-60 arrived from a brief rather than from a derivation,
 * and because the honest answer turned out to be uncomfortable enough that
 * committing it in advance is the only way it survives contact with a result
 * somebody wants.
 */
export interface PowerRegistrationSpec {
  /**
   * The rule-power table is the normal approximation to the committed rule,
   * which is a function of the bootstrap interval and the Hodges-Lehmann point
   * estimate - both asymptotically normal. The Wilcoxon test has no closed form,
   * so the SIMULATION (which runs the real analysis path) validates the table at
   * the registered spot-check points and supplies the test's own power.
   */
  method: 'normal_approximation_validated_by_simulation'
  simulation: {
    seed: string
    trials: number
    /** The power simulation's own bootstrap size. The real analysis uses 10000. */
    bootstrapIterations: number
  }
  alpha: number
  targetPower: number
  /**
   * Matched 12-hour pairs per coin the registered design actually delivers:
   * randomizedDays, because the draw is at the DAY level and each randomized day
   * is one staffed and one unstaffed block. Not 100, and not 60.
   */
  pairsPerCoin: number
  /**
   * Assumed SD of the log1p endpoint WITHIN a coin across 12-hour windows, after
   * hour-of-day and day-of-week are taken out as strata. Note the estimator does
   * NOT difference out day-level shocks - it compares a staffed Monday morning
   * against a different unstaffed Monday morning - so this figure must include
   * them.
   */
  withinCoinSdGrid: number[]
  plannedWithinCoinSd: number
  /**
   * SD of the per-coin TRUE effect on the log scale. Heterogeneity that no
   * number of blocks per coin removes; only more coins touch it.
   */
  plannedBetweenCoinEffectSd: number
  /** Hodges-Lehmann efficiency relative to the sample mean; 0.955 under normality. */
  estimatorEfficiency: number
  enrolledCoinsMin: number
  enrolledCoinsMax: number
  /** Committed derived figures, at plannedWithinCoinSd. Reproducible from the code. */
  mdePctAtMinCoins: number
  mdePctAtMaxCoins: number
  powerCurve: PowerCurvePoint[]
  spotChecks: PowerSpotCheck[]
  /**
   * Emitted VERBATIM in the report and in the pre-registration document. Says
   * out loud, in advance, what the design can and cannot detect.
   */
  adequacyStatement: string
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

export interface PublicationCommitmentSpec {
  /** Literal. A plan that may withhold a null result is not a pre-registration. */
  publishRegardlessOfOutcome: true
  /** What is published, whatever the answer is. */
  artifacts: string[]
  deadlineDaysAfterAnalysis: number
  /** Emitted verbatim. Committed before anyone knows which way it goes. */
  nullResultStatement: string
}

export interface EtiPlanSpec {
  enabled: boolean
  coins: number
  lagDays: number
  endpointId: string
  estimator: 'difference_in_differences'
  inference: 'permutation_on_cohort_labels'
  iterations: number
  /** The ETI sub-study informs procurement. It does not gate Phase 1. */
  gatesPhase1: false
}

export interface AnalysisPlan {
  planVersion: string
  pilotId: string
  hypothesis: string
  design: {
    kind: 'within_coin_time_randomized'
    totalDays: number
    blockHours: number
    randomizedDays: number
    fullCoverageSecondHalf: true
    targetCoinsMin: number
    targetCoinsMax: number
    freeOfCharge: true
  }
  endpoints: EndpointSpec[]
  stratification: StratificationSpec[]
  /** MUST be empty. Any entry here is a defect, not a modelling choice. */
  adjustmentCovariates: string[]
  test: { name: 'wilcoxon_signed_rank'; sided: 'two'; alpha: number }
  estimator: {
    name: 'hodges_lehmann'
    ci: { method: 'bootstrap_percentile'; iterations: number; seed: string }
    report: { median: true; mean: true }
  }
  /** Prose. Kept because a human reads it; the machine reads `exclusionRules`. */
  exclusions: string[]
  /** Machine-checkable, one per REQUIRED_EXCLUSION_RULES entry. */
  exclusionRules: ExclusionRuleSpec[]
  exclusionParameters: ExclusionParameters
  /** Reported alongside the primary, never able to change it. */
  sensitivityAnalyses: SensitivityAnalysisSpec[]
  power: PowerRegistrationSpec
  publication: PublicationCommitmentSpec
  decisionRule: DecisionRuleSpec
  etiSubStudy: EtiPlanSpec
}

export interface PreRegistration {
  planHash: string
  /**
   * sha256 of the rendered pre-registration document. The document is a pure
   * function of the plan, so this is redundant with `planHash` by construction -
   * and that is the point: it is what makes the human-readable artifact that
   * gets published provably the same object as the machine-readable plan the
   * analysis enforces.
   */
  documentHash: string
  committedAtUnix: number
  plan: AnalysisPlan
  /** External timestamp anchor, e.g. a tx hash or a notarised receipt. */
  anchor?: string
}

export class PreRegistrationError extends Error {
  constructor(message: string) {
    super(`pre-registration: ${message}`)
    this.name = 'PreRegistrationError'
  }
}

export class PlanTamperedError extends PreRegistrationError {
  constructor(
    readonly committedHash: string,
    readonly recomputedHash: string,
  ) {
    super(
      `the analysis plan changed after commitment (committed ${committedHash}, recomputed ${recomputedHash}); refusing to analyze`,
    )
    this.name = 'PlanTamperedError'
  }
}

export class UnregisteredCovariateError extends PreRegistrationError {
  constructor(readonly covariate: string) {
    super(
      `"${covariate}" is not a registered stratification variable; covariates may not be introduced at analysis time`,
    )
    this.name = 'UnregisteredCovariateError'
  }
}

export const DEFAULT_FAILURE_STATEMENT =
  'DECISION: DO NOT PROCEED TO PHASE 1. The pre-registered desk-coverage effect was not demonstrated. ' +
  'The operations component, which carries roughly 45% of the claimed value of the service, is therefore ' +
  'unsupported by this experiment. This result is not to be reinterpreted, subset, or re-analysed against ' +
  'a different endpoint; the plan was fixed before the data existed and this is the answer it returned.'

export const DEFAULT_SUCCESS_STATEMENT =
  'DECISION: PROCEED TO PHASE 1. The pre-registered 95% interval on the desk-coverage effect excludes zero ' +
  'and the point estimate on quote-denominated Venue-pool creator fees clears the committed threshold.'

export const DEFAULT_UNDERPOWERED_STATEMENT =
  'DECISION: DO NOT PROCEED TO PHASE 1 ON THIS EVIDENCE. The study did not reach the pre-registered minimum ' +
  'sample, so it neither demonstrates nor refutes the desk-coverage effect. Enrol the committed number of ' +
  'coins and rerun the same plan; do not analyse the partial sample for a result.'

export const DEFAULT_DELIVERY_COMPROMISED_STATEMENT =
  'DECISION: DO NOT PROCEED TO PHASE 1 ON THIS EVIDENCE. The desk failed to deliver its own assigned arm on ' +
  'more than the pre-registered share of staffed blocks, so the arms do not describe what actually happened ' +
  'and the contrast is not interpretable in either direction. This is an operator failure, not a finding ' +
  'about desks. Fix the delivery problem, rerun the trial under a fresh assignment, and report both runs.'

/**
 * The registered adequacy finding. Committed VERBATIM, before collection, and
 * quoted in the report whichever way the trial goes - because the single most
 * likely misreading of a null result here is "the desk does nothing" when what
 * the design can actually support is "the desk does not do +20% or more".
 */
export const DEFAULT_POWER_ADEQUACY_STATEMENT =
  'POWER, DERIVED AND REGISTERED BEFORE COLLECTION. n=40-60 originally came from a brief rather than from a ' +
  'derivation. Derived for this design - paired within coin, 30 matched 12-hour pairs per coin, Hodges-Lehmann ' +
  'with a percentile bootstrap, alpha 0.05, 80% target - the answer has three parts, and the first is the one ' +
  'that matters most. ' +
  '(1) THE COMMITTED RULE CANNOT DETECT +10% AT ANY SAMPLE SIZE. The rule requires the POINT ESTIMATE to reach ' +
  '+10%, so against a true effect of exactly +10% it fires with probability approaching one half from below, ' +
  'however many coins are enrolled. +10% is the minimum effect worth acting on, not the smallest effect this ' +
  'trial can find. A DO NOT PROCEED result rules out a large effect; it does NOT rule out a real effect ' +
  'somewhere between zero and +10%, and it must never be reported as though it did. ' +
  '(2) AGAINST +20%, 40-60 COINS IS ADEQUATE ONLY IF THE ENDPOINT IS NOT TOO NOISY. At a within-coin SD of 1.5 ' +
  'the minimum detectable effect is +19.9% at 40 coins and +16.0% at 60, and 40 coins is exactly the number ' +
  'needed for 80% power against +20%. At an SD of 1.0 the design is generous: 19 coins would do. At an SD of ' +
  '2.0 it is INSUFFICIENT - 69 coins are needed and 60 delivers 75% - and at an SD of 2.5 it is badly ' +
  'insufficient, needing 106. An SD of 2.0 to 2.5 is not a pessimistic invention: a late-life coin whose ' +
  '12-hour windows alternate between real flow and literally zero is zero-inflated, and a series that is 30% ' +
  'zeros and 70% around log1p 5 has an SD near 2.3. ' +
  '(3) THE HONEST CONCLUSION. Enrol at the TOP of the range, 60 and not 40, because the marginal coin is cheap ' +
  'and the difference between 40 and 60 is the difference between +19.9% and +16.0% detectable. Report the ' +
  'observed within-coin SD in the results, because it determines retrospectively which of the rows above the ' +
  'trial was actually in. And if the observed SD comes in at or above 2.0, say plainly that the trial was ' +
  'underpowered for its own question rather than reporting the null as an answer.'

export const DEFAULT_NULL_RESULT_STATEMENT =
  'PUBLICATION COMMITMENT: this pre-registration, the assignment, the per-block dataset, the exclusion log and ' +
  'the analysis output are published in full within 30 days of the analysis date, whatever the answer is. A ' +
  'null result is published with the same prominence as a positive one, under the failure statement committed ' +
  'above, and the operations component of the service is withdrawn from the offer rather than re-argued. No ' +
  'endpoint, exclusion, subgroup or estimator that does not appear in this document will be reported as though ' +
  'it had been planned.'

/**
 * The registered exclusions, with the mechanism each one exists to remove.
 *
 * These are the answer to "what could put money in this window that a staffed
 * desk did not cause". They are committed before collection because after
 * collection every one of them is a knob: whoever wants the desk to have worked
 * can always find a principled-sounding reason to drop the window that hurts.
 */
export const REGISTERED_EXCLUSION_RULES: readonly ExclusionRuleSpec[] = [
  {
    id: 'non_randomized_phase',
    scope: 'primary',
    mechanism:
      'Every coin receives full desk coverage for the second half of the trial. Those blocks were never randomized.',
    rule: 'A block whose phase is not RANDOMIZED contributes nothing to the primary comparison.',
    justification:
      'There is no contrast to make. The full-coverage half exists so that the study randomizes WHEN a free service arrives and never WHETHER it arrives.',
  },
  {
    id: 'unvalued_window',
    scope: 'primary',
    mechanism:
      'Approved quote assets are upgradeable, pausable proxies. A paused asset, an unapproved asset or a missing pinned price means the window has no USD value.',
    rule:
      'A window whose fees could not be valued is excluded. Its endpoint is recorded as NaN, never as zero, so a failure to exclude it aborts the analysis instead of silently averaging in a false zero.',
    justification:
      'An unmeasured window is not a zero-fee window. Imputing zero would move the endpoint toward zero in whichever arm happened to be running when the asset was paused, and the pause has no relationship to the desk.',
  },
  {
    id: 'launch_window_anti_snipe',
    scope: 'primary',
    mechanism:
      'Venue charges an anti-snipe tax of 99% at t=0 that decays to zero over roughly three seconds, and it reaches the fee recipient along the ordinary fee rails. It is real money, it is credited like ordinary revenue, and relative to the organic 12-hour flow of a coin it can be one to two orders of magnitude larger.',
    rule:
      'Every follow-window that starts within 24 hours of the TokenLaunched timestamp for that coin is excluded, and so is any window carrying a credit the classifier attributed to the anti-snipe window (within 5 seconds of launch, or an effective fee rate above twice the hook fee). Because the drop is at the day level, the sibling 12-hour block of the same day goes with it.',
    justification:
      'Three reasons for 24 hours rather than "the first block". First, post-graduation fees arrive as AGGREGATED SWEEPS whose timestamp is that of the sweep and not of the trade, so a windfall accrued at t=0 can be credited materially later and a one-block rule would miss it. Second, the same first day carries launch price discovery, which is a different mechanism with the same signature: an enormous fee spike that no desk caused. Third, dropping a whole 24-hour day-pair preserves the EXACT hour-of-day balance the assignment generator guarantees, which dropping a single half-day would break - and hour-of-day is a stratification variable precisely because this data is violently diurnal. The onboarding hold the operator already runs is 900 seconds, which is calibrated to tax decay and settlement rather than to sweep cadence, so it is not the right N here and 24 hours is the conservative choice on all three grounds.',
  },
  {
    id: 'graduation_mechanism_change',
    scope: 'primary',
    mechanism:
      'Before graduation the creator fee of a coin is an explicit per-trade field on its own curve contract. After graduation it is an aggregated PoolFeesSwept keyed by poolId. The rate basis, the batching and the timestamp semantics all change, and the first sweep after the switch can carry accrued backlog.',
    rule:
      'Windows in which both mechanisms are observed are excluded, and so is every window starting within 48 hours of the first observed PoolFeesSwept for that coin. The day-pair widening applies. The coin keeps all of its other windows.',
    justification:
      'The endpoint would otherwise change definition inside the series of a single coin, which is the one thing a within-coin design cannot absorb. 48 hours covers the first full sweep cycle after the change so that the backlog sweep is not read as a desk effect. Excluding the coin entirely would be worse: graduation is plausibly correlated with the traits that make a coin worth studying.',
  },
  {
    id: 'recipient_change',
    scope: 'primary',
    mechanism:
      'The creator-fee recipient can move: self-service and immediate by the current recipient, or by the three-day-timelocked override held by the Venue owner. After it moves, the fees belong to a different party under different incentives, and that party may be running their own promotion.',
    rule:
      'Every window of that coin from the recipient change onward is excluded. Earlier windows are kept.',
    justification:
      'The change is an intervention on the thing being measured and it is not caused by the desk. It is not reversible by any analysis, so the coin is censored at the change rather than adjusted.',
  },
] as const

export const REGISTERED_EXCLUSION_PARAMETERS: ExclusionParameters = {
  launchExclusionHours: 24,
  graduationExclusionHours: 48,
  antiSnipeWindowSeconds: 5,
  dropWholeDayPair: true,
  maxUndeliveredStaffedShare: 0.1,
  whaleShareThreshold: 0.5,
}

/**
 * The two contaminants deliberately NOT excluded. Both are conditioned on
 * something that happens AFTER randomization, and both would bias the effect in
 * the direction the operator wants if they were dropped from the primary.
 */
export const REGISTERED_SENSITIVITY_ANALYSES: readonly SensitivityAnalysisSpec[] = [
  {
    id: 'per_protocol_delivery',
    gatesDecision: false,
    description:
      'Re-runs the primary excluding blocks where the desk did not deliver the assigned arm - a staffed block we failed to cover, or an unstaffed block somebody answered in anyway.',
    justification:
      'The primary is intention-to-treat. Dropping non-compliant blocks conditions on post-randomization behaviour and reliably flatters the treatment, because the blocks we fail to cover are not a random sample of blocks. Delivery failure is instead capped: past 10% of staffed blocks the trial is reported as compromised, which can only withhold a proceed and never grant one.',
  },
  {
    id: 'whale_dominated_window',
    gatesDecision: false,
    description:
      'Re-runs the primary excluding windows in which a single fee credit accounts for at least half of the USD total for that window.',
    justification:
      'A single enormous trade is real revenue with no plausible desk mechanism, so the temptation to drop it is strong. It is nonetheless an outcome-conditioned exclusion applied after randomization, and even applied blind to arm it biases the treatment effect whenever treatment shifts the outcome distribution - which is the hypothesis. The log1p transform already compresses a whale by construction. So it is flagged, reported, and left in.',
  },
] as const

export const REGISTERED_PUBLICATION_COMMITMENT: PublicationCommitmentSpec = {
  publishRegardlessOfOutcome: true,
  artifacts: [
    'this pre-registration document and its hash, with the commitment timestamp and anchor',
    'the published seed and the full block-level assignment, so any third party can recompute every arm',
    'the per-block dataset: arm, phase, strata, follow window, fee total in minor units and USD with its price provenance',
    'the exclusion log: every block dropped, under which registered rule, with its integrity facts',
    'the analysis output verbatim, including the Wilcoxon statistic, the Hodges-Lehmann estimate, the bootstrap interval and both sensitivity re-runs',
    'the registered power analysis and the adequacy statement, unedited',
  ],
  deadlineDaysAfterAnalysis: 30,
  nullResultStatement: DEFAULT_NULL_RESULT_STATEMENT,
}

/**
 * The registered power assumptions.
 *
 * `pairsPerCoin` is 30 and not 100: the draw is at the DAY level and there are
 * `randomizedDays` = 30 randomized days, each contributing one staffed and one
 * unstaffed 12-hour block. Writing 100 here would flatter the design by a factor
 * of nearly two on the standard error.
 *
 * The SD grid spans what this endpoint plausibly does. A busy coin's log1p fee
 * flow across 12-hour windows sits near 0.5-1.0. A coin late in its life whose
 * windows alternate between real flow and literally zero is zero-inflated, and
 * a series that is 30% zeros and 70% around log1p 5 has an SD near 2.3. The
 * planning value of 1.5 is the middle of that and is not a best case.
 */
export const REGISTERED_POWER_ASSUMPTIONS = {
  seed: 'vault-pilot-power/v1',
  trials: 400,
  bootstrapIterations: 1_000,
  alpha: 0.05,
  targetPower: 0.8,
  pairsPerCoin: 30,
  withinCoinSdGrid: [0.5, 1, 1.5, 2, 2.5],
  plannedWithinCoinSd: 1.5,
  plannedBetweenCoinEffectSd: 0.1,
  enrolledCoinsMin: 40,
  enrolledCoinsMax: 60,
  curveCoinCounts: [40, 60],
  curveEffectsPct: [10, 20, 30],
} as const

function roundTo(value: number, places: number): number {
  const scale = 10 ** places
  return Math.round(value * scale) / scale
}

/**
 * Build the committed power block.
 *
 * The curve is DERIVED rather than typed in, so the document and the code can
 * never disagree about what was claimed - and it is rounded to four places so
 * the plan hash does not depend on the last bits of a libm implementation.
 */
export function registeredPowerSpec(
  thresholdPct: number,
  ciLevel: number,
  estimatorEfficiency: number,
): PowerRegistrationSpec {
  const a = REGISTERED_POWER_ASSUMPTIONS
  const base: PowerDesign = {
    coins: a.enrolledCoinsMin,
    pairsPerCoin: a.pairsPerCoin,
    withinCoinSd: a.plannedWithinCoinSd,
    betweenCoinEffectSd: a.plannedBetweenCoinEffectSd,
    alpha: a.alpha,
    thresholdPct,
    ciLevel,
    estimatorEfficiency,
  }

  return {
    method: 'normal_approximation_validated_by_simulation',
    simulation: {
      seed: a.seed,
      trials: a.trials,
      bootstrapIterations: a.bootstrapIterations,
    },
    alpha: a.alpha,
    targetPower: a.targetPower,
    pairsPerCoin: a.pairsPerCoin,
    withinCoinSdGrid: [...a.withinCoinSdGrid],
    plannedWithinCoinSd: a.plannedWithinCoinSd,
    plannedBetweenCoinEffectSd: a.plannedBetweenCoinEffectSd,
    estimatorEfficiency,
    enrolledCoinsMin: a.enrolledCoinsMin,
    enrolledCoinsMax: a.enrolledCoinsMax,
    mdePctAtMinCoins: roundTo(
      minimumDetectableEffectPct({ ...base, coins: a.enrolledCoinsMin }, a.targetPower).effectPct,
      2,
    ),
    mdePctAtMaxCoins: roundTo(
      minimumDetectableEffectPct({ ...base, coins: a.enrolledCoinsMax }, a.targetPower).effectPct,
      2,
    ),
    powerCurve: powerTable(
      base,
      a.curveCoinCounts,
      a.withinCoinSdGrid,
      a.curveEffectsPct,
    ).map((row) => ({
      coins: row.coins,
      withinCoinSd: row.withinCoinSd,
      trueEffectPct: row.trueEffectPct,
      rulePower: roundTo(row.rulePower, 4),
    })),
    // Empirical, from `simulateDeskPower` at the registered seed and trial
    // count. Typed in because the simulation is far too slow to run inside plan
    // construction; `power-simulation.spec.ts` reproduces every one of them.
    spotChecks: [
      {
        coins: 60,
        withinCoinSd: 1.5,
        trueEffectPct: 10,
        simulatedRulePower: 0.43,
        simulatedWilcoxonPower: 0.44,
      },
      {
        coins: 60,
        withinCoinSd: 1.5,
        trueEffectPct: 20,
        simulatedRulePower: 0.905,
        simulatedWilcoxonPower: 0.9,
      },
      {
        coins: 40,
        withinCoinSd: 2.5,
        trueEffectPct: 20,
        simulatedRulePower: 0.4325,
        simulatedWilcoxonPower: 0.405,
      },
    ],
    adequacyStatement: DEFAULT_POWER_ADEQUACY_STATEMENT,
  }
}

/** The registered Section 9 plan. */
export function defaultAnalysisPlan(
  pilotId: string,
  bootstrapSeed: string,
  overrides: Partial<AnalysisPlan> = {},
): AnalysisPlan {
  const plan: AnalysisPlan = {
    planVersion: 'vault-pilot-plan/v1',
    pilotId,
    hypothesis:
      'Staffing the desk during a 12-hour block raises quote-denominated Venue-pool creator fees credited in the following 12 hours.',
    design: {
      kind: 'within_coin_time_randomized',
      totalDays: 60,
      blockHours: 12,
      randomizedDays: 30,
      fullCoverageSecondHalf: true,
      targetCoinsMin: 40,
      targetCoinsMax: 60,
      freeOfCharge: true,
    },
    endpoints: [
      {
        id: 'fees_log1p',
        role: 'primary',
        description:
          'log1p of quote-denominated Venue-pool creator fees (USD, pinned price) credited in the 12 hours following the block.',
        transform: 'log1p',
        window: 'following_block_span',
      },
      {
        id: 'unique_new_buyers',
        role: 'secondary',
        description: 'Unique addresses making their first ever buy in the following 12 hours.',
        transform: 'identity',
        window: 'following_block_span',
      },
      {
        id: 'telegram_net_join_rate',
        role: 'secondary',
        description: 'Telegram (joins - leaves) divided by end-of-window members.',
        transform: 'rate',
        window: 'following_block_span',
      },
      {
        id: 'unanswered_backlog',
        role: 'secondary',
        description:
          'Sum of the Digest topic code unanswered_backlog in the following 12 hours. Digest-derived only; no raw message is ever read.',
        transform: 'identity',
        window: 'following_block_span',
      },
    ],
    stratification: [
      { name: 'hour_of_day', role: 'stratification' },
      { name: 'day_of_week', role: 'stratification' },
    ],
    adjustmentCovariates: [],
    test: { name: 'wilcoxon_signed_rank', sided: 'two', alpha: 0.05 },
    estimator: {
      name: 'hodges_lehmann',
      ci: { method: 'bootstrap_percentile', iterations: 10_000, seed: bootstrapSeed },
      report: { median: true, mean: true },
    },
    exclusions: [
      'Blocks in the full-coverage second half are not randomized and are excluded from the primary comparison.',
      'A coin contributes only strata in which both arms were observed.',
      'A window whose fees could not be valued (kill-switched asset, missing pinned price) is excluded, never imputed as zero.',
      'Every follow-window starting within 24 hours of the coin launch is excluded, because the 99%-at-t=0 anti-snipe tax reaches the fee recipient along the ordinary rails and can dominate a log1p series by itself.',
      'Windows within 48 hours of the coin graduating are excluded, because graduation changes the fee mechanism underneath the series of that coin.',
      'Every window from a creator-fee recipient change onward is excluded for that coin.',
      'A whale-dominated window and a block the desk failed to deliver are FLAGGED and kept: both are conditioned on what happened after randomization, and dropping either would bias the effect toward the operator.',
    ],
    exclusionRules: REGISTERED_EXCLUSION_RULES.map((rule) => ({ ...rule })),
    exclusionParameters: { ...REGISTERED_EXCLUSION_PARAMETERS },
    sensitivityAnalyses: REGISTERED_SENSITIVITY_ANALYSES.map((spec) => ({ ...spec })),
    power: registeredPowerSpec(10, 0.95, HODGES_LEHMANN_EFFICIENCY),
    publication: {
      ...REGISTERED_PUBLICATION_COMMITMENT,
      artifacts: [...REGISTERED_PUBLICATION_COMMITMENT.artifacts],
    },
    decisionRule: {
      ciLevel: 0.95,
      requireCiExcludesZero: true,
      minFeeEffectPct: 10,
      minCoins: 40,
      minPairedStrataPerCoin: 1,
      failureStatement: DEFAULT_FAILURE_STATEMENT,
      successStatement: DEFAULT_SUCCESS_STATEMENT,
      underpoweredStatement: DEFAULT_UNDERPOWERED_STATEMENT,
      deliveryCompromisedStatement: DEFAULT_DELIVERY_COMPROMISED_STATEMENT,
    },
    etiSubStudy: {
      enabled: true,
      coins: 40,
      lagDays: 14,
      endpointId: 'fees_log1p',
      estimator: 'difference_in_differences',
      inference: 'permutation_on_cohort_labels',
      iterations: 10_000,
      gatesPhase1: false,
    },
    ...overrides,
  }
  validatePlan(plan)
  return plan
}

export function validatePlan(plan: AnalysisPlan): void {
  if (plan.adjustmentCovariates.length > 0) {
    throw new UnregisteredCovariateError(plan.adjustmentCovariates[0]!)
  }
  const primaries = plan.endpoints.filter((e) => e.role === 'primary')
  if (primaries.length !== 1) {
    throw new PreRegistrationError('exactly one primary endpoint must be registered')
  }
  if (primaries[0]!.transform !== 'log1p') {
    throw new PreRegistrationError('the registered primary endpoint transform is log1p')
  }
  for (const stratum of plan.stratification) {
    if (!REGISTERED_STRATIFICATION.includes(stratum.name)) {
      throw new PreRegistrationError(`unknown stratification variable ${stratum.name}`)
    }
    if (stratum.role !== 'stratification') {
      throw new PreRegistrationError(
        `${stratum.name} is a stratification variable and may not be re-declared`,
      )
    }
  }
  if (plan.decisionRule.ciLevel !== 0.95) {
    throw new PreRegistrationError('the committed confidence level is 95%')
  }
  if (!plan.decisionRule.requireCiExcludesZero) {
    throw new PreRegistrationError('the decision rule requires the interval to exclude zero')
  }
  if (!(plan.decisionRule.minFeeEffectPct >= 10)) {
    throw new PreRegistrationError('the committed fee-effect threshold is at least +10%')
  }
  if (!plan.design.fullCoverageSecondHalf || !plan.design.freeOfCharge) {
    throw new PreRegistrationError('the pilot is free and provides full coverage for the second half')
  }
  if (plan.etiSubStudy.gatesPhase1 !== false) {
    throw new PreRegistrationError('the ETI sub-study informs procurement and does not gate Phase 1')
  }
  if (plan.estimator.ci.iterations < 1_000 || !plan.estimator.ci.seed) {
    throw new PreRegistrationError('the bootstrap must be seeded and run at least 1000 iterations')
  }
  validateExclusions(plan)
  validatePower(plan)
  validatePublication(plan)
}

/**
 * Every exclusion the engine can apply must be registered, with its mechanism
 * and its justification, and the parameters may not be loosened below the floors
 * the mechanisms imply. A plan that omits one does not validate, cannot be
 * hashed and therefore cannot be committed.
 */
export function validateExclusions(plan: AnalysisPlan): void {
  const seen = new Set<ExclusionRuleId>()
  for (const rule of plan.exclusionRules) {
    if (!REQUIRED_EXCLUSION_RULES.includes(rule.id)) {
      throw new PreRegistrationError(`unknown exclusion rule ${rule.id}`)
    }
    if (seen.has(rule.id)) throw new PreRegistrationError(`exclusion rule ${rule.id} is registered twice`)
    seen.add(rule.id)
    if (rule.scope !== 'primary') {
      throw new PreRegistrationError(`exclusion rule ${rule.id} must be scoped to the primary`)
    }
    if (!rule.mechanism || !rule.rule || !rule.justification) {
      throw new PreRegistrationError(
        `exclusion rule ${rule.id} must state its mechanism, its rule and its justification`,
      )
    }
  }
  for (const required of REQUIRED_EXCLUSION_RULES) {
    if (!seen.has(required)) {
      throw new PreRegistrationError(
        `the plan does not register the ${required} exclusion; the analysis engine applies it, so ` +
          'committing a plan that omits it would leave the applied exclusions undocumented',
      )
    }
  }

  const sensitivitySeen = new Set<SensitivityAnalysisId>()
  for (const spec of plan.sensitivityAnalyses) {
    if (!REQUIRED_SENSITIVITY_ANALYSES.includes(spec.id)) {
      throw new PreRegistrationError(`unknown sensitivity analysis ${spec.id}`)
    }
    if (spec.gatesDecision !== false) {
      throw new PreRegistrationError(`sensitivity analysis ${spec.id} may not gate the decision`)
    }
    sensitivitySeen.add(spec.id)
  }
  for (const required of REQUIRED_SENSITIVITY_ANALYSES) {
    if (!sensitivitySeen.has(required)) {
      throw new PreRegistrationError(`the plan does not register the ${required} sensitivity analysis`)
    }
  }

  const p = plan.exclusionParameters
  if (!(p.launchExclusionHours >= 24)) {
    throw new PreRegistrationError(
      'the launch exclusion must be at least 24 hours: post-graduation fees arrive as aggregated ' +
        'sweeps whose timestamp is not the trade timestamp, so a shorter window can miss an ' +
        'anti-snipe windfall whose credit was deferred',
    )
  }
  if (!(p.graduationExclusionHours >= 24)) {
    throw new PreRegistrationError('the graduation exclusion must cover at least one sweep cycle')
  }
  if (!(p.antiSnipeWindowSeconds >= 5)) {
    throw new PreRegistrationError(
      'the anti-snipe classification window must be at least 5 seconds: the tax decays over ~3 ' +
        'seconds and block timestamps have second granularity, so the window is padded, not cut fine',
    )
  }
  if (!p.dropWholeDayPair) {
    throw new PreRegistrationError(
      'a launch or graduation drop must take the whole 24-hour day-pair, or the exact hour-of-day ' +
        'balance the assignment generator guarantees is broken',
    )
  }
  if (!(p.maxUndeliveredStaffedShare > 0 && p.maxUndeliveredStaffedShare <= 0.1)) {
    throw new PreRegistrationError('the delivery-failure ceiling is at most 10% of staffed blocks')
  }
  if (!(p.whaleShareThreshold > 0 && p.whaleShareThreshold <= 1)) {
    throw new PreRegistrationError('the whale share threshold must lie in (0, 1]')
  }
}

export function validatePower(plan: AnalysisPlan): void {
  const power = plan.power
  if (power.alpha !== plan.test.alpha) {
    throw new PreRegistrationError(
      `the power analysis was computed at alpha ${power.alpha} but the test is registered at ${plan.test.alpha}`,
    )
  }
  if (!(power.targetPower >= 0.8 && power.targetPower < 1)) {
    throw new PreRegistrationError('the registered target power is at least 80%')
  }
  if (!Number.isInteger(power.pairsPerCoin) || power.pairsPerCoin < 1) {
    throw new PreRegistrationError('pairsPerCoin must be a positive integer')
  }
  if (power.enrolledCoinsMin !== plan.decisionRule.minCoins) {
    throw new PreRegistrationError(
      `the power analysis assumes ${power.enrolledCoinsMin} coins but the decision rule requires ` +
        `${plan.decisionRule.minCoins}; the derivation and the floor may not drift apart`,
    )
  }
  if (power.enrolledCoinsMin !== plan.design.targetCoinsMin || power.enrolledCoinsMax !== plan.design.targetCoinsMax) {
    throw new PreRegistrationError('the power analysis and the design must enrol the same coins')
  }
  if (power.withinCoinSdGrid.length === 0) {
    throw new PreRegistrationError('the power analysis must state the variance grid it swept')
  }
  for (let i = 1; i < power.withinCoinSdGrid.length; i += 1) {
    if (!(power.withinCoinSdGrid[i]! > power.withinCoinSdGrid[i - 1]!)) {
      throw new PreRegistrationError('the within-coin SD grid must ascend')
    }
  }
  if (!power.withinCoinSdGrid.includes(power.plannedWithinCoinSd)) {
    throw new PreRegistrationError('the planning SD must be one of the swept values')
  }
  if (!(power.plannedBetweenCoinEffectSd >= 0)) {
    throw new PreRegistrationError('the between-coin effect SD must be stated, even if it is zero')
  }
  if (power.powerCurve.length === 0 || power.spotChecks.length === 0) {
    throw new PreRegistrationError(
      'the power analysis must publish both its curve and the simulation spot-checks that validate it',
    )
  }
  if (!power.simulation.seed || power.simulation.trials < 100) {
    throw new PreRegistrationError('the power simulation must be seeded and run at least 100 trials')
  }
  if (!power.adequacyStatement) {
    throw new PreRegistrationError(
      'the power analysis must state, in advance and in words, whether the enrolled sample is adequate',
    )
  }
}

export function validatePublication(plan: AnalysisPlan): void {
  const publication = plan.publication
  if (publication.publishRegardlessOfOutcome !== true) {
    throw new PreRegistrationError(
      'a plan that may withhold a null result is not a pre-registration',
    )
  }
  if (publication.artifacts.length === 0) {
    throw new PreRegistrationError('the publication commitment must list what gets published')
  }
  if (!Number.isInteger(publication.deadlineDaysAfterAnalysis) || publication.deadlineDaysAfterAnalysis > 30) {
    throw new PreRegistrationError('the publication deadline is at most 30 days after the analysis')
  }
  if (!publication.nullResultStatement) {
    throw new PreRegistrationError('the null-result statement must be committed verbatim in advance')
  }
}

export function planHash(plan: AnalysisPlan): string {
  validatePlan(plan)
  return hashObject(plan)
}

/**
 * Commit the plan. Do this BEFORE the first block is observed.
 *
 * The document hash is taken here rather than left to whoever publishes, so the
 * artifact a human reads and the object the machine enforces are provably the
 * same thing from the moment of commitment.
 */
export function commitPlan(
  plan: AnalysisPlan,
  committedAtUnix: number,
  anchor?: string,
): PreRegistration {
  if (!Number.isInteger(committedAtUnix) || committedAtUnix <= 0) {
    throw new PreRegistrationError('committedAtUnix must be a positive integer unix timestamp')
  }
  const registration: PreRegistration = {
    planHash: planHash(plan),
    documentHash: preRegistrationDocumentHash(plan),
    committedAtUnix,
    plan,
  }
  if (anchor !== undefined) registration.anchor = anchor
  return registration
}

/**
 * Recompute both hashes and refuse if either moved. Optionally prove the
 * commitment predates the first observation, which is the property the hash
 * alone does not give you.
 */
export function verifyPreRegistration(
  registration: PreRegistration,
  firstObservationUnix?: number,
): void {
  const recomputed = planHash(registration.plan)
  if (recomputed !== registration.planHash) {
    throw new PlanTamperedError(registration.planHash, recomputed)
  }
  const recomputedDocument = preRegistrationDocumentHash(registration.plan)
  if (recomputedDocument !== registration.documentHash) {
    throw new PreRegistrationError(
      `the published pre-registration document does not match the committed plan (committed ` +
        `${registration.documentHash}, recomputed ${recomputedDocument}); refusing to analyze`,
    )
  }
  if (firstObservationUnix !== undefined && registration.committedAtUnix > firstObservationUnix) {
    throw new PreRegistrationError(
      `the plan was committed at ${registration.committedAtUnix}, after data collection began at ${firstObservationUnix}; refusing to analyze`,
    )
  }
}

/** Reject any covariate that is not a registered stratification variable. */
export function assertCovariatesRegistered(
  plan: AnalysisPlan,
  requested: readonly string[] | undefined,
): void {
  if (!requested || requested.length === 0) return
  const allowed = new Set(plan.stratification.map((s) => s.name as string))
  for (const covariate of requested) {
    if (!allowed.has(covariate)) throw new UnregisteredCovariateError(covariate)
  }
}
