/**
 * Integer money for the spend gate.
 *
 * Every comparison the broker makes happens in BIGINT USD CENTS. The domain
 * types carry `number` for USD because USD figures are derived at a pinned price
 * and reported to humans; the moment such a figure enters a decision it is
 * converted here, once, with its provenance checked.
 *
 * Rounding is directional and deliberate:
 *   - amounts AVAILABLE to spend round DOWN  (understate what we may spend)
 *   - amounts ALREADY SPENT or OBLIGATED round UP (overstate what we owe)
 *   - a catalog LIST PRICE must be exactly representable in cents or it is
 *     refused, because a price that cannot be stated in cents cannot be
 *     reconciled against a vendor rate card at zero markup.
 */
import type { UsdValue } from '@fee-split-vaults/core'
import { BrokerError } from './errors.js'

export const CENTS_PER_USD = 100

/** A USD price used in a live money decision may not be older than this. */
export const PRICE_MAX_AGE_SECONDS = 15 * 60

/**
 * Tolerance for accepting a clock that runs slightly ahead of ours.
 *
 * EVERY future-timestamp check in this package reads this constant. A price, a
 * counter, a KYB record, a sanctions screen, a human approval and a policy token
 * are all refused when they are dated further ahead than this, and they are all
 * refused at the SAME distance on purpose: restating the number at one site
 * means that tightening the tolerance here silently leaves that site loose, and
 * the loose site is then the one an attacker with a fast clock uses.
 */
export const CLOCK_SKEW_TOLERANCE_SECONDS = 60

/** Guards against a nonsense figure being converted into a 10^18 cent bigint. */
const MAX_USD = 1e12

function assertUsdNumber(usd: number, field: string): void {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) {
    throw new BrokerError('money', 'invalid_usd', `${field} is not a finite number`)
  }
  if (usd < 0) {
    throw new BrokerError('money', 'negative_usd', `${field} is negative (${usd})`)
  }
  if (usd > MAX_USD) {
    throw new BrokerError('money', 'usd_out_of_range', `${field} exceeds the sanity ceiling`)
  }
}

/**
 * A catalog price. Must land exactly on a cent; sub-cent precision is refused
 * because it cannot be reconciled against an archived vendor rate card.
 */
export function exactCentsFromUsd(usd: number, field: string, gate = 'money'): bigint {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0 || usd > MAX_USD) {
    throw new BrokerError(gate, 'invalid_usd', `${field} is not a valid non-negative USD amount`)
  }
  const scaled = usd * CENTS_PER_USD
  const rounded = Math.round(scaled)
  if (Math.abs(scaled - rounded) > 1e-6) {
    throw new BrokerError(
      gate,
      'sub_cent_precision',
      `${field} (${usd}) is not an exact number of cents`,
    )
  }
  return BigInt(rounded)
}

/** A balance we may draw against. Rounds down. */
export function floorCentsFromUsd(usd: number, field: string): bigint {
  assertUsdNumber(usd, field)
  return BigInt(Math.floor(usd * CENTS_PER_USD))
}

/** An amount already spent or owed. Rounds up. */
export function ceilCentsFromUsd(usd: number, field: string): bigint {
  assertUsdNumber(usd, field)
  return BigInt(Math.ceil(usd * CENTS_PER_USD))
}

/** For reporting only. Never feed the result back into a comparison. */
export function usdFromCents(cents: bigint): number {
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BrokerError('money', 'cents_out_of_range', 'cent amount exceeds safe integer range')
  }
  return Number(cents) / CENTS_PER_USD
}

/**
 * Protocol fractions (0.6, 0.5, 0.25) become integer basis points so that no
 * cap is ever computed in floating point. A fraction that is not exactly
 * representable in bps is refused rather than silently rounded.
 */
