/**
 * Money in the presentation layer.
 *
 * THE RULE, restated because a UI is where it usually breaks: amounts are
 * bigint minor units. A float never touches an amount, not even to render it,
 * because `(0.1 + 0.2).toFixed(2)` is the kind of thing that turns into a
 * support ticket about a missing cent on a receipts page whose entire product
 * claim is that the numbers are exact.
 *
 * USD arrives from the API as a JSON number (core's Receipt.amountUsd and
 * WeeklyReport are typed that way). It is converted to bigint cents once, here,
 * at the boundary, and every sum, split and comparison downstream is integer.
 * The conversion is the only float operation in the money path and it is
 * fixed-width: two decimal places, half-away-from-zero, via toFixed.
 */

export type Minor = bigint
/** USD in integer cents. */
export type Cents = bigint

export class MoneyError extends Error {
  constructor(message: string) {
    super(`money: ${message}`)
    this.name = 'MoneyError'
  }
}

/**
 * Convert a JSON USD number to integer cents exactly once, at the boundary.
 * Fails closed on anything that is not a finite number.
 */
export function usdToCents(usd: number): Cents {
  if (!Number.isFinite(usd)) throw new MoneyError(`usd value is not finite: ${usd}`)
  // toFixed does the rounding in decimal, so 1.005 -> "1.00"/"1.01" is settled
  // by the platform's decimal formatter rather than by binary accumulation.
  const fixed = usd.toFixed(2)
  const negative = fixed.startsWith('-')
  const digits = (negative ? fixed.slice(1) : fixed).replace('.', '')
  const magnitude = BigInt(digits)
  return negative ? -magnitude : magnitude
}

/** Parse a decimal string in a token's own units into minor units. */
export function parseUnits(value: string, decimals: number): Minor {
  if (decimals < 0 || decimals > 36 || !Number.isInteger(decimals)) {
    throw new MoneyError(`unsupported decimals ${decimals}`)
  }
  const trimmed = value.trim()
  if (!/^-?\d*(\.\d*)?$/.test(trimmed) || trimmed === '' || trimmed === '.' || trimmed === '-') {
    throw new MoneyError(`not a decimal amount: ${value}`)
  }
  const negative = trimmed.startsWith('-')
  const body = negative ? trimmed.slice(1) : trimmed
  const [whole = '0', fraction = ''] = body.split('.')
  if (fraction.length > decimals) {
    throw new MoneyError(`${value} has more precision than ${decimals} decimals`)
  }
  const padded = fraction.padEnd(decimals, '0')
  const magnitude = BigInt(`${whole || '0'}${padded || ''}` || '0')
  return negative ? -magnitude : magnitude
}

/** Render minor units as a decimal string. Never lossy, never a float. */
export function formatUnits(amount: Minor, decimals: number, maxFractionDigits = decimals): string {
  if (decimals < 0 || decimals > 36 || !Number.isInteger(decimals)) {
    throw new MoneyError(`unsupported decimals ${decimals}`)
  }
  const negative = amount < 0n
  const magnitude = negative ? -amount : amount
  const scale = 10n ** BigInt(decimals)
  const whole = magnitude / scale
  const fraction = (magnitude % scale).toString().padStart(decimals, '0')
  const shown = fraction.slice(0, Math.min(maxFractionDigits, decimals)).replace(/0+$/, '')
  const body = shown.length > 0 ? `${groupThousands(whole)}.${shown}` : groupThousands(whole)
  return negative ? `-${body}` : body
}

function groupThousands(value: bigint): string {
  const digits = value.toString()
  let out = ''
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ','
    out += digits[i]
  }
  return out
}

/** "$1,234.56". Always two decimals; a receipts page does not round dollars. */
export function formatUsd(cents: Cents): string {
  const negative = cents < 0n
  const magnitude = negative ? -cents : cents
  const body = `$${groupThousands(magnitude / 100n)}.${(magnitude % 100n).toString().padStart(2, '0')}`
  return negative ? `-${body}` : body
}

