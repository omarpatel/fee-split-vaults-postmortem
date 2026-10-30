/**
 * The second, cheaper parallel test: randomized ORDER of Dexscreener Enhanced
 * Token Info purchase across the pilot coins, with a 14-day control lag.
 *
 * Every coin gets the listing; only the ORDER is randomized, which is the same
 * ethical shape as the desk test - we randomize when a free thing arrives, not
 * whether it arrives.
 *
 * The operator buys the listing as PRINCIPAL, in its own name, out of its own
 * money. During the pilot there is no vault, no budget and no client funds at
 * all, so there is no code path here that could send anyone else's money to a
 * vendor, and none is added later: procurement is a reimbursement pull to the
 * operator's own treasury against a countersigned invoice.
 */

import { hashObject, keyRank, sha256Hex } from './hash.js'
import {
  bootstrapTwoSampleShift,
  hodgesLehmannTwoSample,
  logShiftToPercent,
  mean,
  median,
  permutationTestTwoSample,
  type BootstrapCi,
  type PermutationResult,
} from './stats.js'
import type { PreRegistration } from './prereg.js'
import { verifyPreRegistration } from './prereg.js'
import type {
  BlockOutcome,
  EtiAssignmentEntry,
  EtiCohort,
  EtiTrialAssignment,
  PilotCoin,
  PilotDataset,
} from './types.js'

const SECONDS_PER_DAY = 86_400

export class EtiError extends Error {
  constructor(message: string) {
    super(`pilot eti: ${message}`)
    this.name = 'EtiError'
  }
}

export interface EtiConfig {
  pilotId: string
  seed: string
  /** EARLY cohort buys here. LATE is still untreated across the post window. */
  earlyPurchaseUnix: number
  lagDays: number
}

interface Draw {
  coin: PilotCoin
  key: string
  rank: bigint
  stratum: string
}

function byRank(a: Draw, b: Draw): number {
  if (a.rank < b.rank) return -1
  if (a.rank > b.rank) return 1
  return a.coin.coinRef < b.coin.coinRef ? -1 : a.coin.coinRef > b.coin.coinRef ? 1 : 0
}

/**
 * Balanced seeded-hash split into EARLY and LATE, stratified on the coin's
 * pre-registered baseline stratum. Odd strata pass their median-ranked coin up
 * to be resolved against the other strata's leftovers; a single global leftover
 * goes LATE, which is the arm that costs the study nothing to enlarge.
 */
export function assignEtiOrder(config: EtiConfig, coins: PilotCoin[]): EtiTrialAssignment {
  if (!config.pilotId || !config.seed) throw new EtiError('pilotId and seed are published inputs')
  if (!Number.isInteger(config.earlyPurchaseUnix) || config.earlyPurchaseUnix <= 0) {
    throw new EtiError('earlyPurchaseUnix must be a positive integer unix timestamp')
  }
  if (!Number.isInteger(config.lagDays) || config.lagDays < 1) {
    throw new EtiError('the control lag must be a positive whole number of days')
  }
  if (coins.length < 2) throw new EtiError('at least two coins are required to randomize an order')

  const seen = new Set<string>()
  const draws: Draw[] = coins.map((coin) => {
    if (seen.has(coin.coinRef)) throw new EtiError(`duplicate coinRef ${coin.coinRef}`)
    seen.add(coin.coinRef)
    const key = sha256Hex(`vault-pilot/eti/v1|${config.seed}|${config.pilotId}|${coin.coinRef}`)
    return { coin, key, rank: keyRank(key), stratum: coin.baselineStratum ?? 'all' }
  })

  const strata = new Map<string, Draw[]>()
  for (const draw of draws) {
    const bucket = strata.get(draw.stratum)
    if (bucket) bucket.push(draw)
    else strata.set(draw.stratum, [draw])
  }

  const early = new Set<string>()
  const pivots: Draw[] = []
  for (const key of [...strata.keys()].sort()) {
    const group = [...strata.get(key)!].sort(byRank)
    const half = Math.floor(group.length / 2)
    for (let i = 0; i < half; i += 1) early.add(group[i]!.coin.coinRef)
    if (group.length % 2 === 1) pivots.push(group[half]!)
  }
  pivots.sort(byRank)
  const pivotHalf = Math.floor(pivots.length / 2)
  for (let i = 0; i < pivotHalf; i += 1) early.add(pivots[i]!.coin.coinRef)

  const latePurchaseUnix = config.earlyPurchaseUnix + config.lagDays * SECONDS_PER_DAY
  const entries: EtiAssignmentEntry[] = draws
    .map((draw): EtiAssignmentEntry => {
      const cohort: EtiCohort = early.has(draw.coin.coinRef) ? 'EARLY' : 'LATE'
      return {
        coinRef: draw.coin.coinRef,
        cohort,
        purchaseAtUnix: cohort === 'EARLY' ? config.earlyPurchaseUnix : latePurchaseUnix,
        drawKey: draw.key,
        stratum: draw.stratum,
      }
    })
    .sort((a, b) => (a.coinRef < b.coinRef ? -1 : a.coinRef > b.coinRef ? 1 : 0))

  return {
    pilotId: config.pilotId,
    seed: config.seed,
    earlyPurchaseUnix: config.earlyPurchaseUnix,
    latePurchaseUnix,
    lagDays: config.lagDays,
    entries,
    assignmentHash: hashObject({
      v: 'vault-pilot-eti/v1',
      pilotId: config.pilotId,
      seed: config.seed,
      earlyPurchaseUnix: config.earlyPurchaseUnix,
      lagDays: config.lagDays,
      cohorts: entries.map((e) => `${e.coinRef}:${e.cohort}`),
    }),
  }
}

