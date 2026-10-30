/**
 * Tool configuration, read from the environment exactly once, fail-closed.
 *
 * Nothing here has a network default that would silently point a measurement at
 * the wrong chain: if VENUE_RPC_URL is unset, the RPC backend refuses to run
 * rather than falling back to a public endpoint for some other network.
 */

import { join } from 'node:path'
import { VENUE } from '../../config/protocol.ts'

/**
 * Cache and artifact output live INSIDE tools/, resolved against this file
 * rather than the working directory, so a run from any cwd writes to the same
 * place and the repo's root .gitignore (owned by another track) needs no change.
 */
export const TOOLS_DIR = join(import.meta.dirname, '..')

export type EscrowBackend = 'rpc' | 'bitquery'

export interface ToolConfig {
  chainId: number
  /** Ordered RPC endpoints. Later entries are failover only. */
  rpcUrls: string[]
  /** Which escrow indexing backend to use. */
  escrowBackend: EscrowBackend
  bitqueryUrl: string
  bitqueryToken?: string
  bitqueryNetwork: string
  geckoTerminalBase: string
  geckoTerminalNetwork: string
  geckoTerminalDexIds: string[]
  cacheDir: string
  /** Global request rate ceiling for outbound HTTP, requests per second. */
  requestsPerSecond: number
  maxRetries: number
  requestTimeoutMs: number
  /** Largest block span asked for in a single eth_getLogs call. */
  logChunkBlocks: number
  /** USD prices by quote-asset symbol, with the provenance label below. */
  priceUsdBySymbol: Record<string, number>
  priceSource: string
  /** Approximate V2 deployment time. Bounds every tenure claim. */
  v2GenesisUnix: number
  /**
   * Used ONLY to size a --dry-run request budget. Never used to convert a real
   * timestamp to a block: that always goes through a binary search on headers,
   * because an L2 batch cadence drifts and a wrong constant would silently
   * shift the whole observation window.
   */
  estimatedBlockTimeSeconds: number
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * V2 was ~33 days old at the Phase 0 pass (6 Sep 2026), so V2 first appears
 * around 4 Aug 2026. This is a MEASURED ASSUMPTION, not a read constant: it is
 * the ceiling on every tenure number these tools can produce, so it is
 * overridable and it is printed in every report that depends on it.
 */
export const DEFAULT_V2_GENESIS_UNIX = Date.UTC(2026, 7, 4, 0, 0, 0) / 1000

const DEFAULT_GECKO_DEX_IDS = ['venue-v2-dex', 'venue-v2', 'venue-dot-family']

function envString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function envNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = envString(env, key)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${key} must be a positive number, got "${raw}"`)
  }
  return value
}

function envList(env: NodeJS.ProcessEnv, key: string): string[] {
  const raw = envString(env, key)
  if (raw === undefined) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Collect VENUE_PRICE_USD_<SYMBOL> overrides into a price book. */
function collectPrices(env: NodeJS.ProcessEnv): Record<string, number> {
  const prices: Record<string, number> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('VENUE_PRICE_USD_') || value === undefined) continue
    const symbol = key.slice('VENUE_PRICE_USD_'.length).toUpperCase()
    const price = Number(value)
    if (!Number.isFinite(price) || price <= 0) {
      throw new ConfigError(`${key} must be a positive number, got "${value}"`)
    }
    prices[symbol] = price
  }
  return prices
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ToolConfig {
  const backendRaw = (envString(env, 'ESCROW_BACKEND') ?? 'rpc').toLowerCase()
  if (backendRaw !== 'rpc' && backendRaw !== 'bitquery') {
    throw new ConfigError(`ESCROW_BACKEND must be "rpc" or "bitquery", got "${backendRaw}"`)
  }

  const rpcUrls = [
    ...(envString(env, 'VENUE_RPC_URL') ? [envString(env, 'VENUE_RPC_URL')!] : []),
    ...envList(env, 'VENUE_RPC_URLS'),
  ]

  const chainId = Number(envString(env, 'VENUE_CHAIN_ID') ?? VENUE.chainId)
  if (chainId !== VENUE.chainId) {
    throw new ConfigError(
      `VENUE_CHAIN_ID is ${chainId} but the protocol config pins ${VENUE.chainId}. Refusing to measure the wrong chain.`,
    )
  }

  const dexIds = envList(env, 'GECKOTERMINAL_DEX_IDS')

  return {
    chainId,
    rpcUrls,
    escrowBackend: backendRaw,
    bitqueryUrl: envString(env, 'BITQUERY_URL') ?? 'https://streaming.bitquery.io/graphql',
    ...(envString(env, 'BITQUERY_TOKEN') !== undefined
      ? { bitqueryToken: envString(env, 'BITQUERY_TOKEN')! }
      : {}),
    bitqueryNetwork: envString(env, 'BITQUERY_NETWORK') ?? 'robinhood',
    geckoTerminalBase: envString(env, 'GECKOTERMINAL_BASE') ?? 'https://api.geckoterminal.com/api/v2',
    geckoTerminalNetwork: envString(env, 'GECKOTERMINAL_NETWORK') ?? 'robinhood',
    geckoTerminalDexIds: dexIds.length > 0 ? dexIds : DEFAULT_GECKO_DEX_IDS,
    cacheDir: envString(env, 'VENUE_CACHE_DIR') ?? join(TOOLS_DIR, '.cache'),
    requestsPerSecond: envNumber(env, 'VENUE_HTTP_RPS', 4),
    maxRetries: Math.floor(envNumber(env, 'VENUE_HTTP_MAX_RETRIES', 5)),
    requestTimeoutMs: Math.floor(envNumber(env, 'VENUE_HTTP_TIMEOUT_MS', 30_000)),
    logChunkBlocks: Math.floor(envNumber(env, 'VENUE_LOG_CHUNK_BLOCKS', 5_000)),
    priceUsdBySymbol: collectPrices(env),
    priceSource: envString(env, 'VENUE_PRICE_SOURCE') ?? 'env:VENUE_PRICE_USD_*',
    v2GenesisUnix: Math.floor(envNumber(env, 'VENUE_V2_GENESIS_UNIX', DEFAULT_V2_GENESIS_UNIX)),
    estimatedBlockTimeSeconds: envNumber(env, 'VENUE_BLOCK_TIME_SECONDS', 0.25),
  }
}

/** Fail closed when an RPC-backed tool has no endpoint. */
export function requireRpcUrls(config: ToolConfig): string[] {
  if (config.rpcUrls.length === 0) {
    throw new ConfigError(
      'no RPC endpoint configured. Set VENUE_RPC_URL (chain 4663). There is deliberately no public fallback: ' +
        'a measurement against the wrong chain is worse than no measurement.',
    )
  }
  return config.rpcUrls
}

export const UNCONFIGURED_RPC_PLACEHOLDER = 'http://rpc-not-configured.invalid'

/**
 * Endpoints for a run, or a placeholder for a --dry-run.
 *
 * A dry run exists to show the plan and the request budget on a machine that
 * does not yet have credentials, so it must not fail closed on a missing URL -
 * but the placeholder is visibly fake and the caller adds a note saying so.
 */
export function rpcUrlsOrPlaceholder(config: ToolConfig, dryRun: boolean): string[] {
  if (config.rpcUrls.length > 0) return config.rpcUrls
  if (dryRun) return [UNCONFIGURED_RPC_PLACEHOLDER]
  return requireRpcUrls(config)
}

export function requireBitquery(config: ToolConfig): { url: string; token: string } {
  if (config.bitqueryToken === undefined) {
    throw new ConfigError('ESCROW_BACKEND=bitquery requires BITQUERY_TOKEN.')
  }
  return { url: config.bitqueryUrl, token: config.bitqueryToken }
}

/** Redacted view of the config, safe to print in --dry-run and in report meta. */
export function describeConfig(config: ToolConfig): Record<string, unknown> {
  return {
    chainId: config.chainId,
    rpcEndpointCount: config.rpcUrls.length,
    rpcHosts: config.rpcUrls.map(hostOf),
    escrowBackend: config.escrowBackend,
    bitqueryHost: hostOf(config.bitqueryUrl),
    bitqueryTokenPresent: config.bitqueryToken !== undefined,
    geckoTerminalHost: hostOf(config.geckoTerminalBase),
    geckoTerminalNetwork: config.geckoTerminalNetwork,
    geckoTerminalDexIds: config.geckoTerminalDexIds,
    cacheDir: config.cacheDir,
    requestsPerSecond: config.requestsPerSecond,
    logChunkBlocks: config.logChunkBlocks,
    priceSymbols: Object.keys(config.priceUsdBySymbol),
    priceSource: config.priceSource,
    v2GenesisUnix: config.v2GenesisUnix,
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '<unparseable>'
  }
}
