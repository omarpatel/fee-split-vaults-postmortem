/**
 * reprice - turn the measured numbers into a break-even client count, a
 * required acquisition rate, and a mechanical STOP/GO verdict.
 *
 * THE TEST THIS IMPLEMENTS. "If 20-40 durable clients do not clear break-even,
 * stop." That sentence is only useful if it is a function rather than a
 * judgement call made after the fact by whoever most wants to continue, so
 * stopOrGoVerdict() below is pure, typed, exported and unit-tested, and the CLI
 * is a thin wrapper around it.
 *
 * WHAT FEEDS IT. tenure.ts supplies --tenure-days. pool-fees-index.ts supplies
 * --buyback-on-rate, which sets the blended creator rate and therefore how much
 * volume a client needs. addressable-market.ts supplies --clients-above-gate,
 * which decides whether the required acquisition rate is even physically
 * available. Nothing here measures anything: every input is either measured
 * upstream or is an explicit assumption, and the report labels which is which.
 *
 * TERMS.operatorBps is flagged in config/protocol.ts as the most likely-wrong
 * number in the repo. This tool exists to price it, so it sweeps it rather than
 * trusting it.
 */

import type { ParsedValues } from './lib/cli.ts'
import { CliError, getBool, getList, getNumber, getString, isEntrypoint, runCli } from './lib/cli.ts'
import { banner, heading, num, pct, subheading, table, usd } from './lib/format.ts'
import { emit, emitDryRun, type Report } from './lib/report.ts'
import {
  QUALIFICATION_FLOOR_MONTHLY_USD,
  TERMS,
  TIERS,
  TIER_ORDER,
  creatorNetBps,
  devBps,
  volumeForQf,
  type TierId,
} from '../config/protocol.ts'

const SCHEMA_VERSION = 'reprice-1'

const SPEC = {
  name: 'reprice',
  summary: 'Break-even client count, required acquisition rate, and a mechanical stop/go verdict.',
  detail: `
    Consumes measured tenure and buyback-on rate plus a candidate operator bps, and
    answers: how many concurrent clients clear break-even, how many must be won per
    week to hold that, and does the 20-40 durable client test pass or fail.
  `,
  options: [
    {
      name: 'tenure-days',
      type: 'number' as const,
      required: true,
      describe: 'Measured mean tenure above the gate, in days. Use the KM restricted mean from tenure.ts.',
    },
    {
      name: 'buyback-on-rate',
      type: 'number' as const,
      default: 0,
      describe: 'Volume-weighted buyback-on share, 0..1, from pool-fees-index.ts.',
    },
    {
      name: 'operator-bps',
      type: 'number' as const,
      default: TERMS.operatorBps,
      describe: 'Candidate operator take, in bps of QF.',
    },
    {
      name: 'sweep-operator-bps',
      type: 'string[]' as const,
      default: ['100', '250', '500', '1000', '1500', '2000'],
      describe: 'Operator bps values for the sensitivity table.',
    },
    {
      name: 'sweep-tenure-days',
      type: 'string[]' as const,
      default: ['2.14', '7', '12.9', '30', '56'],
      describe:
        'Tenure values for the sensitivity table. Defaults span the Phase 0 measured 2.14d, the survivor-biased 12.9d, and the planned 8 weeks.',
    },
    {
      name: 'qf-per-day',
      type: 'number' as const,
      describe: 'Mean QF/day of a durable client. Defaults to the chosen tier gate.',
    },
    { name: 'tier', type: 'string' as const, default: 'T1', describe: 'Tier whose gate and COGS to use.' },
    {
      name: 'budget-bps',
      type: 'number' as const,
      default: TERMS.budgetBpsDefault,
      describe: 'Dev-elected procurement dial, for the qualification-floor check.',
    },
    {
      name: 'fixed-cost-monthly-usd',
      type: 'number' as const,
      default: 12_000,
      describe:
        'Operator fixed cost per month that client contribution must cover. AN ASSUMPTION, not a measurement - set it deliberately.',
    },
    { name: 'cac-usd', type: 'number' as const, default: 0, describe: 'Cost to acquire one client.' },
    {
      name: 'onboarding-cost-usd',
      type: 'number' as const,
      default: 0,
      describe: 'One-off cost to onboard one client (screening, deploy, review).',
    },
    {
      name: 'clients-above-gate',
      type: 'number' as const,
      describe:
        'Standing population above the gate, from addressable-market.ts. Enables the acquisition-feasibility check.',
    },
    {
      name: 'win-rate',
      type: 'number' as const,
      default: 0.1,
      describe: 'Share of coins crossing the gate that can be signed, 0..1.',
    },
    {
      name: 'go-threshold',
      type: 'number' as const,
      default: 20,
      describe: 'Break-even client count at or below which the verdict is GO.',
    },
    {
      name: 'stop-threshold',
      type: 'number' as const,
      default: 40,
      describe: 'Break-even client count above which the verdict is STOP.',
    },
  ],
  examples: [
    'node tools/reprice.ts --tenure-days 2.14 --buyback-on-rate 0.5',
    'node tools/reprice.ts --tenure-days 12.9 --operator-bps 500 --clients-above-gate 200 --json',
  ],
}

