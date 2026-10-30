/**
 * tenure - how long does a coin stay above a QF gate?
 *
 * This is the number the whole plan was built on and never measured. Phase 0
 * assumed 8 weeks. The standing stock above the gate has a MEAN AGE of 2.14
 * days, and the most survivor-biased cohort available gives 12.9 days. If the
 * real figure is near the low end, every acquisition and break-even number in
 * the plan is wrong by more than an order of magnitude.
 *
 * METHOD. For each gate, a coin's daily QF series is cut into SPELLS: maximal
 * runs of consecutive days at or above the gate. Spells still running at the
 * window edge are right-censored, so the estimator is Kaplan-Meier rather than
 * a plain average - a plain average of a 33-day window would understate tenure
 * in a way that looks precise. Little's Law (L = lambda*W) is then run as an
 * independent cross-check, because it uses only the standing stock and the
 * arrival rate, and it disagrees loudly when the population is not stationary.
 *
 * WHAT CANNOT BE MEASURED. Venue V2 is roughly 33 days old. NOTHING about
 * tenure beyond that horizon is measurable from this chain, at any sample size,
 * by any method. A 60-day retention figure does not exist yet and will not
 * exist until December.
 */

import type { ParsedValues } from './lib/cli.ts'
import { CliError, getBool, getList, getNumber, getString, isEntrypoint, runCli } from './lib/cli.ts'
import { loadConfig } from './lib/env.ts'
import { UNPRICED, banner, heading, num, pct, subheading, table, usd } from './lib/format.ts'
import { parseJson } from './lib/json.ts'
import { emit, emitDryRun, type Report } from './lib/report.ts'
import {
  parseEscrowSeriesDocument,
  usdSeries,
  type EscrowSeriesDocument,
} from './lib/series.ts'
import {
  isFullyPriced,
  pricingCoverage,
  unpricedBannerLines,
  unpricedReasons,
  type PricingCoverage,
} from './lib/unpriced.ts'
import {
  extractSpells,
  littlesLawCheck,
  quantiles,
  survivalCurve,
  trailingMedian,
  type LittlesLawCheck,
  type Quantiles,
  type Spell,
  type SurvivalCurve,
} from './lib/stats.ts'
import { SECONDS_PER_DAY, isoDate } from './lib/time.ts'
import { TIERS, TIER_ORDER, type TierId } from '../config/protocol.ts'
import { readFile } from 'node:fs/promises'

const SCHEMA_VERSION = 'tenure-1'

const SPEC = {
  name: 'tenure',
  summary: 'Survival analysis of time-above-gate, from an escrow-index series.',
  detail: `
    Answers: for each QF gate, how long does a coin stay above it?
    Reports the survival curve, Kaplan-Meier median and restricted mean, and the
    size of the cohort holding the gate for 7+ and 14+ consecutive days.
    Little's Law is run as an independent cross-check on the standing stock.
  `,
  options: [
    {
      name: 'input',
      type: 'string' as const,
      placeholder: '<file>',
      describe: 'escrow-index JSON output. Reads stdin when omitted.',
    },
    {
      name: 'gates',
      type: 'string[]' as const,
      describe:
        'Extra QF/day thresholds to analyse alongside the protocol tiers, e.g. --gates 100,500.',
    },
    {
      name: 'tiers',
      type: 'string[]' as const,
      default: ['T1', 'T2', 'T3'],
      describe: 'Which protocol tiers to analyse.',
    },
    {
      name: 'allow-gap-days',
      type: 'number' as const,
      default: 0,
      describe:
        'Treat a dropout of up to N days as continuing the same spell. 0 is the strict reading.',
    },
    {
      name: 'qf-definition',
      type: 'string' as const,
      default: 'daily',
      placeholder: '<daily|median7>',
      describe:
        'Gate against the raw daily credit ("daily") or against the protocol\'s trailing 7-day MEDIAN ("median7"). The tier grant uses median7.',
    },
    {
      name: 'v2-genesis',
      type: 'string' as const,
      placeholder: '<iso>',
      describe:
        'Override the assumed V2 deployment date used for the measurability ceiling warning.',
    },
    {
      name: 'curve-points',
      type: 'number' as const,
      default: 20,
      describe: 'Survival-curve rows shown in the human report.',
    },
    {
      name: 'allow-missing-prices',
      type: 'boolean' as const,
      describe:
        'Analyse a document whose population is not fully priced. Unpriced recipients are EXCLUDED from every cohort (they are not zeros), the run is marked incomplete and it exits non-zero.',
    },
  ],
  examples: [
    'node tools/escrow-index.ts --days 30 --json | node tools/tenure.ts',
    'node tools/tenure.ts --input artifacts/escrow-30d.json --qf-definition median7',
    'node tools/tenure.ts --input artifacts/escrow-30d.json --gates 100,500,1000 --json --out artifacts/tenure.json',
  ],
}

