/**
 * Minor units -> USD, with provenance attached to every figure.
 *
 * The money rule: amounts stay bigint minor units end to end. A USD number is
 * a DERIVED REPORTING FIGURE and is never fed back into an amount. Every USD
 * value produced here carries the price, its source and the time it was pinned,
 * so a downstream number can always be traced to the rate that made it.
 */

import type { ToolConfig } from './env.ts'

export interface QuoteAsset {
  address: string
  symbol: string
  decimals: number
}

/**
 * THE NATIVE ASSET SENTINEL. address(0), which is the convention this codebase
 * already uses: contracts/src/lib/SafeTransferLib.sol declares
 *
 *   address internal constant NATIVE = address(0);
 *
 * and CoinVault keys its per-asset accounting maps by it. The tools MUST use the
 * same sentinel rather than invent a second one, because a per-asset figure
 * produced here is read next to a per-asset balance produced there.
 *
 * A credit event with no token parameter credits THIS asset. It is never an
 * ERC-20 address, and it is never WETH.
 */
export const NATIVE_ASSET_ADDRESS = '0x0000000000000000000000000000000000000000'
export const NATIVE_ASSET_SYMBOL = 'ETH'
export const NATIVE_ASSET_DECIMALS = 18

export function isNativeAsset(address: string): boolean {
  return address.toLowerCase() === NATIVE_ASSET_ADDRESS
}

/** The chain's native asset as a priceable quote asset. Priced by VENUE_PRICE_USD_ETH. */
export function nativeQuoteAsset(): QuoteAsset {
  return {
    address: NATIVE_ASSET_ADDRESS,
    symbol: NATIVE_ASSET_SYMBOL,
    decimals: NATIVE_ASSET_DECIMALS,
  }
}

/**
 * Documented symbol fallbacks, used ONLY when the primary symbol has no price.
 *
 * ETH <- WETH exists because everyone already sets VENUE_PRICE_USD_WETH and the
 * native path would otherwise silently report n/a for every recipient. It is a
 * convenience, not an identity: WETH is an ERC-20 wrapper that can and does
 * depeg, and a run that uses the fallback says so in its warnings. There is no
 * fallback in the other direction - an ETH price must not be quietly applied to
 * an ERC-20 balance.
 */
export const SYMBOL_PRICE_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  [NATIVE_ASSET_SYMBOL]: ['WETH'],
}

export interface PricedUsd {
  usd: number
  priceUsd: number
  priceSource: string
  pricedAtUnix: number
}

export class MissingPriceError extends Error {
  readonly asset: string

  constructor(asset: string) {
    super(
      `no USD price for ${asset}. Set VENUE_PRICE_USD_<SYMBOL> (VENUE_PRICE_USD_ETH=3200 for the ` +
        `native asset ${NATIVE_ASSET_ADDRESS}, VENUE_PRICE_USD_WETH=3200 for wrapped ether) ` +
        `or pass --allow-missing-prices to emit null USD instead of guessing.`,
    )
    this.name = 'MissingPriceError'
    this.asset = asset
  }
}

export class PriceBook {
  readonly #bySymbol: Record<string, number>
  readonly #byAddress = new Map<string, QuoteAsset>()
  /**
   * Prices pinned to an ADDRESS. These beat symbol lookup, and they have to:
   * across the 263 assets a live ERC-20 run found, symbols are issuer-chosen,
   * they collide, and several are deliberately confusable. "PEPE" is not an
   * identifier. An address is.
   */
  readonly #priceByAddress = new Map<string, number>()
  /** symbol -> the alias its price actually came from. Reported, never hidden. */
  readonly #aliasUsed = new Map<string, { alias: string; price: number }>()
  readonly source: string
  readonly pinnedAtUnix: number