export interface RepriceInputs {
  tenureDays: number
  buybackOnRate: number
  operatorBps: number
  qfPerDayUsd: number
  tier: TierId
  cogsPerDayUsd: number
  budgetBps: number
  fixedCostMonthlyUsd: number
  cacUsd: number
  onboardingCostUsd: number
  clientsAboveGate: number | undefined
  winRate: number
  goThreshold: number
  stopThreshold: number
}

export interface UnitEconomics {
  /** Blended creator bps implied by the measured buyback mix. */
  blendedCreatorBps: number
  /** Venue-pool volume a client must do per day to produce qfPerDay. */
  requiredVolumePerDayUsd: number
  operatorRevenuePerClientDayUsd: number
  contributionPerClientDayUsd: number
  lifetimeRevenuePerClientUsd: number
  lifetimeContributionPerClientUsd: number
  /** Contribution net of acquisition and onboarding. Negative means each client loses money. */
  lifetimeValuePerClientUsd: number
  ltvToCacRatio: number | undefined
  paybackDays: number | undefined
  devShareBps: number
  /** Monthly procurement budget at this dial. Compared to the qualification floor. */
  monthlyBudgetUsd: number
  clearsQualificationFloor: boolean
}

export interface SteadyState {
  /** Concurrent clients needed to cover fixed cost. Infinity when contribution <= 0. */
  breakEvenConcurrentClients: number
  /** L = lambda * W, so lambda = L / W. Clients that must be WON per week. */
  requiredWeeklyAcquisitions: number
  /** Coins crossing the gate per week, implied by the standing population and tenure. */
  availableWeeklyCrossings: number | undefined
  /** Crossings we could plausibly sign, at --win-rate. */
  winnableWeeklyAcquisitions: number | undefined
  /** winnable / required. Below 1.0 the required rate is not physically available. */
  acquisitionFeasibilityRatio: number | undefined
}

export type RepriceVerdict = 'GO' | 'MARGINAL' | 'STOP'

export interface VerdictResult {
  verdict: RepriceVerdict
  /** The single sentence that decides it. */
  headline: string
  /** Every condition tested, with its own pass/fail. */
  checks: Array<{ name: string; passed: boolean; detail: string }>
}

/**
 * The mechanical test. Pure, total, and deliberately unforgiving.
 *
 * Ordered so the first FAILING condition is the one reported: a negative
 * contribution makes every downstream number meaningless, so it is checked
 * before the client-count thresholds rather than alongside them.
 */
