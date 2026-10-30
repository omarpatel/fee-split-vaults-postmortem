/**
 * USD valuation, always with provenance.
 *
 * Minor units are the truth; a USD number is a derived, dated opinion. Every one
 * produced here carries the source and the timestamp of the price that produced
 * it, because a tier grant is a commercial decision that someone will later have
 * to defend with the exact number that justified it.
 *
 * A missing or stale price is a REFUSAL. Reaching for the last known price would
 * quietly re-rate a client's whole week off a number nobody chose.
 */

import type { Asset, AssetAddress, UsdValue } from '@fee-split-vaults/core'
import { MissingPriceError } from './errors.js'
import type { Hex } from './hex.js'

export interface PinnedPrice {
  readonly asset: AssetAddress
  /** USD per ONE whole unit of the asset, not per minor unit. */
  readonly usdPerWholeUnit: number
  readonly source: string
  readonly pricedAtUnix: number
}

export interface PriceOracle {
  /** The price in force at a moment, or undefined if we have none. */
  priceAt(asset: AssetAddress, atUnix: number): PinnedPrice | undefined
}

/** Two days: quote assets here are stablecoin-shaped, but staleness still halts. */
export const DEFAULT_MAX_PRICE_AGE_SECONDS = 172_800

/**
 * Pin-based oracle: an ordered set of observations per asset, each in force from
 * its own timestamp until the next. This is both the test double and the shape a
 * production oracle should take - prices that were decided and recorded, never
 * fetched live at gate-evaluation time.
 */
export class StaticPriceOracle implements PriceOracle {
  private readonly pins = new Map<string, PinnedPrice[]>()

  constructor(pins: readonly PinnedPrice[] = []) {
    for (const pin of pins) this.add(pin)
  }

  add(pin: PinnedPrice): void {
    const key = pin.asset.toLowerCase()
    const list = this.pins.get(key) ?? []
    list.push(pin)
    list.sort((a, b) => a.pricedAtUnix - b.pricedAtUnix)
    this.pins.set(key, list)
  }

  priceAt(asset: AssetAddress, atUnix: number): PinnedPrice | undefined {
    const list = this.pins.get(asset.toLowerCase())
    if (!list) return undefined
    let found: PinnedPrice | undefined
    for (const pin of list) {
      if (pin.pricedAtUnix <= atUnix) found = pin
      else break
    }
    return found
  }
}

export function requirePrice(
  oracle: PriceOracle,
  asset: AssetAddress,
  atUnix: number,
  maxAgeSeconds: number = DEFAULT_MAX_PRICE_AGE_SECONDS,
): PinnedPrice {
  const price = oracle.priceAt(asset, atUnix)
  if (!price) throw new MissingPriceError(asset, atUnix, 'no pinned price at or before this time')
  const age = atUnix - price.pricedAtUnix
  if (age > maxAgeSeconds) {
    throw new MissingPriceError(asset, atUnix, `pinned price is ${age}s old, limit is ${maxAgeSeconds}s`)
  }
  return price
}

const MICRO = 1_000_000n

/**
 * Minor units to USD. The bigint is reduced to micro-units of the asset before
 * it ever meets a float, so the only precision loss is in the final multiply.
 * Above ~9e9 whole units of an asset that loss becomes visible; no quote asset
 * on this chain is anywhere near it, and the minor-unit figure remains exact.
 */
export function usdOf(minorAmount: bigint, decimals: number, price: PinnedPrice): number {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new MissingPriceError(price.asset, price.pricedAtUnix, `invalid decimals ${decimals}`)
  }
  const scaled = (minorAmount * MICRO) / 10n ** BigInt(decimals)
  return (Number(scaled) / Number(MICRO)) * price.usdPerWholeUnit
}

export function toUsdValue(
  minorAmount: bigint,
  asset: Asset,
  price: PinnedPrice,
  blockHash?: Hex,
): UsdValue {
  return {
    usd: usdOf(minorAmount, asset.decimals, price),
    priceSource: price.source,
    pricedAtUnix: price.pricedAtUnix,
    blockHash,
  }
}
