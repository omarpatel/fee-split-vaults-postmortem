/**
 * Delivery evidence from Dexscreener's public pairs API.
 *
 * One endpoint: GET {baseUrl}/token-pairs/v1/{chainSlug}/{tokenAddress}, an
 * array of pair records. An enhanced listing shows up as an `info` object on
 * the record (socials, websites, image); a boost pack shows up as
 * `boosts.active`. Dexscreener publishes no rank endpoint, so a trending SKU is
 * refused as unmeasurable rather than measured against something invented.
 *
 * Every observation cites the sha256 of the exact bytes the API returned. The
 * bytes themselves are not retained: the receipt carries a hash, not a body.
 *
 * Transport is one attempt plus one retry on a transport failure, 429 or 5xx.
 * Anything else that is not a 200 with a JSON array is a typed error, and the
 * predicate registry turns a thrown error into "not delivered".
 */
import type { Address } from '@fee-split-vaults/core'
import { BrokerError, sha256Hex, type EtiListingObservation, type EvidenceRef, type EvidenceSource } from '@fee-split-vaults/broker'
import type { ExternalVolumeObserver } from '@fee-split-vaults/indexer'
import { SourceUnavailableError } from '../errors.js'

/** The `pairSource` value the shipped eti_listing predicate names. */
export const DEXSCREENER_PAIR_SOURCE = 'dexscreener_pairs_api'

const DEFAULT_BASE_URL = 'https://api.dexscreener.com'
const SOURCE = 'dexscreener'

export interface DexscreenerEvidenceSourceOptions {
  /** The chain the predicate names, e.g. "4663". Reported back on every observation. */
  chain: string
  /** Dexscreener's own path segment for that chain. Operator config; no default. */
  chainSlug: string
  fetchImpl?: typeof fetch
  baseUrl?: string
  timeoutMs?: number
}

interface PairRecord {
  chainId?: unknown
  baseToken?: { address?: unknown }
  liquidity?: { usd?: unknown }
  info?: {
    socials?: unknown
    websites?: unknown
  }
  boosts?: { active?: unknown }
  volume?: { h24?: unknown }
}

export class DexscreenerEvidenceSource implements EvidenceSource, ExternalVolumeObserver {
  readonly #chain: string
  readonly #chainSlug: string
  readonly #fetch: typeof fetch
  readonly #baseUrl: string
  readonly #timeoutMs: number

  constructor(options: DexscreenerEvidenceSourceOptions) {
    if (options.chain.length === 0 || options.chainSlug.length === 0) {
      throw new SourceUnavailableError(SOURCE, 'chain and chainSlug are required')
    }
    this.#chain = options.chain
    this.#chainSlug = options.chainSlug
    this.#fetch = options.fetchImpl ?? fetch
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.#timeoutMs = options.timeoutMs ?? 5_000
  }