export function stopOrGoVerdict(
  inputs: RepriceInputs,
  economics: UnitEconomics,
  steady: SteadyState,
): VerdictResult {
  const checks: VerdictResult['checks'] = []

  const contributionPositive = economics.contributionPerClientDayUsd > 0
  checks.push({
    name: 'client contribution is positive',
    passed: contributionPositive,
    detail: contributionPositive
      ? `each client contributes ${usd(economics.contributionPerClientDayUsd)}/day after ${usd(inputs.cogsPerDayUsd)}/day of COGS`
      : `each client LOSES ${usd(-economics.contributionPerClientDayUsd)}/day: ${usd(economics.operatorRevenuePerClientDayUsd)}/day of revenue against ${usd(inputs.cogsPerDayUsd)}/day of COGS. No client count fixes this.`,
  })

  const ltvPositive = economics.lifetimeValuePerClientUsd > 0
  checks.push({
    name: 'lifetime value per client is positive',
    passed: ltvPositive,
    detail: ltvPositive
      ? `${usd(economics.lifetimeValuePerClientUsd)} over a ${num(inputs.tenureDays, 2)}-day life`
      : `${usd(economics.lifetimeValuePerClientUsd)} over a ${num(inputs.tenureDays, 2)}-day life: a client does not repay ${usd(inputs.cacUsd + inputs.onboardingCostUsd)} of acquisition and onboarding before it churns.`,
  })

  const withinGo = steady.breakEvenConcurrentClients <= inputs.goThreshold
  const withinStop = steady.breakEvenConcurrentClients <= inputs.stopThreshold
  checks.push({
    name: `break-even inside the ${inputs.goThreshold}-${inputs.stopThreshold} durable client band`,
    passed: withinStop,
    detail: Number.isFinite(steady.breakEvenConcurrentClients)
      ? `${num(steady.breakEvenConcurrentClients, 1)} concurrent clients needed to cover ${usd(inputs.fixedCostMonthlyUsd)}/month of fixed cost`
      : 'break-even is unreachable at any client count',
  })

  const floorOk = economics.clearsQualificationFloor
  checks.push({
    name: 'client clears the qualification floor',
    passed: floorOk,
    detail: floorOk
      ? `${usd(economics.monthlyBudgetUsd)}/month of procurement budget at a ${inputs.budgetBps}bps dial, above the ${usd(QUALIFICATION_FLOOR_MONTHLY_USD)} floor`
      : `${usd(economics.monthlyBudgetUsd)}/month of procurement budget is below the ${usd(QUALIFICATION_FLOOR_MONTHLY_USD)} floor, so the tier cannot fund its cheapest deliverable and must not be offered.`,
  })

  // Undefined means the check did not run (no --clients-above-gate), which is
  // not a failure - but it is called out in the report's warnings.
  const feasible =
    steady.acquisitionFeasibilityRatio === undefined || steady.acquisitionFeasibilityRatio >= 1
  if (steady.acquisitionFeasibilityRatio !== undefined) {
    checks.push({
      name: 'required acquisition rate is physically available',
      passed: feasible,
      // num() renders an absent value as "n/a"; `?? 0` here would have printed
      // "0 winnable", which reads as a measured market of zero rather than as a
      // quantity that was never computed.
      detail: feasible
        ? `${num(steady.requiredWeeklyAcquisitions, 2)} signings/week needed against ${num(steady.winnableWeeklyAcquisitions, 2)} winnable`
        : `${num(steady.requiredWeeklyAcquisitions, 2)} signings/week are needed but only ${num(steady.winnableWeeklyAcquisitions, 2)}/week are winnable at a ${pct(inputs.winRate)} win rate. The market does not produce enough qualifying coins to hold the book.`,
    })
  }

  // Every one of these is a hard stop. An unreachable break-even is not a
  // "marginal" business: infeasible acquisition means the book can never be
  // held at the size the fixed costs require, at any price.
  const failed = checks.filter((c) => !c.passed)
  if (!contributionPositive || !ltvPositive || !withinStop || !floorOk || !feasible) {
    return {
      verdict: 'STOP',
      headline: failed[0]?.detail ?? 'a hard condition failed',
      checks,
    }
  }
  if (!withinGo) {
    return {
      verdict: 'MARGINAL',
      headline: `break-even needs ${num(steady.breakEvenConcurrentClients, 1)} concurrent clients, inside the ${inputs.goThreshold}-${inputs.stopThreshold} band but above the ${inputs.goThreshold} that would make this comfortable.`,
      checks,
    }
  }
  return {
    verdict: 'GO',
    headline: `break-even at ${num(steady.breakEvenConcurrentClients, 1)} concurrent clients, requiring ${num(steady.requiredWeeklyAcquisitions, 2)} signings/week at a ${num(inputs.tenureDays, 2)}-day mean tenure.`,
    checks,
  }
}

