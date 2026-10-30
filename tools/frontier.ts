/**
 * frontier - WHICH configurations clear break-even, not whether one does.
 *
 * THE GAP THIS FILLS. reprice.ts answers a point question: given this operator
 * take, this gate, this win rate and this fixed cost, does the book close? The
 * two repricings that are now baked into config/protocol.ts - operatorBps
 * 1000 -> 500 and the T1 gate $250 -> $1,000 - were each found by running
 * reprice a handful of times by hand and keeping the first combination that
 * passed. That is a search, performed by a human, over a space nobody mapped.
 * This tool maps it.
 *
 * WHY IT IS NOT JUST A BIGGER SWEEP. The four levers are not independent, and
 * the coupling is the whole point:
 *
 *   RAISING THE GATE RAISES REVENUE PER CLIENT AND EMPTIES THE POPULATION.
 *   reprice.ts takes --clients-above-gate as a scalar, so a hand-run sweep of
 *   the gate silently holds the population fixed - which is the one thing that
 *   cannot be true. Here the population is a FUNCTION of the gate, read off the
 *   measured per-coin QF distribution, and read again for the winnable subset
 *   at that gate rather than by scaling one capture ratio across all gates.
 *
 *   RAISING THE GATE ALSO RAISES COGS. A $2,500/day client is a T2 client and
 *   costs T2 money to serve ($30/day, not $13). Holding T1's COGS while sweeping
 *   the gate into T2's band manufactures margin that the tier table says does
 *   not exist. --cogs-mode tier is therefore the default.
 *
 * THE ARITHMETIC, in full, so nothing below is a black box:
 *
 *   contribution/day  = gate x operatorBps/10,000 - cogs/day
 *   break-even        = (fixedCost/30) / contribution        [Little's Law, L]
 *   feasibility ratio = winRate x P(gate) / break-even
 *
 * TENURE DOES NOT APPEAR. It cancels exactly: the required signing rate is
 * L/W and the available crossing rate is P/W, so W divides out. VERDICT.md
 * confirms this empirically at 3.01d, 8.59d, 11.59d and 32d, all returning
 * 0.6753. That is why this tool does not take a tenure argument for the
 * frontier itself, and why a tenure re-measurement cannot move it.
 *
 * ADMISSIBILITY IS NOT THE SAME AS ARITHMETIC. A configuration that solves is
 * not automatically a configuration that exists. Two bounds are MEASURED and
 * are therefore hard:
 *
 *   - an operator take above the live norms Phase 0 measured on this platform
 *     (venueFlow 0%, Sinjoh 1%, Venue Bot 5%) is not an available price;
 *   - a gate below the measured support of the QF distribution has an UNKNOWN
 *     population, not an extrapolated one.
 *
 * A third bound - the win rate - is NOT measured anywhere in this repository.
 * Rather than invent a ceiling for it, cells above the baseline win rate are
 * FLAGGED as resting on an unmeasured assumption, and the report leads with the
 * minimum win rate each configuration needs so the reader can judge it.
 *
 * IF NOTHING ADMISSIBLE CLEARS, THAT SENTENCE IS THE OUTPUT. It is printed in a
 * banner, first and last, and it is the single most decision-relevant thing this
 * tool can say.
 */

import { readFile } from 'node:fs/promises'
import type { ParsedValues } from './lib/cli.ts'
import { CliError, getBool, getList, getNumber, getString, isEntrypoint, runCli } from './lib/cli.ts'
import { banner, heading, num, pct, subheading, table, usd } from './lib/format.ts'
import { parseJson } from './lib/json.ts'
import { emit, emitDryRun, progress, type Report } from './lib/report.ts'
import {
  QUALIFICATION_FLOOR_MONTHLY_USD,
  TERMS,
  TIERS,
  TIER_ORDER,
  type TierId,
} from '../config/protocol.ts'

const SCHEMA_VERSION = 'frontier-1'

/**
 * The highest take rate anyone on this platform was MEASURED charging.
 *
 * Phase 0: venueFlow 0%, Sinjoh 1%, Venue Bot 5% - and the Venue Bot 5% funds a
 * token buyback rather than labour. The VenuePad 10% the original spec
 * benchmarked against is unverified and that site shows zero launches, so it is
 * not in this bound. A configuration above this is arithmetic, not an offer.
 */
export const MEASURED_MARKET_TAKE_BPS_MAX = 500

/** The classes of live fee recipient a coin can be won from. See VERDICT.md §4. */
export const DEFAULT_WINNABLE_CLASSES = ['EOA', 'EOA_7702'] as const

