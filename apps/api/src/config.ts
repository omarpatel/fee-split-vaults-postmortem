/**
 * Configuration, read once from the environment, fail-closed.
 *
 * There is no default that would let the service run against the wrong chain,
 * the wrong factory, or with disclosure naming nobody. Every one of those is a
 * missing-variable error at boot rather than a surprise at the first request.
 *
 * .env.example at the repository root lists every variable read here.
 */

import { requireOperatorName } from '@fee-split-vaults/core'
import { VENUE, DISCLOSURE } from '../../../config/protocol.js'
import {
  DEV_ONLY_MARKER_ENV,
  isDevOnlyValue,
  isProductionEnv,
  isStructurallyUnreachableAddress,
} from '../../../config/dev-only.js'
import { isAddress, isBytes32, normalizeAddress } from './crypto/address.js'
import type { FactoryDescriptor } from './deploy.js'
import type { Eip712Domain } from './eip712.js'

export class ConfigError extends Error {
  constructor(message: string) {
    super(`config: ${message}`)
    this.name = 'ConfigError'
  }
}

export interface XOAuthConfig {
  clientId: string
  /** Absent for a public client; X then expects client_id in the token request body. */
  clientSecret?: string
  redirectUri: string
}

export interface ApiConfig {
  port: number
  chainId: number
  factory: FactoryDescriptor
  domain: Eip712Domain
  operatorToken: string
  operatorName: string
  /** Public receipts base. Must be https; disclosure links are built from it. */
  receiptsBaseUrl: string
  screeningMaxAgeSeconds: number
  antiSnipeHoldSeconds: number
  /**
   * RPC endpoints for the pinned reads: [primary, secondary]. Two, because
   * reads need a quorum, and the same pair the fleet reads.
   */
  rpcUrls: [string, string]
  rpcTimeoutMs: number
  /** Requests per second per endpoint. The chain answers about 0.8. */
  rpcRps: number
  /** Postgres. Absent means every store is in-memory and forgets on restart. */
  databaseUrl?: string
  /**
   * X OAuth 2.0 application. Absent means the /accounts/x routes answer 503
   * feature_unconfigured; nothing else in the service depends on it.
   */
  x?: XOAuthConfig
  /**
   * AES-256-GCM key (32 bytes, hex) for OAuth tokens at rest. Required whenever
   * X is configured: a stored access token is a posting credential, and it is
   * never written unencrypted.
   */
  publisherTokenKey?: string
  /** App-only bearer for reading tweets named as narrative sources. Absent: those sources are refused. */
  xReadBearerToken?: string
  /** Font files pinned for creative renders. Empty means the host's fonts. */
  creativeFontFiles: string[]
  /**
   * The operator's signing key, 0x + 64 hex. Present means the vault deployer
   * broadcasts real transactions; absent means deployment refuses.
   */
  operatorSignerKey?: string
  /** FLEET_PRICES=coingecko: quote asset address -> CoinGecko id, plus the optional key. */
  prices?: { ids: Record<string, string>; apiKey?: string }
  /**
   * What the web's onboarding quote pins into a consent on the dev's behalf:
   * the adapter, the MSA hash and where the MSA is read. All three or none;
   * absent means /v1/protocol and /v1/onboarding/quote answer 503.
   */
  terms?: { adapter: string; termsHash: string; termsUrl: string; referrerShareBps?: number }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim()
  if (value === undefined || value.length === 0) {
    throw new ConfigError(`${key} is required and has no safe default`)
  }
  return value
}

function requiredAddress(env: NodeJS.ProcessEnv, key: string): string {
  const value = required(env, key)
  if (!isAddress(value)) throw new ConfigError(`${key} must be a 0x address`)
  return normalizeAddress(value)
}

function optionalInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim()
  if (raw === undefined || raw.length === 0) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${key} must be a positive integer`)
  }
  return value
}

/**
 * The two endpoints, from either spelling: VENUE_RPC_URLS as a comma list, or
 * VENUE_RPC_URL plus VENUE_RPC_URL_SECONDARY the way the fleet reads them. Two
 * distinct endpoints or a refusal; one provider agreeing with itself is not a
 * quorum, and there is deliberately no single-provider fallback.
 */
function rpcEndpoints(env: NodeJS.ProcessEnv): [string, string] {
  const list = env.VENUE_RPC_URLS?.trim()
  const urls =
    list !== undefined && list.length > 0
      ? list.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      : [env.VENUE_RPC_URL?.trim() ?? '', env.VENUE_RPC_URL_SECONDARY?.trim() ?? 'https://rpc.ordofi.network'].filter(
          (s) => s.length > 0,
        )
  const [primary, secondary] = urls
  if (primary === undefined || secondary === undefined) {
    throw new ConfigError('VENUE_RPC_URLS must list at least two independent endpoints (or set VENUE_RPC_URL and VENUE_RPC_URL_SECONDARY)')
  }
  if (primary === secondary) {
    throw new ConfigError('the two RPC endpoints are the same; a quorum of one provider agreeing with itself is not a quorum')
  }
  for (const url of [primary, secondary]) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new ConfigError(`RPC endpoint ${JSON.stringify(url)} is not a URL`)
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new ConfigError(`RPC endpoint ${url} must be http(s)`)
    }
  }
  return [primary, secondary]
}

function optionalSignerKey(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.OPERATOR_SIGNER_KEY?.trim()
  if (raw === undefined || raw.length === 0) return undefined
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new ConfigError('OPERATOR_SIGNER_KEY must be 0x followed by 64 hex characters')
  return raw.toLowerCase()
}

/**
 * FLEET_PRICES=coingecko asks for real prices and needs COINGECKO_IDS; the
 * same all-or-nothing rule the fleet applies, with the same messages.
 */
function optionalPrices(env: NodeJS.ProcessEnv): ApiConfig['prices'] | undefined {
  const mode = env.FLEET_PRICES?.trim()
  if (mode === undefined || mode.length === 0) return undefined
  if (mode !== 'coingecko') throw new ConfigError(`FLEET_PRICES=${mode} is not a mode this build knows`)
  const raw = required(env, 'COINGECKO_IDS')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ConfigError(`COINGECKO_IDS is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError('COINGECKO_IDS must be a JSON object of asset address -> CoinGecko id')
  }
  const ids: Record<string, string> = {}
  for (const [asset, id] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isAddress(asset) || typeof id !== 'string' || id.trim().length === 0) {
      throw new ConfigError(`COINGECKO_IDS entry ${asset} -> ${JSON.stringify(id)} is not an address -> id pair`)
    }
    ids[normalizeAddress(asset)] = id.trim()
  }
  if (Object.keys(ids).length === 0) throw new ConfigError('COINGECKO_IDS maps no asset')
  const apiKey = env.COINGECKO_API_KEY?.trim()
  return { ids, ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }) }
}

/**
 * The X application and its token key, together or not at all. Half a
 * configuration - a client id with nowhere to redirect, or credentials with no
 * key to store them under - would let a handshake start and then fail with the
 * operator mid-browser, so it is refused at boot instead.
 */