export interface GateAnalysis {
  id: string
  label: string
  gateQfPerDay: number
  sustainedDaysRequired: number
  cohort: {
    /** Recipients with at least one day at or above the gate. */
    everAbove: number
    /** Recipients whose longest run reached 7 / 14 consecutive days. */
    sustained7: number
    sustained14: number
    /** Recipients above the gate on the final observed day. */
    standingAtWindowEnd: number
    /** Recipients meeting the tier's OWN sustainedDays requirement. */
    meetsTierSustainedDays: number
    /**
     * Recipients skipped because at least one day of their window has no USD
     * value. They are NOT counted as below the gate - nobody knows where they
     * are. Any non-zero value here makes every count above a LOWER BOUND, which
     * is why the renderer refuses to print them as counts.
     */
    excludedUnpriced: number
    /** True when excludedUnpriced is 0: the counts are counts. */
    populationFullyPriced: boolean
  }
  spells: {
    total: number
    completed: number
    rightCensored: number
    leftCensored: number
  }
  survival: {
    medianDays: number | undefined
    restrictedMeanDays: number
    restrictedToDays: number
    naiveMeanDays: number
    completedMeanDays: number
    points: Array<{ day: number; atRisk: number; ended: number; censored: number; survival: number }>
  }
  tenureQuantiles: Quantiles
  littlesLaw: LittlesLawCheck
  /** Mean daily QF of the coins standing above the gate, USD. */
  /**
   * Mean daily QF of the coins standing above the gate, USD. `null` when
   * nothing is standing: the mean of an empty set is undefined, and a 0 here
   * would say the standing stock earns nothing rather than that there is none.
   */
  meanQfOfStandingStockUsd: number | null
}

export interface TenureResult {
  source: {
    escrow: string
    eventSignature: string
    backend: string
    recipients: number
    totalCredits: number
  }
  windowStartDayUnix: number
  windowEndDayUnix: number
  windowDays: number
  qfDefinition: 'daily' | 'median7'
  allowGapDays: number
  /** Days between the assumed V2 genesis and the end of the window. */
  v2AgeDaysAtWindowEnd: number
  /** Hard ceiling on any tenure claim: no spell can be longer than this. */
  measurabilityCeilingDays: number
  /** How much of the source population could be valued in USD at all. */
  pricing: PricingCoverage
  gates: GateAnalysis[]
}

/** Compute the series a gate is tested against, per the chosen QF definition. */
export function gateSeries(
  raw: ReadonlyArray<{ dayUnix: number; value: number }>,
  definition: 'daily' | 'median7',
): Array<{ dayUnix: number; value: number }> {
  if (definition === 'daily') return [...raw]
  // The protocol gates on a trailing 7-day MEDIAN, which is deliberately hard
  // to farm with one day of wash volume - so tenure measured that way is the
  // tenure that actually governs a tier grant.
  return raw.map((point, i) => ({
    dayUnix: point.dayUnix,
    value: trailingMedian(
      raw.slice(0, i + 1).map((p) => p.value),
      7,
    ),
  }))
}

