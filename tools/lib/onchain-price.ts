/**
 * An OPTIONAL, on-chain, self-consistent price source for the native asset.
 *
 * WHY THIS EXISTS. Every USD figure the 7-day measurement produced rested on a
 * hand-entered VENUE_PRICE_USD_ETH that nobody verified, and the QF gate counts
 * are threshold counts, so they move materially with it. A number typed into an
 * environment variable has no provenance and no way to be re-derived later. A
 * Uniswap-V3-shaped WETH/USDG pool on this same chain does: it can be read, it
 * can be re-read at the same block, and it is denominated in an asset the escrow
 * itself is credited in.
 *
 * WHAT IT IS NOT. This is NOT a USD quote.
 *
 *   1. It prices WETH, not native ETH. They track closely and they are not the
 *      same asset - the wrapper can depeg - which is the same caveat
 *      SYMBOL_PRICE_FALLBACKS already carries for VENUE_PRICE_USD_WETH.
 *   2. It prices in USDG, not dollars. Converting to USD assumes the USDG peg
 *      holds at exactly $1.00. That assumption is an INPUT, it is carried in the
 *      provenance string, and it is warned about on every use.
 *   3. It is one pool on one chain. A venue price is not a market price.
 *
 * So it is a CROSS-CHECK and a documented fallback, never an authority. When
 * VENUE_PRICE_USD_ETH is set, that pinned value still wins and the on-chain
 * reading is reported next to it with the discrepancy - which is the use that
 * actually matters, because it is what would have caught a $3,200 pin against a
 * $2,490 market.
 *
 * MANIPULATION. `slot0` spot is a single-block value and is manipulable by
 * anyone willing to move the pool for one block. This module reads the
 * arithmetic-mean tick over a TWAP window via `observe()` instead, and it
 * REFUSES rather than silently degrading to spot if the pool cannot serve the
 * window asked for.
 */

import { NATIVE_ASSET_SYMBOL, nativeQuoteAsset, type PriceBook } from './prices.ts'
import type { ChainReader } from './rpc.ts'

/** observe(uint32[]) — verified against a live pool on chain 4663. */
const SELECTOR_OBSERVE = '0x883bdbfd'
/** token0() / token1(), for verifying the pool is the pair we think it is. */
const SELECTOR_TOKEN0 = '0x0dfe1681'
const SELECTOR_TOKEN1 = '0xd21220a7'

/** Default TWAP window. Long enough that moving it costs real money. */
export const DEFAULT_TWAP_SECONDS = 1800

export class OnchainPriceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OnchainPriceError'
  }
}