function optionalXConfig(env: NodeJS.ProcessEnv): Pick<ApiConfig, 'x' | 'publisherTokenKey'> {
  const clientId = env.X_CLIENT_ID?.trim()
  const redirectUri = env.X_REDIRECT_URI?.trim()
  const clientSecret = env.X_CLIENT_SECRET?.trim()
  const tokenKey = env.PUBLISHER_TOKEN_KEY?.trim()
  const xSet = (clientId !== undefined && clientId.length > 0) || (redirectUri !== undefined && redirectUri.length > 0)

  const result: Pick<ApiConfig, 'x' | 'publisherTokenKey'> = {}
  if (tokenKey !== undefined && tokenKey.length > 0) {
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(tokenKey)) {
      throw new ConfigError('PUBLISHER_TOKEN_KEY must be 32 bytes of hex')
    }
    result.publisherTokenKey = tokenKey.replace(/^0x/, '').toLowerCase()
  }
  if (!xSet) {
    if (clientSecret !== undefined && clientSecret.length > 0) {
      throw new ConfigError('X_CLIENT_SECRET is set without X_CLIENT_ID and X_REDIRECT_URI')
    }
    return result
  }

  if (clientId === undefined || clientId.length === 0) {
    throw new ConfigError('X_CLIENT_ID is required when X_REDIRECT_URI is set')
  }
  if (redirectUri === undefined || redirectUri.length === 0) {
    throw new ConfigError('X_REDIRECT_URI is required when X_CLIENT_ID is set')
  }
  let parsed: URL
  try {
    parsed = new URL(redirectUri)
  } catch {
    throw new ConfigError('X_REDIRECT_URI is not a URL')
  }
  if (parsed.protocol !== 'https:') throw new ConfigError('X_REDIRECT_URI must be https')
  if (result.publisherTokenKey === undefined) {
    throw new ConfigError('PUBLISHER_TOKEN_KEY is required when X_CLIENT_ID is set; OAuth tokens are never stored unencrypted')
  }
  result.x = { clientId, redirectUri }
  if (clientSecret !== undefined && clientSecret.length > 0) result.x.clientSecret = clientSecret
  return result
}

/**
 * The published terms, together or not at all. A quote that pins an adapter
 * without naming the MSA it binds the dev to is not an offer.
 */
function optionalTerms(env: NodeJS.ProcessEnv): ApiConfig['terms'] | undefined {
  const adapter = env.VENUE_ADAPTER?.trim()
  const termsHash = env.VENUE_TERMS_HASH?.trim()
  const termsUrl = env.VENUE_TERMS_URL?.trim()
  const referrerShare = env.VENUE_REFERRER_SHARE_BPS?.trim()
  const set = [adapter, termsHash, termsUrl].filter((value) => value !== undefined && value.length > 0)
  if (set.length === 0) {
    if (referrerShare !== undefined && referrerShare.length > 0) {
      throw new ConfigError('VENUE_REFERRER_SHARE_BPS is set without VENUE_ADAPTER, VENUE_TERMS_HASH and VENUE_TERMS_URL')
    }
    return undefined
  }
  if (set.length !== 3) {
    throw new ConfigError('VENUE_ADAPTER, VENUE_TERMS_HASH and VENUE_TERMS_URL must be set together')
  }
  if (!isAddress(adapter)) throw new ConfigError('VENUE_ADAPTER must be a 0x address')
  if (!isBytes32(termsHash)) throw new ConfigError('VENUE_TERMS_HASH must be a 32-byte hex string')
  let parsed: URL
  try {
    parsed = new URL(termsUrl as string)
  } catch {
    throw new ConfigError('VENUE_TERMS_URL is not a URL')
  }
  if (parsed.protocol !== 'https:') throw new ConfigError('VENUE_TERMS_URL must be https')
  const terms: NonNullable<ApiConfig['terms']> = { adapter: normalizeAddress(adapter), termsHash, termsUrl: termsUrl as string }
  if (referrerShare !== undefined && referrerShare.length > 0) {
    const bps = Number.parseInt(referrerShare, 10)
    if (!/^\d{1,5}$/.test(referrerShare) || bps > 10_000) {
      throw new ConfigError('VENUE_REFERRER_SHARE_BPS must be an integer in [0, 10000]')
    }
    terms.referrerShareBps = bps
  }
  return terms
}

// The placeholder predicate is single-sourced in @fee-split-vaults/core; see
// packages/core/src/disclosure.ts for why four local copies was a defect.