const SPEC = {
  name: 'frontier',
  summary:
    'Solve for the region of (operator bps, gate, win rate, fixed cost) that clears break-even, and say plainly when none does.',
  detail: `
    reprice.ts answers "does THIS configuration work". This answers "WHICH
    configurations work". The standing population is a function of the gate, read
    off the measured per-coin QF distribution rather than held fixed, and COGS
    follows the tier the gate lands in. Regions above the measured market take
    rate, or below the measured support of the QF distribution, are marked
    INADMISSIBLE rather than reported as options.
  `,
  options: [
    {
      name: 'qf-distribution',
      type: 'string' as const,
      placeholder: '<file>',
      describe:
        'Per-coin QF/day distribution. Accepts incumbent-capture.json, t1-final-rows.json, or an array of {coin, qfPerDayUsd, winnable}. Without it the gate axis cannot be solved and is refused.',
    },
    {
      name: 'qf-field',
      type: 'string' as const,
      default: 'median7',
      describe: 'Field carrying each coin’s QF/day. The gate is a trailing-7-day MEDIAN, so median7 is the right one.',
    },
    {
      name: 'winnable-classes',
      type: 'string[]' as const,
      default: [...DEFAULT_WINNABLE_CLASSES],
      describe:
        'Recipient classes counted as winnable when a row carries no explicit `winnable` flag.',
    },
    {
      name: 'extra-winnable-coins',
      type: 'string[]' as const,
      describe:
        'Coin addresses that are winnable despite a contract-routed class - the ones carrying transferCreatorFeeRecipient. Measured coin by coin; VERDICT.md found 3.',
    },
    {
      name: 'support-floor-usd',
      type: 'number' as const,
      describe:
        'The QF/day gate the distribution file was ASSEMBLED at. Counts are exact at or above it; below it the population is UNKNOWN. Defaults to the smallest QF in the file, which is the only bound the file itself proves.',
    },
    {
      name: 'clients-above-gate',
      type: 'number' as const,
      describe:
        'Winnable standing population at the BASELINE gate, when no distribution file is available. Holds the population constant, so the gate axis is refused.',
    },
    {
      name: 'sweep-operator-bps',
      type: 'string[]' as const,
      default: ['100', '250', '500', '750', '1000', '1500'],
      describe: 'Operator take values, in bps of QF.',
    },
    {
      name: 'sweep-gate',
      type: 'string[]' as const,
      default: ['500', '1000', '1500', '2000', '2500', '3000', '4000', '5000', '7500', '10000', '20000'],
      describe: 'Candidate QF/day gates.',
    },
    {
      name: 'sweep-win-rate',
      type: 'string[]' as const,
      default: ['0.05', '0.1', '0.2', '0.35'],
      describe: 'Share of gate-crossing coins that can be signed, 0..1.',
    },
    {
      name: 'sweep-fixed-cost-usd',
      type: 'string[]' as const,
      default: ['6000', '12000', '24000'],
      describe: 'Operator fixed cost per month. AN ASSUMPTION on every axis value.',
    },
    {
      name: 'operator-bps',
      type: 'number' as const,
      default: TERMS.operatorBps,
      describe: 'Baseline operator take. The grid in the human report is cut at this value.',
    },
    { name: 'gate', type: 'number' as const, default: TIERS.T1.gateQfPerDay, describe: 'Baseline gate.' },
    { name: 'win-rate', type: 'number' as const, default: 0.1, describe: 'Baseline win rate.' },
    {
      name: 'fixed-cost-monthly-usd',
      type: 'number' as const,
      default: 12_000,
      describe: 'Baseline operator fixed cost per month.',
    },
    {
      name: 'cogs-mode',
      type: 'string' as const,
      default: 'tier',
      describe:
        'tier = use the COGS of the highest tier the gate clears (a $2,500/day client is a T2 client). fixed = hold --cogs-per-day at every gate.',
    },
    {
      name: 'cogs-per-day',
      type: 'number' as const,
      describe: 'COGS/day override. Required by --cogs-mode fixed; defaults to the baseline tier’s.',
    },
    {
      name: 'budget-bps',
      type: 'number' as const,
      default: TERMS.budgetBpsDefault,
      describe: 'Procurement dial, for the qualification-floor admissibility test.',
    },
    {
      name: 'max-market-bps',
      type: 'number' as const,
      default: MEASURED_MARKET_TAKE_BPS_MAX,
      describe:
        'Operator take above which a configuration is INADMISSIBLE. Defaults to the highest rate Phase 0 measured anyone charging on this platform.',
    },
    {
      name: 'min-population',
      type: 'number' as const,
      default: 10,
      describe:
        'Winnable standing population below which a gate is treated as having emptied the market rather than priced it.',
    },
    {
      name: 'stop-threshold',
      type: 'number' as const,
      default: 40,
      describe: 'Break-even concurrent client count above which the 20-40 durable client test fails.',
    },
  ],
  examples: [
    'node tools/frontier.ts --qf-distribution tools/artifacts/incumbent-capture.json --support-floor-usd 1000',
    'node tools/frontier.ts --qf-distribution tools/artifacts/incumbent-capture.json --cogs-mode fixed --cogs-per-day 13 --json',
    'node tools/frontier.ts --clients-above-gate 73   # no distribution: gate axis refused',
  ],
}

// ---------------------------------------------------------------------------
// The measured QF distribution
// ---------------------------------------------------------------------------

export interface FrontierCoin {
  coin: string
  /** Trailing-7-day median QF, USD/day. */
  qfPerDayUsd: number
  /** Live creator-fee recipient class, when the source carries one. */
  cls: string | undefined
  winnable: boolean
}

export interface QfDistribution {
  coins: FrontierCoin[]
  /** Smallest QF/day in the file. */
  observedFloorUsd: number
  observedCeilingUsd: number
  /**
   * The gate this file was ASSEMBLED at. Counts are exact at or above it and
   * incomplete below it, because the file simply does not contain the coins
   * that would qualify. Defaults to the smallest observed value, which is the
   * only bound derivable from the file itself; --support-floor-usd declares the
   * real one when the operator knows it.
   */
  supportFloorUsd: number
  /** Rows dropped because the QF field was absent or not a finite number. */
  droppedRows: number
  winnableRule: string
}

export class QfDistributionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QfDistributionError'
  }
}

interface ParseDistributionOptions {
  qfField: string
  winnableClasses: readonly string[]
  extraWinnableCoins: readonly string[]
  /** The gate the file was assembled at, when the operator knows it. */
  supportFloorUsd?: number | undefined
}

/**
 * Read a per-coin QF distribution from any of the shapes this repository
 * actually produced.
 *
 * A row whose QF field is missing is DROPPED and counted, never coerced to
 * zero: a zero would sit below every gate and quietly shrink the population,
 * which is the same unknown-as-zero failure the rest of the toolkit refuses.
 */
export function parseQfDistribution(value: unknown, options: ParseDistributionOptions): QfDistribution {
  const rows = extractRows(value)
  if (rows.length === 0) {
    throw new QfDistributionError(
      'the QF distribution file contained no rows. Expected an array of coin rows, or an object with a `rows` array (incumbent-capture.json).',
    )
  }
  const winnableClasses = new Set(options.winnableClasses.map((c) => c.toUpperCase()))
  const extra = new Set(options.extraWinnableCoins.map((c) => c.toLowerCase()))
  const coins: FrontierCoin[] = []
  let dropped = 0
  for (const row of rows) {
    const qfRaw = row[options.qfField]
    const qf = typeof qfRaw === 'number' ? qfRaw : Number.NaN
    const coinRaw = row['coin'] ?? row['token'] ?? row['memecoin'] ?? row['recipient']
    const coin = typeof coinRaw === 'string' ? coinRaw.toLowerCase() : ''
    if (!Number.isFinite(qf) || coin.length === 0) {
      dropped++
      continue
    }
    const clsRaw = row['cls'] ?? row['class']
    const cls = typeof clsRaw === 'string' ? clsRaw : undefined
    const explicit = row['winnable']
    const winnable =
      typeof explicit === 'boolean'
        ? explicit
        : extra.has(coin) || (cls !== undefined && winnableClasses.has(cls.toUpperCase()))
    coins.push({ coin, qfPerDayUsd: qf, cls, winnable })
  }
  if (coins.length === 0) {
    throw new QfDistributionError(
      `no row carried a finite "${options.qfField}" and a coin address. Use --qf-field to name the right column.`,
    )
  }
  const values = coins.map((c) => c.qfPerDayUsd)
  const observedFloorUsd = Math.min(...values)
  return {
    coins,
    observedFloorUsd,
    observedCeilingUsd: Math.max(...values),
    supportFloorUsd: options.supportFloorUsd ?? observedFloorUsd,
    droppedRows: dropped,
    winnableRule:
      `explicit \`winnable\` field when present; otherwise class in {${[...winnableClasses].join(', ')}}` +
      (extra.size > 0 ? ` plus ${extra.size} coin(s) named by --extra-winnable-coins` : ''),
  }
}

function extractRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter(isRecord)
  if (isRecord(value)) {
    for (const key of ['rows', 'coins', 'result']) {
      const candidate = value[key]
      if (Array.isArray(candidate)) return candidate.filter(isRecord)
    }
  }
  return []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface PopulationAtGate {
  gateQfPerDay: number
  /** Coins at or above the gate, all classes. */
  total: number
  /** Coins at or above the gate whose recipiency can actually be won. */
  winnable: number
  /** winnable/total at THIS gate. Measured per gate, never a ratio carried over. */
  winnableShare: number | undefined
  /**
   * True when the gate sits below the file's smallest observed QF, so the
   * population is unknown rather than measured. Every count above is then a
   * lower bound and the caller must refuse to price the cell.
   */
  belowMeasuredSupport: boolean
}

/**
 * Standing population at a gate, measured.
 *
 * The counts are exact for any gate at or above the file's observed floor,
 * because a QF distribution assembled at a floor is complete above it. Below
 * the floor they are lower bounds - the file simply does not contain the coins
 * that would qualify - and `belowMeasuredSupport` says so.
 */
export function populationAtGate(distribution: QfDistribution, gate: number): PopulationAtGate {
  let total = 0
  let winnable = 0
  for (const coin of distribution.coins) {
    if (coin.qfPerDayUsd < gate) continue
    total++
    if (coin.winnable) winnable++
  }
  return {
    gateQfPerDay: gate,
    total,
    winnable,
    winnableShare: total > 0 ? winnable / total : undefined,
    belowMeasuredSupport: gate < distribution.supportFloorUsd,
  }
}

// ---------------------------------------------------------------------------
// COGS follows the tier the gate lands in
// ---------------------------------------------------------------------------

export type CogsMode = 'tier' | 'fixed'

export interface CogsResolution {
  cogsPerDayUsd: number
  tier: TierId | undefined
  /** Set when the gate was raised into a tier above the baseline one. */
  tierRaised: boolean
}

/**
 * The COGS a client at this gate costs to serve.
 *
 * Under `tier` this is the COGS of the HIGHEST tier whose gate the candidate
 * gate clears. That is the conservative and, more importantly, the honest
 * reading: TIERS says a $2,500/day coin is a Campaign client at $30/day, and a
 * sweep that raises the gate while holding Desk COGS invents $17/day/coin of
 * margin the tier table does not offer.
 */
export function cogsForGate(
  gate: number,
  mode: CogsMode,
  baselineTier: TierId,
  fixedCogsPerDay: number,
): CogsResolution {
  if (mode === 'fixed') {
    return { cogsPerDayUsd: fixedCogsPerDay, tier: undefined, tierRaised: false }
  }
  let chosen: TierId = TIER_ORDER[0] as TierId
  for (const id of TIER_ORDER) {
    if (gate >= TIERS[id].gateQfPerDay) chosen = id
  }
  const chosenIndex = TIER_ORDER.indexOf(chosen)
  const baselineIndex = TIER_ORDER.indexOf(baselineTier)
  return {
    cogsPerDayUsd: TIERS[chosen].cogsPerDay,
    tier: chosen,
    tierRaised: chosenIndex > baselineIndex,
  }
}

// ---------------------------------------------------------------------------
// One cell of the frontier
// ---------------------------------------------------------------------------

export interface CellInputs {
  operatorBps: number
  gateQfPerDay: number
  winRate: number
  fixedCostMonthlyUsd: number
  cogsPerDayUsd: number
  budgetBps: number
  /** Winnable standing population at this gate. undefined = not measurable. */
  winnablePopulation: number | undefined
  stopThreshold: number
  maxMarketBps: number
  minPopulation: number
  baselineWinRate: number
  belowMeasuredSupport: boolean
}

/** Why a cell is not a real option, as opposed to not a solving one. */
export type InadmissibleReason =
  | 'operator_bps_above_measured_market_norm'
  | 'gate_below_measured_support'
  | 'population_empty'
  | 'below_qualification_floor'

/** Not inadmissible, but resting on something nobody measured. */
export type CellFlag = 'win_rate_above_baseline' | 'tier_cogs_raised'

export interface FrontierCell {
  operatorBps: number
  gateQfPerDay: number
  winRate: number
  fixedCostMonthlyUsd: number
  cogsPerDayUsd: number
  tier: TierId | undefined
  winnablePopulation: number | undefined
  contributionPerClientDayUsd: number
  breakEvenConcurrentClients: number
  requiredWeeklyAcquisitionsPerTenureDay: number
  feasibilityRatio: number | undefined
  monthlyBudgetUsd: number
  /** Population at which this cell's ratio reaches 1.0. The flip point. */
  flipPointPopulation: number | undefined
  /** Smallest win rate that clears, at this population. */
  minWinRateToClear: number | undefined
  /** Largest monthly fixed cost that clears, at this population and win rate. */
  maxFixedCostToClear: number | undefined
  /** Clears break-even AND the feasibility test AND the tier floor. */
  clears: boolean
  admissible: boolean
  inadmissibleReasons: InadmissibleReason[]
  flags: CellFlag[]
}

/**
 * Evaluate one configuration.
 *
 * Pure, total, and it never substitutes a number for an unknown: when the
 * population could not be measured, `feasibilityRatio` is undefined and
 * `clears` is false - never "clears because the unknown was small".
 */