export interface OnchainPriceQuote {
  /** USD per whole unit of the base asset, under the quote asset's peg assumption. */
  priceUsd: number
  /** Provenance, carried into every derived figure. Never a bare number. */
  source: string
  pool: string
  twapSeconds: number
  /** Floor-divided mean tick, matching Uniswap's own OracleLibrary. */
  meanTick: number
  /** The exact rational mean, before the floor. Reported for auditability. */
  meanTickExact: number
  baseSymbol: string
  quoteSymbol: string
  /** The peg this reading ASSUMES for the quote asset. Always stated. */
  quotePegUsd: number
  observedAtUnix: number
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Pure encoding/decoding and tick math. No network, so it is directly testable.
// ---------------------------------------------------------------------------

const hexWord = (value: bigint | number): string => BigInt(value).toString(16).padStart(64, '0')

/** ABI-encode `observe(uint32[] secondsAgos)`. */
export function encodeObserve(secondsAgos: readonly number[]): string {
  if (secondsAgos.length === 0) throw new OnchainPriceError('observe() needs at least one secondsAgo')
  for (const s of secondsAgos) {
    if (!Number.isInteger(s) || s < 0 || s > 0xffffffff) {
      throw new OnchainPriceError(`secondsAgo must be a uint32, got ${String(s)}`)
    }
  }
  return (
    SELECTOR_OBSERVE +
    hexWord(32) +
    hexWord(secondsAgos.length) +
    secondsAgos.map((s) => hexWord(s)).join('')
  )
}

/** Read a 32-byte word as a signed two's-complement integer. */
function toSigned(word: string): bigint {
  const value = BigInt(`0x${word}`)
  return value >= 1n << 255n ? value - (1n << 256n) : value
}

/**
 * Decode the `int56[] tickCumulatives` half of an `observe()` return.
 *
 * Only the first return value is decoded; secondsPerLiquidity is not used here
 * and decoding data we do not use is a way to fail on data we do not need.
 */
export function decodeTickCumulatives(returnData: string): bigint[] {
  const body = returnData.replace(/^0x/, '')
  if (body.length === 0) {
    throw new OnchainPriceError(
      'observe() returned empty data. The address is probably not a Uniswap-V3-shaped pool.',
    )
  }
  if (body.length % 64 !== 0) throw new OnchainPriceError('observe() return is not word-aligned')
  const words = body.length / 64
  if (words < 2) throw new OnchainPriceError('observe() return is too short to hold two array offsets')

  const offsetBytes = Number(BigInt(`0x${body.slice(0, 64)}`))
  if (offsetBytes % 32 !== 0) throw new OnchainPriceError('observe() tickCumulatives offset is not word-aligned')
  const head = offsetBytes / 32
  if (head + 1 > words) throw new OnchainPriceError('observe() tickCumulatives offset points past the return data')

  const length = Number(BigInt(`0x${body.slice(head * 64, (head + 1) * 64)}`))
  if (head + 1 + length > words) {
    throw new OnchainPriceError(
      `observe() claims ${length} tickCumulatives but the return data holds only ${words - head - 1}`,
    )
  }
  const out: bigint[] = []
  for (let i = 0; i < length; i++) {
    out.push(toSigned(body.slice((head + 1 + i) * 64, (head + 2 + i) * 64)))
  }
  return out
}

/**
 * Arithmetic-mean tick over the window, floor-divided.
 *
 * Uniswap's own OracleLibrary.consult floors rather than truncating, so a
 * negative delta that does not divide evenly rounds DOWN. Every WETH/USDG tick
 * is negative (WETH is token0 and worth ~2.5e3 of a 6-decimal token1), so
 * getting this wrong is not a corner case here - it is every single reading.
 */
export function meanTickFromCumulatives(delta: bigint, secondsAgo: number): number {
  if (!Number.isInteger(secondsAgo) || secondsAgo <= 0) {
    throw new OnchainPriceError(`TWAP window must be a positive integer number of seconds, got ${String(secondsAgo)}`)
  }
  const span = BigInt(secondsAgo)
  let tick = delta / span
  if (delta < 0n && delta % span !== 0n) tick -= 1n
  return Number(tick)
}

/**
 * Whole-unit price of `base` denominated in `quote`, from a V3 tick.
 *
 * In a V3 pool the tick encodes token1-per-token0 in MINOR units:
 *   amount1_minor = amount0_minor * 1.0001^tick
 * so in whole units
 *   price(token0 in token1) = 1.0001^tick * 10^(decimals0 - decimals1).
 *
 * The decimal term is not cosmetic. For WETH(18)/USDG(6) it is 10^12 — the same
 * factor that made USDG render as 9.033e-6 instead of $9.03M when decimals were
 * assumed rather than read.
 */
export function priceFromTick(
  tick: number,
  decimals0: number,
  decimals1: number,
  baseIsToken0: boolean,
): number {
  const token1PerToken0 = Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1)
  if (!Number.isFinite(token1PerToken0) || token1PerToken0 <= 0) {
    throw new OnchainPriceError(
      `tick ${tick} with decimals ${decimals0}/${decimals1} produced a non-positive price; refusing to report it`,
    )
  }
  const price = baseIsToken0 ? token1PerToken0 : 1 / token1PerToken0
  if (!Number.isFinite(price) || price <= 0) {
    throw new OnchainPriceError(`derived price ${price} is not a usable positive number`)
  }
  return price
}

// ---------------------------------------------------------------------------
// The network read.
// ---------------------------------------------------------------------------

export interface OnchainPriceOptions {
  /** The Uniswap-V3-shaped pool to read. */
  pool: string
  /** The asset being priced (WETH here). */
  base: { address: string; symbol: string; decimals: number }
  /** The asset it is priced IN (USDG here), and the peg assumed for it. */
  quote: { address: string; symbol: string; decimals: number; pegUsd: number }
  /** TWAP window in seconds. */
  twapSeconds?: number
  /**
   * Reject a reading outside this band, as a last-ditch guard against reading a
   * pool that is not the pool we think it is. Omit to accept any positive price.
   */
  sanityBandUsd?: { min: number; max: number }
}

