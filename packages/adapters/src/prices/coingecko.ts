/**
 * Live USD prices from CoinGecko, DECIDED and pinned.
 *
 * The orchestrator's price book is synchronous and historical: priceAt(asset,
 * t) answers with the pin in force at t, and requirePrice() refuses one older
 * than the caller's window (15 minutes for a spend, two days for a QF read).
 * So this book is an InMemoryPriceBook that knows how to fetch its next pin.
 * `refresh()` is what the tick loop calls before it reads; it is a no-op inside
 * the cache window, and it never pins a quote CoinGecko itself reports as older
 * than the live-money window, because a stale upstream price is not a price.
 *
 * Venue (chain 4663) is not a CoinGecko asset platform, so there is no address
 * lookup: the operator maps each quote asset address to a CoinGecko coin id.
 * An asset outside that map has no price, which is a refusal, not a default.
 */
import type { AssetAddress } from '@fee-split-vaults/core'
import { PRICE_MAX_AGE_SECONDS } from '@fee-split-vaults/broker'
import { InMemoryPriceBook, type PinnedUsdPrice } from '@fee-split-vaults/orchestrator'
import { CredentialMissingError, SourceUnavailableError } from '../errors.js'

const DEFAULT_BASE_URL = 'https://api.coingecko.com/api/v3'
const SOURCE = 'coingecko'

/** Quote asset address -> CoinGecko coin id, e.g. USDG -> 'global-dollar'. */
export type CoinGeckoIdMap = Readonly<Record<string, string>>

export interface CoinGeckoPriceBookOptions {
  ids: CoinGeckoIdMap
  fetchImpl?: typeof fetch
  /** `https://api.coingecko.com/api/v3` or the pro origin. */
  baseUrl?: string
  /** Sent as `x-cg-demo-api-key` (default origin) or `x-cg-pro-api-key` (pro origin). */
  apiKey?: string
  timeoutMs?: number
  /** A pin younger than this is served without a network read. */
  cacheSeconds?: number
  /** Upstream `last_updated_at` older than this against now is refused, not pinned. */
  maxAgeSeconds?: number
  nowUnix?: () => number
}

export class CoinGeckoPriceBook extends InMemoryPriceBook {
  readonly #ids: Map<string, string>
  readonly #fetch: typeof fetch
  readonly #baseUrl: string
  readonly #apiKey: string | undefined
  readonly #timeoutMs: number
  readonly #cacheSeconds: number
  readonly #maxAgeSeconds: number
  readonly #nowUnix: () => number
  /** asset -> when this process last read it; the cache window is measured from here. */
  readonly #fetched = new Map<string, { atUnix: number; price: PinnedUsdPrice }>()

  constructor(options: CoinGeckoPriceBookOptions) {
    super()
    this.#ids = new Map()
    for (const [asset, id] of Object.entries(options.ids)) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(asset) || id.length === 0) {
        throw new SourceUnavailableError(SOURCE, `bad id map entry ${asset} -> "${id}"`)
      }
      this.#ids.set(asset.toLowerCase(), id)
    }
    this.#fetch = options.fetchImpl ?? fetch
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.#apiKey = options.apiKey
    this.#timeoutMs = options.timeoutMs ?? 5_000
    this.#cacheSeconds = options.cacheSeconds ?? 60
    this.#maxAgeSeconds = options.maxAgeSeconds ?? PRICE_MAX_AGE_SECONDS
    this.#nowUnix = options.nowUnix ?? (() => Math.floor(Date.now() / 1000))
  }

  get assets(): AssetAddress[] {
    return [...this.#ids.keys()]
  }

  /** The pin in force now, fetched unless one younger than the cache window exists. */
  async refresh(asset: AssetAddress): Promise<PinnedUsdPrice> {
    const id = this.#ids.get(asset.toLowerCase())
    if (id === undefined) {
      throw new CredentialMissingError(
        'COINGECKO id map',
        `asset ${asset} has no CoinGecko coin id; map it or the asset has no price`,
      )
    }
    const now = this.#nowUnix()
    const cached = this.#fetched.get(asset.toLowerCase())
    if (cached !== undefined && now - cached.atUnix <= this.#cacheSeconds) return cached.price

    const url =
      `${this.#baseUrl}/simple/price?ids=${encodeURIComponent(id)}` +
      '&vs_currencies=usd&include_last_updated_at=true&precision=full'
    const headers: Record<string, string> = { accept: 'application/json' }
    if (this.#apiKey !== undefined) {
      headers[this.#baseUrl.includes('pro-api') ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key'] = this.#apiKey
    }
    let response: Response
    try {
      response = await this.#fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(this.#timeoutMs) })
    } catch (cause) {
      throw new SourceUnavailableError(SOURCE, `transport failure for ${id}`, cause)
    }
    if (response.status !== 200) {
      throw new SourceUnavailableError(SOURCE, `HTTP ${response.status} for ${id}`)
    }
    let body: unknown
    try {
      body = JSON.parse(await response.text())
    } catch {
      throw new SourceUnavailableError(SOURCE, `non-JSON body for ${id}`)
    }
    const quote = (body as Record<string, { usd?: unknown; last_updated_at?: unknown } | undefined>)[id]
    if (quote === undefined || typeof quote.usd !== 'number' || !Number.isFinite(quote.usd)) {
      throw new SourceUnavailableError(SOURCE, `no usd quote for ${id}`)
    }
    if (typeof quote.last_updated_at !== 'number' || !Number.isInteger(quote.last_updated_at)) {
      throw new SourceUnavailableError(SOURCE, `no last_updated_at for ${id}; an undated price cannot be aged`)
    }
    const pricedAtUnix = quote.last_updated_at
    if (pricedAtUnix > now + 60 || now - pricedAtUnix > this.#maxAgeSeconds) {
      throw new SourceUnavailableError(
        SOURCE,
        `quote for ${id} is ${now - pricedAtUnix}s old, limit ${this.#maxAgeSeconds}s; refusing to pin it`,
      )
    }
    // Whole cents per whole unit, nearest. A price that rounds to nothing is
    // not a price this book can express, and a zero would make every pull
    // divide by it.
    const cents = BigInt(Math.round(quote.usd * 100))
    if (cents < 1n) {
      throw new SourceUnavailableError(SOURCE, `quote for ${id} (${quote.usd} USD) is below one cent`)
    }
    const price: PinnedUsdPrice = {
      asset: asset.toLowerCase(),
      centsPerWholeUnit: cents,
      source: `${SOURCE}:${id}`,
      pricedAtUnix,
    }
    // Same upstream instant twice is the same pin; do not duplicate it.
    const existing = this.priceAt(asset, pricedAtUnix)
    if (existing === undefined || existing.pricedAtUnix !== pricedAtUnix) this.pin(price)
    this.#fetched.set(asset.toLowerCase(), { atUnix: now, price })
    return price
  }

  /** Every mapped asset, so one failure surfaces per asset rather than as one throw. */
  async refreshAll(): Promise<Map<AssetAddress, PinnedUsdPrice | SourceUnavailableError | CredentialMissingError>> {
    const out = new Map<AssetAddress, PinnedUsdPrice | SourceUnavailableError | CredentialMissingError>()
    for (const asset of this.#ids.keys()) {
      try {
        out.set(asset, await this.refresh(asset))
      } catch (error) {
        if (error instanceof SourceUnavailableError || error instanceof CredentialMissingError) {
          out.set(asset, error)
          continue
        }
        throw error
      }
    }
    return out
  }
}