export function evaluateCell(inputs: CellInputs): FrontierCell {
  const contribution = (inputs.gateQfPerDay * inputs.operatorBps) / 10_000 - inputs.cogsPerDayUsd
  const fixedPerDay = inputs.fixedCostMonthlyUsd / 30
  const breakEven = contribution > 0 ? fixedPerDay / contribution : Number.POSITIVE_INFINITY
  const monthlyBudgetUsd = (inputs.gateQfPerDay * inputs.budgetBps * 30) / 10_000

  const population = inputs.winnablePopulation
  const feasibilityRatio =
    population !== undefined && Number.isFinite(breakEven) && breakEven > 0
      ? (inputs.winRate * population) / breakEven
      : undefined

  const flipPointPopulation = Number.isFinite(breakEven)
    ? Math.ceil(breakEven / inputs.winRate)
    : undefined
  const minWinRateToClear =
    population !== undefined && population > 0 && Number.isFinite(breakEven)
      ? breakEven / population
      : undefined
  const maxFixedCostToClear =
    population !== undefined && contribution > 0
      ? 30 * inputs.winRate * population * contribution
      : undefined

  const inadmissibleReasons: InadmissibleReason[] = []
  if (inputs.operatorBps > inputs.maxMarketBps) {
    inadmissibleReasons.push('operator_bps_above_measured_market_norm')
  }
  if (inputs.belowMeasuredSupport) inadmissibleReasons.push('gate_below_measured_support')
  if (population !== undefined && population < inputs.minPopulation) {
    inadmissibleReasons.push('population_empty')
  }
  if (monthlyBudgetUsd < QUALIFICATION_FLOOR_MONTHLY_USD) {
    inadmissibleReasons.push('below_qualification_floor')
  }

  const flags: CellFlag[] = []
  if (inputs.winRate > inputs.baselineWinRate) flags.push('win_rate_above_baseline')

  const clears =
    contribution > 0 &&
    breakEven <= inputs.stopThreshold &&
    feasibilityRatio !== undefined &&
    feasibilityRatio >= 1

  return {
    operatorBps: inputs.operatorBps,
    gateQfPerDay: inputs.gateQfPerDay,
    winRate: inputs.winRate,
    fixedCostMonthlyUsd: inputs.fixedCostMonthlyUsd,
    cogsPerDayUsd: inputs.cogsPerDayUsd,
    tier: undefined,
    winnablePopulation: population,
    contributionPerClientDayUsd: contribution,
    breakEvenConcurrentClients: breakEven,
    // Tenure cancels out of the ratio, so the only tenure-dependent quantity
    // worth publishing is the rate PER DAY OF TENURE. Multiply by 7/tenure to
    // get reprice.ts's signings/week.
    requiredWeeklyAcquisitionsPerTenureDay: Number.isFinite(breakEven) ? breakEven * 7 : Number.POSITIVE_INFINITY,
    feasibilityRatio,
    monthlyBudgetUsd,
    flipPointPopulation,
    minWinRateToClear,
    maxFixedCostToClear,
    clears,
    admissible: inadmissibleReasons.length === 0,
    inadmissibleReasons,
    flags,
  }
}

// ---------------------------------------------------------------------------
// The solve
// ---------------------------------------------------------------------------

export interface FrontierParams {
  operatorBpsValues: number[]
  gateValues: number[]
  winRateValues: number[]
  fixedCostValues: number[]
  budgetBps: number
  cogsMode: CogsMode
  cogsPerDayUsd: number
  baselineTier: TierId
  stopThreshold: number
  maxMarketBps: number
  minPopulation: number
  baselineWinRate: number
  /** Measured distribution, or undefined when the gate axis is refused. */
  distribution: QfDistribution | undefined
  /** Population held constant when there is no distribution. */
  fixedPopulation: number | undefined
  baselineGate: number
  baselineOperatorBps: number
}

export interface FrontierSummary {
  cellsEvaluated: number
  admissibleCells: number
  clearingCells: number
  /** Cells that are both admissible and clearing. The answer to the question. */
  admissibleClearingCells: number
  /** True when nothing admissible clears. The headline. */
  noAdmissibleConfigurationClears: boolean
  /** Admissible clearing cells that need a win rate above the baseline. */
  admissibleClearingCellsNeedingUnmeasuredWinRate: number
  /**
   * Admissible clearing cells that move NEITHER assumption - same win rate,
   * same fixed cost as the configuration on file. Zero here with a non-empty
   * region above means the region is bought entirely with assumptions.
   */
  admissibleClearingCellsAtBaselineAssumptions: number
  /** The cheapest-take admissible clearing cell, then the lowest gate. */
  best: FrontierCell | undefined
  /**
   * The admissible cell that comes closest to clearing without doing so, at the
   * baseline assumptions. A frontier that misses by 1% is a different decision
   * from one that misses by 60%, and the ratio table alone buries it.
   */
  closestAdmissibleMiss: FrontierCell | undefined
  /** Ranges of each axis inside the admissible clearing region. */
  region:
    | {
        operatorBps: { min: number; max: number }
        gateQfPerDay: { min: number; max: number }
        winRate: { min: number; max: number }
        fixedCostMonthlyUsd: { min: number; max: number }
      }
    | undefined
}

export interface FrontierResult {
  params: {
    cogsMode: CogsMode
    budgetBps: number
    maxMarketBps: number
    minPopulation: number
    stopThreshold: number
    baseline: { operatorBps: number; gateQfPerDay: number; winRate: number; fixedCostMonthlyUsd: number }
  }
  distribution:
    | {
        coins: number
        winnableCoins: number
        observedFloorUsd: number
        observedCeilingUsd: number
        supportFloorUsd: number
        droppedRows: number
        winnableRule: string
      }
    | undefined
  populations: PopulationAtGate[]
  cells: FrontierCell[]
  summary: FrontierSummary
  /**
   * The configuration config/protocol.ts is currently set to. Anchors the
   * frontier to the verdict already on file: if this cell does not reproduce
   * what reprice.ts returns, one of the two is wrong.
   */
  baselineCell: FrontierCell | undefined
  /** Per (operatorBps, gate) at the baseline win rate and fixed cost. */
  grid: FrontierCell[]
}