export function analyseGate(
  document: EscrowSeriesDocument,
  options: {
    id: string
    label: string
    gateQfPerDay: number
    sustainedDaysRequired: number
    qfDefinition: 'daily' | 'median7'
    allowGapDays: number
  },
): GateAnalysis {
  const windowStart = document.windowStartDayUnix
  const windowEnd = document.windowEndDayUnix

  const spells: Spell[] = []
  let everAbove = 0
  let sustained7 = 0
  let sustained14 = 0
  let standing = 0
  let meetsTier = 0
  let standingQfTotal = 0
  let excludedUnpriced = 0

  for (const recipient of document.recipients) {
    // An unpriced recipient is EXCLUDED, never zero-filled. Feeding it in as a
    // series of zeros is what turned "we could not price this escrow" into
    // "nobody clears the gate" - the same sentence, and only one of them is
    // about the market.
    if (!isFullyPriced(recipient)) {
      excludedUnpriced++
      continue
    }
    const series = gateSeries(usdSeries(recipient), options.qfDefinition)
    const recipientSpells = extractSpells(recipient.recipient, series, options.gateQfPerDay, {
      allowGapDays: options.allowGapDays,
      windowStartDayUnix: windowStart,
      windowEndDayUnix: windowEnd,
    })
    if (recipientSpells.length === 0) continue

    everAbove++
    spells.push(...recipientSpells)
    const longest = Math.max(...recipientSpells.map((s) => s.days))
    if (longest >= 7) sustained7++
    if (longest >= 14) sustained14++
    if (longest >= options.sustainedDaysRequired) meetsTier++

    const last = series[series.length - 1]
    if (last !== undefined && last.value >= options.gateQfPerDay) {
      standing++
      standingQfTotal += last.value
    }
  }

  const curve = survivalCurve(spells)
  return {
    id: options.id,
    label: options.label,
    gateQfPerDay: options.gateQfPerDay,
    sustainedDaysRequired: options.sustainedDaysRequired,
    cohort: {
      everAbove,
      sustained7,
      sustained14,
      standingAtWindowEnd: standing,
      meetsTierSustainedDays: meetsTier,
      excludedUnpriced,
      populationFullyPriced: excludedUnpriced === 0,
    },
    spells: {
      total: spells.length,
      completed: curve.completedSpells,
      rightCensored: curve.censoredSpells,
      leftCensored: spells.filter((s) => s.leftCensored).length,
    },
    survival: {
      medianDays: curve.medianDays,
      restrictedMeanDays: curve.restrictedMeanDays,
      restrictedToDays: curve.restrictedToDays,
      naiveMeanDays: curve.naiveMeanDays,
      completedMeanDays: curve.completedMeanDays,
      points: curve.points,
    },
    tenureQuantiles: quantiles(spells.map((s) => s.days)),
    littlesLaw: littlesLawCheck(spells, {
      windowStartDayUnix: windowStart,
      windowEndDayUnix: windowEnd,
      curve,
    }),
    meanQfOfStandingStockUsd: standing === 0 ? null : standingQfTotal / standing,
  }
}

async function readInput(path: string | undefined): Promise<unknown> {
  if (path !== undefined && path.length > 0) {
    return parseJson(await readFile(path, 'utf8'))
  }
  if (process.stdin.isTTY) {
    throw new CliError('no --input given and stdin is a terminal. Pipe escrow-index JSON or pass --input.')
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) throw new CliError('stdin was empty. Pipe escrow-index JSON or pass --input.')
  return parseJson(text)
}