export function fractionToBps(fraction: number, field: string): number {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0) {
    throw new BrokerError('money', 'invalid_fraction', `${field} is not a valid fraction`)
  }
  const scaled = fraction * 10_000
  const rounded = Math.round(scaled)
  if (Math.abs(scaled - rounded) > 1e-9) {
    throw new BrokerError(
      'money',
      'fraction_not_bps',
      `${field} (${fraction}) is not expressible in basis points`,
    )
  }
  return rounded
}

/** Floor((amount * bps) / 10_000). Integer throughout. */
export function applyBps(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new BrokerError('money', 'invalid_bps', `bps must be a non-negative integer (${bps})`)
  }
  return (amount * BigInt(bps)) / 10_000n
}

export function sumCents(values: Iterable<bigint>): bigint {
  let total = 0n
  for (const v of values) total += v
  return total
}

export function maxCents(a: bigint, b: bigint): bigint {
  return a > b ? a : b
}

/**
 * MEDIAN, not mean. A mean is farmable: one day of wash volume lifts it and
 * therefore lifts the rolling cap. A median needs the attacker to sustain the
 * fake accrual for half the window, at which point they have paid real fees.
 *
 * Even-length windows take the floor of the average of the two middle values,
 * which biases the cap downward. That direction is deliberate.
 */
export function medianCents(values: readonly bigint[]): bigint {
  if (values.length === 0) {
    throw new BrokerError('money', 'empty_median', 'median of an empty series is undefined')
  }
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) {
    const only = sorted[mid]
    if (only === undefined) {
      throw new BrokerError('money', 'median_index', 'median index out of range')
    }
    return only
  }
  const lo = sorted[mid - 1]
  const hi = sorted[mid]
  if (lo === undefined || hi === undefined) {
    throw new BrokerError('money', 'median_index', 'median index out of range')
  }
  const sum = lo + hi
  // Floor division that also floors for negatives, which cannot occur here but
  // would otherwise round toward zero and overstate the cap.
  return sum >= 0n ? sum / 2n : (sum - 1n) / 2n
}

export interface PinnedCentsOptions {
  /** 'floor' for balances we may draw against, 'ceil' for amounts we owe. */
  mode: 'floor' | 'ceil'
  /**
   * Omit for historical records, which were priced when they happened and are
   * legitimately old. Supply for any figure describing the present.
   */
  maxAgeSeconds?: number
}

/**
 * Convert a provenance-carrying USD figure into cents, refusing anything whose
 * price source is missing, whose timestamp is in the future, or which is stale
 * for the use it is being put to. Missing price means no spend.
 */
export function pinnedCents(
  value: UsdValue | undefined,
  nowUnix: number,
  field: string,
  options: PinnedCentsOptions,
): bigint {
  if (value === undefined || value === null || typeof value !== 'object') {
    throw new BrokerError('money', 'missing_price', `${field} has no pinned USD value`)
  }
  if (typeof value.priceSource !== 'string' || value.priceSource.length === 0) {
    throw new BrokerError('money', 'missing_price_source', `${field} has no price source`)
  }
  if (!Number.isFinite(value.pricedAtUnix) || value.pricedAtUnix <= 0) {
    throw new BrokerError('money', 'missing_price_time', `${field} has no pricing timestamp`)
  }
  if (value.pricedAtUnix > nowUnix + CLOCK_SKEW_TOLERANCE_SECONDS) {
    throw new BrokerError('money', 'price_in_future', `${field} is priced in the future`)
  }
  if (
    options.maxAgeSeconds !== undefined &&
    value.pricedAtUnix < nowUnix - options.maxAgeSeconds
  ) {
    throw new BrokerError(
      'money',
      'stale_price',
      `${field} was priced ${nowUnix - value.pricedAtUnix}s ago, limit ${options.maxAgeSeconds}s`,
    )
  }
  return options.mode === 'floor'
    ? floorCentsFromUsd(value.usd, field)
    : ceilCentsFromUsd(value.usd, field)
}
