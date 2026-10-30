/**
 * USD derivation.
 *
 * USD is a REPORTING and GATING figure only. No settlement amount is ever
 * derived from it, and no USD number is ever converted back into minor units.
 * Every figure carries its price provenance, per the money rule in core/types.
 *
 * A missing or stale price throws. Defaulting an unpriceable balance to zero
 * would silently classify a real variance as no variance at all.
 */

import type { Asset, Money, UsdValue } from '@fee-split-vaults/core'
import { InvalidInputError, PriceUnavailableError } from './errors.js'

export interface PriceQuote {
  asset: string
  /** USD per whole unit of the asset, not per minor unit. */
  usdPerUnit: number
  source: string
  asOfUnix: number
  /** Block the price was pinned against, when it came from a chain read. */
  blockHash?: string
}

export interface PriceOracle {
  quote(asset: string, atUnix: number): Promise<PriceQuote | undefined>
}

export interface UsdOptions {
  /** A price older than this is refused. Fail closed on stale marks. */
  maxAgeSeconds: number
}

export const DEFAULT_USD_OPTIONS: UsdOptions = { maxAgeSeconds: 900 }

/**
 * Exact decimal string for a minor-unit amount. Goes through strings rather
 * than arithmetic so a balance above 2^53 minor units is not corrupted on its
 * way to a display figure.
 */
export function minorToDecimalString(amountMinor: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new InvalidInputError(`unsupported decimals ${decimals}`, 'decimals')
  }
  const negative = amountMinor < 0n
  const digits = (negative ? -amountMinor : amountMinor).toString(10).padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const frac = decimals === 0 ? '' : `.${digits.slice(digits.length - decimals)}`
  return `${negative ? '-' : ''}${whole}${frac}`
}

export function toUsdValue(
  money: Money,
  asset: Pick<Asset, 'address' | 'decimals'>,
  quote: PriceQuote,
  atUnix: number,
  options: UsdOptions = DEFAULT_USD_OPTIONS,
): UsdValue {
  if (asset.address !== money.asset) {
    throw new InvalidInputError('asset metadata does not match the money asset', 'asset')
  }
  if (quote.asset !== money.asset) {
    throw new PriceUnavailableError('quote is for a different asset', money.asset)
  }
  const age = atUnix - quote.asOfUnix
  if (!Number.isFinite(age) || age < 0 || age > options.maxAgeSeconds) {
    throw new PriceUnavailableError(
      `price for ${money.asset} is ${age}s old, limit ${options.maxAgeSeconds}s`,
      money.asset,
    )
  }
  if (!Number.isFinite(quote.usdPerUnit) || quote.usdPerUnit < 0) {
    throw new PriceUnavailableError(`price for ${money.asset} is not a usable number`, money.asset)
  }

  const units = Number(minorToDecimalString(money.amount, asset.decimals))
  const value: UsdValue = {
    usd: units * quote.usdPerUnit,
    priceSource: quote.source,
    pricedAtUnix: quote.asOfUnix,
  }
  if (quote.blockHash !== undefined) value.blockHash = quote.blockHash
  return value
}

/**
 * In-memory oracle for tests and for pinned-price replays. Prices are pinned by
 * the caller, so a test that forgets to pin one gets the fail-closed path rather
 * than an invented number.
 */
export class PinnedPriceOracle implements PriceOracle {
  private readonly prices = new Map<string, PriceQuote>()

  pin(quote: PriceQuote): void {
    this.prices.set(quote.asset, quote)
  }

  async quote(asset: string, _atUnix: number): Promise<PriceQuote | undefined> {
    return this.prices.get(asset)
  }
}

/** Convenience for the variance path: USD of a delta, or undefined if unpriceable. */
export async function tryUsd(
  oracle: PriceOracle,
  asset: Pick<Asset, 'address' | 'decimals'>,
  amountMinor: bigint,
  atUnix: number,
  options: UsdOptions = DEFAULT_USD_OPTIONS,
): Promise<number | undefined> {
  const quote = await oracle.quote(asset.address, atUnix)
  if (quote === undefined) return undefined
  try {
    const magnitude = amountMinor < 0n ? -amountMinor : amountMinor
    return toUsdValue(
      { asset: asset.address, amount: magnitude },
      asset,
      quote,
      atUnix,
      options,
    ).usd
  } catch {
    return undefined
  }
}