  async #pairs(token: Address): Promise<{ pairs: PairRecord[]; ref: EvidenceRef }> {
    const url = `${this.#baseUrl}/token-pairs/v1/${encodeURIComponent(this.#chainSlug)}/${encodeURIComponent(token)}`
    let lastFailure = ''
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response: Response
      try {
        response = await this.#fetch(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(this.#timeoutMs),
        })
      } catch (cause) {
        lastFailure = `transport failure: ${String(cause)}`
        continue
      }
      if (response.status === 429 || response.status >= 500) {
        lastFailure = `HTTP ${response.status}`
        continue
      }
      if (response.status !== 200) {
        throw new SourceUnavailableError(SOURCE, `HTTP ${response.status} for ${url}`)
      }
      const raw = await response.text()
      let body: unknown
      try {
        body = JSON.parse(raw)
      } catch {
        throw new SourceUnavailableError(SOURCE, `non-JSON body for ${url}`)
      }
      if (!Array.isArray(body)) {
        throw new SourceUnavailableError(SOURCE, `expected a pair array for ${url}`)
      }
      const wanted = token.toLowerCase()
      const pairs = body.filter(
        (p): p is PairRecord =>
          typeof p === 'object' &&
          p !== null &&
          typeof (p as PairRecord).baseToken?.address === 'string' &&
          ((p as PairRecord).baseToken?.address as string).toLowerCase() === wanted,
      )
      return { pairs, ref: { uri: url, hash: sha256Hex(raw) } }
    }
    throw new SourceUnavailableError(SOURCE, `${lastFailure} after 2 attempts for ${url}`)
  }

  /** The record a listing is read from: the deepest pool, so a dust pair cannot stand in. */
  static #primary(pairs: readonly PairRecord[]): PairRecord | undefined {
    let best: PairRecord | undefined
    let bestUsd = -1
    for (const pair of pairs) {
      const usd = typeof pair.liquidity?.usd === 'number' ? pair.liquidity.usd : 0
      if (usd > bestUsd) {
        best = pair
        bestUsd = usd
      }
    }
    return best
  }

  async etiListing(token: Address): Promise<EtiListingObservation | null> {
    const { pairs, ref } = await this.#pairs(token)
    const primary = DexscreenerEvidenceSource.#primary(pairs)
    const info = primary?.info
    const presentFields =
      primary === undefined
        ? []
        : Object.keys(primary).filter((key) => (primary as Record<string, unknown>)[key] !== null)
    const platforms = new Set<string>()
    if (info !== undefined && Array.isArray(info.socials)) {
      for (const social of info.socials) {
        const platform = (social as { platform?: unknown; handle?: unknown } | null)?.platform
        const handle = (social as { platform?: unknown; handle?: unknown } | null)?.handle
        if (typeof platform === 'string' && platform.length > 0 && typeof handle === 'string' && handle.length > 0) {
          platforms.add(platform.toLowerCase())
        }
      }
    }
    return {
      chain: this.#chain,
      pairSource: DEXSCREENER_PAIR_SOURCE,
      presentFields,
      socialsPresent: platforms.size,
      ref,
    }
  }

  /**
   * Boosts are per token, mirrored onto every pair. A record with no `boosts`
   * object is a token with none active - that is how the API reports zero - so
   * the count is the largest `active` seen, or 0 when the token has pairs but
   * no boosts. No pairs at all is not a zero; it is nothing to measure.
   */
  async boostCount(token: Address): Promise<{ boosts: number; ref: EvidenceRef } | null> {
    const { pairs, ref } = await this.#pairs(token)
    if (pairs.length === 0) return null
    let boosts = 0
    for (const pair of pairs) {
      const active = pair.boosts?.active
      if (active === undefined) continue
      if (typeof active !== 'number' || !Number.isInteger(active) || active < 0) return null
      if (active > boosts) boosts = active
    }
    return { boosts, ref }
  }

  /**
   * Headline 24h USD volume, summed over EVERY pair Dexscreener lists for the
   * token on this chain - the "total" side of the pool-share signal is about
   * all venues, and a token with two pools trades in both. A pair whose
   * volume is not a finite non-negative number makes the whole reading
   * unusable: summing around it would report the other pairs as the total.
   * No pairs is nothing to measure, not zero.
   */
  async volume24hUsd(token: Address): Promise<{ totalVolumeUsd: number; source: string; observedAtUnix: number } | undefined> {
    const { pairs, ref } = await this.#pairs(token)
    if (pairs.length === 0) return undefined
    let total = 0
    for (const pair of pairs) {
      const h24 = pair.volume?.h24
      if (typeof h24 !== 'number' || !Number.isFinite(h24) || h24 < 0) return undefined
      total += h24
    }
    return { totalVolumeUsd: total, source: `${SOURCE}:${ref.hash}`, observedAtUnix: Math.floor(Date.now() / 1000) }
  }

  /** Dexscreener exposes no rank. A rank this source reported would be made up. */
  async trendingRank(): Promise<{ rank: number | null; ref: EvidenceRef } | null> {
    throw new BrokerError(
      'measurability',
      'unmeasurable',
      'dexscreener publishes no trending rank endpoint; a trending_rank predicate cannot be verified from this source',
    )
  }

  async post(): Promise<null> {
    throw new BrokerError('measurability', 'unmeasurable', 'dexscreener carries no KOL post evidence')
  }

  async attestation(): Promise<null> {
    throw new BrokerError('measurability', 'unmeasurable', 'dexscreener carries no attestation evidence')
  }
}