// ---------------------------------------------------------------------------
// Difference in differences
// ---------------------------------------------------------------------------

export interface EtiCoinPanel {
  coinRef: string
  cohort: EtiCohort
  preMean: number
  postMean: number
  difference: number
  preBlocks: number
  postBlocks: number
  /** Balance diagnostic: desk coverage must not differ systematically by cohort. */
  preStaffedShare: number
  postStaffedShare: number
}

export interface EtiAnalysis {
  pilotId: string
  planHash: string
  etiAssignmentHash: string
  endpointId: string
  early: number
  late: number
  droppedCoins: string[]
  /** Classic DiD: mean(early post-pre) - mean(late post-pre). */
  didMean: number
  didMedian: number
  /** Robust shift estimate on the same contrast. */
  didHodgesLehmann: number
  ciHodgesLehmann: BootstrapCi
  ciMean: BootstrapCi
  permutation: PermutationResult
  effectPct: { point: number; lo: number; hi: number }
  balance: {
    earlyPreStaffedShare: number
    earlyPostStaffedShare: number
    latePreStaffedShare: number
    latePostStaffedShare: number
  }
  panels: EtiCoinPanel[]
  /** Committed in advance: this sub-study informs procurement, it does not gate Phase 1. */
  gatesPhase1: false
  reportText: string
}

function windowMean(
  outcomes: readonly BlockOutcome[],
  fromUnix: number,
  toUnixExclusive: number,
): { value: number; blocks: number; staffedShare: number } {
  const inWindow = outcomes.filter(
    (o) => o.followWindowStartUnix >= fromUnix && o.followWindowStartUnix < toUnixExclusive,
  )
  if (inWindow.length === 0) return { value: Number.NaN, blocks: 0, staffedShare: Number.NaN }
  const staffed = inWindow.filter((o) => o.arm === 'STAFFED').length
  return {
    value: mean(inWindow.map((o) => o.primaryLog1pFeesUsd)),
    blocks: inWindow.length,
    staffedShare: staffed / inWindow.length,
  }
}

/**
 * Difference-in-differences on the same primary endpoint.
 *
 * Inference is a permutation test on the cohort labels: the design randomized
 * those labels, so the randomization distribution is the null and no
 * distributional assumption is needed.
 */
