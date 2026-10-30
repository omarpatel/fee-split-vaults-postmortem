/**
 * THE PUBLICATION LAG AND THE BALANCE BANDS.
 *
 * A receipts ledger that publishes an unexecuted commitment in real time is a
 * purchase calendar. Anyone reading it learns that this coin is about to buy a
 * Dexscreener slot on Thursday with roughly this much money, which is enough to
 * position ahead of it - so the artifact built to make the client honest ends up
 * handing a trading edge to strangers at the client's expense.
 *
 * Two controls, both implemented HERE in the presentation layer rather than
 * only server-side:
 *
 *   1. LAG. An unexecuted commitment is withheld for 72 hours. Executed
 *      disbursements publish immediately: money that has already left cannot be
 *      front-run, and the whole point of the page is that it appears fast.
 *
 *   2. BANDS. Balances - anything that tells a reader how much dry powder is
 *      left - publish as a range on a fixed ladder, never as an exact figure.
 *
 * WHY BOTH SIDES ENFORCE IT. The server sets `publishAfterUnix`. This module
 * does not trust it: it re-derives the floor from `occurredAtUnix` and takes
 * the LATER of the two. A server bug, a fixture, or a compromised API that
 * hands the browser an early `publishAfterUnix` therefore cannot shorten the
 * lag, because the client already knows what the lag is. Fail closed.
 */

export const PUBLISH_LAG_SECONDS = 72 * 60 * 60

/**
 * Balance observation timestamps are snapped to the hour before display. A band
 * that changed at 14:03:22 tells a watcher when a credit landed even though it
 * does not tell them how much; snapping removes the minute hand from that
 * signal. The residual leak - that a value crossed a known ladder edge at all -
 * is bounded by how coarse the ladder is, which is the point of the ladder.
 */
export const BALANCE_OBSERVATION_QUANTUM_SECONDS = 60 * 60

export interface LaggableItem {
  occurredAtUnix: number
  /** Server-declared reveal time. Advisory: only ever able to DELAY, not hasten. */
  publishAfterUnix: number
  /**
   * True once the money has actually moved and there is a disbursement to point
   * at. Unexecuted commitments are the front-runnable ones.
   */
  executed: boolean
}

export type LagVisibility =
  | { visible: true; reason: 'executed' | 'lag_elapsed' }
  | { visible: false; reason: 'lag_pending'; revealsAtUnix: number; secondsRemaining: number }

/**
 * The effective reveal time for an unexecuted commitment: the later of the
 * client-derived floor and whatever the server asked for. Exported because the
 * "publishes in N hours" copy on the page must quote the same number the
 * filter uses.
 */
export function effectiveRevealUnix(item: LaggableItem): number {
  const clientFloor = item.occurredAtUnix + PUBLISH_LAG_SECONDS
  return Math.max(clientFloor, item.publishAfterUnix)
}

export function lagVisibility(item: LaggableItem, nowUnix: number): LagVisibility {
  if (item.executed) return { visible: true, reason: 'executed' }

  const revealsAtUnix = effectiveRevealUnix(item)
  if (nowUnix >= revealsAtUnix) return { visible: true, reason: 'lag_elapsed' }

  return {
    visible: false,
    reason: 'lag_pending',
    revealsAtUnix,
    secondsRemaining: revealsAtUnix - nowUnix,
  }
}

export interface LagPartition<T> {
  /** Safe to render in full. */
  published: T[]
  /**
   * Withheld. The page still says HOW MANY are withheld and when the next one
   * reveals, because "3 commitments publish in the next 72 hours" is honest and
   * carries no timing edge, whereas silence looks like an omission.
   */
  withheldCount: number
  nextRevealUnix: number | null
}

/** Split a list into what may be shown now and a count of what may not. */
export function partitionByLag<T extends LaggableItem>(
  items: readonly T[],
  nowUnix: number,
): LagPartition<T> {
  const published: T[] = []
  let withheldCount = 0
  let nextRevealUnix: number | null = null

  for (const item of items) {
    const verdict = lagVisibility(item, nowUnix)
    if (verdict.visible) {
      published.push(item)
      continue
    }
    withheldCount += 1
    if (nextRevealUnix === null || verdict.revealsAtUnix < nextRevealUnix) {
      nextRevealUnix = verdict.revealsAtUnix
    }
  }

  return { published, withheldCount, nextRevealUnix }
}

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

