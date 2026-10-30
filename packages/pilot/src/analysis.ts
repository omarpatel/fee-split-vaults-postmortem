/**
 * The analysis, and the decision it mechanically produces.
 *
 * The comparison is PAIRED WITHIN COIN and stratified on hour-of-day and
 * day-of-week. That is what the observational evidence cannot do: each coin is
 * its own control, so the coin's own decay curve, the heterogeneity between
 * coins, and the selection that put a coin in the pilot at all are differenced
 * away rather than argued away.
 *
 * The decision rule was committed before the data existed and is evaluated here
 * without a human in the loop. A negative result is reported as a negative
 * result, in the words that were committed in advance.
 */

import {
  applyRegisteredExclusions,
  assertNoContaminatedBlockSurvived,
  SENSITIVITY_FILTERS,
} from './exclusions.js'
import {
  assertCovariatesRegistered,
  verifyPreRegistration,
  type AnalysisPlan,
  type PreRegistration,
} from './prereg.js'
import {
  bootstrapHodgesLehmannPaired,
  hodgesLehmannPaired,
  logShiftToPercent,
  mean,
  median,
  wilcoxonSignedRank,
  type BootstrapCi,
  type WilcoxonResult,
} from './stats.js'
import type {
  BlockOutcome,
  ExclusionReport,
  PilotDataset,
  SensitivityAnalysisId,
} from './types.js'

export class AnalysisError extends Error {
  constructor(message: string) {
    super(`pilot analysis: ${message}`)
    this.name = 'AnalysisError'
  }
}

export type Verdict =
  | 'PROCEED_TO_PHASE_1'
  | 'DO_NOT_PROCEED'
  | 'INCONCLUSIVE_UNDERPOWERED'
  /** The desk failed to deliver its own assignment often enough to void the trial. */
  | 'COMPROMISED_DELIVERY'

export interface CoinDifference {
  coinRef: string
  /** Weighted mean of within-stratum (staffed - unstaffed) differences. */
  difference: number
  /** Strata in which BOTH arms were observed. */
  pairedStrata: number
  staffedBlocks: number
  unstaffedBlocks: number
}

export interface EndpointResult {
  endpointId: string
  role: 'primary' | 'secondary'
  coins: number
  /** Both are reported. A median alone hides a skewed tail; a mean alone is farmable. */
  medianDifference: number
  meanDifference: number
  hodgesLehmann: number
  ci: BootstrapCi
  wilcoxon: WilcoxonResult
  /** Only meaningful on the log1p endpoint. */
  effectPct?: { point: number; lo: number; hi: number }
  /** Secondaries carry no multiplicity control and cannot support the decision. */
  alphaControlled: boolean
  perCoin: CoinDifference[]
}

export interface DecisionResult {
  verdict: Verdict
  proceed: boolean
  ciExcludesZero: boolean
  pointEstimatePct: number
  ciPct: { lo: number; hi: number }
  thresholdPct: number
  coins: number
  minCoins: number
  /** True when delivery failure exceeded the committed ceiling. Withholds only. */
  deliveryCeilingBreached: boolean
  /** Emitted verbatim from the committed plan. */
  statement: string
}

/**
 * A registered re-run. It is reported next to the primary and it is structurally
 * incapable of changing the verdict: `gatesDecision` is a literal false and
 * nothing here is fed to `decide`.
 */
export interface SensitivityResult {
  id: SensitivityAnalysisId
  gatesDecision: false
  /** Absent when the filter left too little data to estimate anything. */
  result?: EndpointResult
  blocksRemoved: number
  coins: number
  note: string
}

export interface DeskAnalysis {
  pilotId: string
  planHash: string
  documentHash: string
  assignmentHash: string
  analyzedAtUnix: number
  /** What the committed exclusions actually removed, and under which rule. */
  exclusions: ExclusionReport
  primary: EndpointResult
  secondaries: EndpointResult[]
  sensitivity: SensitivityResult[]
  decision: DecisionResult
  /** Code-authored. No model writes any part of this. */
  reportText: string
}

export interface AnalyzeOptions {
  /**
   * Refused unless every entry is a registered stratification variable. There
   * is no path here for a covariate discovered after the fact.
   */
  covariates?: string[]
  analyzedAtUnix?: number
}

type EndpointExtractor = (outcome: BlockOutcome) => number