  constructor(
    prices: Record<string, number>,
    source: string,
    pinnedAtUnix: number,
    assets: readonly QuoteAsset[] = [],
  ) {
    this.source = source
    this.pinnedAtUnix = pinnedAtUnix
    this.#bySymbol = Object.fromEntries(
      Object.entries(prices).map(([k, v]) => [k.toUpperCase(), v]),
    )
    for (const asset of assets) this.registerAsset(asset)
  }

  static fromConfig(config: ToolConfig, assets: readonly QuoteAsset[] = []): PriceBook {
    return new PriceBook(
      config.priceUsdBySymbol,
      config.priceSource,
      Math.floor(Date.now() / 1000),
      assets,
    )
  }

  registerAsset(asset: QuoteAsset, priceUsd?: number): void {
    this.#byAddress.set(asset.address.toLowerCase(), asset)
    if (priceUsd !== undefined) {
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
        throw new Error(
          `price for ${asset.address} must be a positive number, got ${String(priceUsd)}`,
        )
      }
      this.#priceByAddress.set(asset.address.toLowerCase(), priceUsd)
    }
  }

  /** Addresses carrying an operator-pinned price, in registration order. */
  addressPricedAssets(): string[] {
    return [...this.#priceByAddress.keys()]
  }

  asset(address: string): QuoteAsset | undefined {
    return this.#byAddress.get(address.toLowerCase())
  }

  knownAssets(): QuoteAsset[] {
    return [...this.#byAddress.values()]
  }

  priceOf(address: string): number | undefined {
    // An address-pinned price wins over a symbol lookup. With a long tail of
    // issuer-named tokens, symbol matching is a collision waiting to happen.
    const direct = this.#priceByAddress.get(address.toLowerCase())
    if (direct !== undefined) return direct
    const asset = this.asset(address)
    if (asset === undefined) return undefined
    return this.priceOfSymbol(asset.symbol)
  }

  /**
   * Price for a symbol, falling back through SYMBOL_PRICE_FALLBACKS.
   *
   * A fallback that fires is RECORDED, not swallowed: aliasWarnings() surfaces
   * it in the report so nobody reads an ETH figure believing an ETH price was
   * configured when a WETH price was.
   */
  priceOfSymbol(symbol: string): number | undefined {
    const key = symbol.toUpperCase()
    const direct = this.#bySymbol[key]
    if (direct !== undefined) return direct
    for (const alias of SYMBOL_PRICE_FALLBACKS[key] ?? []) {
      const price = this.#bySymbol[alias.toUpperCase()]
      if (price !== undefined) {
        this.#aliasUsed.set(key, { alias: alias.toUpperCase(), price })
        return price
      }
    }
    return undefined
  }

  /** One warning per symbol that was priced through a fallback alias. */
  aliasWarnings(): string[] {
    return [...this.#aliasUsed.entries()].map(
      ([symbol, { alias, price }]) =>
        `VENUE_PRICE_USD_${symbol} is not set, so ${symbol} was priced at $${price} from ` +
        `VENUE_PRICE_USD_${alias} as a documented fallback alias. ${symbol} and ${alias} are NOT the ` +
        `same asset - ${alias} is a wrapper that can depeg - so every USD figure derived from ${symbol} ` +
        `here carries that substitution. Set VENUE_PRICE_USD_${symbol} to remove this warning.`,
    )
  }

  /**
   * Convert minor units to USD. Returns undefined when the price or the asset
   * is unknown - the CALLER decides whether that is fatal, because a market
   * count that quietly treats an unpriced asset as zero is the failure mode
   * this whole file exists to prevent.
   */
  toUsd(address: string, amountMinor: bigint): PricedUsd | undefined {
    const asset = this.asset(address)
    const price = this.priceOf(address)
    if (asset === undefined || price === undefined) return undefined
    return {
      usd: minorToUnits(amountMinor, asset.decimals) * price,
      priceUsd: price,
      priceSource: this.source,
      pricedAtUnix: this.pinnedAtUnix,
    }
  }

  toUsdOrThrow(address: string, amountMinor: bigint): PricedUsd {
    const priced = this.toUsd(address, amountMinor)
    if (priced === undefined) throw new MissingPriceError(address)
    return priced
  }
}

/**
 * Minor units to a float of whole units. Reporting only.
 *
 * Split into integer and fractional parts before touching a float so a large
 * WETH balance does not lose its low digits to a 2^53 rounding step.
 */
export function minorToUnits(amountMinor: bigint, decimals: number): number {
  if (decimals === 0) return Number(amountMinor)
  const scale = 10n ** BigInt(decimals)
  const negative = amountMinor < 0n
  const magnitude = negative ? -amountMinor : amountMinor
  const whole = magnitude / scale
  const fraction = magnitude % scale
  const value = Number(whole) + Number(fraction) / Number(scale)
  return negative ? -value : value
}

/** Whole units to minor units, exactly, from a decimal STRING (never a float). */
export function unitsToMinor(value: string, decimals: number): bigint {
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(value.trim())
  if (!match) throw new Error(`not a decimal amount: ${value}`)
  const sign = match[1] === '-' ? -1n : 1n
  const whole = match[2] ?? '0'
  const fractionRaw = match[3] ?? ''
  if (fractionRaw.length > decimals) {
    throw new Error(`${value} has more than ${decimals} decimal places; refusing to round money`)
  }
  const fraction = fractionRaw.padEnd(decimals, '0')
  return sign * BigInt(`${whole === '' ? '0' : whole}${fraction}`)
}

/**
 * The quote assets every escrow run knows about without an --assets file.
 *
 * The NATIVE asset is first and is not optional: the escrow's `Credited` event
 * carries native value in msg.value and names no token, so without a registered
 * native asset every native credit prices as n/a. That is exactly the failure a
 * live run hit.
 */
export function defaultQuoteAssets(wethAddress: string): QuoteAsset[] {
  return [nativeQuoteAsset(), { address: wethAddress.toLowerCase(), symbol: 'WETH', decimals: 18 }]
}

/**
 * Parse a `--assets` file: [{address, symbol, decimals}]. Quote assets on this
 * chain are issuer-controlled proxies whose decimals must be read, not assumed.
 */
export function parseAssetsFile(json: unknown): QuoteAsset[] {
  return parseAssetEntriesFile(json).map((entry) => {
    if (entry.decimals === undefined) {
      throw new Error(
        `assets[${entry.address}].decimals is required here; use --resolve-metadata to read it from the chain instead`,
      )
    }
    return { address: entry.address, symbol: entry.symbol ?? 'UNKNOWN', decimals: entry.decimals }
  })
}

/**
 * One line of an operator-authored `--assets` file.
 *
 * This is the hand-pricing surface for Part B. Pricing 263 assets individually
 * is not realistic, so the operator prices the head of the distribution here
 * and the tail is reported as UNPRICED rather than guessed at.
 *
 * `decimals` and `symbol` are OPTIONAL because the on-chain resolver supplies
 * them. Omitting decimals means "read it", never "assume 18": an entry whose
 * decimals were neither given nor resolved stays unpriceable, which is the
 * whole point.
 */
export interface AssetEntry {
  address: string
  symbol?: string
  decimals?: number
  /** USD per whole unit, pinned by the operator to THIS address. */
  priceUsd?: number
}

export function parseAssetEntriesFile(json: unknown): AssetEntry[] {
  if (!Array.isArray(json)) throw new Error('assets file must be a JSON array')
  const seen = new Set<string>()
  return json.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) throw new Error(`assets[${i}] is not an object`)
    const entry = raw as Record<string, unknown>
    const address = entry.address
    if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new Error(`assets[${i}].address is not an address`)
    }
    const lower = address.toLowerCase()
    if (seen.has(lower)) {
      // Two prices for one asset is a silent coin flip over which one wins.
      throw new Error(`assets file names ${lower} twice; one entry per address`)
    }
    seen.add(lower)

    const out: AssetEntry = { address: lower }
    if (entry.symbol !== undefined) {
      if (typeof entry.symbol !== 'string' || entry.symbol.length === 0) {
        throw new Error(`assets[${i}].symbol must be a non-empty string when present`)
      }
      out.symbol = entry.symbol
    }
    if (entry.decimals !== undefined && entry.decimals !== null) {
      const decimals = entry.decimals
      if (
        typeof decimals !== 'number' ||
        !Number.isInteger(decimals) ||
        decimals < 0 ||
        decimals > 36
      ) {
        throw new Error(`assets[${i}].decimals must be an integer 0..36`)
      }
      out.decimals = decimals
    }
    if (entry.priceUsd !== undefined && entry.priceUsd !== null) {
      const price = entry.priceUsd
      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
        throw new Error(`assets[${i}].priceUsd must be a positive number`)
      }
      out.priceUsd = price
    }
    return out
  })
}