async function main(values: ParsedValues): Promise<void> {
  const config = loadConfig()
  const json = getBool(values, 'json')
  const outPath = getString(values, 'out')

  if (getBool(values, 'dry-run')) {
    emitDryRun(
      {
        tool: SPEC.name,
        config: { input: getString(values, 'input') ?? '<stdin>' },
        steps: [
          { description: 'read the escrow-index series document (no network I/O)' },
          { description: 'cut each recipient series into spells above each gate' },
          { description: 'fit a Kaplan-Meier survival curve per gate' },
          { description: "cross-check with Little's Law on the standing stock" },
        ],
        estimatedRequestsTotal: 0,
        notes: [
          'tenure.ts is pure computation over escrow-index output. It never touches the network.',
        ],
      },
      json,
    )
    return
  }

  const document = parseEscrowSeriesDocument(await readInput(getString(values, 'input')))

  // Every gate in this tool is a USD threshold. A population that cannot be
  // valued cannot be gated, and the failure is silent unless it is checked
  // here: extractSpells() over a zero-filled unpriced series returns no spells,
  // which renders as an empty cohort - visually identical to a real market with
  // nobody in it.
  const coverage = pricingCoverage(document)
  const allowMissingPrices = getBool(values, 'allow-missing-prices')
  if (!coverage.complete && !allowMissingPrices) {
    throw new CliError(
      `this series cannot be gated: ${coverage.assetsUnpriced} of ${coverage.assetsSeen} asset(s) ` +
        `have no USD price and ${coverage.recipientsUnpriced} of ${coverage.recipientsTotal} recipients ` +
        `hold at least one unpriced credit. Re-run escrow-index.ts with prices for ` +
        `${coverage.unpricedAssetSample.slice(0, 3).join(', ') || 'those assets'}, or pass ` +
        `--allow-missing-prices to analyse only the priced subset - which exits non-zero and ` +
        `refuses to present its cohorts as a population count.`,
    )
  }

  const qfDefinitionRaw = getString(values, 'qf-definition') ?? 'daily'
  if (qfDefinitionRaw !== 'daily' && qfDefinitionRaw !== 'median7') {
    throw new CliError('--qf-definition must be "daily" or "median7"')
  }
  const qfDefinition: 'daily' | 'median7' = qfDefinitionRaw
  const allowGapDays = Math.max(0, Math.floor(getNumber(values, 'allow-gap-days', 0)))

  const tierIds = getList(values, 'tiers').filter((t): t is TierId =>
    (TIER_ORDER as string[]).includes(t),
  )
  const gates: GateAnalysis[] = []
  for (const tierId of tierIds) {
    const tier = TIERS[tierId]
    gates.push(
      analyseGate(document, {
        id: tierId,
        label: `${tierId} ${tier.name}`,
        gateQfPerDay: tier.gateQfPerDay,
        sustainedDaysRequired: tier.sustainedDays,
        qfDefinition,
        allowGapDays,
      }),
    )
  }
  for (const raw of getList(values, 'gates')) {
    const gate = Number(raw)
    if (!Number.isFinite(gate) || gate < 0) throw new CliError(`--gates value "${raw}" is not a number`)
    gates.push(
      analyseGate(document, {
        id: `custom:${gate}`,
        label: `custom $${gate}/day`,
        gateQfPerDay: gate,
        sustainedDaysRequired: 7,
        qfDefinition,
        allowGapDays,
      }),
    )
  }

  const genesisOverride = getString(values, 'v2-genesis')
  const v2GenesisUnix =
    genesisOverride !== undefined ? Math.floor(Date.parse(genesisOverride) / 1000) : config.v2GenesisUnix
  if (Number.isNaN(v2GenesisUnix)) throw new CliError(`--v2-genesis could not be parsed`)
  const v2AgeDays = Math.max(0, (document.windowEndDayUnix - v2GenesisUnix) / SECONDS_PER_DAY)

  const result: TenureResult = {
    source: {
      escrow: document.escrow,
      eventSignature: document.eventSignature,
      backend: document.backend,
      recipients: document.recipients.length,
      totalCredits: document.totalCredits,
    },
    windowStartDayUnix: document.windowStartDayUnix,
    windowEndDayUnix: document.windowEndDayUnix,
    windowDays: document.windowDays,
    qfDefinition,
    allowGapDays,
    v2AgeDaysAtWindowEnd: v2AgeDays,
    measurabilityCeilingDays: Math.min(document.windowDays, Math.ceil(v2AgeDays)),
    pricing: coverage,
    gates,
  }

  const report: Report<TenureResult> = {
    meta: {
      tool: SPEC.name,
      schemaVersion: SCHEMA_VERSION,
      generatedAtUnix: Math.floor(Date.now() / 1000),
      config: { qfDefinition, allowGapDays, v2GenesisUnix },
      io: { httpRequests: 0, cacheHits: 0, cacheMisses: 0 },
      warnings: buildTenureWarnings(result),
      measurementComplete: coverage.complete,
      ...(coverage.complete
        ? {}
        : {
            incompleteReasons: [
              ...unpricedReasons(coverage),
              `Every cohort size above is over the PRICED SUBSET only: ${coverage.recipientsTotal - coverage.recipientsUnpriced} of ${coverage.recipientsTotal} recipients. It is a lower bound on the cohort, not the cohort.`,
            ],
          }),
      methodLimits: [
        'Spells are cut from a discrete daily series, so tenure resolution is one day. A coin that clears the gate for six hours is not above the gate.',
        'Right-censored spells are handled by Kaplan-Meier. Left-censored spells (already running when the window opened) are counted in the survival fit but EXCLUDED from the arrival rate, since their start time is unknown.',
        'The restricted mean is the area under the survival curve out to the longest OBSERVED spell. It is a lower bound on true mean tenure, and on a window this short it is a weak one.',
        'This measures RECIPIENTS, inherited from escrow-index. A recipient serving two coins is one subject here.',
      ],
    },
    result,
  }

  await emit(report, {
    json,
    outPath,
    human: (r) => renderHuman(r.result, Math.floor(getNumber(values, 'curve-points', 20))),
  })
}