const SECONDARY_EXTRACTORS: Record<string, EndpointExtractor> = {
  unique_new_buyers: (o) => o.uniqueNewBuyers,
  telegram_net_join_rate: (o) =>
    o.membership.membersEnd > 0
      ? (o.membership.joins - o.membership.leaves) / o.membership.membersEnd
      : 0,
  unanswered_backlog: (o) => o.unansweredBacklog,
}

const PRIMARY_EXTRACTOR: EndpointExtractor = (o) => o.primaryLog1pFeesUsd

/**
 * Within-coin, within-stratum paired difference.
 *
 * Hour-of-day and day-of-week enter here as STRATA and nowhere else. They are
 * never fitted, never selected on, and never reported as an effect.
 */
export function coinDifferences(
  outcomes: readonly BlockOutcome[],
  extract: EndpointExtractor,
  minPairedStrata: number,
): CoinDifference[] {
  const byCoin = new Map<string, BlockOutcome[]>()
  for (const outcome of outcomes) {
    if (outcome.phase !== 'RANDOMIZED') continue
    const bucket = byCoin.get(outcome.coinRef)
    if (bucket) bucket.push(outcome)
    else byCoin.set(outcome.coinRef, [outcome])
  }

  const results: CoinDifference[] = []
  for (const coinRef of [...byCoin.keys()].sort()) {
    const blocks = byCoin.get(coinRef)!
    const strata = new Map<string, { staffed: number[]; unstaffed: number[] }>()
    for (const block of blocks) {
      const key = `${block.dayOfWeek}:${block.hourOfDay}`
      const cell = strata.get(key) ?? { staffed: [], unstaffed: [] }
      const value = extract(block)
      if (!Number.isFinite(value)) {
        throw new AnalysisError(`non-finite endpoint value for ${coinRef} block ${block.blockIndex}`)
      }
      if (block.arm === 'STAFFED') cell.staffed.push(value)
      else cell.unstaffed.push(value)
      strata.set(key, cell)
    }

    let weighted = 0
    let weight = 0
    let pairedStrata = 0
    let staffedBlocks = 0
    let unstaffedBlocks = 0
    for (const cell of strata.values()) {
      staffedBlocks += cell.staffed.length
      unstaffedBlocks += cell.unstaffed.length
      if (cell.staffed.length === 0 || cell.unstaffed.length === 0) continue
      const w = cell.staffed.length + cell.unstaffed.length
      weighted += w * (mean(cell.staffed) - mean(cell.unstaffed))
      weight += w
      pairedStrata += 1
    }

    if (pairedStrata < minPairedStrata || weight === 0) continue
    results.push({
      coinRef,
      difference: weighted / weight,
      pairedStrata,
      staffedBlocks,
      unstaffedBlocks,
    })
  }
  return results
}

function evaluateEndpoint(
  endpointId: string,
  role: 'primary' | 'secondary',
  outcomes: readonly BlockOutcome[],
  extract: EndpointExtractor,
  plan: AnalysisPlan,
  seedSuffix: string,
): EndpointResult {
  const perCoin = coinDifferences(outcomes, extract, plan.decisionRule.minPairedStrataPerCoin)
  if (perCoin.length === 0) {
    throw new AnalysisError(`endpoint ${endpointId} has no coin with both arms observed`)
  }
  return evaluatePairedDifferences(endpointId, role, perCoin, plan, seedSuffix)
}

/**
 * The estimator half of the analysis, given coin-level differences.
 *
 * Split out so the POWER SIMULATION can drive the identical code path rather
 * than a re-implementation of it: a power figure computed against a second copy
 * of the estimator is a power figure for a study nobody is running.
 */
export function evaluatePairedDifferences(
  endpointId: string,
  role: 'primary' | 'secondary',
  perCoin: readonly CoinDifference[],
  plan: AnalysisPlan,
  seedSuffix: string,
): EndpointResult {
  if (perCoin.length === 0) {
    throw new AnalysisError(`endpoint ${endpointId} has no coin with both arms observed`)
  }
  const differences = perCoin.map((c) => c.difference)

  const ci = bootstrapHodgesLehmannPaired(differences, {
    iterations: plan.estimator.ci.iterations,
    level: plan.decisionRule.ciLevel,
    seed: `${plan.estimator.ci.seed}|${endpointId}|${seedSuffix}`,
  })

  const result: EndpointResult = {
    endpointId,
    role,
    coins: perCoin.length,
    medianDifference: median(differences),
    meanDifference: mean(differences),
    hodgesLehmann: hodgesLehmannPaired(differences),
    ci,
    wilcoxon: wilcoxonSignedRank(differences),
    alphaControlled: role === 'primary',
    perCoin: [...perCoin],
  }
  if (endpointId === 'fees_log1p') {
    result.effectPct = {
      point: logShiftToPercent(result.hodgesLehmann),
      lo: logShiftToPercent(ci.lo),
      hi: logShiftToPercent(ci.hi),
    }
  }
  return result
}