export function computeEconomics(inputs: RepriceInputs): UnitEconomics {
  const blendedCreatorBps =
    inputs.buybackOnRate * creatorNetBps(true, 0) + (1 - inputs.buybackOnRate) * creatorNetBps(false, 0)
  const requiredVolumePerDayUsd = (inputs.qfPerDayUsd * 10_000) / blendedCreatorBps

  const operatorRevenuePerClientDayUsd = (inputs.qfPerDayUsd * inputs.operatorBps) / 10_000
  const contributionPerClientDayUsd = operatorRevenuePerClientDayUsd - inputs.cogsPerDayUsd
  const lifetimeRevenuePerClientUsd = operatorRevenuePerClientDayUsd * inputs.tenureDays
  const lifetimeContributionPerClientUsd = contributionPerClientDayUsd * inputs.tenureDays
  const acquisitionCost = inputs.cacUsd + inputs.onboardingCostUsd
  const lifetimeValuePerClientUsd = lifetimeContributionPerClientUsd - acquisitionCost

  const monthlyBudgetUsd = (inputs.qfPerDayUsd * inputs.budgetBps * 30) / 10_000

  return {
    blendedCreatorBps,
    requiredVolumePerDayUsd,
    operatorRevenuePerClientDayUsd,
    contributionPerClientDayUsd,
    lifetimeRevenuePerClientUsd,
    lifetimeContributionPerClientUsd,
    lifetimeValuePerClientUsd,
    ltvToCacRatio:
      acquisitionCost > 0 ? lifetimeContributionPerClientUsd / acquisitionCost : undefined,
    paybackDays:
      contributionPerClientDayUsd > 0 && acquisitionCost > 0
        ? acquisitionCost / contributionPerClientDayUsd
        : contributionPerClientDayUsd > 0
          ? 0
          : undefined,
    devShareBps: devBps(inputs.budgetBps),
    monthlyBudgetUsd,
    clearsQualificationFloor: monthlyBudgetUsd >= QUALIFICATION_FLOOR_MONTHLY_USD,
  }
}

export function computeSteadyState(inputs: RepriceInputs, economics: UnitEconomics): SteadyState {
  const fixedCostPerDay = inputs.fixedCostMonthlyUsd / 30
  const breakEvenConcurrentClients =
    economics.contributionPerClientDayUsd > 0
      ? fixedCostPerDay / economics.contributionPerClientDayUsd
      : Number.POSITIVE_INFINITY

  // Little's Law again, run forwards: to HOLD L clients with mean life W, you
  // must win L/W per day. This is where a short tenure does its damage - it
  // does not reduce revenue per client so much as multiply the sales problem.
  const requiredWeeklyAcquisitions =
    inputs.tenureDays > 0 && Number.isFinite(breakEvenConcurrentClients)
      ? (breakEvenConcurrentClients / inputs.tenureDays) * 7
      : Number.POSITIVE_INFINITY

  let availableWeeklyCrossings: number | undefined
  let winnableWeeklyAcquisitions: number | undefined
  let acquisitionFeasibilityRatio: number | undefined
  if (inputs.clientsAboveGate !== undefined && inputs.tenureDays > 0) {
    // Same law inverted on the market: a standing population P with mean life W
    // is being replenished at P/W per day.
    availableWeeklyCrossings = (inputs.clientsAboveGate / inputs.tenureDays) * 7
    winnableWeeklyAcquisitions = availableWeeklyCrossings * inputs.winRate
    acquisitionFeasibilityRatio =
      requiredWeeklyAcquisitions > 0 ? winnableWeeklyAcquisitions / requiredWeeklyAcquisitions : undefined
  }

  return {
    breakEvenConcurrentClients,
    requiredWeeklyAcquisitions,
    availableWeeklyCrossings,
    winnableWeeklyAcquisitions,
    acquisitionFeasibilityRatio,
  }
}