export function analyzeEtiDid(
  dataset: PilotDataset,
  trial: EtiTrialAssignment,
  registration: PreRegistration,
): EtiAnalysis {
  verifyPreRegistration(registration, dataset.firstObservationUnix)
  const spec = registration.plan.etiSubStudy
  if (!spec.enabled) throw new EtiError('the registered plan disabled the ETI sub-study')
  if (spec.lagDays !== trial.lagDays) {
    throw new EtiError(
      `registered control lag is ${spec.lagDays} days but the trial was run at ${trial.lagDays}`,
    )
  }
  if (registration.plan.pilotId !== dataset.pilotId || trial.pilotId !== dataset.pilotId) {
    throw new EtiError('pilot id mismatch between plan, trial and dataset')
  }

  const lagSeconds = trial.lagDays * SECONDS_PER_DAY
  const preFrom = trial.earlyPurchaseUnix - lagSeconds
  const preTo = trial.earlyPurchaseUnix
  const postFrom = trial.earlyPurchaseUnix
  const postTo = trial.latePurchaseUnix

  const byCoin = new Map<string, BlockOutcome[]>()
  for (const outcome of dataset.outcomes) {
    const bucket = byCoin.get(outcome.coinRef)
    if (bucket) bucket.push(outcome)
    else byCoin.set(outcome.coinRef, [outcome])
  }

  const panels: EtiCoinPanel[] = []
  const dropped: string[] = []
  for (const entry of trial.entries) {
    const outcomes = byCoin.get(entry.coinRef) ?? []
    const pre = windowMean(outcomes, preFrom, preTo)
    const post = windowMean(outcomes, postFrom, postTo)
    if (pre.blocks === 0 || post.blocks === 0) {
      dropped.push(entry.coinRef)
      continue
    }
    panels.push({
      coinRef: entry.coinRef,
      cohort: entry.cohort,
      preMean: pre.value,
      postMean: post.value,
      difference: post.value - pre.value,
      preBlocks: pre.blocks,
      postBlocks: post.blocks,
      preStaffedShare: pre.staffedShare,
      postStaffedShare: post.staffedShare,
    })
  }

  const earlyDiffs = panels.filter((p) => p.cohort === 'EARLY').map((p) => p.difference)
  const lateDiffs = panels.filter((p) => p.cohort === 'LATE').map((p) => p.difference)
  if (earlyDiffs.length < 2 || lateDiffs.length < 2) {
    throw new EtiError('both cohorts need at least two coins with observations in both windows')
  }

  const meanContrast = (x: readonly number[], y: readonly number[]): number => mean(x) - mean(y)
  const didMean = meanContrast(earlyDiffs, lateDiffs)
  const didHodgesLehmann = hodgesLehmannTwoSample(earlyDiffs, lateDiffs)

  const bootstrapOptions = {
    iterations: spec.iterations,
    level: registration.plan.decisionRule.ciLevel,
    seed: `${registration.plan.estimator.ci.seed}|eti|${trial.assignmentHash}`,
  }
  const ciHodgesLehmann = bootstrapTwoSampleShift(earlyDiffs, lateDiffs, bootstrapOptions)
  const ciMean = bootstrapTwoSampleShift(
    earlyDiffs,
    lateDiffs,
    { ...bootstrapOptions, seed: `${bootstrapOptions.seed}|mean` },
    meanContrast,
  )
  const permutation = permutationTestTwoSample(earlyDiffs, lateDiffs, meanContrast, {
    iterations: spec.iterations,
    seed: `${bootstrapOptions.seed}|perm`,
  })

  const balance = {
    earlyPreStaffedShare: shareOf(panels, 'EARLY', 'pre'),
    earlyPostStaffedShare: shareOf(panels, 'EARLY', 'post'),
    latePreStaffedShare: shareOf(panels, 'LATE', 'pre'),
    latePostStaffedShare: shareOf(panels, 'LATE', 'post'),
  }

  const effectPct = {
    point: logShiftToPercent(didHodgesLehmann),
    lo: logShiftToPercent(ciHodgesLehmann.lo),
    hi: logShiftToPercent(ciHodgesLehmann.hi),
  }

  const analysis: EtiAnalysis = {
    pilotId: dataset.pilotId,
    planHash: registration.planHash,
    etiAssignmentHash: trial.assignmentHash,
    endpointId: spec.endpointId,
    early: earlyDiffs.length,
    late: lateDiffs.length,
    droppedCoins: dropped,
    didMean,
    didMedian: median(earlyDiffs) - median(lateDiffs),
    didHodgesLehmann,
    ciHodgesLehmann,
    ciMean,
    permutation,
    effectPct,
    balance,
    panels,
    gatesPhase1: false,
    reportText: '',
  }
  analysis.reportText = renderEtiReport(analysis)
  return analysis
}

function shareOf(panels: readonly EtiCoinPanel[], cohort: EtiCohort, window: 'pre' | 'post'): number {
  const values = panels
    .filter((p) => p.cohort === cohort)
    .map((p) => (window === 'pre' ? p.preStaffedShare : p.postStaffedShare))
    .filter((v) => Number.isFinite(v))
  return values.length === 0 ? Number.NaN : mean(values)
}

function renderEtiReport(a: EtiAnalysis): string {
  const f = (x: number): string => x.toFixed(4)
  const p = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`
  return [
    `ETI ORDER SUB-STUDY - ${a.pilotId}`,
    `plan hash ${a.planHash}, trial hash ${a.etiAssignmentHash}`,
    `cohorts: ${a.early} EARLY, ${a.late} LATE${a.droppedCoins.length > 0 ? `, ${a.droppedCoins.length} dropped for missing windows` : ''}`,
    `DiD (mean)              ${f(a.didMean)}`,
    `DiD (median)            ${f(a.didMedian)}`,
    `DiD (Hodges-Lehmann)    ${f(a.didHodgesLehmann)}  CI[${f(a.ciHodgesLehmann.lo)}, ${f(a.ciHodgesLehmann.hi)}]`,
    `fee effect              ${p(a.effectPct.point)} [${p(a.effectPct.lo)}, ${p(a.effectPct.hi)}]`,
    `permutation p           ${a.permutation.pValue.toExponential(3)} (${a.permutation.iterations} label draws)`,
    `desk-coverage balance   early ${f(a.balance.earlyPreStaffedShare)}/${f(a.balance.earlyPostStaffedShare)} ` +
      `late ${f(a.balance.latePreStaffedShare)}/${f(a.balance.latePostStaffedShare)} (pre/post staffed share)`,
    '',
    'This sub-study informs procurement only. It does not gate Phase 1, and no reading of it may be ' +
      'substituted for the desk-coverage decision rule.',
  ].join('\n')
}