/**
 * THE DEV-ONLY VALUES MUST NEVER REACH PRODUCTION.
 *
 * `tools/bootstrap-env.ts` exists because this loader failed closed on
 * VENUE_VAULT_INIT_CODE_HASH and nothing in the repository said where to obtain
 * one, so the service could not be started from a clean checkout by anybody.
 * The init-code hash it writes is a real derived value. Three others cannot be
 * derived -- there is no VaultFactory deployed on this chain, and a token is by
 * definition not derivable -- so it writes the published sentinels from
 * config/dev-only.ts instead. Those are in git. They protect nothing and they
 * point at nothing.
 *
 * TWO INDEPENDENT GUARDS, because the failure mode they cover is different:
 *
 *   The MARKER catches a bootstrapped .env.local shipped as-is.
 *
 *   The VALUE and SHAPE checks catch someone copying the addresses or the token
 *     out of that file into a real deployment's secret store, where the marker
 *     line would not have come along. The shape check needs no lookup table:
 *     an address with 24+ leading zero nibbles is a ~2^96 search for CREATE or
 *     CREATE2, so no real deployment produces one.
 *
 * Only in production. Every other NODE_ENV -- including unset -- is a laptop,
 * a test runner or a staging box, and refusing there would break the thing this
 * whole change exists to make possible.
 */