export interface RepriceResult {
  inputs: RepriceInputs
  economics: UnitEconomics
  steadyState: SteadyState
  verdict: VerdictResult
  sensitivity: Array<{
    operatorBps: number
    tenureDays: number
    breakEvenConcurrentClients: number
    requiredWeeklyAcquisitions: number
    lifetimeValuePerClientUsd: number
    verdict: RepriceVerdict
  }>
  /** Which inputs were measured upstream and which are assumptions. */
  provenance: Array<{ input: string; value: string; source: 'measured' | 'assumption' | 'protocol' }>
}

async function main(values: ParsedValues): Promise<void> {
  const json = getBool(values, 'json')
  const outPath = getString(values, 'out')

  if (getBool(values, 'dry-run')) {
    emitDryRun(
      {
        tool: SPEC.name,
        config: {},
        steps: [
          { description: 'compute unit economics from the supplied measured inputs' },
          { description: "solve steady state via Little's Law (L = lambda * W)" },
          { description: 'run stopOrGoVerdict() and sweep operator bps x tenure' },
        ],
        estimatedRequestsTotal: 0,
        notes: [
          'reprice.ts is pure arithmetic over inputs you supply. It never touches the network and measures nothing itself.',
          'Every input is labelled measured / assumption / protocol in the provenance block of the output.',
        ],
      },
      json,
    )
    return
  }

  const tierRaw = getString(values, 'tier') ?? 'T1'
  if (!(TIER_ORDER as string[]).includes(tierRaw)) {
    throw new CliError(`--tier must be one of ${TIER_ORDER.join(', ')}`)
  }
  const tier = tierRaw as TierId
  const tenureDays = getNumber(values, 'tenure-days', Number.NaN)
  if (!Number.isFinite(tenureDays) || tenureDays <= 0) {
    throw new CliError('--tenure-days must be a positive number. Take it from tenure.ts.')
  }
  const buybackOnRate = getNumber(values, 'buyback-on-rate', 0)
  if (buybackOnRate < 0 || buybackOnRate > 1) throw new CliError('--buyback-on-rate must be 0..1')
  const winRate = getNumber(values, 'win-rate', 0.1)
  if (winRate <= 0 || winRate > 1) throw new CliError('--win-rate must be in (0, 1]')

  const clientsRaw = values['clients-above-gate']
  const inputs: RepriceInputs = {
    tenureDays,
    buybackOnRate,
    operatorBps: getNumber(values, 'operator-bps', TERMS.operatorBps),
    qfPerDayUsd: getNumber(values, 'qf-per-day', TIERS[tier].gateQfPerDay),
    tier,
    cogsPerDayUsd: TIERS[tier].cogsPerDay,
    budgetBps: getNumber(values, 'budget-bps', TERMS.budgetBpsDefault),
    fixedCostMonthlyUsd: getNumber(values, 'fixed-cost-monthly-usd', 12_000),
    cacUsd: getNumber(values, 'cac-usd', 0),
    onboardingCostUsd: getNumber(values, 'onboarding-cost-usd', 0),
    clientsAboveGate: typeof clientsRaw === 'number' ? clientsRaw : undefined,
    winRate,
    goThreshold: getNumber(values, 'go-threshold', 20),
    stopThreshold: getNumber(values, 'stop-threshold', 40),
  }

  const economics = computeEconomics(inputs)
  const steadyState = computeSteadyState(inputs, economics)
  const verdict = stopOrGoVerdict(inputs, economics, steadyState)

  const sweepBps = getList(values, 'sweep-operator-bps').map(Number).filter(Number.isFinite)
  const sweepTenure = getList(values, 'sweep-tenure-days').map(Number).filter(Number.isFinite)
  const sensitivity: RepriceResult['sensitivity'] = []
  for (const opBps of sweepBps) {
    for (const days of sweepTenure) {
      const candidate: RepriceInputs = { ...inputs, operatorBps: opBps, tenureDays: days }
      const candidateEconomics = computeEconomics(candidate)
      const candidateSteady = computeSteadyState(candidate, candidateEconomics)
      sensitivity.push({
        operatorBps: opBps,
        tenureDays: days,
        breakEvenConcurrentClients: candidateSteady.breakEvenConcurrentClients,
        requiredWeeklyAcquisitions: candidateSteady.requiredWeeklyAcquisitions,
        lifetimeValuePerClientUsd: candidateEconomics.lifetimeValuePerClientUsd,
        verdict: stopOrGoVerdict(candidate, candidateEconomics, candidateSteady).verdict,
      })
    }
  }

  const result: RepriceResult = {
    inputs,
    economics,
    steadyState,
    verdict,
    sensitivity,
    provenance: [
      { input: 'tenure-days', value: num(inputs.tenureDays, 2), source: 'measured' },
      { input: 'buyback-on-rate', value: pct(inputs.buybackOnRate), source: 'measured' },
      { input: 'clients-above-gate', value: inputs.clientsAboveGate === undefined ? 'not supplied' : String(inputs.clientsAboveGate), source: 'measured' },
      { input: 'operator-bps', value: String(inputs.operatorBps), source: 'assumption' },
      { input: 'qf-per-day', value: usd(inputs.qfPerDayUsd), source: 'assumption' },
      { input: 'fixed-cost-monthly-usd', value: usd(inputs.fixedCostMonthlyUsd), source: 'assumption' },
      { input: 'cac-usd', value: usd(inputs.cacUsd), source: 'assumption' },
      { input: 'win-rate', value: pct(inputs.winRate), source: 'assumption' },
      { input: `cogs-per-day (${tier})`, value: usd(inputs.cogsPerDayUsd), source: 'protocol' },
      { input: 'budget-bps', value: String(inputs.budgetBps), source: 'protocol' },
      { input: 'qualification-floor', value: usd(QUALIFICATION_FLOOR_MONTHLY_USD), source: 'protocol' },
    ],
  }

  const warnings: string[] = [
    'reprice.ts MEASURES NOTHING. Its output is exactly as good as --tenure-days, --buyback-on-rate and --clients-above-gate. Feed it defaults and it will produce a confident, meaningless verdict.',
    `--fixed-cost-monthly-usd is ${usd(inputs.fixedCostMonthlyUsd)}, an ASSUMPTION. Break-even client count scales linearly in it.`,
  ]
  if (inputs.clientsAboveGate === undefined) {
    warnings.push(
      'No --clients-above-gate given, so the acquisition-feasibility check did not run. A GO verdict without it says the economics work, not that the clients exist.',
    )
  }
  if (inputs.tenureDays < 7) {
    warnings.push(
      `A mean tenure of ${num(inputs.tenureDays, 2)} days means the entire book turns over every ${num(inputs.tenureDays, 1)} days. Acquisition, not delivery, is the whole business at that tenure, and the required weekly signing rate below is the real product requirement.`,
    )
  }
  if (inputs.operatorBps !== TERMS.operatorBps) {
    warnings.push(
      `--operator-bps ${inputs.operatorBps} differs from TERMS.operatorBps ${TERMS.operatorBps}. config/protocol.ts is owned by another track: report the change, do not edit it. Note that operatorBps is in the CREATE2 salt preimage, so it cannot be changed for an existing vault.`,
    )
  }

  const report: Report<RepriceResult> = {
    meta: {
      tool: SPEC.name,
      schemaVersion: SCHEMA_VERSION,
      generatedAtUnix: Math.floor(Date.now() / 1000),
      config: { tier, operatorBps: inputs.operatorBps },
      io: { httpRequests: 0, cacheHits: 0, cacheMisses: 0 },
      warnings,
      methodLimits: [
        "Steady state assumes a stationary book: arrivals equal departures and mean tenure is constant. tenure.ts's Little's Law check is what tells you whether that assumption holds; if its consistency ratio is far from 1.0, these figures describe a market that does not exist.",
        'Mean tenure is used, not median. With a heavy-tailed tenure distribution a handful of long-lived clients carry the mean, and losing one moves break-even more than the arithmetic suggests.',
        'COGS is the modelled TIERS.cogsPerDay, not an instrumented cost. Until it is instrumented, contribution per client is a plan, not a measurement.',
        'Revenue is operatorBps of QF only. The procurement dial is pass-through at cost with zero markup and contributes nothing to contribution margin by design.',
      ],
    },
    result,
  }

  await emit(report, { json, outPath, human: (r) => renderHuman(r.result) })
}