const addressFrom = (word: string): string => `0x${word.replace(/^0x/, '').slice(24, 64)}`.toLowerCase()

/**
 * Read the TWAP price of `base` in `quote` from a V3-shaped pool, and convert it
 * to USD under the quote asset's declared peg.
 *
 * Every failure path throws. There is deliberately no "return undefined and let
 * the caller substitute something": an operator who asked for an on-chain price
 * and did not get one must not silently receive a different number.
 */
export async function readOnchainTwapPrice(
  reader: ChainReader,
  options: OnchainPriceOptions,
): Promise<OnchainPriceQuote> {
  const twapSeconds = options.twapSeconds ?? DEFAULT_TWAP_SECONDS
  if (!Number.isInteger(twapSeconds) || twapSeconds <= 0) {
    throw new OnchainPriceError(`TWAP window must be a positive integer, got ${String(twapSeconds)}`)
  }
  if (!Number.isFinite(options.quote.pegUsd) || options.quote.pegUsd <= 0) {
    throw new OnchainPriceError(`quote peg must be a positive number, got ${String(options.quote.pegUsd)}`)
  }

  const pool = options.pool.toLowerCase()
  const base = options.base.address.toLowerCase()
  const quote = options.quote.address.toLowerCase()

  // 1. VERIFY THE PAIR BEFORE TRUSTING ITS PRICE. A pool address that turns out
  //    to hold a different pair would otherwise yield a confident wrong number,
  //    which is the exact failure mode this toolkit refuses everywhere else.
  const [token0Raw, token1Raw] = await Promise.all([
    reader.call(pool, SELECTOR_TOKEN0),
    reader.call(pool, SELECTOR_TOKEN1),
  ])
  const token0 = addressFrom(token0Raw)
  const token1 = addressFrom(token1Raw)
  const baseIsToken0 = token0 === base
  const pairMatches = (baseIsToken0 && token1 === quote) || (token1 === base && token0 === quote)
  if (!pairMatches) {
    throw new OnchainPriceError(
      `pool ${pool} holds ${token0}/${token1}, not ${base}/${quote}. Refusing to read a price from ` +
        `a pool that is not the pair it was configured as.`,
    )
  }
  const decimals0 = baseIsToken0 ? options.base.decimals : options.quote.decimals
  const decimals1 = baseIsToken0 ? options.quote.decimals : options.base.decimals

  // 2. TWAP, not spot.
  let returnData: string
  try {
    returnData = await reader.call(pool, encodeObserve([twapSeconds, 0]))
  } catch (error) {
    throw new OnchainPriceError(
      `observe([${twapSeconds}, 0]) on pool ${pool} failed: ${error instanceof Error ? error.message : String(error)}. ` +
        `A V3 pool reverts when its observation cardinality does not yet cover the window asked for. ` +
        `Lower the TWAP window or use a pool with more observations. NOT falling back to slot0 spot, ` +
        `which is manipulable within a single block.`,
    )
  }

  const cumulatives = decodeTickCumulatives(returnData)
  if (cumulatives.length !== 2) {
    throw new OnchainPriceError(`observe() returned ${cumulatives.length} tickCumulatives, expected 2`)
  }
  const delta = cumulatives[1]! - cumulatives[0]!
  const meanTick = meanTickFromCumulatives(delta, twapSeconds)
  const meanTickExact = Number(delta) / twapSeconds

  const priceInQuote = priceFromTick(meanTick, decimals0, decimals1, baseIsToken0)
  const priceUsd = priceInQuote * options.quote.pegUsd

  if (options.sanityBandUsd) {
    const { min, max } = options.sanityBandUsd
    if (priceUsd < min || priceUsd > max) {
      throw new OnchainPriceError(
        `on-chain TWAP resolved ${options.base.symbol} to $${priceUsd.toFixed(2)}, outside the configured ` +
          `sanity band $${min}..$${max}. Refusing the reading rather than reporting it.`,
      )
    }
  }

  const source =
    `onchain-twap:v3:${pool}:${twapSeconds}s:` +
    `${options.base.symbol}/${options.quote.symbol}@peg${options.quote.pegUsd}`

  return {
    priceUsd,
    source,
    pool,
    twapSeconds,
    meanTick,
    meanTickExact,
    baseSymbol: options.base.symbol,
    quoteSymbol: options.quote.symbol,
    quotePegUsd: options.quote.pegUsd,
    observedAtUnix: Math.floor(Date.now() / 1000),
    warnings: [
      `${options.base.symbol} was priced from an ON-CHAIN pool TWAP (${pool}, ${twapSeconds}s), not from a ` +
        `market data vendor. It is a venue price from one pool on one chain.`,
      `That reading is denominated in ${options.quote.symbol} and converted at an ASSUMED peg of ` +
        `$${options.quote.pegUsd.toFixed(2)}. If ${options.quote.symbol} is off its peg, every USD figure ` +
        `derived from this price is off by the same factor.`,
      `${options.base.symbol} is not the native asset. Applying this price to native credits repeats the ` +
        `documented ETH<-WETH substitution; they track closely and they are not the same asset.`,
    ],
  }
}