export function buildTenureWarnings(result: TenureResult): string[] {
  const unpricedWarning =
    result.pricing !== undefined && !result.pricing.complete
      ? [
          `THE POPULATION IS NOT FULLY PRICED. ${result.pricing.recipientsUnpriced} of ${result.pricing.recipientsTotal} recipients have at least one day with no USD value and were EXCLUDED from every cohort below. They are not below the gate; nobody knows where they are. Read every cohort size here as a lower bound over the priced subset, and read none of them as a market size.`,
        ]
      : []
  const warnings: string[] = [
    ...unpricedWarning,
    `VENUE V2 IS ONLY ~${result.v2AgeDaysAtWindowEnd.toFixed(0)} DAYS OLD. No tenure beyond ${result.measurabilityCeilingDays} days is measurable from this chain by any method. A 30-day or 60-day retention figure does not exist yet; if a plan needs one, the plan needs to wait, not to extrapolate.`,
    `The observation window is ${result.windowDays} days. Every spell running at either edge is truncated by the window, not by the coin dying.`,
  ]

  for (const gate of result.gates) {
    if (gate.spells.total === 0) continue
    const censoredShare = gate.spells.rightCensored / gate.spells.total
    if (censoredShare > 0.5) {
      warnings.push(
        `${gate.label}: ${pct(censoredShare)} of spells were still running when the window closed. The median tenure is therefore mostly unobserved, and the Kaplan-Meier median ${gate.survival.medianDays === undefined ? 'never reached 0.5 and is undefined' : `of ${gate.survival.medianDays}d rests on few completed spells`}.`,
      )
    }
    if (gate.spells.total < 20) {
      warnings.push(
        `${gate.label}: only ${gate.spells.total} spell(s) observed. That is not a distribution; it is an anecdote. Do not price against it.`,
      )
    }
    warnings.push(...gate.littlesLaw.notes.map((note) => `${gate.label}: ${note}`))
  }
  return warnings
}

