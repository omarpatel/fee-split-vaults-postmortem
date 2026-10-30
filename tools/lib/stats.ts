/**
 * Distributions, survival analysis and Little's Law.
 *
 * The whole point of the tenure work is that a naive mean tenure computed over
 * a 33-day observation window is WRONG IN A KNOWN DIRECTION: every spell that
 * is still running when the window ends is truncated, so a plain average
 * understates tenure, while restricting to completed spells oversamples short
 * ones and understates it again. Kaplan-Meier is the standard fix and it is
 * implemented here rather than approximated.
 */

export interface Quantiles {
  count: number
  min: number
  p10: number
  p25: number
  median: number
  p75: number
  p90: number
  p99: number
  max: number
  mean: number
  sum: number
}

export function quantiles(rawValues: readonly number[]): Quantiles {
  const values = [...rawValues].sort((a, b) => a - b)
  const n = values.length
  if (n === 0) {
    return {
      count: 0,
      min: 0,
      p10: 0,
      p25: 0,
      median: 0,
      p75: 0,
      p90: 0,
      p99: 0,
      max: 0,
      mean: 0,
      sum: 0,
    }
  }
  const sum = values.reduce((a, b) => a + b, 0)
  return {
    count: n,
    min: values[0]!,
    p10: percentile(values, 0.1),
    p25: percentile(values, 0.25),
    median: percentile(values, 0.5),
    p75: percentile(values, 0.75),
    p90: percentile(values, 0.9),
    p99: percentile(values, 0.99),
    max: values[n - 1]!,
    mean: sum / n,
    sum,
  }
}

/** Linear-interpolated percentile over a PRE-SORTED ascending array. */
export function percentile(sorted: readonly number[], q: number): number {
  const n = sorted.length
  if (n === 0) return 0
  if (n === 1) return sorted[0]!
  const position = (n - 1) * Math.min(1, Math.max(0, q))
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]!
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
}

export function median(values: readonly number[]): number {
  return percentile([...values].sort((a, b) => a - b), 0.5)
}

/**
 * Trailing-window median of daily values, the QF definition from protocol.ts.
 * A median, not a mean: a mean is farmable with a single day of wash volume.
 */
export function trailingMedian(dailyValues: readonly number[], window: number): number {
  if (dailyValues.length === 0) return 0
  const slice = dailyValues.slice(Math.max(0, dailyValues.length - window))
  return median(slice)
}

export interface HistogramBin {
  lower: number
  upper: number
  count: number
  share: number
}

export function histogram(values: readonly number[], edges: readonly number[]): HistogramBin[] {
  const bins: HistogramBin[] = []
  for (let i = 0; i < edges.length - 1; i++) {
    bins.push({ lower: edges[i]!, upper: edges[i + 1]!, count: 0, share: 0 })
  }
  if (bins.length === 0) return bins
  for (const value of values) {
    for (let i = 0; i < bins.length; i++) {
      const bin = bins[i]!
      const last = i === bins.length - 1
      if (value >= bin.lower && (value < bin.upper || (last && value <= bin.upper))) {
        bin.count++
        break
      }
    }
  }
  const total = values.length || 1
  for (const bin of bins) bin.share = bin.count / total
  return bins
}

/** Exact-value tally, for discrete distributions like an implied bps. */
export function valueCounts(values: readonly (string | number)[]): Array<{
  value: string | number
  count: number
  share: number
}> {
  const counts = new Map<string | number, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  const total = values.length || 1
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count, share: count / total }))
    .sort((a, b) => b.count - a.count)
}

// ---------------------------------------------------------------------------
// Survival analysis
// ---------------------------------------------------------------------------

/**
 * One continuous run above a threshold.
 *
 * `rightCensored` means the run was still going when observation stopped, so
 * its true length is AT LEAST `days`. `leftCensored` means it was already going
 * when observation started, so its true length is also at least `days` and its
 * start time is unknown - which is why left-censored spells are excluded from
 * the arrival rate used in Little's Law.
 */
export interface Spell {
  subject: string
  startDayUnix: number
  endDayUnix: number
  days: number
  leftCensored: boolean
  rightCensored: boolean
}

/**
 * Extract maximal runs of consecutive days at or above `threshold`.
 *
 * `allowGapDays` tolerates short dropouts (a coin that misses the gate for a
 * single day and comes back is one client, not two), and defaults to 0 so the
 * strict reading is the one you get unless you ask otherwise.
 */