// ---------------------------------------------------------------------------
// Environment wiring. OFF unless explicitly configured.
// ---------------------------------------------------------------------------

export interface OnchainPriceConfig {
  pool: string
  twapSeconds: number
  base: { address: string; symbol: string; decimals: number }
  quote: { address: string; symbol: string; decimals: number; pegUsd: number }
}

/**
 * Build the on-chain price config from the environment, or return undefined when
 * the operator has not opted in. Opting in requires naming the POOL explicitly:
 * there is no discovered default, because a price source nobody chose is a price
 * source nobody checked.
 */
export function loadOnchainPriceConfig(
  env: NodeJS.ProcessEnv,
  defaults: { wethAddress: string },
): OnchainPriceConfig | undefined {
  const pool = env.VENUE_ONCHAIN_PRICE_POOL?.trim()
  if (pool === undefined || pool.length === 0) return undefined
  if (!/^0x[0-9a-fA-F]{40}$/.test(pool)) {
    throw new OnchainPriceError(`VENUE_ONCHAIN_PRICE_POOL must be an address, got "${pool}"`)
  }

  const quoteAddress = env.VENUE_ONCHAIN_PRICE_QUOTE?.trim()
  if (quoteAddress === undefined || !/^0x[0-9a-fA-F]{40}$/.test(quoteAddress)) {
    throw new OnchainPriceError(
      'VENUE_ONCHAIN_PRICE_QUOTE must be set to the address of the stablecoin the pool quotes in ' +
        '(e.g. USDG). It is not defaulted: pricing against the wrong side of a pool is silent.',
    )
  }
  const quoteSymbol = env.VENUE_ONCHAIN_PRICE_QUOTE_SYMBOL?.trim() ?? 'QUOTE'
  const quoteDecimalsRaw = env.VENUE_ONCHAIN_PRICE_QUOTE_DECIMALS?.trim()
  if (quoteDecimalsRaw === undefined) {
    throw new OnchainPriceError(
      'VENUE_ONCHAIN_PRICE_QUOTE_DECIMALS must be set. Decimals are READ from the chain everywhere else ' +
        'in this toolkit and are never assumed to be 18 - USDG is 6, and assuming 18 is a 10^12 error.',
    )
  }
  const quoteDecimals = Number(quoteDecimalsRaw)
  if (!Number.isInteger(quoteDecimals) || quoteDecimals < 0 || quoteDecimals > 36) {
    throw new OnchainPriceError(`VENUE_ONCHAIN_PRICE_QUOTE_DECIMALS must be an integer 0..36, got "${quoteDecimalsRaw}"`)
  }

  const pegRaw = env.VENUE_ONCHAIN_PRICE_QUOTE_PEG_USD?.trim()
  const pegUsd = pegRaw === undefined ? 1 : Number(pegRaw)
  if (!Number.isFinite(pegUsd) || pegUsd <= 0) {
    throw new OnchainPriceError(`VENUE_ONCHAIN_PRICE_QUOTE_PEG_USD must be a positive number, got "${String(pegRaw)}"`)
  }

  const twapRaw = env.VENUE_ONCHAIN_PRICE_TWAP_SECONDS?.trim()
  const twapSeconds = twapRaw === undefined ? DEFAULT_TWAP_SECONDS : Number(twapRaw)
  if (!Number.isInteger(twapSeconds) || twapSeconds <= 0) {
    throw new OnchainPriceError(
      `VENUE_ONCHAIN_PRICE_TWAP_SECONDS must be a positive integer, got "${String(twapRaw)}"`,
    )
  }

  const baseAddress = env.VENUE_ONCHAIN_PRICE_BASE?.trim() ?? defaults.wethAddress
  if (!/^0x[0-9a-fA-F]{40}$/.test(baseAddress)) {
    throw new OnchainPriceError(`VENUE_ONCHAIN_PRICE_BASE must be an address, got "${baseAddress}"`)
  }

  return {
    pool: pool.toLowerCase(),
    twapSeconds,
    base: {
      address: baseAddress.toLowerCase(),
      symbol: env.VENUE_ONCHAIN_PRICE_BASE_SYMBOL?.trim() ?? 'WETH',
      decimals: 18,
    },
    quote: {
      address: quoteAddress.toLowerCase(),
      symbol: quoteSymbol,
      decimals: quoteDecimals,
      pegUsd,
    },
  }
}