/**
 * Run the registered analysis. Refuses on a changed plan, on a plan committed
 * after collection began, on an assignment the dataset does not match, on any
 * covariate that was not registered, and on an exclusion set that does not match
 * the committed one.
 *
 * THE EXCLUSIONS ARE APPLIED HERE, not upstream. A caller cannot opt out of
 * them, cannot pass a pre-filtered dataset without being caught, and cannot
 * supply their own: `applyRegisteredExclusions` takes the plan and nothing else.
 */
export function analyzeDesk(
  dataset: PilotDataset,
  registration: PreRegistration,
  expectedAssignmentHash: string,
  options: AnalyzeOptions = {},
): DeskAnalysis {
  verifyPreRegistration(registration, dataset.firstObservationUnix)
  const plan = registration.plan

  if (plan.pilotId !== dataset.pilotId) {
    throw new AnalysisError(
      `plan is registered for pilot ${plan.pilotId} but the dataset is ${dataset.pilotId}`,
    )
  }
  if (dataset.assignmentHash !== expectedAssignmentHash) {
    throw new AnalysisError(
      'dataset assignment hash does not match the committed assignment; the arms may have moved',
    )
  }
  assertCovariatesRegistered(plan, options.covariates)

  const { kept, report } = applyRegisteredExclusions(dataset.outcomes, plan)
  if (dataset.exclusionReport !== undefined) {
    if (dataset.exclusionReport.planExclusionHash !== report.planExclusionHash) {
      throw new AnalysisError(
        'the dataset was filtered under a different exclusion policy than the committed plan ' +
          `(dataset ${dataset.exclusionReport.planExclusionHash}, plan ${report.planExclusionHash}); refusing to analyze`,
      )
    }
    if (dataset.exclusionReport.reportHash !== report.reportHash) {
      throw new AnalysisError(
        'the exclusions applied to the dataset do not match the exclusions the committed plan ' +
          `produces (dataset ${dataset.exclusionReport.reportHash}, recomputed ${report.reportHash}); refusing to analyze`,
      )
    }
  }
  assertNoContaminatedBlockSurvived(kept, plan)
  if (kept.length === 0) {
    throw new AnalysisError('the registered exclusions removed every observation')
  }

  const primaryId = plan.endpoints.find((e) => e.role === 'primary')!.id
  const primary = evaluateEndpoint(
    primaryId,
    'primary',
    kept,
    PRIMARY_EXTRACTOR,
    plan,
    dataset.assignmentHash,
  )

  const secondaries: EndpointResult[] = []
  for (const endpoint of plan.endpoints) {
    if (endpoint.role !== 'secondary') continue
    const extract = SECONDARY_EXTRACTORS[endpoint.id]
    if (!extract) {
      throw new AnalysisError(
        `registered secondary endpoint ${endpoint.id} has no extractor; refusing to silently drop it`,
      )
    }
    secondaries.push(
      evaluateEndpoint(endpoint.id, 'secondary', kept, extract, plan, dataset.assignmentHash),
    )
  }

  const sensitivity = runSensitivityAnalyses(kept, plan, dataset.assignmentHash)
  const decision = decide(primary, plan, report.deliveryCeilingBreached)
  const analyzedAtUnix = options.analyzedAtUnix ?? dataset.collectedAtUnix

  return {
    pilotId: dataset.pilotId,
    planHash: registration.planHash,
    documentHash: registration.documentHash,
    assignmentHash: dataset.assignmentHash,
    analyzedAtUnix,
    exclusions: report,
    primary,
    secondaries,
    sensitivity,
    decision,
    reportText: renderReport(primary, secondaries, sensitivity, report, decision, registration),
  }
}

/**
 * The registered sensitivity re-runs. Each one drops a class of window that we
 * deliberately did NOT exclude from the primary, so a reader can see how much of
 * the answer rested on that choice. `gatesDecision` is a literal false and no
 * value produced here is passed to `decide`.
 */
