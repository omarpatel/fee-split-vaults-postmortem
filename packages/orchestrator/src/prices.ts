/**
 * One pinned price book, three consumers.
 *
 * The indexer wants a float per whole unit, the ledger wants a quote object,
 * the broker wants integer cents. Rather than let an operator configure three
 * price sources that can silently disagree - which is a reconciliation variance
 * waiting to happen - there is one UsdPriceBook and these adapters.
 *
 * The canonical unit is CENTS PER WHOLE UNIT as a bigint, because that is the
 * only one of the three that cannot lose a digit.
 */

import type { Asset, AssetAddress, UsdValue } from '@fee-split-vaults/core'
import type { AssetUsdPrice } from '@fee-split-vaults/broker'
import type { PinnedPrice, PriceOracle as IndexerPriceOracle } from '@fee-split-vaults/indexer'
import type { PriceOracle as LedgerPriceOracle, PriceQuote } from '@fee-split-vaults/ledger'
import { FailClosed, type TickPhase } from './errors.js'
import type { PinnedUsdPrice, UsdPriceBook } from './ports.js'

export const CENTS_PER_USD = 100n

/** In-memory book. The production shape is the same: prices DECIDED and pinned. */
export class InMemoryPriceBook implements UsdPriceBook {
  readonly #pins = new Map<string, PinnedUsdPrice[]>()

  constructor(pins: readonly PinnedUsdPrice[] = []) {
    for (const pin of pins) this.pin(pin)
  }

  pin(price: PinnedUsdPrice): void {
    const key = price.asset.toLowerCase()
    const list = this.#pins.get(key) ?? []
    list.push(price)
    list.sort((a, b) => a.pricedAtUnix - b.pricedAtUnix)
    this.#pins.set(key, list)
  }

  priceAt(asset: AssetAddress, atUnix: number): PinnedUsdPrice | undefined {
    const list = this.#pins.get(asset.toLowerCase())
    if (list === undefined) return undefined
    let found: PinnedUsdPrice | undefined
    for (const pin of list) {
      if (pin.pricedAtUnix <= atUnix) found = pin
      else break
    }
    return found
  }
}

export function requirePrice(
  book: UsdPriceBook,
  asset: AssetAddress,
  atUnix: number,
  maxAgeSeconds: number,
  phase: TickPhase,
): PinnedUsdPrice {
  const price = book.priceAt(asset, atUnix)
  if (price === undefined) {
    throw new FailClosed(phase, 'price_missing', `no pinned USD price for ${asset} at ${atUnix}`)
  }
  const age = atUnix - price.pricedAtUnix
  if (age < 0 || age > maxAgeSeconds) {
    throw new FailClosed(
      phase,
      'price_stale',
      `price for ${asset} is ${age}s old, limit ${maxAgeSeconds}s; refusing to reuse it`,
    )
  }
  return price
}

// ---------------------------------------------------------------------------
// Exact conversions
// ---------------------------------------------------------------------------

function pow10(n: number): bigint {
  let out = 1n
  for (let i = 0; i < n; i += 1) out *= 10n
  return out
}

/**
 * Minor units to USD cents, FLOORED.
 *
 * Flooring is not an aesthetic choice: this figure is used as a balance the
 * client is allowed to spend against, and rounding a balance up invents money.
 */
export function minorToCents(amountMinor: bigint, decimals: number, price: PinnedUsdPrice): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new FailClosed('measure', 'bad_decimals', `unsupported decimals ${decimals}`)
  }
  const negative = amountMinor < 0n
  const magnitude = negative ? -amountMinor : amountMinor
  const cents = (magnitude * price.centsPerWholeUnit) / pow10(decimals)
  return negative ? -cents : cents
}

/** Cents back to a float USD, for the report and gate shapes that want one. */
export function centsToUsd(cents: bigint): number {
  return Number(cents) / 100
}

/** A core UsdValue carrying its provenance, derived exactly then widened once. */
export function toUsdValue(
  amountMinor: bigint,
  asset: Pick<Asset, 'address' | 'decimals'>,
  price: PinnedUsdPrice,
): UsdValue {
  if (asset.address.toLowerCase() !== price.asset.toLowerCase()) {
    throw new FailClosed('measure', 'price_asset_mismatch', 'price is for a different asset')
  }
  const value: UsdValue = {
    usd: centsToUsd(minorToCents(amountMinor, asset.decimals, price)),
    priceSource: price.source,
    pricedAtUnix: price.pricedAtUnix,
  }
  if (price.blockHash !== undefined) value.blockHash = price.blockHash
  return value
}

/**
 * A UsdValue built from a figure that was ALREADY measured in cents.
 *
 * Some inputs never pass through minor units at all - the disbursement
 * counters record what was paid, in cents, because that is what the invoice
 * said. Routing those through `toUsdValue` would mean inventing a minor-unit
 * amount for them, and the flooring in `minorToCents` would then shave the
 * value on the way back. This keeps the number exact and still attaches the
 * price provenance, because a USD figure in this system without provenance is
 * a figure nobody can audit - even when no conversion was needed to get it.
 */
export function usdFromCents(cents: bigint, price: PinnedUsdPrice): UsdValue {
  const value: UsdValue = {
    usd: centsToUsd(cents),
    priceSource: price.source,
    pricedAtUnix: price.pricedAtUnix,
  }
  if (price.blockHash !== undefined) value.blockHash = price.blockHash
  return value
}

/** A zero-valued UsdValue that still carries provenance, for empty buckets. */
export function zeroUsd(price: PinnedUsdPrice): UsdValue {
  const value: UsdValue = { usd: 0, priceSource: price.source, pricedAtUnix: price.pricedAtUnix }
  if (price.blockHash !== undefined) value.blockHash = price.blockHash
  return value
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

export function toBrokerPrice(price: PinnedUsdPrice, decimals: number): AssetUsdPrice {
  return {
    asset: price.asset,
    decimals,
    centsPerWholeUnit: price.centsPerWholeUnit,
    source: price.source,
    pricedAtUnix: price.pricedAtUnix,
  }
}

/** Widens cents to a float. The indexer only ever multiplies it by a balance. */
export function toIndexerOracle(book: UsdPriceBook): IndexerPriceOracle {
  return {
    priceAt(asset: AssetAddress, atUnix: number): PinnedPrice | undefined {
      const price = book.priceAt(asset, atUnix)
      if (price === undefined) return undefined
      return {
        asset: price.asset,
        usdPerWholeUnit: Number(price.centsPerWholeUnit) / 100,
        source: price.source,
        pricedAtUnix: price.pricedAtUnix,
      }
    },
  }
}

export function toLedgerOracle(book: UsdPriceBook): LedgerPriceOracle {
  return {
    async quote(asset: string, atUnix: number): Promise<PriceQuote | undefined> {
      const price = book.priceAt(asset, atUnix)
      if (price === undefined) return undefined
      const quote: PriceQuote = {
        asset: price.asset,
        usdPerUnit: Number(price.centsPerWholeUnit) / 100,
        source: price.source,
        asOfUnix: price.pricedAtUnix,
      }
      if (price.blockHash !== undefined) quote.blockHash = price.blockHash
      return quote
    },
  }
}
