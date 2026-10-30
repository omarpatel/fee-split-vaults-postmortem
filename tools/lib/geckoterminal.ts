/**
 * GeckoTerminal public API client, narrow to what market sizing needs.
 *
 * THE PAGE CAP IS THE WHOLE PROBLEM. The public endpoint serves 20 pools per
 * page and refuses to page past 10, so ANY single query sees at most ~200 pools
 * per dex. Phase 0's "200+ above $143k/day" is that cap talking, not the market.
 *
 * The workaround implemented here is to enumerate the same dex under SEVERAL
 * SORT ORDERS and union the results by pool address. Each sort exposes a
 * different 200-pool slice: volume-desc finds the top of the fee distribution,
 * created-at-desc finds new launches that have not accumulated volume yet, and
 * tx-count-desc finds high-frequency low-notional pools. The union is strictly
 * larger than any one view and is still a LOWER BOUND, which is why every
 * result carries an explicit coverage block saying so.
 */

import type { Cache } from './cache.ts'
import { cacheKey } from './cache.ts'
import type { HttpClient } from './http.ts'

const GT_SCHEMA_VERSION = 'geckoterminal-1'

/** Sort orders used to widen coverage past the per-query page cap. */
export const DEFAULT_SORTS = [
  'h24_volume_usd_desc',
  'h24_tx_count_desc',
  'pool_created_at_desc',
  'h24_volume_usd_liquidity_desc',
] as const

/** Hard limits imposed by the upstream API, restated in every report. */
export const GT_LIMITS = {
  pageSize: 20,
  maxPage: 10,
  get maxPoolsPerQuery(): number {
    return this.pageSize * this.maxPage
  },
} as const

export interface GtPool {
  /** Network-qualified id, e.g. "robinhood_0xabc...". */
  id: string
  address: string
  name: string
  dexId: string
  baseTokenAddress: string
  quoteTokenAddress: string
  volumeUsd24h: number
  /**
   * False when the upstream row carried no 24h volume at all. `volumeUsd24h` is
   * then 0 for arithmetic convenience ONLY, and every gate count that includes
   * this pool is a floor. Never render a zero from an unknown-volume pool as a
   * measured $0.
   */
  volumeKnown: boolean
  reserveUsd: number
  createdAtUnix: number | undefined
  txCount24h: number
  /** Which sort orders surfaced this pool. Coverage diagnostics. */
  seenVia: string[]
}

export interface GtCoverage {
  dexId: string
  sortsUsed: string[]
  /** Pools returned per sort, before the union. */
  perSortCounts: Record<string, number>
  unionCount: number
  /** True when any sort filled its entire page budget: more pools exist. */
  hitPageCap: boolean
  pagesFetched: number
}

interface JsonApiResource {
  id?: string
  type?: string
  attributes?: Record<string, unknown>
  relationships?: Record<string, { data?: { id?: string; type?: string } | null }>
}

/**
 * A number the upstream JSON may or may not have. `undefined` means ABSENT.
 *
 * The difference matters: this used to return 0 for a missing field, and a pool
 * whose volume is unknown then counts as a pool doing $0/day, which places it
 * below every QF gate. A missing input became a measurement of zero.
 */
export function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** For fields where absent and zero are genuinely the same (trade counts). */
function readNumber(value: unknown): number {
  return readOptionalNumber(value) ?? 0
}

/** Strip the "network_" prefix GeckoTerminal puts on token and dex ids. */
export function stripNetworkPrefix(id: string | undefined): string {
  if (id === undefined) return ''
  const index = id.indexOf('_')
  return index === -1 ? id.toLowerCase() : id.slice(index + 1).toLowerCase()
}

export function parsePool(resource: JsonApiResource, fallbackDexId: string): GtPool | undefined {
  const attributes = resource.attributes
  if (attributes === undefined) return undefined
  const address = typeof attributes.address === 'string' ? attributes.address.toLowerCase() : ''
  if (address.length === 0) return undefined

  const volume = attributes.volume_usd as Record<string, unknown> | undefined
  const transactions = attributes.transactions as Record<string, unknown> | undefined
  const h24 = transactions?.h24 as Record<string, unknown> | undefined
  const createdAt = attributes.pool_created_at
  const createdAtUnix =
    typeof createdAt === 'string' && !Number.isNaN(Date.parse(createdAt))
      ? Math.floor(Date.parse(createdAt) / 1000)
      : undefined

  return {
    id: typeof resource.id === 'string' ? resource.id : address,
    address,
    name: typeof attributes.name === 'string' ? attributes.name : '',
    dexId: stripNetworkPrefix(resource.relationships?.dex?.data?.id) || fallbackDexId,
    baseTokenAddress: stripNetworkPrefix(resource.relationships?.base_token?.data?.id),
    quoteTokenAddress: stripNetworkPrefix(resource.relationships?.quote_token?.data?.id),
    volumeUsd24h: readOptionalNumber(volume?.h24) ?? 0,
    volumeKnown: readOptionalNumber(volume?.h24) !== undefined,
    reserveUsd: readNumber(attributes.reserve_in_usd),
    ...(createdAtUnix !== undefined ? { createdAtUnix } : { createdAtUnix: undefined }),
    txCount24h: readNumber(h24?.buys) + readNumber(h24?.sells),
    seenVia: [],
  }
}