function runSensitivityAnalyses(
  kept: readonly BlockOutcome[],
  plan: AnalysisPlan,
  seedSuffix: string,
): SensitivityResult[] {
  const results: SensitivityResult[] = []
  for (const spec of plan.sensitivityAnalyses) {
    const filter = SENSITIVITY_FILTERS.find((f) => f.id === spec.id)
    if (!filter) {
      throw new AnalysisError(
        `registered sensitivity analysis ${spec.id} has no filter; refusing to silently drop it`,
      )
    }
    const subset = kept.filter((o) => filter.keep(o, plan))
    const blocksRemoved = kept.length - subset.length
    const perCoin = coinDifferences(
      subset,
      PRIMARY_EXTRACTOR,
      plan.decisionRule.minPairedStrataPerCoin,
    )
    if (perCoin.length === 0) {
      results.push({
        id: spec.id,
        gatesDecision: false,
        blocksRemoved,
        coins: 0,
        note: 'not evaluable: the filter left no coin with both arms observed',
      })
      continue
    }
    results.push({
      id: spec.id,
      gatesDecision: false,
      result: evaluatePairedDifferences(
        'fees_log1p',
        'secondary',
        perCoin,
        plan,
        `${seedSuffix}|sensitivity|${spec.id}`,
      ),
      blocksRemoved,
      coins: perCoin.length,
      note: spec.description,
    })
  }
  return results
}

/** The committed rule, evaluated mechanically. No interpretation happens here. */
export function decide(
  primary: EndpointResult,
  plan: AnalysisPlan,
  deliveryCeilingBreached = false,
): DecisionResult {
  const rule = plan.decisionRule
  const effect = primary.effectPct
  if (!effect) {
    throw new AnalysisError('the primary endpoint did not produce a fee effect; cannot decide')
  }

  const ciExcludesZero = primary.ci.lo > 0 || primary.ci.hi < 0
  const base = {
    ciExcludesZero,
    pointEstimatePct: effect.point,
    ciPct: { lo: effect.lo, hi: effect.hi },
    thresholdPct: rule.minFeeEffectPct,
    coins: primary.coins,
    minCoins: rule.minCoins,
    deliveryCeilingBreached,
  }

  // Checked first: a trial the operator failed to run as assigned has no
  // interpretable arm contrast, whatever its sample size or its interval. This
  // branch can only ever withhold a proceed - it has no path to granting one.
  if (deliveryCeilingBreached) {
    return {
      ...base,
      verdict: 'COMPROMISED_DELIVERY',
      proceed: false,
      statement: rule.deliveryCompromisedStatement,
    }
  }
  if (primary.coins < rule.minCoins) {
    return {
      ...base,
      verdict: 'INCONCLUSIVE_UNDERPOWERED',
      proceed: false,
      statement: rule.underpoweredStatement,
    }
  }
  if (ciExcludesZero && effect.point >= rule.minFeeEffectPct) {
    return { ...base, verdict: 'PROCEED_TO_PHASE_1', proceed: true, statement: rule.successStatement }
  }
  return { ...base, verdict: 'DO_NOT_PROCEED', proceed: false, statement: rule.failureStatement }
}

function pct(x: number): string {
  return `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`
}

function num(x: number): string {
  return x.toFixed(4)
}