function renderHuman(result: RepriceResult): string {
  const { inputs, economics, steadyState, verdict } = result
  const lines: string[] = []

  lines.push(
    banner([
      `VERDICT: ${verdict.verdict}`,
      ...wrap(verdict.headline, 76),
    ]),
  )

  lines.push(heading('The test'))
  lines.push(
    table(verdict.checks, [
      { header: '', value: (c) => (c.passed ? 'PASS' : 'FAIL') },
      { header: 'condition', value: (c) => c.name },
      { header: 'detail', value: (c) => c.detail },
    ]),
  )

  lines.push(heading('Unit economics per client'))
  lines.push(`  tier ${inputs.tier}   QF ${usd(inputs.qfPerDayUsd)}/day   operator ${inputs.operatorBps}bps   tenure ${num(inputs.tenureDays, 2)}d`)
  lines.push(
    `  blended creator rate ${num(economics.blendedCreatorBps, 2)}bps at ${pct(inputs.buybackOnRate)} buyback-on`,
  )
  lines.push(
    `  a client must trade ${usd(economics.requiredVolumePerDayUsd)}/day of VENUE-POOL volume to produce that QF`,
  )
  lines.push('')
  lines.push(`  operator revenue      ${usd(economics.operatorRevenuePerClientDayUsd)}/day`)
  lines.push(`  COGS (${inputs.tier})            ${usd(inputs.cogsPerDayUsd)}/day`)
  lines.push(`  contribution          ${usd(economics.contributionPerClientDayUsd)}/day`)
  lines.push(`  lifetime revenue      ${usd(economics.lifetimeRevenuePerClientUsd)}`)
  lines.push(`  lifetime contribution ${usd(economics.lifetimeContributionPerClientUsd)}`)
  lines.push(`  lifetime value        ${usd(economics.lifetimeValuePerClientUsd)} (after ${usd(inputs.cacUsd + inputs.onboardingCostUsd)} acquisition + onboarding)`)
  lines.push(
    `  LTV/CAC ${economics.ltvToCacRatio === undefined ? 'n/a (no CAC given)' : num(economics.ltvToCacRatio, 2)}   payback ${economics.paybackDays === undefined ? 'never' : `${num(economics.paybackDays, 1)}d`}`,
  )
  lines.push('')
  lines.push(
    `  dev keeps ${economics.devShareBps}bps of QF at a ${inputs.budgetBps}bps dial; procurement budget ${usd(economics.monthlyBudgetUsd)}/month ` +
      `vs the ${usd(QUALIFICATION_FLOOR_MONTHLY_USD)} qualification floor -> ${economics.clearsQualificationFloor ? 'clears' : 'BELOW FLOOR'}`,
  )

  lines.push(heading('Steady state'))
  lines.push(
    `  break-even concurrent clients : ${Number.isFinite(steadyState.breakEvenConcurrentClients) ? num(steadyState.breakEvenConcurrentClients, 1) : 'unreachable'}`,
  )
  lines.push(
    `  required signings per week    : ${Number.isFinite(steadyState.requiredWeeklyAcquisitions) ? num(steadyState.requiredWeeklyAcquisitions, 2) : 'unreachable'}`,
  )
  if (steadyState.availableWeeklyCrossings !== undefined) {
    lines.push(`  coins crossing the gate/week  : ${num(steadyState.availableWeeklyCrossings, 2)} (from ${inputs.clientsAboveGate} standing, ${num(inputs.tenureDays, 2)}d tenure)`)
    lines.push(`  winnable at ${pct(inputs.winRate)} win rate      : ${num(steadyState.winnableWeeklyAcquisitions, 2)}/week`)
    lines.push(
      `  feasibility ratio             : ${num(steadyState.acquisitionFeasibilityRatio, 2)}  ${
        steadyState.acquisitionFeasibilityRatio === undefined
          ? '(not computed)'
          : steadyState.acquisitionFeasibilityRatio >= 1
            ? '(achievable)'
            : '(NOT ACHIEVABLE)'
      }`,
    )
  }

  lines.push(heading('Sensitivity: break-even concurrent clients'))
  const tenures = [...new Set(result.sensitivity.map((s) => s.tenureDays))].sort((a, b) => a - b)
  const bpsValues = [...new Set(result.sensitivity.map((s) => s.operatorBps))].sort((a, b) => a - b)
  const grid = bpsValues.map((opBps) => ({ opBps }))
  lines.push(
    table(grid, [
      { header: 'operator bps', value: (row) => String(row.opBps), align: 'right' },
      ...tenures.map((days) => ({
        header: `${days}d`,
        value: (row: { opBps: number }) => {
          const cell = result.sensitivity.find((s) => s.operatorBps === row.opBps && s.tenureDays === days)
          if (cell === undefined) return '-'
          const n = Number.isFinite(cell.breakEvenConcurrentClients)
            ? num(cell.breakEvenConcurrentClients, 0)
            : 'inf'
          return `${n}${cell.verdict === 'GO' ? '' : cell.verdict === 'MARGINAL' ? '?' : '!'}`
        },
        align: 'right' as const,
      })),
    ]),
  )
  lines.push('  Cells are break-even concurrent clients. "!" = STOP, "?" = MARGINAL, bare = GO.')
  lines.push('  Columns are mean tenure in days. 2.14d is the Phase 0 measured mean age of the standing stock;')
  lines.push('  12.9d is the most survivor-biased cohort available; 56d is the 8 weeks the original plan assumed.')

  lines.push(heading('Required weekly signings'))
  lines.push(
    table(grid, [
      { header: 'operator bps', value: (row) => String(row.opBps), align: 'right' },
      ...tenures.map((days) => ({
        header: `${days}d`,
        value: (row: { opBps: number }) => {
          const cell = result.sensitivity.find((s) => s.operatorBps === row.opBps && s.tenureDays === days)
          if (cell === undefined) return '-'
          return Number.isFinite(cell.requiredWeeklyAcquisitions)
            ? num(cell.requiredWeeklyAcquisitions, 1)
            : 'inf'
        },
        align: 'right' as const,
      })),
    ]),
  )

  lines.push(subheading('Input provenance'))
  lines.push(
    table(result.provenance, [
      { header: 'input', value: (p) => p.input },
      { header: 'value', value: (p) => p.value, align: 'right' },
      { header: 'source', value: (p) => p.source },
    ]),
  )
  return lines.join('\n')
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (current.length + word.length + 1 > width) {
      lines.push(current)
      current = word
    } else {
      current = current.length === 0 ? word : `${current} ${word}`
    }
  }
  if (current.length > 0) lines.push(current)
  return lines
}

if (isEntrypoint(import.meta.url)) {
  await runCli(SPEC, process.argv.slice(2), main)
}

export { SPEC as REPRICE_SPEC }