export function parsePoolList(body: string, fallbackDexId: string): GtPool[] {
  const parsed = JSON.parse(body) as { data?: JsonApiResource[]; errors?: Array<{ title?: string }> }
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(`geckoterminal: ${parsed.errors.map((e) => e.title ?? 'error').join('; ')}`)
  }
  const rows = parsed.data ?? []
  const pools: GtPool[] = []
  for (const row of rows) {
    const pool = parsePool(row, fallbackDexId)
    if (pool !== undefined) pools.push(pool)
  }
  return pools
}

export interface GeckoTerminalOptions {
  baseUrl: string
  network: string
  http: HttpClient
  cache?: Cache
  /** Cached page TTL. Volume is a rolling 24h figure, so it goes stale fast. */
  cacheTtlSeconds?: number
  onProgress?: (message: string) => void
}

export class GeckoTerminalClient {
  readonly #options: GeckoTerminalOptions

  constructor(options: GeckoTerminalOptions) {
    this.#options = options
  }

  async #getJson(path: string, label: string): Promise<string> {
    const url = `${this.#options.baseUrl.replace(/\/$/, '')}${path}`
    const key = cacheKey({ kind: 'gt', url })
    const cached = await this.#options.cache?.get<string>(
      key,
      GT_SCHEMA_VERSION,
      this.#options.cacheTtlSeconds ?? 900,
    )
    if (cached !== undefined) return cached

    const response = await this.#options.http.request({
      url,
      method: 'GET',
      headers: { accept: 'application/json' },
      label,
    })
    if (response.status === 404) {
      throw new Error(`geckoterminal: 404 for ${path}. The network or dex id is probably wrong.`)
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`geckoterminal: HTTP ${response.status} for ${path}: ${response.body.slice(0, 200)}`)
    }
    await this.#options.cache?.set(key, GT_SCHEMA_VERSION, response.body)
    return response.body
  }

  /** One page of a dex's pools under one sort order. */
  async dexPoolsPage(dexId: string, sort: string, page: number): Promise<GtPool[]> {
    const path = `/networks/${encodeURIComponent(this.#options.network)}/dexes/${encodeURIComponent(dexId)}/pools?page=${page}&sort=${encodeURIComponent(sort)}`
    return parsePoolList(await this.#getJson(path, `gt:dexPools:${dexId}:${sort}:${page}`), dexId)
  }

  /**
   * Enumerate one dex as widely as the page cap allows, unioning across sorts.
   * Stops a sort early when a page comes back short, since that means the end.
   */
  async enumerateDex(
    dexId: string,
    sorts: readonly string[],
    maxPages: number = GT_LIMITS.maxPage,
  ): Promise<{ pools: Map<string, GtPool>; coverage: GtCoverage }> {
    const pools = new Map<string, GtPool>()
    const perSortCounts: Record<string, number> = {}
    let pagesFetched = 0
    let hitPageCap = false

    for (const sort of sorts) {
      let sortCount = 0
      for (let page = 1; page <= maxPages; page++) {
        let batch: GtPool[]
        try {
          batch = await this.dexPoolsPage(dexId, sort, page)
        } catch (error) {
          this.#options.onProgress?.(
            `gt: ${dexId} sort=${sort} page=${page} failed: ${error instanceof Error ? error.message : String(error)}`,
          )
          break
        }
        pagesFetched++
        sortCount += batch.length
        for (const pool of batch) {
          const existing = pools.get(pool.address)
          if (existing === undefined) {
            pools.set(pool.address, { ...pool, seenVia: [sort] })
          } else if (!existing.seenVia.includes(sort)) {
            existing.seenVia.push(sort)
          }
        }
        if (batch.length < GT_LIMITS.pageSize) break
        if (page === maxPages) hitPageCap = true
      }
      perSortCounts[sort] = sortCount
      this.#options.onProgress?.(`gt: ${dexId} sort=${sort} -> ${sortCount} pools`)
    }

    return {
      pools,
      coverage: {
        dexId,
        sortsUsed: [...sorts],
        perSortCounts,
        unionCount: pools.size,
        hitPageCap,
        pagesFetched,
      },
    }
  }

  /**
   * Every pool GeckoTerminal knows for a token, across all dexes.
   *
   * This is what makes the Venue-pool volume SHARE computable. CASHCAT showed a
   * 122x gap between headline token volume and fee-bearing Venue-pool volume;
   * without this call, a market count built on headline volume is wrong by up
   * to that factor.
   */
  async tokenPools(tokenAddress: string): Promise<GtPool[]> {
    const path = `/networks/${encodeURIComponent(this.#options.network)}/tokens/${encodeURIComponent(tokenAddress)}/pools`
    return parsePoolList(await this.#getJson(path, `gt:tokenPools:${tokenAddress}`), 'unknown')
  }
}