/**
 * Resolve the on-chain price, if one is configured, and apply it to a PriceBook.
 *
 * PRECEDENCE, and the reasoning for it:
 *
 *   VENUE_PRICE_USD_ETH set   -> the PINNED value still wins. An operator who
 *                               typed a number meant it, and having a tool
 *                               silently overrule an explicit input is its own
 *                               kind of unpleasant surprise. But the on-chain
 *                               reading is taken anyway and reported NEXT TO IT
 *                               with the discrepancy. That is the case that
 *                               matters: it is what turns "$3,200, unverified"
 *                               into "$3,200 pinned, chain says $2,490, you are
 *                               28.5% high" without anyone having to think of
 *                               checking.
 *
 *   VENUE_PRICE_USD_ETH unset -> the on-chain reading FILLS the gap, pinned to
 *                               address(0) and to the WETH address, and every
 *                               figure derived from it carries the provenance
 *                               string and the three standing caveats.
 *
 * Returns the warnings to surface. Throws if the operator asked for an on-chain
 * price and it could not be read: a requested price source that fails is a
 * refusal, not a licence to quietly use something else.
 */
export async function applyOnchainPrice(options: {
  reader: ChainReader
  prices: PriceBook
  config: OnchainPriceConfig
  /** Symbol prices already configured, from ToolConfig.priceUsdBySymbol. */
  pinnedBySymbol: Record<string, number>
  /** Reject a reading outside this band. Optional. */
  sanityBandUsd?: { min: number; max: number }
}): Promise<{ quote: OnchainPriceQuote; applied: boolean; warnings: string[] }> {
  const { reader, prices, config, pinnedBySymbol } = options
  const quote = await readOnchainTwapPrice(reader, {
    pool: config.pool,
    base: config.base,
    quote: config.quote,
    twapSeconds: config.twapSeconds,
    ...(options.sanityBandUsd ? { sanityBandUsd: options.sanityBandUsd } : {}),
  })

  const pinned = pinnedBySymbol[NATIVE_ASSET_SYMBOL]
  if (pinned !== undefined) {
    const deltaPct = ((pinned - quote.priceUsd) / quote.priceUsd) * 100
    return {
      quote,
      applied: false,
      warnings: [
        `PRICE CROSS-CHECK: VENUE_PRICE_USD_ETH is pinned at $${pinned.toFixed(2)} and the on-chain ` +
          `${config.base.symbol}/${config.quote.symbol} TWAP over ${config.twapSeconds}s reads ` +
          `$${quote.priceUsd.toFixed(2)}. The pinned value is ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}% ` +
          `against the chain. THE PINNED VALUE WAS USED; every USD figure in this run scales in it.` +
          (Math.abs(deltaPct) > 5
            ? ` A gap this size is material to threshold counts as well as to totals - re-check the pin before quoting anything.`
            : ''),
        ...quote.warnings,
      ],
    }
  }

  // Pin to the native sentinel AND to WETH: the escrow credits native value to
  // address(0), while an --assets file may name the WETH address directly.
  prices.registerAsset(nativeQuoteAsset(), quote.priceUsd)
  prices.registerAsset(
    { address: config.base.address, symbol: config.base.symbol, decimals: config.base.decimals },
    quote.priceUsd,
  )
  return {
    quote,
    applied: true,
    warnings: [
      `VENUE_PRICE_USD_ETH is not set, so the native asset was priced at $${quote.priceUsd.toFixed(2)} from ` +
        `the on-chain source ${quote.source}. This is a VENUE price, not a market quote.`,
      ...quote.warnings,
    ],
  }
}