export function extractSpells(
  subject: string,
  series: ReadonlyArray<{ dayUnix: number; value: number }>,
  threshold: number,
  options: { allowGapDays?: number; windowStartDayUnix: number; windowEndDayUnix: number },
): Spell[] {
  const allowGap = options.allowGapDays ?? 0
  const above = series
    .filter((point) => point.value >= threshold)
    .sort((a, b) => a.dayUnix - b.dayUnix)
  const spells: Spell[] = []
  if (above.length === 0) return spells

  const DAY = 86_400
  let start = above[0]!.dayUnix
  let previous = start
  for (let i = 1; i < above.length; i++) {
    const current = above[i]!.dayUnix
    const gapDays = (current - previous) / DAY - 1
    if (gapDays > allowGap) {
      spells.push(makeSpell(subject, start, previous, options))
      start = current
    }
    previous = current
  }
  spells.push(makeSpell(subject, start, previous, options))
  return spells
}

function makeSpell(
  subject: string,
  startDayUnix: number,
  endDayUnix: number,
  options: { windowStartDayUnix: number; windowEndDayUnix: number },
): Spell {
  const DAY = 86_400
  return {
    subject,
    startDayUnix,
    endDayUnix,
    days: (endDayUnix - startDayUnix) / DAY + 1,
    leftCensored: startDayUnix <= options.windowStartDayUnix,
    rightCensored: endDayUnix >= options.windowEndDayUnix,
  }
}

export interface SurvivalPoint {
  /** Tenure in days. */
  day: number
  /** Number still "at risk" of ending at this duration. */
  atRisk: number
  /** Spells observed to end exactly at this duration. */
  ended: number
  /** Spells censored at this duration (still running when observation stopped). */
  censored: number
  /** Kaplan-Meier survival probability S(t): P(tenure >= day + 1 | reached day). */
  survival: number
}

export interface SurvivalCurve {
  points: SurvivalPoint[]
  /** Kaplan-Meier median. undefined when S(t) never reaches 0.5 inside the window. */
  medianDays: number | undefined
  /**
   * Restricted mean survival time: the area under S(t) out to the longest
   * observed duration. It is a LOWER BOUND on true mean tenure, and with a
   * 33-day window it is a badly truncated one. Reported as such.
   */
  restrictedMeanDays: number
  restrictedToDays: number
  /** Naive mean over all spells, censored ones counted at their observed length. */
  naiveMeanDays: number
  /** Mean over completed spells only. Biased short by construction. */
  completedMeanDays: number
  totalSpells: number
  censoredSpells: number
  completedSpells: number
}

/**
 * Kaplan-Meier estimator over integer-day spells.
 *
 * A spell of length d that ENDED contributes an event at duration d.
 * A spell of length d that was still running contributes a censoring at d.
 * Left-censored spells are included here (their length is a lower bound too)
 * but they are flagged separately for the caller's warning block.
 */
export function survivalCurve(spells: readonly Spell[]): SurvivalCurve {
  const durations = [...new Set(spells.map((s) => s.days))].sort((a, b) => a - b)
  const points: SurvivalPoint[] = []
  let survival = 1
  let medianDays: number | undefined
  let restrictedMean = 0
  let previousDuration = 0
  let previousSurvival = 1

  for (const day of durations) {
    const atRisk = spells.filter((s) => s.days >= day).length
    // "Ended at d" = the spell's last observed day was d and it was not censored.
    const ended = spells.filter((s) => s.days === day && !s.rightCensored).length
    const censored = spells.filter((s) => s.days === day && s.rightCensored).length

    // Area under the step function since the previous event time.
    restrictedMean += previousSurvival * (day - previousDuration)
    previousDuration = day

    if (atRisk > 0 && ended > 0) survival *= 1 - ended / atRisk
    previousSurvival = survival

    points.push({ day, atRisk, ended, censored, survival })
    if (medianDays === undefined && survival <= 0.5) medianDays = day
  }

  const completed = spells.filter((s) => !s.rightCensored)
  const censoredCount = spells.length - completed.length
  return {
    points,
    medianDays,
    restrictedMeanDays: restrictedMean,
    restrictedToDays: previousDuration,
    naiveMeanDays: spells.length === 0 ? 0 : spells.reduce((a, s) => a + s.days, 0) / spells.length,
    completedMeanDays:
      completed.length === 0 ? 0 : completed.reduce((a, s) => a + s.days, 0) / completed.length,
    totalSpells: spells.length,
    censoredSpells: censoredCount,
    completedSpells: completed.length,
  }
}