export function renderHuman(result: TenureResult, curvePoints: number): string {
  const lines: string[] = []
  const priced = result.pricing === undefined || result.pricing.complete
  if (!priced) lines.push(banner(unpricedBannerLines(result.pricing!)))
  lines.push(
    banner([
      `VENUE V2 IS ~${result.v2AgeDaysAtWindowEnd.toFixed(0)} DAYS OLD.`,
      `NOTHING BEYOND ${result.measurabilityCeilingDays} DAYS OF TENURE IS MEASURABLE.`,
      `Every number below is bounded by that, not by the market.`,
    ]),
  )
  lines.push(heading('Tenure above the QF gates'))
  lines.push(
    `window ${isoDate(result.windowStartDayUnix)} .. ${isoDate(result.windowEndDayUnix)} (${result.windowDays}d)  ` +
      `qf-definition=${result.qfDefinition}  allow-gap=${result.allowGapDays}d`,
  )
  lines.push(
    `source: ${result.source.recipients} recipients, ${result.source.totalCredits} credits, event ${result.source.eventSignature}`,
  )

  lines.push(subheading('Cohort sizes'))
  // A cohort size taken over a population that is missing prices is not a
  // cohort size. It is refused rather than printed as a smaller number, because
  // a smaller number in a column headed "ever above" is read as a measurement.
  const count = (g: GateAnalysis, value: number, suffix = ''): string =>
    g.cohort.populationFullyPriced ? `${value}${suffix}` : UNPRICED
  lines.push(
    table(result.gates, [
      { header: 'gate', value: (g) => g.label },
      { header: '$/day', value: (g) => String(g.gateQfPerDay), align: 'right' },
      { header: 'ever above', value: (g) => count(g, g.cohort.everAbove), align: 'right' },
      { header: '>=7d run', value: (g) => count(g, g.cohort.sustained7), align: 'right' },
      { header: '>=14d run', value: (g) => count(g, g.cohort.sustained14), align: 'right' },
      {
        header: `tier grant (>=${''}sustainedDays)`,
        value: (g) => count(g, g.cohort.meetsTierSustainedDays, ` (${g.sustainedDaysRequired}d)`),
        align: 'right',
      },
      {
        header: 'standing at end',
        value: (g) => count(g, g.cohort.standingAtWindowEnd),
        align: 'right',
      },
      {
        header: 'mean QF standing',
        // Three states, three renderings: a figure, "n/a" for an empty standing
        // stock, and UNPRICED when the population could not be valued at all.
        value: (g) =>
          !g.cohort.populationFullyPriced
            ? UNPRICED
            : g.meanQfOfStandingStockUsd === null
              ? 'n/a'
              : usd(g.meanQfOfStandingStockUsd),
        align: 'right',
      },
    ]),
  )
  if (!priced) {
    const excluded = result.gates[0]?.cohort.excludedUnpriced ?? 0
    lines.push(
      `  REFUSED. ${excluded} of ${result.source.recipients} recipients could not be valued in USD and were excluded,`,
    )
    lines.push(
      '  so no number in this table would be a cohort size - each would be a lower bound wearing a count\'s clothes.',
    )
    lines.push(
      '  The priced-subset figures are in the JSON under result.gates[].cohort, beside populationFullyPriced=false.',
    )
  }
  lines.push('  ">=7d run" and ">=14d run" ARE the durable-cohort sizes the plan needs.')

  lines.push(subheading('Tenure estimates, days'))
  // Every column here is a mean, a median or an extreme OF THE SPELLS. With no
  // spells there is nothing to average, and survivalCurve() returning 0 for an
  // empty set is an implementation detail, not a measured tenure of zero days -
  // which matters because the closing line of this report tells the reader to
  // paste "KM restricted mean" straight into reprice.ts --tenure-days.
  const stat = (g: GateAnalysis, value: number, digits: number): string => {
    if (!g.cohort.populationFullyPriced) return UNPRICED
    if (g.spells.total === 0) return 'n/a'
    return num(value, digits)
  }
  /** For quantities that ARE legitimately zero over a priced empty population. */
  const stat0 = (g: GateAnalysis, value: number, digits: number): string =>
    g.cohort.populationFullyPriced ? num(value, digits) : UNPRICED
  lines.push(
    table(result.gates, [
      { header: 'gate', value: (g) => g.label },
      {
        header: 'spells',
        value: (g) => (g.cohort.populationFullyPriced ? String(g.spells.total) : UNPRICED),
        align: 'right',
      },
      {
        header: 'censored',
        value: (g) =>
          !g.cohort.populationFullyPriced
            ? UNPRICED
            : g.spells.total === 0
              ? 'n/a'
              : `${g.spells.rightCensored} (${pct(g.spells.rightCensored / g.spells.total, 0)})`,
        align: 'right',
      },
      {
        header: 'KM median',
        value: (g) =>
          !g.cohort.populationFullyPriced
            ? UNPRICED
            : g.spells.total === 0
              ? 'n/a'
              : g.survival.medianDays === undefined
                ? '>window'
                : num(g.survival.medianDays, 1),
        align: 'right',
      },
      { header: 'KM restricted mean', value: (g) => stat(g, g.survival.restrictedMeanDays, 2), align: 'right' },
      { header: 'naive mean', value: (g) => stat(g, g.survival.naiveMeanDays, 2), align: 'right' },
      { header: 'completed-only mean', value: (g) => stat(g, g.survival.completedMeanDays, 2), align: 'right' },
      { header: 'p90', value: (g) => stat(g, g.tenureQuantiles.p90, 1), align: 'right' },
      { header: 'max', value: (g) => stat(g, g.tenureQuantiles.max, 0), align: 'right' },
    ]),
  )
  lines.push('  "n/a" is an empty spell set: nothing was observed above the gate, so there is no tenure to average.')
  lines.push('  "KM median >window" means survival never fell to 0.5 inside the window: the median is longer than we can see.')
  lines.push('  "naive mean" counts a censored spell at its truncated length, so it UNDERSTATES. "completed-only" oversamples short spells, so it understates too.')

  lines.push(subheading("Little's Law cross-check (L = lambda * W)"))
  lines.push(
    table(result.gates, [
      { header: 'gate', value: (g) => g.label },
      // L and lambda ARE zero for a priced population with nobody above the
      // gate - that is a measurement. The tenure columns beside them are not:
      // they are averages over an empty set.
      { header: 'L standing stock', value: (g) => stat0(g, g.littlesLaw.meanStandingStock, 2), align: 'right' },
      { header: 'lambda arrivals/day', value: (g) => stat0(g, g.littlesLaw.arrivalsPerDay, 3), align: 'right' },
      {
        header: 'W implied',
        value: (g) => stat(g, g.littlesLaw.impliedMeanTenureDays ?? Number.NaN, 2),
        align: 'right',
      },
      { header: 'W from curve', value: (g) => stat(g, g.littlesLaw.measuredRestrictedMeanTenureDays, 2), align: 'right' },
      {
        header: 'ratio',
        value: (g) => stat(g, g.littlesLaw.consistencyRatio ?? Number.NaN, 2),
        align: 'right',
      },
      { header: 'mean age of stock', value: (g) => stat(g, g.littlesLaw.meanAgeOfStandingStockDays, 2), align: 'right' },
    ]),
  )
  lines.push('  A ratio near 1.0 means the two independent estimates agree. Far from 1.0 means the population is growing or collapsing,')
  lines.push('  and a steady-state tenure figure does not describe it. Compare "mean age of stock" against the Phase 0 figure of 2.14 days.')

  for (const gate of result.gates) {
    if (gate.survival.points.length === 0) continue
    lines.push(subheading(`Survival curve: ${gate.label} ($${gate.gateQfPerDay}/day)`))
    lines.push(
      table(gate.survival.points.slice(0, curvePoints), [
        { header: 'tenure d', value: (p) => String(p.day), align: 'right' },
        { header: 'at risk', value: (p) => String(p.atRisk), align: 'right' },
        { header: 'ended', value: (p) => String(p.ended), align: 'right' },
        { header: 'censored', value: (p) => String(p.censored), align: 'right' },
        { header: 'S(t)', value: (p) => pct(p.survival, 1), align: 'right' },
        {
          header: '',
          value: (p) => '#'.repeat(Math.round(p.survival * 30)),
        },
      ]),
    )
    if (gate.survival.points.length > curvePoints) {
      lines.push(`  (${gate.survival.points.length - curvePoints} further points; use --json for all)`)
    }
  }

  lines.push('')
  lines.push('  Next: node tools/reprice.ts --tenure-days <KM restricted mean> --buyback-on-rate <from pool-fees-index>')
  return lines.join('\n')
}

if (isEntrypoint(import.meta.url)) {
  await runCli(SPEC, process.argv.slice(2), main)
}

export { SPEC as TENURE_SPEC }
export type { SurvivalCurve }