/**
 * Ladder edges in USD CENTS, 1-2-5 per decade. Half-open intervals [lower,
 * upper). Integers throughout: a band derived from a float would defeat the
 * purpose by leaking precision through its own rounding.
 */
export const BAND_EDGES_CENTS: readonly bigint[] = [
  0n,
  10_000n, // $100
  25_000n, // $250
  50_000n, // $500
  100_000n, // $1,000
  250_000n, // $2,500
  500_000n, // $5,000
  1_000_000n, // $10,000
  2_500_000n, // $25,000
  5_000_000n, // $50,000
  10_000_000n, // $100,000
  25_000_000n, // $250,000
  50_000_000n, // $500,000
  100_000_000n, // $1,000,000
]

export interface Band {
  /** Index into the ladder. Monotone in the underlying value. */
  index: number
  lowerCents: bigint
  /** null means "and up" - the top of the ladder is open. */
  upperCents: bigint | null
  /** True only for an exact zero, which is not sensitive and is worth stating. */
  isZero: boolean
  label: string
}

export class BandError extends Error {
  constructor(message: string) {
    super(`band: ${message}`)
    this.name = 'BandError'
  }
}

function usdLabel(cents: bigint): string {
  const dollars = cents / 100n
  if (dollars >= 1_000_000n) return `$${dollars / 1_000_000n}M`
  if (dollars >= 1_000n) {
    const thousands = (dollars * 10n) / 1_000n
    const whole = thousands / 10n
    const tenth = thousands % 10n
    return tenth === 0n ? `$${whole}k` : `$${whole}.${tenth}k`
  }
  return `$${dollars}`
}

/**
 * Snap a balance to its band.
 *
 * Zero is reported exactly, on purpose: "this budget is empty" is information
 * the dev and the public are entitled to, and it gives away no future purchase.
 * Every non-zero value lands in a range whose width grows with the value, so
 * the relative precision leaked is roughly constant.
 */
export function bandFor(cents: bigint): Band {
  if (cents < 0n) throw new BandError('cannot band a negative balance')
  if (cents === 0n) {
    return { index: -1, lowerCents: 0n, upperCents: 0n, isZero: true, label: 'none' }
  }

  let index = 0
  for (let i = 0; i < BAND_EDGES_CENTS.length; i++) {
    const edge = BAND_EDGES_CENTS[i]
    if (edge === undefined) break
    if (cents >= edge) index = i
    else break
  }

  const lowerCents = BAND_EDGES_CENTS[index] ?? 0n
  const upperCents = BAND_EDGES_CENTS[index + 1] ?? null

  const label =
    upperCents === null
      ? `${usdLabel(lowerCents)}+`
      : lowerCents === 0n
        ? `under ${usdLabel(upperCents)}`
        : `${usdLabel(lowerCents)} – ${usdLabel(upperCents)}`

  return { index, lowerCents, upperCents, isZero: false, label }
}

/** Snap an observation timestamp down to the hour. See the quantum note above. */
export function quantizeObservationUnix(unix: number): number {
  return Math.floor(unix / BALANCE_OBSERVATION_QUANTUM_SECONDS) * BALANCE_OBSERVATION_QUANTUM_SECONDS
}

/**
 * A balance as the public page is allowed to see it.
 *
 * Note the shape: there is no exact-cents field on this object at all. That is
 * the enforcement. A component cannot accidentally render the precise figure
 * because it was never handed one, and a reviewer can confirm that by reading
 * the type rather than by auditing every call site.
 */
export interface BandedBalance {
  band: Band
  observedAtUnix: number
  label: string
}

export function bandBalance(cents: bigint, observedAtUnix: number): BandedBalance {
  const band = bandFor(cents)
  return {
    band,
    observedAtUnix: quantizeObservationUnix(observedAtUnix),
    label: band.label,
  }
}

/** "in 14 hours" / "in 2 days". Coarse on purpose; the lag is not a countdown. */
export function formatRevealDelay(secondsRemaining: number): string {
  if (secondsRemaining <= 0) return 'now'
  const hours = Math.ceil(secondsRemaining / 3_600)
  if (hours < 24) return `in ${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.ceil(hours / 24)
  return `in ${days} day${days === 1 ? '' : 's'}`
}