function assertNoDevOnlyValuesInProduction(
  env: NodeJS.ProcessEnv,
  resolved: Readonly<Record<string, string>>,
): void {
  if (!isProductionEnv(env)) return

  const marker = env[DEV_ONLY_MARKER_ENV]?.trim()
  if (marker !== undefined && marker.length > 0 && marker !== '0') {
    throw new ConfigError(
      `${DEV_ONLY_MARKER_ENV} is set and NODE_ENV=production. That variable marks an environment ` +
        'generated by tools/bootstrap-env.ts, which fills values that cannot be derived with sentinels ' +
        'published in config/dev-only.ts. Replace every line tagged [DEV-ONLY] with real values and ' +
        `remove ${DEV_ONLY_MARKER_ENV}.`,
    )
  }

  for (const [key, value] of Object.entries(resolved)) {
    if (isDevOnlyValue(value)) {
      throw new ConfigError(
        `${key} is the DEV-ONLY value published in config/dev-only.ts and NODE_ENV=production. ` +
          'It is committed to this repository, so it is public: as a factory address it points at nothing, ' +
          'and as a token it authorises everyone. Set a real value.',
      )
    }
  }

  for (const key of ['VENUE_VAULT_FACTORY', 'VENUE_VAULT_DEPLOYER']) {
    const value = resolved[key]
    if (isStructurallyUnreachableAddress(value)) {
      throw new ConfigError(
        `${key} is ${String(value)}, which no CREATE or CREATE2 can reach, and NODE_ENV=production. ` +
          'A contract cannot exist there, so every vault address predicted from it would be wrong. ' +
          'This is a development sentinel; set the deployed address.',
      )
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const chainId = optionalInt(env, 'VENUE_CHAIN_ID', VENUE.chainId)
  if (chainId !== VENUE.chainId) {
    // A service pointed at another chain would verify signatures against the
    // wrong domain and predict vault addresses that do not exist.
    throw new ConfigError(
      `VENUE_CHAIN_ID is ${String(chainId)} but the protocol config pins ${String(VENUE.chainId)}`,
    )
  }

  const vaultInitCodeHash = required(env, 'VENUE_VAULT_INIT_CODE_HASH')
  if (!isBytes32(vaultInitCodeHash)) {
    throw new ConfigError('VENUE_VAULT_INIT_CODE_HASH must be a 32-byte hex string')
  }

  const operatorName = requireOperatorName(
    env.VENUE_OPERATOR_NAME ?? DISCLOSURE.operatorName,
    (message) => new ConfigError(`VENUE_OPERATOR_NAME is unset and ${message}`),
  )

  const receiptsBaseUrl = required(env, 'VENUE_RECEIPTS_BASE_URL')
  let parsed: URL
  try {
    parsed = new URL(receiptsBaseUrl)
  } catch {
    throw new ConfigError('VENUE_RECEIPTS_BASE_URL is not a URL')
  }
  if (parsed.protocol !== 'https:') {
    throw new ConfigError('VENUE_RECEIPTS_BASE_URL must be https')
  }

  const rpcUrls = rpcEndpoints(env)
  const rpcRps = Number.parseFloat(env.VENUE_HTTP_RPS?.trim() || '0.8')
  if (!(rpcRps > 0)) throw new ConfigError(`VENUE_HTTP_RPS=${String(env.VENUE_HTTP_RPS)} is not a positive rate`)

  const operatorToken = required(env, 'VENUE_OPERATOR_API_TOKEN')
  if (operatorToken.length < 32) {
    throw new ConfigError('VENUE_OPERATOR_API_TOKEN must be at least 32 characters')
  }

  const factoryAddress = requiredAddress(env, 'VENUE_VAULT_FACTORY')
  const deployerAddress = requiredAddress(env, 'VENUE_VAULT_DEPLOYER')

  assertNoDevOnlyValuesInProduction(env, {
    VENUE_VAULT_FACTORY: factoryAddress,
    VENUE_VAULT_DEPLOYER: deployerAddress,
    VENUE_OPERATOR_API_TOKEN: operatorToken,
    VENUE_RECEIPTS_BASE_URL: receiptsBaseUrl,
    VENUE_OPERATOR_NAME: operatorName,
  })

  const databaseUrl = env.DATABASE_URL?.trim()
  const xReadBearerToken = env.X_READ_BEARER_TOKEN?.trim()
  const operatorSignerKey = optionalSignerKey(env)
  const prices = optionalPrices(env)
  const terms = optionalTerms(env)

  return {
    port: optionalInt(env, 'PORT', 8080),
    chainId,
    factory: {
      factory: factoryAddress,
      // NOT the factory. VaultFactory delegates to a VaultDeployer it
      // constructs, and CREATE2 hashes the DEPLOYER address.
      deployer: deployerAddress,
      vaultInitCodeHash,
      chainId,
    },
    domain: { chainId, verifyingContract: factoryAddress },
    operatorToken,
    operatorName,
    receiptsBaseUrl,
    screeningMaxAgeSeconds: optionalInt(env, 'VENUE_SCREENING_MAX_AGE_SECONDS', 7 * 24 * 3_600),
    antiSnipeHoldSeconds: optionalInt(env, 'VENUE_ANTI_SNIPE_HOLD_SECONDS', 900),
    rpcUrls,
    rpcTimeoutMs: optionalInt(env, 'VENUE_RPC_TIMEOUT_MS', 20_000),
    rpcRps,
    creativeFontFiles: (env.CREATIVE_FONT_FILES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    ...(databaseUrl === undefined || databaseUrl.length === 0 ? {} : { databaseUrl }),
    ...optionalXConfig(env),
    ...(xReadBearerToken === undefined || xReadBearerToken.length === 0 ? {} : { xReadBearerToken }),
    ...(operatorSignerKey === undefined ? {} : { operatorSignerKey }),
    ...(prices === undefined ? {} : { prices }),
    ...(terms === undefined ? {} : { terms }),
  }
}

/** Redacted view, safe to log at boot. */
export function describeConfig(config: ApiConfig): Record<string, unknown> {
  return {
    port: config.port,
    chainId: config.chainId,
    factory: config.factory.factory,
    deployer: config.factory.deployer,
    operatorName: config.operatorName,
    receiptsHost: new URL(config.receiptsBaseUrl).host,
    rpcEndpoints: config.rpcUrls.map((url) => new URL(url).host),
    operatorTokenPresent: config.operatorToken.length > 0,
    antiSnipeHoldSeconds: config.antiSnipeHoldSeconds,
    persistence: config.databaseUrl === undefined ? 'in-memory' : 'postgres',
    xConfigured: config.x !== undefined,
    publisherTokenKeyPresent: config.publisherTokenKey !== undefined,
    xReadBearerPresent: config.xReadBearerToken !== undefined,
    operatorSignerKeyPresent: config.operatorSignerKey !== undefined,
    prices: config.prices === undefined ? 'none' : `coingecko (${Object.keys(config.prices.ids).length} asset(s))`,
    terms: config.terms === undefined ? 'unset' : `${config.terms.termsUrl} (${config.terms.termsHash.slice(0, 10)}…)`,
    creativeFontFiles: config.creativeFontFiles.length,
  }
}