/** Deterministic, code-authored. No model contributes a character of this. */
export function renderReport(
  primary: EndpointResult,
  secondaries: readonly EndpointResult[],
  sensitivity: readonly SensitivityResult[],
  exclusions: ExclusionReport,
  decision: DecisionResult,
  registration: PreRegistration,
): string {
  const plan = registration.plan
  const lines: string[] = []
  lines.push(`PILOT ANALYSIS - ${plan.pilotId}`)
  lines.push(`plan hash ${registration.planHash} committed at ${registration.committedAtUnix}`)
  lines.push(`document hash ${registration.documentHash}`)
  lines.push('')
  lines.push('REGISTERED EXCLUSIONS (applied by code, committed before collection):')
  lines.push(
    `  observed ${exclusions.observedBlocks} blocks, kept ${exclusions.keptBlocks}, ` +
      `excluded ${exclusions.excluded.length}  [policy ${exclusions.planExclusionHash.slice(0, 16)}]`,
  )
  for (const count of exclusions.countsByRule) {
    lines.push(`  ${count.ruleId.padEnd(28)} ${String(count.blocks).padStart(5)} blocks`)
  }
  lines.push(
    `  delivery: ${exclusions.undeliveredStaffedBlocks} staffed and ` +
      `${exclusions.undeliveredUnstaffedBlocks} unstaffed blocks not delivered as assigned ` +
      `(${(exclusions.undeliveredStaffedShare * 100).toFixed(1)}% of staffed, ceiling ` +
      `${(plan.exclusionParameters.maxUndeliveredStaffedShare * 100).toFixed(1)}%)`,
  )
  lines.push(
    `  whale-dominated windows FLAGGED but kept: ${exclusions.whaleFlaggedBlocks} ` +
      '(dropping on outcome size after randomization would bias the effect)',
  )
  lines.push('')
  lines.push(
    `PRIMARY (${primary.endpointId}): paired within-coin, stratified on hour-of-day and day-of-week.`,
  )
  lines.push(`  coins paired            ${primary.coins}`)
  lines.push(`  median difference       ${num(primary.medianDifference)} (log1p USD)`)
  lines.push(`  mean difference         ${num(primary.meanDifference)} (log1p USD)`)
  lines.push(`  Hodges-Lehmann          ${num(primary.hodgesLehmann)} (log1p USD)`)
  lines.push(
    `  ${(primary.ci.level * 100).toFixed(0)}% CI                ` +
      `[${num(primary.ci.lo)}, ${num(primary.ci.hi)}] ` +
      `(${primary.ci.method}, ${primary.ci.iterations} draws)`,
  )
  if (primary.effectPct) {
    lines.push(
      `  fee effect per block    ${pct(primary.effectPct.point)} ` +
        `[${pct(primary.effectPct.lo)}, ${pct(primary.effectPct.hi)}]`,
    )
  }
  lines.push(
    `  Wilcoxon signed-rank    W=${num(primary.wilcoxon.statistic)} p=${primary.wilcoxon.pValue.toExponential(3)} ` +
      `(${primary.wilcoxon.method}${primary.wilcoxon.hasTies ? ', ties corrected' : ''})`,
  )
  lines.push('')
  lines.push('SECONDARY (no multiplicity control; these cannot support the decision):')
  for (const s of secondaries) {
    lines.push(
      `  ${s.endpointId.padEnd(24)} HL=${num(s.hodgesLehmann)} ` +
        `CI[${num(s.ci.lo)}, ${num(s.ci.hi)}] median=${num(s.medianDifference)} mean=${num(s.meanDifference)} ` +
        `p=${s.wilcoxon.pValue.toExponential(2)}`,
    )
  }
  lines.push('')
  lines.push('SENSITIVITY (registered, reported, and unable to change the verdict):')
  for (const s of sensitivity) {
    if (!s.result) {
      lines.push(`  ${s.id.padEnd(24)} ${s.note}`)
      continue
    }
    const effect = s.result.effectPct
    lines.push(
      `  ${s.id.padEnd(24)} coins=${s.coins} blocks removed=${s.blocksRemoved} ` +
        `HL=${num(s.result.hodgesLehmann)} CI[${num(s.result.ci.lo)}, ${num(s.result.ci.hi)}]` +
        (effect ? ` effect ${pct(effect.point)} [${pct(effect.lo)}, ${pct(effect.hi)}]` : ''),
    )
  }
  lines.push('')
  lines.push('POWER, as registered before collection:')
  lines.push(
    `  ${plan.power.enrolledCoinsMin}-${plan.power.enrolledCoinsMax} coins x ` +
      `${plan.power.pairsPerCoin} matched 12h pairs; planning SD ${plan.power.plannedWithinCoinSd} ` +
      `on log1p, between-coin effect SD ${plan.power.plannedBetweenCoinEffectSd}`,
  )
  lines.push(
    `  MDE at ${plan.power.enrolledCoinsMin} coins ${pct(plan.power.mdePctAtMinCoins)}, ` +
      `at ${plan.power.enrolledCoinsMax} coins ${pct(plan.power.mdePctAtMaxCoins)} ` +
      `(${(plan.power.targetPower * 100).toFixed(0)}% power, alpha ${plan.power.alpha})`,
  )
  lines.push(`  ${plan.power.adequacyStatement}`)
  lines.push('')
  lines.push(
    `RULE: proceed iff the ${(primary.ci.level * 100).toFixed(0)}% CI excludes zero ` +
      `AND the fee point estimate is at least ${pct(decision.thresholdPct)} per staffed block.`,
  )
  lines.push(
    `  interval excludes zero  ${decision.ciExcludesZero ? 'yes' : 'no'}` +
      `   point estimate ${pct(decision.pointEstimatePct)} vs threshold ${pct(decision.thresholdPct)}` +
      `   coins ${decision.coins}/${decision.minCoins}` +
      `   delivery compromised ${decision.deliveryCeilingBreached ? 'yes' : 'no'}`,
  )
  lines.push('')
  lines.push(decision.statement)
  return lines.join('\n')
}