export function solveFrontier(params: FrontierParams): FrontierResult {
  const populations: PopulationAtGate[] = []
  const populationByGate = new Map<number, PopulationAtGate | undefined>()
  for (const gate of params.gateValues) {
    if (params.distribution === undefined) {
      populationByGate.set(gate, undefined)
      continue
    }
    const population = populationAtGate(params.distribution, gate)
    populations.push(population)
    populationByGate.set(gate, population)
  }

  const cells: FrontierCell[] = []
  for (const operatorBps of params.operatorBpsValues) {
    for (const gate of params.gateValues) {
      const population = populationByGate.get(gate)
      const cogs = cogsForGate(gate, params.cogsMode, params.baselineTier, params.cogsPerDayUsd)
      for (const winRate of params.winRateValues) {
        for (const fixedCost of params.fixedCostValues) {
          const cell = evaluateCell({
            operatorBps,
            gateQfPerDay: gate,
            winRate,
            fixedCostMonthlyUsd: fixedCost,
            cogsPerDayUsd: cogs.cogsPerDayUsd,
            budgetBps: params.budgetBps,
            winnablePopulation:
              params.distribution === undefined
                ? gate === params.baselineGate
                  ? params.fixedPopulation
                  : undefined
                : population?.belowMeasuredSupport === true
                  ? undefined
                  : population?.winnable,
            stopThreshold: params.stopThreshold,
            maxMarketBps: params.maxMarketBps,
            minPopulation: params.minPopulation,
            baselineWinRate: params.baselineWinRate,
            belowMeasuredSupport: population?.belowMeasuredSupport ?? params.distribution === undefined,
          })
          cell.tier = cogs.tier
          if (cogs.tierRaised) cell.flags.push('tier_cogs_raised')
          cells.push(cell)
        }
      }
    }
  }

  const winning = cells.filter((c) => c.admissible && c.clears)
  const best = pickBest(winning)
  const atBaselineAssumptions = (cell: FrontierCell): boolean =>
    cell.winRate === params.baselineWinRate && cell.fixedCostMonthlyUsd === (params.fixedCostValues[0] ?? 0)
  const closestAdmissibleMiss = cells
    .filter(
      (c) =>
        c.admissible &&
        !c.clears &&
        atBaselineAssumptions(c) &&
        c.feasibilityRatio !== undefined &&
        Number.isFinite(c.feasibilityRatio),
    )
    .sort((a, b) => (b.feasibilityRatio ?? 0) - (a.feasibilityRatio ?? 0))[0]
  const summary: FrontierSummary = {
    cellsEvaluated: cells.length,
    admissibleCells: cells.filter((c) => c.admissible).length,
    clearingCells: cells.filter((c) => c.clears).length,
    admissibleClearingCells: winning.length,
    noAdmissibleConfigurationClears: winning.length === 0,
    admissibleClearingCellsNeedingUnmeasuredWinRate: winning.filter((c) =>
      c.flags.includes('win_rate_above_baseline'),
    ).length,
    admissibleClearingCellsAtBaselineAssumptions: winning.filter(atBaselineAssumptions).length,
    best,
    closestAdmissibleMiss,
    region:
      winning.length === 0
        ? undefined
        : {
            operatorBps: range(winning.map((c) => c.operatorBps)),
            gateQfPerDay: range(winning.map((c) => c.gateQfPerDay)),
            winRate: range(winning.map((c) => c.winRate)),
            fixedCostMonthlyUsd: range(winning.map((c) => c.fixedCostMonthlyUsd)),
          },
  }

  const baselineFixedCost = params.fixedCostValues[0] ?? 0
  const grid = cells.filter(
    (c) => c.winRate === params.baselineWinRate && c.fixedCostMonthlyUsd === baselineFixedCost,
  )
  const baselineCell = cells.find(
    (c) =>
      c.operatorBps === params.baselineOperatorBps &&
      c.gateQfPerDay === params.baselineGate &&
      c.winRate === params.baselineWinRate &&
      c.fixedCostMonthlyUsd === baselineFixedCost,
  )

  return {
    params: {
      cogsMode: params.cogsMode,
      budgetBps: params.budgetBps,
      maxMarketBps: params.maxMarketBps,
      minPopulation: params.minPopulation,
      stopThreshold: params.stopThreshold,
      baseline: {
        operatorBps: params.baselineOperatorBps,
        gateQfPerDay: params.baselineGate,
        winRate: params.baselineWinRate,
        fixedCostMonthlyUsd: baselineFixedCost,
      },
    },
    distribution:
      params.distribution === undefined
        ? undefined
        : {
            coins: params.distribution.coins.length,
            winnableCoins: params.distribution.coins.filter((c) => c.winnable).length,
            observedFloorUsd: params.distribution.observedFloorUsd,
            observedCeilingUsd: params.distribution.observedCeilingUsd,
            supportFloorUsd: params.distribution.supportFloorUsd,
            droppedRows: params.distribution.droppedRows,
            winnableRule: params.distribution.winnableRule,
          },
    populations,
    cells,
    summary,
    baselineCell,
    grid,
  }
}

/**
 * The configuration a reader should look at first.
 *
 * Ordered by what costs the client least, not by what earns most: lowest
 * operator take, then lowest gate (the widest market), then lowest win rate
 * required, then highest tolerated fixed cost. A frontier tool that ranked by
 * operator revenue would recommend the corner of the space furthest from the
 * measured market every time.
 */
function pickBest(cells: readonly FrontierCell[]): FrontierCell | undefined {
  const sorted = [...cells].sort(
    (a, b) =>
      a.operatorBps - b.operatorBps ||
      a.gateQfPerDay - b.gateQfPerDay ||
      a.winRate - b.winRate ||
      b.fixedCostMonthlyUsd - a.fixedCostMonthlyUsd,
  )
  return sorted[0]
}