// ---------------------------------------------------------------------------
// Little's Law
// ---------------------------------------------------------------------------

export interface LittlesLawCheck {
  /** L: mean number of subjects above the gate on a given day. */
  meanStandingStock: number
  /** lambda: arrivals (uncensored spell starts) per day. */
  arrivalsPerDay: number
  /** W implied by L = lambda * W. */
  impliedMeanTenureDays: number | undefined
  /** W measured directly from the spells (naive, censored-truncated). */
  measuredNaiveMeanTenureDays: number
  /** W from Kaplan-Meier restricted mean. A lower bound. */
  measuredRestrictedMeanTenureDays: number
  /**
   * Directly measured mean age of the subjects standing above the gate on the
   * final observed day. Phase 0 measured 2.14 days for this quantity; if this
   * disagrees with impliedMeanTenureDays the population is not in steady state
   * and NO tenure figure here should be extrapolated.
   */
  meanAgeOfStandingStockDays: number
  /** impliedMeanTenureDays / measuredRestrictedMeanTenureDays. ~1 means consistent. */
  consistencyRatio: number | undefined
  notes: string[]
}

export function littlesLawCheck(
  spells: readonly Spell[],
  options: {
    windowStartDayUnix: number
    windowEndDayUnix: number
    curve: SurvivalCurve
  },
): LittlesLawCheck {
  const DAY = 86_400
  const windowDays = (options.windowEndDayUnix - options.windowStartDayUnix) / DAY + 1
  const notes: string[] = []

  // L: average over the window of how many spells cover each day.
  let occupancy = 0
  for (let day = options.windowStartDayUnix; day <= options.windowEndDayUnix; day += DAY) {
    occupancy += spells.filter((s) => s.startDayUnix <= day && s.endDayUnix >= day).length
  }
  const meanStandingStock = windowDays > 0 ? occupancy / windowDays : 0

  // lambda: only spells whose START we actually observed are arrivals.
  const arrivals = spells.filter((s) => !s.leftCensored)
  const arrivalsPerDay = windowDays > 0 ? arrivals.length / windowDays : 0
  if (arrivals.length < 10) {
    notes.push(
      `only ${arrivals.length} uncensored arrivals observed; the arrival rate is too thin for Little's Law to bind`,
    )
  }

  const impliedMeanTenureDays =
    arrivalsPerDay > 0 ? meanStandingStock / arrivalsPerDay : undefined

  // Mean age of the stock standing on the final day.
  const standing = spells.filter(
    (s) => s.startDayUnix <= options.windowEndDayUnix && s.endDayUnix >= options.windowEndDayUnix,
  )
  const meanAgeOfStandingStockDays =
    standing.length === 0
      ? 0
      : standing.reduce((a, s) => a + (options.windowEndDayUnix - s.startDayUnix) / DAY + 1, 0) /
        standing.length

  const standingLeftCensored = standing.filter((s) => s.leftCensored).length
  if (standingLeftCensored > 0) {
    notes.push(
      `${standingLeftCensored} of ${standing.length} subjects standing above the gate were already above it when the window opened, so their measured age is a LOWER BOUND and the mean age above is understated.`,
    )
  }

  const consistencyRatio =
    impliedMeanTenureDays !== undefined && options.curve.restrictedMeanDays > 0
      ? impliedMeanTenureDays / options.curve.restrictedMeanDays
      : undefined

  if (consistencyRatio !== undefined && (consistencyRatio < 0.5 || consistencyRatio > 2)) {
    notes.push(
      `Little's Law implies ${impliedMeanTenureDays!.toFixed(2)}d but the survival curve gives ` +
        `${options.curve.restrictedMeanDays.toFixed(2)}d (ratio ${consistencyRatio.toFixed(2)}). ` +
        `The population is not in steady state - it is growing or collapsing - so neither figure may be extrapolated.`,
    )
  }
  return {
    meanStandingStock,
    arrivalsPerDay,
    impliedMeanTenureDays,
    measuredNaiveMeanTenureDays: options.curve.naiveMeanDays,
    measuredRestrictedMeanTenureDays: options.curve.restrictedMeanDays,
    meanAgeOfStandingStockDays,
    consistencyRatio,
    notes,
  }
}
