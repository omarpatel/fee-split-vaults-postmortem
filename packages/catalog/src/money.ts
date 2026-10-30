/**
 * Integer money for the catalog.
 *
 * Every price comparison in this package happens in BIGINT USD CENTS. The
 * shared `Sku.unitCostUsd` is a `number` because it is a published list price
 * that humans read; the moment it enters an equality test against a vendor rate
 * card it comes through here, once.
 *
 * A LIST PRICE MUST BE EXACTLY REPRESENTABLE IN CENTS or it is refused. A price
 * that cannot be stated in cents cannot be compared to a rate card at exactly
 * zero markup, and "approximately zero markup" is not the invariant.
 *
 * NOTE ON DUPLICATION. packages/broker/src/money.ts carries an
 * `exactCentsFromUsd` with identical semantics. The two are deliberately not
 * shared today because the broker consumes the catalog and a dependency in the
 * other direction would be a cycle. See the assumptions note: the intended
 * end state is that broker/money.ts re-exports from here.
 */
import { CatalogError } from './errors.js'

export const CENTS_PER_USD = 100

/** Guards against a nonsense figure becoming a 10^18-cent bigint. */
const MAX_USD = 1e12

/**
 * A catalog price. Sub-cent precision is refused rather than rounded, because
 * rounding a list price is how a one-cent spread gets introduced by accident.
 */
export function exactCentsFromUsd(usd: number, field: string): bigint {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0 || usd > MAX_USD) {
    throw new CatalogError('schema', 'invalid_usd', `${field} is not a valid non-negative USD amount`)
  }
  const scaled = usd * CENTS_PER_USD
  const rounded = Math.round(scaled)
  if (Math.abs(scaled - rounded) > 1e-6) {
    throw new CatalogError(
      'schema',
      'sub_cent_precision',
      `${field} (${usd}) is not an exact number of cents`,
    )
  }
  return BigInt(rounded)
}

/** For display and for tier-budget modelling. Never fed back into a comparison. */
export function usdFromCents(cents: bigint): number {
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CatalogError('schema', 'cents_out_of_range', 'cent amount exceeds safe integer range')
  }
  return Number(cents) / CENTS_PER_USD
}

/**
 * Protocol fractions (0.25, 0.5, 0.6) become integer basis points so no cap is
 * ever computed in floating point. A fraction not exactly expressible in bps is
 * refused rather than silently rounded.
 */
export function fractionToBps(fraction: number, field: string): number {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0) {
    throw new CatalogError('schema', 'invalid_fraction', `${field} is not a valid fraction`)
  }
  const scaled = fraction * 10_000
  const rounded = Math.round(scaled)
  if (Math.abs(scaled - rounded) > 1e-9) {
    throw new CatalogError(
      'schema',
      'fraction_not_bps',
      `${field} (${fraction}) is not expressible in basis points`,
    )
  }
  return rounded
}

/** Floor((amount * bps) / 10_000). Integer throughout. */
export function applyBps(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new CatalogError('schema', 'invalid_bps', `bps must be a non-negative integer (${bps})`)
  }
  return (amount * BigInt(bps)) / 10_000n
}

export function sumCents(values: Iterable<bigint>): bigint {
  let total = 0n
  for (const value of values) total += value
  return total
}

/** Human-readable cents, for error messages and reports only. */
export function formatCents(cents: bigint): string {
  const negative = cents < 0n
  const abs = negative ? -cents : cents
  const dollars = abs / 100n
  const remainder = abs % 100n
  return `${negative ? '-' : ''}$${dollars}.${remainder.toString().padStart(2, '0')}`
}