function range(values: readonly number[]): { min: number; max: number } {
  return { min: Math.min(...values), max: Math.max(...values) }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseNumberList(values: ParsedValues, name: string): number[] {
  const parsed = getList(values, name).map((raw) => {
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new CliError(`--${name} contains "${raw}", which is not a number.`)
    return n
  })
  if (parsed.length === 0) throw new CliError(`--${name} needs at least one value.`)
  return [...new Set(parsed)].sort((a, b) => a - b)
}

async function main(values: ParsedValues): Promise<void> {
  const json = getBool(values, 'json')
  const verbose = getBool(values, 'verbose')
  const outPath = getString(values, 'out')

  const cogsModeRaw = (getString(values, 'cogs-mode') ?? 'tier').toLowerCase()
  if (cogsModeRaw !== 'tier' && cogsModeRaw !== 'fixed') {
    throw new CliError('--cogs-mode must be "tier" or "fixed".')
  }
  const cogsMode: CogsMode = cogsModeRaw

  const operatorBpsValues = parseNumberList(values, 'sweep-operator-bps')
  const gateValues = parseNumberList(values, 'sweep-gate')
  const winRateValues = parseNumberList(values, 'sweep-win-rate')
  const fixedCostValues = parseNumberList(values, 'sweep-fixed-cost-usd')
  for (const rate of winRateValues) {
    if (rate <= 0 || rate > 1) throw new CliError(`--sweep-win-rate must be in (0, 1]; got ${rate}.`)
  }

  const baselineWinRate = getNumber(values, 'win-rate', 0.1)
  if (baselineWinRate <= 0 || baselineWinRate > 1) throw new CliError('--win-rate must be in (0, 1]')
  const baselineGate = getNumber(values, 'gate', TIERS.T1.gateQfPerDay)
  const baselineOperatorBps = getNumber(values, 'operator-bps', TERMS.operatorBps)
  const baselineFixedCost = getNumber(values, 'fixed-cost-monthly-usd', 12_000)
  if (baselineFixedCost <= 0) throw new CliError('--fixed-cost-monthly-usd must be positive')
  const distributionPath = getString(values, 'qf-distribution')
  const clientsRaw = values['clients-above-gate']
  const fixedPopulation = typeof clientsRaw === 'number' ? clientsRaw : undefined

  if (getBool(values, 'dry-run')) {
    emitDryRun(
      {
        tool: SPEC.name,
        config: {
          cogsMode,
          operatorBpsValues,
          gateValues,
          winRateValues,
          fixedCostValues,
          qfDistribution: distributionPath ?? '(none - gate axis will be refused)',
        },
        steps: [
          {
            description: distributionPath
              ? `read the per-coin QF distribution from ${distributionPath}`
              : 'no --qf-distribution: the gate axis is refused and every off-baseline gate reports an UNKNOWN population',
          },
          { description: 'count the winnable standing population at each candidate gate' },
          {
            description: `evaluate ${operatorBpsValues.length * gateValues.length * winRateValues.length * fixedCostValues.length} configurations`,
          },
          { description: 'mark inadmissible regions and report the admissible clearing region, if any' },
        ],
        estimatedRequestsTotal: 0,
        notes: [
          'frontier.ts makes no network request. It reads one local file and does arithmetic.',
          'Tenure is absent by construction: it cancels out of the feasibility ratio.',
        ],
      },
      json,
    )
    return
  }

  let distribution: QfDistribution | undefined
  if (distributionPath !== undefined) {
    progress(verbose, `reading QF distribution from ${distributionPath}`)
    const supportFloorRaw = values['support-floor-usd']
    distribution = parseQfDistribution(parseJson(await readFile(distributionPath, 'utf8')), {
      qfField: getString(values, 'qf-field') ?? 'median7',
      winnableClasses: getList(values, 'winnable-classes'),
      extraWinnableCoins: getList(values, 'extra-winnable-coins'),
      supportFloorUsd: typeof supportFloorRaw === 'number' ? supportFloorRaw : undefined,
    })
    progress(
      verbose,
      `${distribution.coins.length} coins, floor ${usd(distribution.observedFloorUsd)}/day, ceiling ${usd(distribution.observedCeilingUsd)}/day`,
    )
  } else if (fixedPopulation === undefined) {
    throw new CliError(
      'neither --qf-distribution nor --clients-above-gate was given, so there is no population to solve against. ' +
        'Pass --qf-distribution tools/artifacts/incumbent-capture.json for the full frontier, or ' +
        '--clients-above-gate <n> to solve every axis except the gate.',
    )
  }

  const baselineTier = tierForGate(baselineGate)
  const cogsPerDayUsd = getNumber(values, 'cogs-per-day', TIERS[baselineTier].cogsPerDay)

  // Every baseline value is forced into its own axis, and the fixed-cost
  // baseline is placed FIRST, because the human grid and the baseline cell are
  // both cut at it. A baseline that is not in the sweep would otherwise be
  // silently reported as a configuration nobody evaluated.
  const withBaseline = (sweep: number[], baseline: number): number[] =>
    sweep.includes(baseline) ? sweep : [...sweep, baseline].sort((a, b) => a - b)
  const orderedFixedCosts = [
    baselineFixedCost,
    ...fixedCostValues.filter((v) => v !== baselineFixedCost),
  ]
  const result = solveFrontier({
    operatorBpsValues: withBaseline(operatorBpsValues, baselineOperatorBps),
    gateValues: withBaseline(gateValues, baselineGate),
    winRateValues: withBaseline(winRateValues, baselineWinRate),
    fixedCostValues: orderedFixedCosts,
    budgetBps: getNumber(values, 'budget-bps', TERMS.budgetBpsDefault),
    cogsMode,
    cogsPerDayUsd,
    baselineTier,
    stopThreshold: getNumber(values, 'stop-threshold', 40),
    maxMarketBps: getNumber(values, 'max-market-bps', MEASURED_MARKET_TAKE_BPS_MAX),
    minPopulation: getNumber(values, 'min-population', 10),
    baselineWinRate,
    distribution,
    fixedPopulation,
    baselineGate,
    baselineOperatorBps,
  })

  const warnings: string[] = [
    'The population at each gate is a STANDING COUNT measured over one window inside the gas subsidy that expires 2026-09-29. Every cell inherits that expiry; see tools/artifacts/OCTOBER-RERUN.md.',
    `--fixed-cost-monthly-usd is an ASSUMPTION on every axis value. Break-even, and therefore the whole frontier, scales linearly in it. maxFixedCostToClear on each cell is the number to argue about.`,
  ]
  if (distribution === undefined) {
    warnings.push(
      `No --qf-distribution, so the population is held constant at ${String(fixedPopulation)} for the baseline gate only and is UNKNOWN at every other gate. The gate axis is refused, which is the one coupling this tool exists to model.`,
    )
  } else {
    warnings.push(
      `Gates below ${usd(distribution.supportFloorUsd)}/day sit under the measured support of the distribution: those populations are UNKNOWN, not small. They are marked inadmissible rather than estimated.` +
        (values['support-floor-usd'] === undefined
          ? ` That floor is the smallest QF in the file, which is the only bound the file itself proves. If you know the gate it was assembled at, declare it with --support-floor-usd.`
          : ` That floor was DECLARED with --support-floor-usd, not read from the file; the file's own smallest QF is ${usd(distribution.observedFloorUsd)}/day.`),
    )
    if (distribution.droppedRows > 0) {
      warnings.push(
        `${distribution.droppedRows} row(s) had no usable QF and were DROPPED, not zero-filled. Every population count is a lower bound by up to that many coins.`,
      )
    }
  }
  if (cogsMode === 'fixed') {
    warnings.push(
      `--cogs-mode fixed holds COGS at ${usd(cogsPerDayUsd)}/day at every gate. TIERS says a client above ${usd(TIERS.T2.gateQfPerDay)}/day costs ${usd(TIERS.T2.cogsPerDay)}/day to serve. Any clearing region this produces above that gate is margin the tier table does not offer.`,
    )
  }
  if (result.summary.admissibleClearingCellsNeedingUnmeasuredWinRate > 0) {
    warnings.push(
      `${result.summary.admissibleClearingCellsNeedingUnmeasuredWinRate} of the ${result.summary.admissibleClearingCells} admissible clearing configurations need a win rate above the ${pct(baselineWinRate)} baseline. NOTHING IN THIS REPOSITORY MEASURES THE WIN RATE. Those cells are a hypothesis about sales, not a measurement.`,
    )
  }

  const report: Report<FrontierResult> = {
    meta: {
      tool: SPEC.name,
      schemaVersion: SCHEMA_VERSION,
      generatedAtUnix: Math.floor(Date.now() / 1000),
      config: {
        cogsMode,
        operatorBpsValues,
        gateValues,
        winRateValues,
        fixedCostValues: orderedFixedCosts,
        qfDistribution: distributionPath ?? null,
      },
      io: { httpRequests: 0, cacheHits: 0, cacheMisses: 0 },
      warnings,
      methodLimits: [
        'The population at a gate is counted from ONE window of per-coin QF. It is a standing stock, not a flow, which is what makes it the right input to the feasibility ratio - but it is also a single observation with no error bar.',
        "Tenure is absent because it cancels out of the ratio. That is a property of the steady-state model, not of the market: if arrivals and departures are not in balance, Little's Law does not hold and neither does any cell here. tenure.ts's consistency ratio was 0.428 at the last measurement, and reprice.ts's own method limits call that 'a market that does not exist'.",
        'Winnability is a LIVE property. A coin classified winnable can point its recipiency at a distributor the next block, and the measured direction of travel is one-way: 361 recipient changes, zero moves off a distributor.',
        'COGS is the modelled TIERS.cogsPerDay, not an instrumented cost. Every contribution figure here is a plan.',
      ],
    },
    result,
  }

  await emit(report, { json, outPath, human: (r) => renderHuman(r.result) })
}

function tierForGate(gate: number): TierId {
  let chosen: TierId = TIER_ORDER[0] as TierId
  for (const id of TIER_ORDER) {
    if (gate >= TIERS[id].gateQfPerDay) chosen = id
  }
  return chosen
}

const REASON_LABEL: Record<InadmissibleReason, string> = {
  operator_bps_above_measured_market_norm: 'take above the measured market norm',
  gate_below_measured_support: 'gate below the measured QF support (population UNKNOWN)',
  population_empty: 'the gate empties the population',
  below_qualification_floor: 'budget below the qualification floor',
}

/**
 * One sentence for a cell's ratio, which is three different facts wearing one
 * number: a real ratio, a client that loses money, or a population nobody
 * measured. Collapsing them all onto "n/a" is how a missing measurement reads
 * as a bad one.
 */
function describeRatio(cell: FrontierCell): string {
  if (cell.winnablePopulation === undefined) {
    return 'Feasibility ratio UNKNOWN: the winnable population at this gate was never measured.'
  }
  if (cell.contributionPerClientDayUsd <= 0) {
    return `Each client LOSES ${usd(-cell.contributionPerClientDayUsd)}/day, so there is no break-even and no ratio.`
  }
  return (
    `Feasibility ratio ${num(cell.feasibilityRatio, 2)}, break-even ${num(cell.breakEvenConcurrentClients, 1)} concurrent clients, ` +
    `contribution ${usd(cell.contributionPerClientDayUsd)}/day.`
  )
}

function renderHuman(result: FrontierResult): string {
  const lines: string[] = []
  lines.push(heading('Viability frontier'))

  if (result.summary.noAdmissibleConfigurationClears) {
    lines.push('')
    lines.push(
      banner([
        'NO ADMISSIBLE CONFIGURATION CLEARS BREAK-EVEN.',
        '',
        `${result.summary.cellsEvaluated} configurations were solved. ${result.summary.clearingCells} of them clear the`,
        `arithmetic and ${result.summary.admissibleCells} are admissible, but the two sets do not intersect: every`,
        'configuration that closes requires either a take above the rates this platform was',
        'measured charging, a gate below the measured support of the QF distribution, a gate',
        'that empties the population, or a procurement budget below the qualification floor.',
        '',
        'This is not "no configuration was found". It is "the viable region is empty".',
      ]),
    )
  } else {
    const region = result.summary.region!
    lines.push('')
    lines.push(
      banner([
        `AN ADMISSIBLE REGION EXISTS: ${result.summary.admissibleClearingCells} of ${result.summary.cellsEvaluated} configurations clear.`,
        '',
        `operator take   ${region.operatorBps.min}-${region.operatorBps.max} bps`,
        `gate            ${usd(region.gateQfPerDay.min)} - ${usd(region.gateQfPerDay.max)} QF/day`,
        `win rate        ${pct(region.winRate.min)} - ${pct(region.winRate.max)}`,
        `fixed cost      ${usd(region.fixedCostMonthlyUsd.min)} - ${usd(region.fixedCostMonthlyUsd.max)}/month`,
        '',
        'These are the RANGES each axis takes across the clearing cells. They are not a',
        'box in which every point clears - read the table at the bottom for the cells',
        'themselves. A region is not a recommendation either: read the admissibility',
        'notes and the warnings below before treating any cell as an option.',
      ]),
    )
    const best = result.summary.best
    if (best !== undefined) {
      lines.push('')
      lines.push(
        `  Cheapest admissible clearing configuration: ${best.operatorBps}bps take, ${usd(best.gateQfPerDay)}/day gate, ` +
          `${pct(best.winRate)} win rate, ${usd(best.fixedCostMonthlyUsd)}/month fixed.`,
      )
      lines.push(
        `  It needs ${num(best.winnablePopulation, 0)} winnable coins standing and the flip point is ${num(best.flipPointPopulation, 0)}; ` +
          `ratio ${num(best.feasibilityRatio, 2)}, break-even ${num(best.breakEvenConcurrentClients, 1)} concurrent clients, ` +
          `COGS ${usd(best.cogsPerDayUsd)}/day${best.tier ? ` (${best.tier})` : ''}.`,
      )
    }
    if (result.summary.admissibleClearingCellsAtBaselineAssumptions === 0) {
      lines.push('')
      lines.push(
        banner([
          'NONE OF THAT REGION IS REACHABLE WITHOUT MOVING AN ASSUMPTION.',
          '',
          `Every clearing configuration needs a win rate above ${pct(result.params.baseline.winRate)} or a fixed cost`,
          `below ${usd(result.params.baseline.fixedCostMonthlyUsd)}/month. Neither is measured: the win rate is a`,
          'hypothesis about a sales motion nobody has run, and the fixed cost is a plan.',
          'At the assumptions actually on file, the viable region is empty.',
        ]),
      )
      const miss = result.summary.closestAdmissibleMiss
      if (miss !== undefined) {
        lines.push('')
        lines.push(
          `  Closest admissible miss at those assumptions: ${miss.operatorBps}bps, ${usd(miss.gateQfPerDay)}/day gate, ` +
            `ratio ${num(miss.feasibilityRatio, 3)}. It needs ${num(miss.flipPointPopulation, 0)} winnable coins and ` +
            `${num(miss.winnablePopulation, 0)} are standing.`,
        )
      }
    }
  }

  const baseline = result.baselineCell
  lines.push(subheading('The configuration on file'))
  if (baseline === undefined) {
    lines.push('  Not evaluated - the baseline fell outside every swept axis.')
  } else {
    lines.push(
      `  ${baseline.operatorBps}bps take, ${usd(baseline.gateQfPerDay)}/day gate, ${pct(baseline.winRate)} win rate, ` +
        `${usd(baseline.fixedCostMonthlyUsd)}/month fixed, ${usd(baseline.cogsPerDayUsd)}/day COGS${baseline.tier ? ` (${baseline.tier})` : ''}.`,
    )
    lines.push(
      `  ${describeRatio(baseline)}   winnable population ${num(baseline.winnablePopulation, 0)} against a flip point of ${num(baseline.flipPointPopulation, 0)}.`,
    )
    lines.push(
      `  ${baseline.clears ? 'CLEARS' : 'DOES NOT CLEAR'}${baseline.admissible ? '' : ' (and is INADMISSIBLE: ' + baseline.inadmissibleReasons.map((r) => REASON_LABEL[r]).join('; ') + ')'}.`,
    )
    lines.push(
      '  This cell should reproduce what reprice.ts returns on the same inputs. If it does not, one of the two is wrong.',
    )
  }

  if (result.distribution !== undefined) {
    lines.push(subheading('Measured QF distribution'))
    lines.push(
      `  ${result.distribution.coins} coins, ${result.distribution.winnableCoins} winnable. ` +
        `Observed ${usd(result.distribution.observedFloorUsd)} .. ${usd(result.distribution.observedCeilingUsd)} QF/day; ` +
        `counts are exact at or above ${usd(result.distribution.supportFloorUsd)}/day.`,
    )
    lines.push(`  Winnable rule: ${result.distribution.winnableRule}.`)
    lines.push('')
    lines.push(
      table(result.populations, [
        { header: 'gate QF/day', value: (p) => usd(p.gateQfPerDay), align: 'right' },
        {
          header: 'coins >= gate',
          value: (p) => (p.belowMeasuredSupport ? 'UNKNOWN' : String(p.total)),
          align: 'right',
        },
        {
          header: 'winnable',
          value: (p) => (p.belowMeasuredSupport ? 'UNKNOWN' : String(p.winnable)),
          align: 'right',
        },
        {
          header: 'winnable share',
          value: (p) => (p.belowMeasuredSupport ? 'UNKNOWN' : pct(p.winnableShare)),
          align: 'right',
        },
      ]),
    )
  } else {
    lines.push(subheading('Measured QF distribution'))
    lines.push('  NOT SUPPLIED. The gate axis is refused: every gate but the baseline reports an UNKNOWN population.')
  }

  lines.push(
    subheading(
      `Feasibility ratio at ${pct(result.params.baseline.winRate)} win rate, ${usd(result.params.baseline.fixedCostMonthlyUsd)}/month fixed`,
    ),
  )
  const gates = [...new Set(result.grid.map((c) => c.gateQfPerDay))].sort((a, b) => a - b)
  const bpsValues = [...new Set(result.grid.map((c) => c.operatorBps))].sort((a, b) => a - b)
  const byKey = new Map(result.grid.map((c) => [`${c.operatorBps}:${c.gateQfPerDay}`, c]))
  lines.push(
    table(bpsValues, [
      { header: 'bps', value: (b) => String(b), align: 'right' },
      ...gates.map((gate) => ({
        header: usd(gate, 0),
        align: 'right' as const,
        value: (b: number) => {
          const cell = byKey.get(`${b}:${gate}`)
          if (cell === undefined) return '-'
          if (cell.winnablePopulation === undefined) return 'UNKNOWN'
          if (cell.contributionPerClientDayUsd <= 0) return 'LOSS'
          if (cell.feasibilityRatio === undefined) return 'n/a'
          const mark = !cell.admissible ? 'x' : cell.clears ? '*' : ' '
          return `${num(cell.feasibilityRatio, 2)}${mark}`
        },
      })),
    ]),
  )
  lines.push('')
  lines.push('  * clears and is admissible.  x inadmissible - the ratio is arithmetic, not an option.')
  lines.push(
    '  LOSS  = the client loses money at that take and gate, so no client count and no ratio exist. Different from UNKNOWN.',
  )
  lines.push('  UNKNOWN = the population at that gate was never measured. It is not zero and it is not small.')

  const reasons = new Map<InadmissibleReason, number>()
  for (const cell of result.cells) {
    for (const reason of cell.inadmissibleReasons) reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
  }
  if (reasons.size > 0) {
    lines.push(subheading('Why cells are inadmissible'))
    lines.push(
      table([...reasons.entries()].sort((a, b) => b[1] - a[1]), [
        { header: 'cells', value: ([, n]) => String(n), align: 'right' },
        { header: 'reason', value: ([reason]) => REASON_LABEL[reason] },
      ]),
    )
    lines.push('')
    lines.push(
      `  The take bound is ${result.params.maxMarketBps}bps, the highest rate Phase 0 measured anyone charging on this platform ` +
        '(venueFlow 0%, Sinjoh 1%, Venue Bot 5%). It is a measurement, not a preference.',
    )
  }

  const clearing = result.cells.filter((c) => c.admissible && c.clears)
  if (clearing.length > 0) {
    lines.push(subheading('The admissible clearing region, cheapest take first'))
    lines.push(
      table(
        [...clearing]
          .sort(
            (a, b) =>
              a.operatorBps - b.operatorBps ||
              a.gateQfPerDay - b.gateQfPerDay ||
              a.winRate - b.winRate ||
              b.fixedCostMonthlyUsd - a.fixedCostMonthlyUsd,
          )
          .slice(0, 30),
        [
          { header: 'bps', value: (c) => String(c.operatorBps), align: 'right' },
          { header: 'gate', value: (c) => usd(c.gateQfPerDay, 0), align: 'right' },
          { header: 'win', value: (c) => pct(c.winRate, 0), align: 'right' },
          { header: 'fixed/mo', value: (c) => usd(c.fixedCostMonthlyUsd, 0), align: 'right' },
          { header: 'cogs/day', value: (c) => usd(c.cogsPerDayUsd, 0), align: 'right' },
          { header: 'winnable', value: (c) => num(c.winnablePopulation, 0), align: 'right' },
          { header: 'flip pt', value: (c) => num(c.flipPointPopulation, 0), align: 'right' },
          { header: 'ratio', value: (c) => num(c.feasibilityRatio, 2), align: 'right' },
          { header: 'min win', value: (c) => pct(c.minWinRateToClear, 1), align: 'right' },
          { header: 'max fixed/mo', value: (c) => usd(c.maxFixedCostToClear, 0), align: 'right' },
          { header: 'flags', value: (c) => (c.flags.length === 0 ? '-' : c.flags.join(',')) },
        ],
      ),
    )
    if (clearing.length > 30) lines.push(`  ... ${clearing.length - 30} more in the JSON.`)
  }

  if (result.summary.noAdmissibleConfigurationClears) {
    lines.push('')
    lines.push(
      banner([
        'REPEATING THE ONLY SENTENCE THAT MATTERS: no admissible configuration clears.',
        'Changing the take, the gate, the win rate and the fixed cost together does not',
        'produce a business inside the bounds this platform was measured to have.',
      ]),
    )
  }
  return lines.join('\n')
}

if (isEntrypoint(import.meta.url)) {
  await runCli(SPEC, process.argv.slice(2), main)
}

export { SPEC as FRONTIER_SPEC, tierForGate }