/**
 * Compact USD for headline figures, e.g. "$12.4k". Derived from the exact cents
 * by integer arithmetic; the exact figure is always shown alongside it in the
 * UI so this is a label, never the only representation of an amount.
 */
export function formatUsdCompact(cents: Cents): string {
  const negative = cents < 0n
  const magnitude = negative ? -cents : cents
  const dollars = magnitude / 100n
  const sign = negative ? '-' : ''
  if (dollars < 1_000n) return `${sign}${formatUsd(magnitude)}`
  if (dollars < 1_000_000n) return `${sign}$${tenths(dollars, 1_000n)}k`
  if (dollars < 1_000_000_000n) return `${sign}$${tenths(dollars, 1_000_000n)}M`
  return `${sign}$${tenths(dollars, 1_000_000_000n)}B`
}

function tenths(value: bigint, unit: bigint): string {
  const scaled = (value * 10n) / unit
  const whole = scaled / 10n
  const decimal = scaled % 10n
  return decimal === 0n ? groupThousands(whole) : `${groupThousands(whole)}.${decimal}`
}

/** bps of an integer amount, floored, exactly as Solidity's `a * bps / 10000`. */
export function applyBps(amount: Minor, bps: number): Minor {
  if (!Number.isInteger(bps) || bps < 0) throw new MoneyError(`bps must be a non-negative integer`)
  return (amount * BigInt(bps)) / 10_000n
}

/** A percentage label from bps, e.g. 1000 -> "10%", 35 -> "0.35%". */
export function formatBps(bps: number): string {
  const scaled = Math.round(bps * 100)
  const whole = Math.trunc(scaled / 10_000)
  const fraction = Math.abs(scaled % 10_000)
    .toString()
    .padStart(4, '0')
    .replace(/0+$/, '')
  return fraction.length > 0 ? `${whole}.${fraction}%` : `${whole}%`
}

/**
 * USD in integer MILLIONTHS of a dollar.
 *
 * Cents is the wrong unit for exactly one figure on this site: metered model
 * spend. A single reader call costs a fraction of a cent and a day is hundreds
 * of them, so a per-call figure rounded to cents renders as "$0.00" and a
 * running total accumulated in cents drifts below the truth. Micro-USD is exact
 * at the granularity the meter actually has, and it is still an integer, so the
 * no-floats rule is intact.
 *
 * It is a DIFFERENT TYPE from Cents on purpose. The two are three orders of
 * magnitude apart and a mixed-up unit here would be a four-figure error.
 */
export type MicroUsd = bigint

/**
 * Render micro-USD, keeping sub-cent precision when there is any.
 *
 * Below a cent it shows four decimals, because "$0.0043" is the true figure and
 * "$0.00" reads as free. At or above a cent it shows the ordinary two, because
 * four decimals on a budget line is noise.
 */
export function formatMicroUsd(micro: MicroUsd): string {
  const negative = micro < 0n
  const magnitude = negative ? -micro : micro
  const sign = negative ? '-' : ''
  if (magnitude > 0n && magnitude < 10_000n) {
    // Truncates rather than rounds: a sub-cent figure rounded UP to the next
    // ten-thousandth would overstate what a coin was charged.
    const fraction = (magnitude / 100n).toString().padStart(4, '0')
    return `${sign}$0.${fraction}`
  }
  const cents = magnitude / 10_000n
  return `${sign}${formatUsd(cents)}`
}

/**
 * A USD figure that carries where its price came from. Mirrors core's UsdValue.
 * The page never renders a converted amount without the provenance next to it:
 * an unattributed dollar figure on a receipts page is a claim, not a receipt.
 */
export interface PricedUsd {
  cents: Cents
  priceSource: string
  pricedAtUnix: number
  blockHash?: string
}
