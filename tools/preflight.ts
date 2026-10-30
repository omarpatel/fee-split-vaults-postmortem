/**
 * GO-LIVE PREFLIGHT.
 *
 *   node tools/preflight.ts                      against process.env
 *   node tools/preflight.ts --env .env.local     Node's --env-file semantics: the file fills what is unset
 *   node tools/preflight.ts --json               one JSON document instead of the report
 *
 * Exit 0 ONLY WHEN EVERY CHECK PASSES. A SKIP is not a pass: it names a
 * subsystem the environment did not ask for and states exactly what the fleet
 * will do without it, which on a laptop is information and on the go-live
 * host is a refusal. Every other outcome is FAIL with the reason.
 *
 * READ-ONLY AGAINST THE WORLD. Nothing here signs, broadcasts, posts, or
 * writes a row. The two exceptions are documented where they happen: the
 * migration dry run creates the empty ops_migration table if it is absent
 * (exactly what `migrate status` does), and the fleet bootstrap in check 12
 * runs the same one-token model probe every fleet start runs
 * (FLEET_MODEL_PROBE=0 skips it, on the operator's say-so).
 *
 * WHAT IS CHECKED, IN ORDER.
 *   1  env completeness, per subsystem, with the refusal or the fake each gap earns
 *   2  DISCLOSURE.operatorName passes requireOperatorName
 *   3  the database answers and `migrate` dry-run reports zero pending
 *   4  the two RPC endpoints agree on chain 4663, sit within N blocks, and hold
 *      code at every VENUE.contracts.* address (and the factory/deployer the API deploys through)
 *   5  OPERATOR_SIGNER_KEY derives an address, holds gas, and is not the treasury
 *   6  every bound x_operator account has a credential the sealing key opens and a live label attestation
 *   7  the Telegram bot answers getMe and is an administrator with the desk's three rights in every bound chat
 *   8  every COINGECKO_IDS asset returns a dated quote
 *   9  the vendor catalog loads fresh, and every enabled pass-through vendor carries KYB/OFAC dates the broker will accept
 *  10  the operator lexicon loads with slur entries and the SDN list loads authoritative
 *  11  a text-only render resolves a font
 *  12  the ops ports module bootstraps the fleet and records ZERO fakes
 *
 * Check 12 goes through `createPorts` from `@fee-split-vaults/fleet/ports` - the
 * module docker-compose runs - rather than `resolveAdapters` alone, because
 * the loader records only what resolved REAL; the fakes are recorded by the
 * sandbox world and by the ports module, and asserting `anyFake === false` on
 * a ledger that cannot contain a fake would prove nothing.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  CoinGeckoPriceBook,
  PgAccountCredentialStore,
  PgLabelAttestationStore,
  PrivateKeySigner,
  TelegramModerationActions,
} from '@fee-split-vaults/adapters'
import { KYB_MAX_AGE_SECONDS, OFAC_MAX_AGE_SECONDS } from '@fee-split-vaults/broker'
import { loadCatalog } from '@fee-split-vaults/catalog'
import { requireOperatorName } from '@fee-split-vaults/core'
import { renderCoinAssets } from '@fee-split-vaults/creative'
import { throttledFetch } from '@fee-split-vaults/fleet'
import { createPorts } from '@fee-split-vaults/fleet/ports'
import { JsonRpcClient, QuorumRpc, type Hex } from '@fee-split-vaults/indexer'
import { DEFAULT_LEXICON_SOURCE, SampleSdnSource, loadScreeningSources } from '@fee-split-vaults/screening'
import { DISCLOSURE, VENUE } from '../config/protocol.ts'
import { connectPg } from '../ops/lib/pg.js'
import { migrationsDirectory } from '../ops/migrations/cli.js'
import { PgDriver, type SqlDriver } from '../ops/migrations/driver.js'
import { PgAdvisoryLock, migrate } from '../ops/migrations/runner.js'
import { CliError, getBool, getNumber, getString, isEntrypoint, runCli, type CommandSpec, type ParsedValues } from './lib/cli.ts'

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

export type Verdict = 'PASS' | 'FAIL' | 'SKIP'

export interface CheckResult {
  /** Stable, dotted, greppable. */
  id: string
  /** The numbered group in the header comment. */
  group: number
  verdict: Verdict
  /** One line. The consequence for a SKIP, the fix for a FAIL. */
  reason: string
  /** Supporting lines, printed indented. */
  details?: string[]
}

export interface PreflightReport {
  tool: 'preflight'
  generatedAtUnix: number
  checks: CheckResult[]
  summary: { pass: number; fail: number; skip: number }
  /** True only when every check PASSED. Drives the exit code. */
  ok: boolean
}

export const GROUP_TITLES: Readonly<Record<number, string>> = {
  1: 'environment, per subsystem',
  2: 'disclosure',
  3: 'database and migrations',
  4: 'RPC quorum and contract code',
  5: 'operator signer',
  6: 'X accounts',
  7: 'Telegram bot',
  8: 'prices',
  9: 'vendor catalog',
  10: 'screening sources',
  11: 'creative',
  12: 'fleet bootstrap (the ops ports module)',
}

type Env = Record<string, string | undefined>

// ---------------------------------------------------------------------------
// The world: every I/O the checks perform, behind one injectable seam
// ---------------------------------------------------------------------------

export interface BlockHead {
  number: bigint
  hash: string
}

/** The two-provider quorum as the checks see it. Built once per run from the resolved endpoints. */
export interface QuorumReads {
  /** eth_chainId from each endpoint, primary first. A rejection is that endpoint's failure. */
  chainIds(): Promise<[PromiseSettledResult<number>, PromiseSettledResult<number>]>
  /** Each endpoint's own `latest`, primary first. */
  heads(): Promise<[PromiseSettledResult<BlockHead>, PromiseSettledResult<BlockHead>]>
  /**
   * A recent block both providers agree on: the quorum head (lower of the two
   * heights) stepped back `marginBlocks`, hashes agreed, or a throw naming the
   * disagreement. Recent rather than finalized because the public providers
   * are full nodes: finalized sits ~50 minutes back and their state there is gone.
   */
  recentAgreed(marginBlocks: bigint): Promise<BlockHead>
  /** Bytecode at a pinned block, agreed byte for byte by both providers. `0x` for no code. */
  getCode(address: string, blockHash: string): Promise<string>
}

export interface BotRights {
  administrator: boolean
  can_delete_messages: boolean
  can_restrict_members: boolean
  can_pin_messages: boolean
}

export interface XCredentialView {
  expiresAtUnix: number
  refreshable: boolean
  scopes: readonly string[]
}

export interface LabelAttestationView {
  attestedBy: string
  attestedAtUnix: number
  expiresAtUnix: number
}

export interface CatalogVendorView {
  id: string
  enabled: boolean
  isRelatedParty: boolean
  kybVerifiedAtUnix?: number
  ofacScreenedAtUnix?: number
}

export interface CatalogEntryView {
  skuId: string
  vendorId: string
  enabled: boolean
  pricing: 'third_party_pass_through' | 'operator_service'
}

export interface CatalogView {
  vendors: CatalogVendorView[]
  entries: CatalogEntryView[]
  rateCards: number
}

export interface ScreeningView {
  lexiconReal: boolean
  lexiconDetail: string
  sdnReal: boolean
  sdnDetail: string
}

/**
 * What the ports module said when asked to start under FLEET_REFUSE_FAKES=1.
 * `banner` is the startup banner it printed, verbatim, so the report can show
 * what resolved real beside what did not.
 */
export interface FleetBootstrap {
  banner: string[]
}

/** Thrown by the world when the ports module refused; `fakes` is the list the refusal named. */
export class FleetRefused extends Error {
  readonly fakes: readonly string[]
  readonly banner: readonly string[]

  constructor(message: string, fakes: readonly string[], banner: readonly string[]) {
    super(message)
    this.name = 'FleetRefused'
    this.fakes = fakes
    this.banner = banner
  }
}

export interface Database {
  driver: SqlDriver
  close(): Promise<void>
}

export interface PreflightWorld {
  nowUnix(): number
  fileExists(path: string): boolean
  connectDb(url: string): Promise<Database>
  pendingMigrations(driver: SqlDriver): Promise<{ pending: string[]; applied: number }>
  quorum(endpoints: RpcEndpoints): QuorumReads
  nativeBalanceWei(url: string, address: string, timeoutMs: number): Promise<bigint>
  /** Throws on a malformed key, with the signer's own message. */
  signerAddress(key: string): string
  /** Bot API `getMe`: the bot's username, or a throw with Telegram's description. */
  botIdentity(token: string): Promise<{ id: string; username: string }>
  botRights(token: string, chatId: string): Promise<BotRights>
  priceQuote(
    ids: Record<string, string>,
    apiKey: string | undefined,
    asset: string,
  ): Promise<{ centsPerWholeUnit: bigint; pricedAtUnix: number; source: string }>
  loadCatalog(dataDir: string | undefined, nowUnix: number): CatalogView
  loadScreening(options: { lexiconFile?: string; sdnFile?: string; sdnUrl?: string }, nowUnix: number): Promise<ScreeningView>
  /** Renders one text-only asset; throws CreativeError `font_unresolved` when no font resolves. */
  renderProbe(fontFiles: readonly string[]): Promise<{ sha256: string }>
  credential(driver: SqlDriver, sealingKeyHex: string, accountId: string): Promise<XCredentialView | null>
  labelAttestation(driver: SqlDriver, accountId: string): Promise<LabelAttestationView | null>
  /**
   * `createPorts` over the real env with FLEET_REFUSE_FAKES=1 forced, so the
   * composition root itself decides: it returns only with zero fakes, and a
   * refusal names every fake (FleetRefused). Any other throw is passed up.
   */
  bootstrapPorts(env: Env, driver: SqlDriver, nowUnix: number): Promise<FleetBootstrap>
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH32 = /^0x[0-9a-fA-F]{64}$/
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`
/** packages/fleet/src/adapters.ts resolvePublisher: maxAccountLabelAgeSeconds. */
export const PUBLISHER_LABEL_MAX_AGE_SECONDS = 24 * 3_600
/** packages/fleet/src/adapters.ts resolveRpcEndpoints: the default second provider. */
export const DEFAULT_SECONDARY_RPC = 'https://rpc.ordofi.network'
export const DEFAULT_OFAC_SDN_URL = 'https://www.treasury.gov/ofac/downloads/sdn.csv'
/**
 * Blocks behind the lower tip that contract code is read at. 2000 is where
 * apps/api pins every chain read. Measured 2026-09-16: the default secondary
 * (rpc.ordofi.network) is load-balanced across replicas up to ~500 blocks
 * apart, so a by-number read within ~2 minutes of its tip answers null from
 * some replicas; the primary (a full node) still serves state at this depth.
 */
export const CODE_PIN_MARGIN_BLOCKS = 2_000n

function trimmed(env: Env, name: string): string | undefined {
  const value = env[name]
  if (value === undefined) return undefined
  const t = value.trim()
  return t.length === 0 ? undefined : t
}

function has(env: Env, name: string): boolean {
  return trimmed(env, name) !== undefined
}

function isHttps(url: string | undefined): boolean {
  if (url === undefined) return false
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function pass(id: string, group: number, reason: string, details?: string[]): CheckResult {
  return { id, group, verdict: 'PASS', reason, ...(details === undefined || details.length === 0 ? {} : { details }) }
}

function fail(id: string, group: number, reason: string, details?: string[]): CheckResult {
  return { id, group, verdict: 'FAIL', reason, ...(details === undefined || details.length === 0 ? {} : { details }) }
}

function skip(id: string, group: number, reason: string, details?: string[]): CheckResult {
  return { id, group, verdict: 'SKIP', reason, ...(details === undefined || details.length === 0 ? {} : { details }) }
}

/** Node's --env-file parse for the shapes .env.example ships: KEY=VALUE, comments, blank lines, optional quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/** The env the checks read: the file fills what the process did not already set. */
export function mergeEnv(processEnv: Env, file: Record<string, string> | undefined): Env {
  if (file === undefined) return { ...processEnv }
  const merged: Env = { ...file }
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined) merged[key] = value
  }
  return merged
}

export interface RpcEndpoints {
  primary: string
  secondary: string
  timeoutMs: number
  rps: number
}

/**
 * The fleet's endpoint rule (packages/fleet/src/adapters.ts resolveRpcEndpoints)
 * with the API's spelling accepted: VENUE_RPC_URLS's first two entries stand in
 * for VENUE_RPC_URL / VENUE_RPC_URL_SECONDARY when those are unset.
 */
export function rpcEndpointsOf(env: Env): RpcEndpoints | undefined {
  const urls = (trimmed(env, 'VENUE_RPC_URLS') ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u.length > 0)
  const primary = trimmed(env, 'VENUE_RPC_URL') ?? urls[0]
  if (primary === undefined) return undefined
  const secondary = trimmed(env, 'VENUE_RPC_URL_SECONDARY') ?? urls.find((u) => u !== primary) ?? DEFAULT_SECONDARY_RPC
  const timeoutMs = Number.parseInt(trimmed(env, 'VENUE_RPC_TIMEOUT_MS') ?? '20000', 10)
  const rps = Number.parseFloat(trimmed(env, 'VENUE_HTTP_RPS') ?? '0.8')
  return { primary, secondary, timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20_000, rps }
}

// ---------------------------------------------------------------------------
// 1. Environment completeness, per subsystem
// ---------------------------------------------------------------------------

export function envChecks(env: Env, fileExists: (path: string) => boolean): CheckResult[] {
  const out: CheckResult[] = []
  const G = 1
  const chainLive = trimmed(env, 'FLEET_CHAIN') === 'live'
  const db = has(env, 'DATABASE_URL')
  const keyringSet = has(env, 'POLICY_SIGNING_KEY') && has(env, 'POLICY_SIGNING_KEY_ID')

  // chain
  {
    const mode = trimmed(env, 'FLEET_CHAIN')
    if (mode === undefined) {
      out.push(
        skip('env.chain', G, 'no FLEET_CHAIN=live → the fixture chain: no vault is scanned, no fee is indexed, and settlement, holders and the desk cannot resolve [MONEY PATH]'),
      )
    } else if (mode !== 'live') {
      out.push(fail('env.chain', G, `FLEET_CHAIN=${mode} is not a mode this build knows (FleetStartupRefused)`))
    } else {
      const endpoints = rpcEndpointsOf(env)
      if (endpoints === undefined) {
        out.push(fail('env.chain', G, 'FLEET_CHAIN=live needs a chain to read: set VENUE_RPC_URL (FleetStartupRefused)'))
      } else if (endpoints.primary === endpoints.secondary) {
        out.push(fail('env.chain', G, 'VENUE_RPC_URL and VENUE_RPC_URL_SECONDARY are the same endpoint; a quorum of one is not a quorum'))
      } else if (!(endpoints.rps > 0)) {
        out.push(fail('env.chain', G, `VENUE_HTTP_RPS=${String(env.VENUE_HTTP_RPS)} is not a positive rate`))
      } else {
        out.push(
          pass('env.chain', G, `FLEET_CHAIN=live over ${endpoints.primary} + ${endpoints.secondary}`, [
            `VENUE_HTTP_RPS=${String(endpoints.rps)} per endpoint, timeout ${String(endpoints.timeoutMs)}ms`,
            ...(has(env, 'VENUE_RPC_URL_SECONDARY') ? [] : ['VENUE_RPC_URL_SECONDARY unset: the named default second provider is in use']),
          ]),
        )
      }
    }
  }

  // database
  out.push(
    db
      ? pass('env.database', G, 'DATABASE_URL set: every durable store is Postgres')
      : skip('env.database', G, 'no DATABASE_URL → every store is in-memory and vanishes with the process; the scheduler refuses to start; FLEET_COINS_SOURCE=db and TELEGRAM_BOT_TOKEN refuse by name'),
  )

  // coins
  {
    const source = trimmed(env, 'FLEET_COINS_SOURCE')
    const file = trimmed(env, 'FLEET_COINS_FILE')
    if (source === 'db') {
      out.push(db ? pass('env.coins', G, 'FLEET_COINS_SOURCE=db: the directory is every onboarding row in state active') : fail('env.coins', G, 'FLEET_COINS_SOURCE=db refuses without DATABASE_URL'))
    } else if (source === 'file' || (source === undefined && file !== undefined)) {
      if (file === undefined) out.push(fail('env.coins', G, 'FLEET_COINS_SOURCE=file refuses without FLEET_COINS_FILE'))
      else if (!fileExists(file)) out.push(fail('env.coins', G, `FLEET_COINS_FILE=${file} does not exist`))
      else out.push(pass('env.coins', G, `coin directory from ${file}`))
    } else if (source !== undefined) {
      out.push(fail('env.coins', G, `FLEET_COINS_SOURCE=${source} is not a source this build knows`))
    } else if (chainLive) {
      out.push(fail('env.coins', G, 'no FLEET_COINS_SOURCE under FLEET_CHAIN=live: the fixture fleet is refused ("would scan the chain for fixture coins that do not exist there"); set FLEET_COINS_SOURCE=db'))
    } else {
      out.push(skip('env.coins', G, 'no FLEET_COINS_SOURCE → the fixture fleet (three fictional coins); refused under FLEET_CHAIN=live'))
    }
  }

  // model
  out.push(
    has(env, 'ANTHROPIC_API_KEY')
      ? pass('env.model', G, 'ANTHROPIC_API_KEY set; the fleet bootstrap (check 12) confirms it with a one-token probe' + (trimmed(env, 'FLEET_MODEL_PROBE') === '0' ? ' (FLEET_MODEL_PROBE=0: skipped, provenance live on your say-so)' : ''))
      : skip('env.model', G, 'no ANTHROPIC_API_KEY → the SCRIPTED model, provenance fake on every run record; every paid tier\'s cognition is fiction; the API\'s narrative derive route answers 503; refused under FLEET_REFUSE_FAKES=1'),
  )

  // production posture
  {
    const missing: string[] = []
    if (trimmed(env, 'FLEET_REFUSE_FAKES') !== '1') missing.push('FLEET_REFUSE_FAKES=1 (a fleet with any fake would start)')
    if (trimmed(env, 'FLEET_REQUIRE_LIVE_MODEL') !== '1') missing.push('FLEET_REQUIRE_LIVE_MODEL=1 (a probe that fails on the network runs scripted instead of refusing)')
    if (trimmed(env, 'NODE_ENV') !== 'production') missing.push('NODE_ENV=production (apps/api tolerates the dev-only sentinels)')
    if (has(env, 'VENUE_DEV_ONLY_CONFIG')) {
      out.push(fail('env.posture', G, 'VENUE_DEV_ONLY_CONFIG is set: this environment was generated by tools/bootstrap-env.ts with DEV-ONLY sentinels and apps/api refuses to boot on it in production'))
    } else if (missing.length > 0) {
      out.push(skip('env.posture', G, 'not the production posture; fakes are tolerated at startup', missing))
    } else {
      out.push(pass('env.posture', G, 'FLEET_REFUSE_FAKES=1, FLEET_REQUIRE_LIVE_MODEL=1, NODE_ENV=production'))
    }
  }

  // settlement
  {
    const mode = trimmed(env, 'FLEET_SETTLEMENT')
    if (mode === undefined) {
      out.push(skip('env.settlement', G, 'no FLEET_SETTLEMENT=live → reimbursements are recorded, never broadcast [MONEY PATH]'))
    } else if (mode !== 'live') {
      out.push(fail('env.settlement', G, `FLEET_SETTLEMENT=${mode} is not a mode this build knows`))
    } else {
      const problems: string[] = []
      if (!chainLive) problems.push('FLEET_CHAIN=live (there is no chain to broadcast on)')
      if (!has(env, 'OPERATOR_SIGNER_KEY')) problems.push('OPERATOR_SIGNER_KEY (signs pullBudget)')
      const treasury = trimmed(env, 'OPERATOR_TREASURY_ADDRESS')
      if (treasury === undefined) problems.push('OPERATOR_TREASURY_ADDRESS (the only address a pull may pay)')
      else if (!ADDRESS.test(treasury)) problems.push('OPERATOR_TREASURY_ADDRESS is not a 20-byte address')
      else if (treasury.toLowerCase() === ZERO_ADDRESS) problems.push('OPERATOR_TREASURY_ADDRESS is the zero address; a reimbursement paid there is burned')
      if (!db) problems.push('DATABASE_URL (the asset registry a pull is sized against is read from the chain and quote_asset)')
      if (!keyringSet) problems.push('POLICY_SIGNING_KEY_ID + POLICY_SIGNING_KEY (a pull under the sandbox key is authorised by nobody)')
      out.push(problems.length === 0 ? pass('env.settlement', G, 'FLEET_SETTLEMENT=live with signer, treasury, database and policy keyring') : fail('env.settlement', G, 'FLEET_SETTLEMENT=live is a startup refusal without:', problems))
    }
  }

  // policy keyring
  {
    const id = trimmed(env, 'POLICY_SIGNING_KEY_ID')
    const key = trimmed(env, 'POLICY_SIGNING_KEY')
    if (id === undefined && key === undefined) {
      out.push(skip('env.policyKeyring', G, 'no POLICY_SIGNING_KEY → policy tokens are signed under the sandbox key that ships in the source [MONEY PATH]; FLEET_SETTLEMENT=live and FLEET_CATALOG=data refuse beside it'))
    } else if (id === undefined || key === undefined) {
      out.push(fail('env.policyKeyring', G, 'POLICY_SIGNING_KEY_ID and POLICY_SIGNING_KEY are set together or not at all'))
    } else if (id === 'policy-sandbox') {
      out.push(fail('env.policyKeyring', G, 'POLICY_SIGNING_KEY_ID must not be the sandbox id "policy-sandbox"'))
    } else if (Buffer.byteLength(key, 'utf8') < 32) {
      out.push(fail('env.policyKeyring', G, 'POLICY_SIGNING_KEY is shorter than 32 bytes; the keyring refuses it'))
    } else {
      out.push(pass('env.policyKeyring', G, `policy tokens signed under key id "${id}"`))
    }
  }

  // salt
  out.push(
    has(env, 'FLEET_USER_ID_SALT')
      ? pass('env.userIdSalt', G, 'FLEET_USER_ID_SALT set')
      : skip('env.userIdSalt', G, 'no FLEET_USER_ID_SALT → the fleet REFUSES to start beside any real dependency (a real model, chain, store or transport); the sandbox salt is derived from the coin ref'),
  )

  // prices
  {
    const mode = trimmed(env, 'FLEET_PRICES')
    if (mode === undefined) {
      out.push(skip('env.prices', G, 'no FLEET_PRICES=coingecko → the fixture price book pinned at $1.00 [MONEY PATH]; no QF can be measured, no tier granted, no spend authorised'))
    } else if (mode !== 'coingecko') {
      out.push(fail('env.prices', G, `FLEET_PRICES=${mode} is not a mode this build knows`))
    } else {
      const parsed = parseCoinGeckoIds(env)
      out.push('error' in parsed ? fail('env.prices', G, parsed.error) : pass('env.prices', G, `FLEET_PRICES=coingecko for ${String(Object.keys(parsed.ids).length)} asset(s)`, Object.entries(parsed.ids).map(([a, id]) => `${a} → ${id}`)))
    }
  }

  // evidence
  {
    const mode = trimmed(env, 'FLEET_EVIDENCE')
    if (mode === undefined) {
      out.push(skip('env.evidence', G, 'no FLEET_EVIDENCE=dexscreener → delivery predicates observe nothing, ops.predicateVerifier is a fake, and a post-graduation coin\'s pool-share signal REFUSES'))
    } else if (mode !== 'dexscreener') {
      out.push(fail('env.evidence', G, `FLEET_EVIDENCE=${mode} is not a mode this build knows`))
    } else if (!has(env, 'DEXSCREENER_CHAIN_SLUG')) {
      out.push(fail('env.evidence', G, 'FLEET_EVIDENCE=dexscreener needs DEXSCREENER_CHAIN_SLUG, which has no default'))
    } else {
      out.push(pass('env.evidence', G, `Dexscreener token-pairs on chain slug ${String(trimmed(env, 'DEXSCREENER_CHAIN_SLUG'))}`))
    }
  }

  // holders / signals
  {
    const mode = trimmed(env, 'FLEET_HOLDERS')
    if (mode === undefined) {
      out.push(skip('env.holders', G, 'no FLEET_HOLDERS=index → the qualification signals are the sandbox\'s fixed numbers [MONEY PATH]; on a live chain every signal read REFUSES, so no upgrade and no spend'))
    } else if (mode !== 'index') {
      out.push(fail('env.holders', G, `FLEET_HOLDERS=${mode} is not a mode this build knows`))
    } else {
      const problems: string[] = []
      if (!chainLive) problems.push('FLEET_CHAIN=live')
      if (!db) problems.push('DATABASE_URL (token_holder_balance)')
      if (trimmed(env, 'FLEET_PRICES') !== 'coingecko') problems.push('FLEET_PRICES=coingecko (the pool-share signal prices volume)')
      out.push(problems.length === 0 ? pass('env.holders', G, 'FLEET_HOLDERS=index: Transfer replay into token_holder_balance to the finalized head') : fail('env.holders', G, 'FLEET_HOLDERS=index is a startup refusal without:', problems))
    }
  }

  // catalog
  {
    const mode = trimmed(env, 'FLEET_CATALOG')
    if (mode === undefined) {
      out.push(skip('env.catalog', G, 'no FLEET_CATALOG=data → one sandbox vendor and one listing SKU [MONEY PATH]'))
    } else if (mode !== 'data') {
      out.push(fail('env.catalog', G, `FLEET_CATALOG=${mode} is not a mode this build knows`))
    } else if (!keyringSet) {
      out.push(fail('env.catalog', G, 'FLEET_CATALOG=data needs POLICY_SIGNING_KEY_ID and POLICY_SIGNING_KEY: a catalog quote authorised under the sandbox key is authorised by nobody'))
    } else {
      out.push(pass('env.catalog', G, 'FLEET_CATALOG=data: data/vendors.json + data/skus.json + sealed rate cards'))
    }
  }

  // telegram
  {
    const token = trimmed(env, 'TELEGRAM_BOT_TOKEN')
    if (token === undefined) {
      out.push(skip('env.telegram', G, 'no TELEGRAM_BOT_TOKEN → holder messages are fixtures, the desk phase records desk_unavailable, the weekly report delivery is a fake, and FLEET_PUBLISHER=live refuses'))
    } else if (!db) {
      out.push(fail('env.telegram', G, 'TELEGRAM_BOT_TOKEN refuses without DATABASE_URL: getUpdates is a consuming stream and its offset must outlive the process'))
    } else {
      out.push(pass('env.telegram', G, 'TELEGRAM_BOT_TOKEN set with a database for the update stream'))
    }
  }

  // publisher
  {
    const mode = trimmed(env, 'FLEET_PUBLISHER')
    if (mode === undefined) {
      out.push(skip('env.publisher', G, 'no FLEET_PUBLISHER=live → fake transports; posts are recorded, never sent; X mentions are never read'))
    } else if (mode !== 'live') {
      out.push(fail('env.publisher', G, `FLEET_PUBLISHER=${mode} is not a mode this build knows`))
    } else {
      const problems: string[] = []
      const notes: string[] = []
      if (!db) problems.push('DATABASE_URL (account bindings, sealed tokens and the post registry live in Postgres)')
      const tokenKey = trimmed(env, 'PUBLISHER_TOKEN_KEY')
      if (tokenKey === undefined) problems.push('PUBLISHER_TOKEN_KEY (OAuth tokens are never stored unencrypted)')
      else if (!/^(0x)?[0-9a-fA-F]{64}$/.test(tokenKey)) problems.push('PUBLISHER_TOKEN_KEY must be 32 bytes of hex')
      if (!has(env, 'X_CLIENT_ID')) problems.push('X_CLIENT_ID')
      const redirect = trimmed(env, 'X_REDIRECT_URI')
      if (redirect === undefined) problems.push('X_REDIRECT_URI')
      else if (!isHttps(redirect)) problems.push('X_REDIRECT_URI must be https')
      const receipts = trimmed(env, 'PUBLISHER_RECEIPTS_BASE_URL')
      if (receipts === undefined) problems.push('PUBLISHER_RECEIPTS_BASE_URL (every disclosure links the receipts page)')
      else if (!isHttps(receipts)) problems.push('PUBLISHER_RECEIPTS_BASE_URL must be https')
      if (!has(env, 'TELEGRAM_BOT_TOKEN')) problems.push('TELEGRAM_BOT_TOKEN (the publisher posts to Telegram through the bot)')
      const approvalUrl = trimmed(env, 'PUBLISHER_APPROVAL_URL')
      if (approvalUrl === undefined) notes.push('PUBLISHER_APPROVAL_URL unset: the DENY-ALL approval gate is installed; every post that needs a human is refused')
      else {
        if (!isHttps(approvalUrl)) problems.push('PUBLISHER_APPROVAL_URL must be https')
        if (!has(env, 'PUBLISHER_APPROVAL_TOKEN')) problems.push('PUBLISHER_APPROVAL_TOKEN (required beside PUBLISHER_APPROVAL_URL)')
      }
      if (!has(env, 'PUBLISHER_ALLOWED_LINK_HOSTS')) notes.push('PUBLISHER_ALLOWED_LINK_HOSTS unset: only the receipts host may be linked')
      out.push(problems.length === 0 ? pass('env.publisher', G, 'FLEET_PUBLISHER=live: real X and Telegram transports', notes) : fail('env.publisher', G, 'FLEET_PUBLISHER=live is a startup refusal without:', [...problems, ...notes]))
    }
  }

  // desk
  {
    const parts: string[] = []
    if (!has(env, 'TELEGRAM_BOT_TOKEN')) parts.push('TELEGRAM_BOT_TOKEN')
    if (!chainLive) parts.push('FLEET_CHAIN=live')
    if (!db) parts.push('DATABASE_URL')
    if (parts.length > 0) {
      out.push(skip('env.desk', G, `no ${parts.join(' + ')} → the holder desk is desk_unavailable on every tick; holder questions are corpus only`))
    } else if (!has(env, 'VENUE_EXPLORER_BASE_URL')) {
      out.push(fail('env.desk', G, 'the desk resolves (bot + live chain + database) and needs VENUE_EXPLORER_BASE_URL: it cites the block explorer in every fact reply (FleetStartupRefused)'))
    } else {
      out.push(pass('env.desk', G, `Telegram desk over the quorum FactSheet reader, explorer ${String(trimmed(env, 'VENUE_EXPLORER_BASE_URL'))}${has(env, 'ANTHROPIC_API_KEY') ? ', T1 model answers' : ', T0 commands only (no ANTHROPIC_API_KEY)'}`))
    }
  }

  // api
  {
    const problems: string[] = []
    const chainId = trimmed(env, 'VENUE_CHAIN_ID')
    if (chainId !== undefined && chainId !== String(VENUE.chainId)) problems.push(`VENUE_CHAIN_ID=${chainId} must equal ${String(VENUE.chainId)}`)
    for (const name of ['VENUE_VAULT_FACTORY', 'VENUE_VAULT_DEPLOYER']) {
      const value = trimmed(env, name)
      if (value === undefined) problems.push(`${name} is required and has no safe default`)
      else if (!ADDRESS.test(value)) problems.push(`${name} is not a 20-byte address`)
      else if (/^0x0{32}/.test(value)) problems.push(`${name}=${value} is a DEV-ONLY sentinel no CREATE or CREATE2 can reach; there is no factory there`)
    }
    const initHash = trimmed(env, 'VENUE_VAULT_INIT_CODE_HASH')
    if (initHash === undefined) problems.push('VENUE_VAULT_INIT_CODE_HASH is required (factory.VAULT_INIT_CODE_HASH())')
    else if (!HASH32.test(initHash)) problems.push('VENUE_VAULT_INIT_CODE_HASH is not 32-byte hex')
    try {
      requireOperatorName(trimmed(env, 'VENUE_OPERATOR_NAME'), (m) => new Error(m))
    } catch (error) {
      problems.push(`VENUE_OPERATOR_NAME: ${message(error)}`)
    }
    if (!isHttps(trimmed(env, 'VENUE_RECEIPTS_BASE_URL'))) problems.push('VENUE_RECEIPTS_BASE_URL must be an https URL')
    const apiToken = trimmed(env, 'VENUE_OPERATOR_API_TOKEN')
    if (apiToken === undefined || apiToken.length < 32) problems.push('VENUE_OPERATOR_API_TOKEN must be at least 32 characters')
    if (rpcEndpointsOf(env) === undefined) problems.push('VENUE_RPC_URLS (two endpoints) or VENUE_RPC_URL + VENUE_RPC_URL_SECONDARY')
    if (!has(env, 'OPERATOR_SIGNER_KEY')) problems.push('OPERATOR_SIGNER_KEY: without it every vault deployment, bind and activation REFUSES (operator_unwired)')
    out.push(problems.length === 0 ? pass('env.api', G, 'apps/api has its factory, deployer, init code hash, operator identity, receipts URL, token, quorum and signer') : fail('env.api', G, 'apps/api refuses to boot or to deploy:', problems))
  }

  // screening inputs
  {
    const lexicon = trimmed(env, 'SCREENING_LEXICON_FILE')
    if (lexicon === undefined) out.push(skip('env.screening.lexicon', G, 'no SCREENING_LEXICON_FILE → the builtin list only, recorded as a fake, and NO CLEAR VERDICT CAN ISSUE (lexicon_unconfigured)'))
    else if (!fileExists(lexicon)) out.push(fail('env.screening.lexicon', G, `SCREENING_LEXICON_FILE=${lexicon} does not exist (startup refusal naming the file)`))
    else out.push(pass('env.screening.lexicon', G, `SCREENING_LEXICON_FILE=${lexicon}`))
    const sdnFile = trimmed(env, 'OFAC_SDN_FILE')
    const sdnUrl = trimmed(env, 'OFAC_SDN_URL')
    if (sdnFile !== undefined) {
      out.push(fileExists(sdnFile) ? pass('env.screening.sdn', G, `OFAC_SDN_FILE=${sdnFile}${sdnFile.toLowerCase().endsWith('.csv') ? ' (a CSV file cannot be dated and is NOT authoritative; use sdn.xml)' : ''}`) : fail('env.screening.sdn', G, `OFAC_SDN_FILE=${sdnFile} does not exist (startup refusal)`))
    } else if (sdnUrl !== undefined) {
      out.push(pass('env.screening.sdn', G, `OFAC_SDN_URL=${sdnUrl}`))
    } else {
      out.push(skip('env.screening.sdn', G, `no OFAC_SDN_FILE / OFAC_SDN_URL → the default ${DEFAULT_OFAC_SDN_URL} is downloaded at boot; if that fails the sample list is in and no CLEAR verdict can issue`))
    }
  }

  // ops scheduler
  {
    const module = trimmed(env, 'OPS_PORTS_MODULE')
    if (has(env, 'OPS_ALLOW_FAKE_PORTS')) out.push(fail('env.ops', G, 'OPS_ALLOW_FAKE_PORTS is set: the scheduler would run the ops fakes, which report healthy while doing nothing'))
    else if (module === undefined) out.push(fail('env.ops', G, 'OPS_PORTS_MODULE is required (the scheduler refuses to start without one); set @fee-split-vaults/fleet/ports'))
    else if (module !== '@fee-split-vaults/fleet/ports') out.push(fail('env.ops', G, `OPS_PORTS_MODULE=${module} is not the composition root; docker-compose runs @fee-split-vaults/fleet/ports`))
    else out.push(pass('env.ops', G, 'OPS_PORTS_MODULE=@fee-split-vaults/fleet/ports'))

    const webhook = trimmed(env, 'OPS_ALERT_WEBHOOK_URL')
    if (webhook === undefined) out.push(skip('env.alerts', G, 'no OPS_ALERT_WEBHOOK_URL → ops.alerts and ops.monitoring stay fakes: firings are neither logged to ops_alert_firing nor paged'))
    else if (!isHttps(webhook)) out.push(fail('env.alerts', G, 'OPS_ALERT_WEBHOOK_URL must be https (startup refusal)'))
    else out.push(pass('env.alerts', G, `alerts paged to ${new URL(webhook).host}`))

    const reportToken = trimmed(env, 'OPS_REPORT_TELEGRAM_BOT_TOKEN') ?? trimmed(env, 'TELEGRAM_BOT_TOKEN')
    if (reportToken === undefined || !has(env, 'PUBLISHER_RECEIPTS_BASE_URL')) out.push(skip('env.reports', G, 'no OPS_REPORT_TELEGRAM_BOT_TOKEN (or TELEGRAM_BOT_TOKEN) + PUBLISHER_RECEIPTS_BASE_URL → the weekly dev report is never delivered (ops.reportDelivery fake)'))
    else out.push(pass('env.reports', G, `weekly report delivered by ${has(env, 'OPS_REPORT_TELEGRAM_BOT_TOKEN') ? 'OPS_REPORT_TELEGRAM_BOT_TOKEN' : 'TELEGRAM_BOT_TOKEN'} to each coin's bound telegram chat`))
  }

  // creative fonts
  {
    const files = fontFilesOf(env)
    if (files.length === 0) out.push(pass('env.creative', G, 'CREATIVE_FONT_FILES unset: system fonts (asset hashes stable per host, not across hosts)'))
    else {
      const missing = files.filter((f) => !fileExists(f))
      out.push(missing.length === 0 ? pass('env.creative', G, `${String(files.length)} pinned font file(s)`) : fail('env.creative', G, 'CREATIVE_FONT_FILES names files that do not exist:', missing))
    }
  }

  return out
}

export function fontFilesOf(env: Env): string[] {
  return (trimmed(env, 'CREATIVE_FONT_FILES') ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
}

export function parseCoinGeckoIds(env: Env): { ids: Record<string, string> } | { error: string } {
  const raw = trimmed(env, 'COINGECKO_IDS')
  if (raw === undefined) return { error: 'FLEET_PRICES=coingecko needs COINGECKO_IDS (JSON object of quote-asset address → CoinGecko id)' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { error: `COINGECKO_IDS is not JSON: ${message(error)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { error: 'COINGECKO_IDS must be a JSON object of asset address → CoinGecko id' }
  const ids: Record<string, string> = {}
  for (const [asset, id] of Object.entries(parsed as Record<string, unknown>)) {
    if (!ADDRESS.test(asset) || typeof id !== 'string' || id.trim().length === 0) return { error: `COINGECKO_IDS entry ${asset} → ${JSON.stringify(id)} is not an address → id pair` }
    ids[asset.toLowerCase()] = id.trim()
  }
  if (Object.keys(ids).length === 0) return { error: 'COINGECKO_IDS maps no asset' }
  return { ids }
}

// ---------------------------------------------------------------------------
// 2..12
// ---------------------------------------------------------------------------

export interface PreflightOptions {
  /** How far apart the two providers' heads may sit. */
  maxHeadLagBlocks: number
  /** The least native balance the signer must hold, in wei. */
  minSignerBalanceWei: bigint
}

export const DEFAULT_OPTIONS: PreflightOptions = {
  maxHeadLagBlocks: 32,
  // 0.005 ETH: enough for many L2 operator transactions at this chain's gas.
  minSignerBalanceWei: 5_000_000_000_000_000n,
}

function disclosureCheck(): CheckResult {
  try {
    const name = requireOperatorName(DISCLOSURE.operatorName, (m) => new Error(m))
    return pass('disclosure.operatorName', 2, `DISCLOSURE.operatorName = ${JSON.stringify(name)} (config/protocol.ts)`)
  } catch (error) {
    return fail('disclosure.operatorName', 2, `${message(error)} The fleet's publisher and the desk take the name from config/protocol.ts and refuse to construct until it is edited; there is no environment override.`)
  }
}

async function databaseChecks(env: Env, world: PreflightWorld): Promise<{ results: CheckResult[]; db?: Database }> {
  const url = trimmed(env, 'DATABASE_URL')
  if (url === undefined) return { results: [skip('db.reachable', 3, 'no DATABASE_URL → not attempted'), skip('db.migrations', 3, 'no database to plan against')] }
  let db: Database
  try {
    db = await world.connectDb(url)
  } catch (error) {
    return { results: [fail('db.reachable', 3, `could not connect: ${message(error)}`), skip('db.migrations', 3, 'unreachable database')] }
  }
  const results: CheckResult[] = [pass('db.reachable', 3, `connected to ${redactUrl(url)}`)]
  try {
    const plan = await world.pendingMigrations(db.driver)
    results.push(
      plan.pending.length === 0
        ? pass('db.migrations', 3, `${String(plan.applied)} migration(s) applied, none pending`)
        : fail('db.migrations', 3, `${String(plan.pending.length)} migration(s) pending; run \`node ops/migrations/cli.js up\` (or \`docker compose run --rm migrate\`)`, plan.pending),
    )
  } catch (error) {
    results.push(fail('db.migrations', 3, `migration plan refused: ${message(error)}`))
  }
  return { results, db }
}

export function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.username.length > 0 ? `${u.username}:***@` : ''}${u.host}${u.pathname}`
  } catch {
    return '<unparseable DATABASE_URL>'
  }
}

async function rpcChecks(env: Env, world: PreflightWorld, options: PreflightOptions): Promise<{ results: CheckResult[]; endpoints?: RpcEndpoints }> {
  const endpoints = rpcEndpointsOf(env)
  if (endpoints === undefined) {
    return { results: [skip('rpc.chainId', 4, 'no VENUE_RPC_URL → the chain is not consulted'), skip('rpc.head', 4, 'no endpoints'), skip('rpc.code', 4, 'no endpoints')] }
  }
  if (!(endpoints.rps > 0)) return { results: [fail('rpc.chainId', 4, `VENUE_HTTP_RPS=${String(env.VENUE_HTTP_RPS)} is not a positive rate`), skip('rpc.head', 4, 'bad rate'), skip('rpc.code', 4, 'bad rate')] }
  const quorum = world.quorum(endpoints)
  const labels = [endpoints.primary, endpoints.secondary] as const
  const results: CheckResult[] = []

  const problems: string[] = []
  for (const [i, settled] of (await quorum.chainIds()).entries()) {
    if (settled.status === 'rejected') problems.push(`${labels[i] ?? ''}: ${message(settled.reason)}`)
    else if (settled.value !== VENUE.chainId) problems.push(`${labels[i] ?? ''} answers chain ${String(settled.value)}, expected ${String(VENUE.chainId)}`)
  }
  if (problems.length > 0) {
    results.push(fail('rpc.chainId', 4, 'the quorum does not agree on chain 4663:', problems), skip('rpc.head', 4, 'chain not verified'), skip('rpc.code', 4, 'chain not verified'))
    return { results, endpoints }
  }
  results.push(pass('rpc.chainId', 4, `both endpoints answer chain ${String(VENUE.chainId)}`))

  const heads = await quorum.heads()
  const headProblems: string[] = []
  for (const [i, settled] of heads.entries()) {
    if (settled.status === 'rejected') headProblems.push(`${labels[i] ?? ''}: ${message(settled.reason)}`)
  }
  if (heads[0].status !== 'fulfilled' || heads[1].status !== 'fulfilled') {
    results.push(fail('rpc.head', 4, 'a head read failed:', headProblems), skip('rpc.code', 4, 'no head to pin to'))
    return { results, endpoints }
  }
  const [a, b] = [heads[0].value, heads[1].value]
  const lag = a.number > b.number ? a.number - b.number : b.number - a.number
  if (lag > BigInt(options.maxHeadLagBlocks)) {
    results.push(fail('rpc.head', 4, `heads are ${String(lag)} blocks apart (primary ${String(a.number)}, secondary ${String(b.number)}), limit ${String(options.maxHeadLagBlocks)}; the quorum takes the lower height, and a provider this far behind lags every money read`))
  } else {
    results.push(pass('rpc.head', 4, `heads within ${String(lag)} block(s): primary ${String(a.number)}, secondary ${String(b.number)}`))
  }

  // Pinned at a block BOTH providers agree on, a few seconds behind the
  // quorum head: hashes agreed like every money read, and old enough that a
  // lagging replica behind a load balancer has it, young enough that a full
  // node still holds its state.
  let pin: BlockHead
  try {
    pin = await quorum.recentAgreed(CODE_PIN_MARGIN_BLOCKS)
  } catch (error) {
    results.push(fail('rpc.code', 4, `the quorum could not agree on a recent block to pin to: ${message(error)}`))
    return { results, endpoints }
  }
  const addresses: Array<[string, string]> = Object.entries(VENUE.contracts).map(([name, address]) => [`VENUE.contracts.${name}`, address])
  for (const name of ['VENUE_VAULT_FACTORY', 'VENUE_VAULT_DEPLOYER']) {
    const value = trimmed(env, name)
    if (value !== undefined && ADDRESS.test(value)) addresses.push([name, value])
  }
  const codeProblems: string[] = []
  const codeOk: string[] = []
  for (const [name, address] of addresses) {
    try {
      const code = await quorum.getCode(address, pin.hash)
      if (code.length <= 2) codeProblems.push(`${name} ${address}: NO CODE at block ${String(pin.number)}`)
      else codeOk.push(`${name} ${address}: ${String((code.length - 2) / 2)} bytes, both providers agree`)
    } catch (error) {
      codeProblems.push(`${name} ${address}: ${message(error)}`)
    }
  }
  results.push(
    codeProblems.length === 0
      ? pass('rpc.code', 4, `code present at ${String(addresses.length)} address(es), agreed by both providers at block ${String(pin.number)}`, codeOk)
      : fail('rpc.code', 4, `an address the system depends on holds no code at block ${String(pin.number)}:`, [...codeProblems, ...codeOk]),
  )
  return { results, endpoints }
}

async function signerChecks(env: Env, world: PreflightWorld, options: PreflightOptions, endpoints: RpcEndpoints | undefined): Promise<CheckResult[]> {
  const key = trimmed(env, 'OPERATOR_SIGNER_KEY')
  if (key === undefined) {
    return [
      skip('signer.address', 5, 'no OPERATOR_SIGNER_KEY → nothing can sign: no vault deploy, bind or activation in the API; settlement, sweeper, enforcement and heartbeat stay fakes [MONEY PATH]'),
      skip('signer.balance', 5, 'no signer'),
      skip('signer.treasury', 5, 'no signer'),
    ]
  }
  let address: string
  try {
    address = world.signerAddress(key)
  } catch (error) {
    return [fail('signer.address', 5, `OPERATOR_SIGNER_KEY refused: ${message(error)}`), skip('signer.balance', 5, 'no address'), skip('signer.treasury', 5, 'no address')]
  }
  const results: CheckResult[] = []
  if (address === ZERO_ADDRESS) results.push(fail('signer.address', 5, 'OPERATOR_SIGNER_KEY derives the zero address'))
  else results.push(pass('signer.address', 5, `signer ${address}`))

  if (endpoints === undefined) results.push(skip('signer.balance', 5, 'no RPC endpoint to read the balance from'))
  else {
    try {
      const wei = await world.nativeBalanceWei(endpoints.primary, address, endpoints.timeoutMs)
      results.push(
        wei >= options.minSignerBalanceWei
          ? pass('signer.balance', 5, `${formatEth(wei)} native (minimum ${formatEth(options.minSignerBalanceWei)})`)
          : fail('signer.balance', 5, `${formatEth(wei)} native is below the ${formatEth(options.minSignerBalanceWei)} minimum; fund ${address} before a deploy, bind, activate, claim or settle can pay gas`),
      )
    } catch (error) {
      results.push(fail('signer.balance', 5, `eth_getBalance failed: ${message(error)}`))
    }
  }

  const treasury = trimmed(env, 'OPERATOR_TREASURY_ADDRESS')
  if (treasury === undefined) results.push(skip('signer.treasury', 5, 'no OPERATOR_TREASURY_ADDRESS → FLEET_SETTLEMENT=live would refuse; no pull can name a destination'))
  else if (!ADDRESS.test(treasury)) results.push(fail('signer.treasury', 5, 'OPERATOR_TREASURY_ADDRESS is not a 20-byte address'))
  else if (treasury.toLowerCase() === address) results.push(fail('signer.treasury', 5, 'OPERATOR_SIGNER_KEY derives the treasury address itself; a leaked hot signer must not be a leaked treasury'))
  else results.push(pass('signer.treasury', 5, `treasury ${treasury.toLowerCase()} ≠ signer`))
  return results
}

export function formatEth(wei: bigint): string {
  const whole = wei / 1_000_000_000_000_000_000n
  const frac = (wei % 1_000_000_000_000_000_000n).toString().padStart(18, '0').slice(0, 6)
  return `${String(whole)}.${frac} ETH`
}

interface BindingRow {
  account_id: string
  coin_ref: string
}

async function bindings(driver: SqlDriver, channel: string): Promise<BindingRow[]> {
  const rows = await driver.query<BindingRow>('SELECT account_id, coin_ref FROM publisher_account_binding WHERE channel = $1 ORDER BY account_id', [channel])
  return rows.map((r) => ({ account_id: String(r.account_id), coin_ref: String(r.coin_ref) }))
}

async function xChecks(env: Env, world: PreflightWorld, db: Database | undefined): Promise<CheckResult[]> {
  const now = world.nowUnix()
  const sealingKey = trimmed(env, 'PUBLISHER_TOKEN_KEY')
  if (db === undefined) return [skip('x.accounts', 6, 'no database → no account binding can exist')]
  let rows: BindingRow[]
  try {
    rows = await bindings(db.driver, 'x_operator')
  } catch (error) {
    return [fail('x.accounts', 6, `publisher_account_binding could not be read: ${message(error)}`)]
  }
  if (rows.length === 0) return [skip('x.accounts', 6, 'no x_operator account is bound yet → nothing posts to X; bind one after the coin has pointed (POST /accounts/x/bind)')]
  if (sealingKey === undefined) return rows.map((r) => fail(`x.${r.account_id}`, 6, `bound to ${r.coin_ref} but no PUBLISHER_TOKEN_KEY: the sealed credential cannot be opened`))
  const results: CheckResult[] = []
  for (const row of rows) {
    const id = `x.${row.account_id}`
    const problems: string[] = []
    const notes: string[] = [`bound to ${row.coin_ref}`]
    try {
      const cred = await world.credential(db.driver, sealingKey, row.account_id)
      if (cred === null) problems.push('no credential row: complete GET /accounts/x/authorize → callback for this account')
      else {
        if (cred.expiresAtUnix <= now && !cred.refreshable) problems.push(`access token expired ${String(now - cred.expiresAtUnix)}s ago and no refresh token was stored; re-authorise`)
        else notes.push(cred.expiresAtUnix <= now ? 'access token expired; refresh token present, the transport refreshes on first use' : `access token valid for ${String(cred.expiresAtUnix - now)}s, scopes ${cred.scopes.join(' ')}`)
      }
    } catch (error) {
      problems.push(`credential unopenable: ${message(error)}`)
    }
    try {
      const label = await world.labelAttestation(db.driver, row.account_id)
      if (label === null) problems.push('no Automated-label attestation: node tools/operator.ts x attest-label --account-id … --attested-by … --days …')
      else if (label.expiresAtUnix <= now) problems.push(`label attestation by ${label.attestedBy} expired ${String(now - label.expiresAtUnix)}s ago; re-attest`)
      else if (now - label.attestedAtUnix > PUBLISHER_LABEL_MAX_AGE_SECONDS) problems.push(`label attested ${String(now - label.attestedAtUnix)}s ago; the fleet's publisher refuses a label observed more than ${String(PUBLISHER_LABEL_MAX_AGE_SECONDS)}s ago (maxAccountLabelAgeSeconds) - re-attest daily`)
      else notes.push(`label attested by ${label.attestedBy} ${String(now - label.attestedAtUnix)}s ago, expires in ${String(label.expiresAtUnix - now)}s`)
    } catch (error) {
      problems.push(`label attestation unreadable: ${message(error)}`)
    }
    results.push(problems.length === 0 ? pass(id, 6, 'credential opens and the label attestation is live', notes) : fail(id, 6, 'this account would be refused at publish:', [...notes, ...problems]))
  }
  return results
}

async function telegramChecks(env: Env, world: PreflightWorld, db: Database | undefined): Promise<CheckResult[]> {
  const token = trimmed(env, 'TELEGRAM_BOT_TOKEN')
  if (token === undefined) return [skip('telegram.getMe', 7, 'no TELEGRAM_BOT_TOKEN → not attempted')]
  let me: { id: string; username: string }
  try {
    me = await world.botIdentity(token)
  } catch (error) {
    return [fail('telegram.getMe', 7, `getMe failed: ${message(error)}`)]
  }
  const results: CheckResult[] = [pass('telegram.getMe', 7, `bot @${me.username} (id ${me.id})`)]
  if (db === undefined) {
    results.push(skip('telegram.chats', 7, 'no database → no bound chat can be listed'))
    return results
  }
  let rows: BindingRow[]
  try {
    rows = await bindings(db.driver, 'telegram')
  } catch (error) {
    results.push(fail('telegram.chats', 7, `publisher_account_binding could not be read: ${message(error)}`))
    return results
  }
  if (rows.length === 0) {
    results.push(skip('telegram.chats', 7, 'no telegram chat is bound yet → the bot has nothing to listen to and the fleet REFUSES a bot token with no bound chat'))
    return results
  }
  for (const row of rows) {
    const id = `telegram.chat.${row.account_id}`
    try {
      const rights = await world.botRights(token, row.account_id)
      const missing: string[] = []
      if (!rights.administrator) missing.push('administrator')
      else {
        if (!rights.can_delete_messages) missing.push('can_delete_messages')
        if (!rights.can_restrict_members) missing.push('can_restrict_members')
        if (!rights.can_pin_messages) missing.push('can_pin_messages')
      }
      results.push(missing.length === 0 ? pass(id, 7, `administrator with delete, restrict and pin (bound to ${row.coin_ref})`) : fail(id, 7, `bound to ${row.coin_ref}; the bot lacks ${missing.join(', ')} - every moderation action refuses (moderation_rights_missing)`))
    } catch (error) {
      results.push(fail(id, 7, `getChatMember failed: ${message(error)}`))
    }
  }
  return results
}

async function priceChecks(env: Env, world: PreflightWorld): Promise<CheckResult[]> {
  if (trimmed(env, 'FLEET_PRICES') !== 'coingecko') return [skip('prices.quotes', 8, 'no FLEET_PRICES=coingecko → not attempted')]
  const parsed = parseCoinGeckoIds(env)
  if ('error' in parsed) return [fail('prices.quotes', 8, parsed.error)]
  const now = world.nowUnix()
  const results: CheckResult[] = []
  for (const [asset, coinId] of Object.entries(parsed.ids)) {
    const id = `prices.${asset}`
    try {
      const quote = await world.priceQuote(parsed.ids, trimmed(env, 'COINGECKO_API_KEY'), asset)
      results.push(pass(id, 8, `${coinId}: ${(Number(quote.centsPerWholeUnit) / 100).toFixed(2)} USD, dated ${String(now - quote.pricedAtUnix)}s ago (${quote.source})`))
    } catch (error) {
      results.push(fail(id, 8, `${coinId}: ${message(error)}`))
    }
  }
  return results
}

function catalogChecks(env: Env, world: PreflightWorld): CheckResult[] {
  if (trimmed(env, 'FLEET_CATALOG') !== 'data') return [skip('catalog.load', 9, 'no FLEET_CATALOG=data → not attempted'), skip('catalog.vendors', 9, 'no catalog')]
  const now = world.nowUnix()
  let view: CatalogView
  try {
    view = world.loadCatalog(trimmed(env, 'VENUE_DATA_DIR'), now)
  } catch (error) {
    return [fail('catalog.load', 9, `the catalog did not load: ${message(error)}`), skip('catalog.vendors', 9, 'no catalog')]
  }
  const results: CheckResult[] = [pass('catalog.load', 9, `${String(view.vendors.length)} vendor(s), ${String(view.entries.length)} SKU(s), ${String(view.rateCards)} sealed rate card(s); no drift at ${String(now)}`)]
  const refused: string[] = []
  const cleared: string[] = []
  for (const vendor of view.vendors) {
    const paidMedia = view.entries.filter((e) => e.enabled && e.vendorId === vendor.id && e.pricing === 'third_party_pass_through').map((e) => e.skuId)
    if (!vendor.enabled || paidMedia.length === 0) continue
    const problems: string[] = []
    if (vendor.kybVerifiedAtUnix === undefined) problems.push('no KYB record')
    else if (vendor.kybVerifiedAtUnix < now - KYB_MAX_AGE_SECONDS) problems.push(`KYB ${String(now - vendor.kybVerifiedAtUnix)}s old, limit ${String(KYB_MAX_AGE_SECONDS)}s`)
    else if (vendor.kybVerifiedAtUnix > now + 60) problems.push('KYB dated in the future')
    if (vendor.ofacScreenedAtUnix === undefined) problems.push('never sanctions screened')
    else if (vendor.ofacScreenedAtUnix < now - OFAC_MAX_AGE_SECONDS) problems.push(`sanctions screen ${String(now - vendor.ofacScreenedAtUnix)}s old, limit ${String(OFAC_MAX_AGE_SECONDS)}s`)
    else if (vendor.ofacScreenedAtUnix > now + 60) problems.push('sanctions screen dated in the future')
    if (problems.length > 0) refused.push(`${vendor.id}: ${problems.join('; ')} → payee_allowlist refuses ${paidMedia.join(', ')}`)
    else cleared.push(`${vendor.id}: KYB and sanctions screen current → ${paidMedia.join(', ')}`)
  }
  results.push(
    refused.length === 0
      ? pass('catalog.vendors', 9, cleared.length === 0 ? 'no enabled pass-through vendor offers paid media' : 'every enabled pass-through vendor carries dates the broker accepts', cleared)
      : fail('catalog.vendors', 9, 'paid media the broker would REFUSE at payee_allowlist (record kybVerifiedAtUnix / ofacScreenedAtUnix in data/vendors.json from the operator\'s own file, or disable the vendor):', [...refused, ...cleared]),
  )
  return results
}

async function screeningChecks(env: Env, world: PreflightWorld): Promise<CheckResult[]> {
  const lexiconFile = trimmed(env, 'SCREENING_LEXICON_FILE')
  const sdnFile = trimmed(env, 'OFAC_SDN_FILE')
  const sdnUrl = trimmed(env, 'OFAC_SDN_URL')
  let view: ScreeningView
  try {
    view = await world.loadScreening(
      {
        ...(lexiconFile === undefined ? {} : { lexiconFile }),
        ...(sdnFile !== undefined ? { sdnFile } : { sdnUrl: sdnUrl ?? DEFAULT_OFAC_SDN_URL }),
      },
      world.nowUnix(),
    )
  } catch (error) {
    return [fail('screening.sources', 10, `a named screening source refused to load (startup refusal): ${message(error)}`)]
  }
  return [
    view.lexiconReal ? pass('screening.lexicon', 10, view.lexiconDetail) : lexiconFile === undefined ? skip('screening.lexicon', 10, view.lexiconDetail) : fail('screening.lexicon', 10, view.lexiconDetail),
    view.sdnReal ? pass('screening.sdn', 10, view.sdnDetail) : fail('screening.sdn', 10, `${view.sdnDetail}${sdnFile === undefined && sdnUrl === undefined ? ` (the unnamed default ${DEFAULT_OFAC_SDN_URL} is what the API and the ops rescreen load at boot)` : ''}`),
  ]
}

async function creativeCheck(env: Env, world: PreflightWorld): Promise<CheckResult> {
  const files = fontFilesOf(env)
  try {
    const rendered = await world.renderProbe(files)
    return pass('creative.font', 11, `a text-only avatar rendered (sha256 ${rendered.sha256.slice(0, 16)}…) with ${files.length === 0 ? 'system fonts' : `${String(files.length)} pinned font file(s)`}`)
  } catch (error) {
    return fail('creative.font', 11, `render refused: ${message(error)}${files.length === 0 ? ' - this host has no sans-serif font; install one (the images install ttf-dejavu) or pin CREATIVE_FONT_FILES' : ''}`)
  }
}

async function fleetCheck(env: Env, world: PreflightWorld, db: Database | undefined): Promise<CheckResult> {
  if (db === undefined) return skip('fleet.bootstrap', 12, 'no DATABASE_URL → the ops ports module cannot be constructed (it asserts a driver); not attempted')
  let boot: FleetBootstrap
  try {
    boot = await world.bootstrapPorts({ ...env, FLEET_REFUSE_FAKES: '1' }, db.driver, world.nowUnix())
  } catch (error) {
    if (error instanceof FleetRefused) {
      return fail('fleet.bootstrap', 12, `FLEET_REFUSE_FAKES=1 refused to start: ${String(error.fakes.length)} fake(s) remain: ${error.fakes.join(', ')}`, [...error.banner])
    }
    const reason = message(error)
    if (/coin directory is empty/i.test(reason)) {
      return skip('fleet.bootstrap', 12, 'the coin directory is empty: no onboarding row is active yet, so the fleet cannot be bootstrapped; re-run after the first activation (every other check above is what activation needs)')
    }
    return fail('fleet.bootstrap', 12, `the ops ports module refused to start: ${reason}`)
  }
  return pass('fleet.bootstrap', 12, 'the ops ports module started under FLEET_REFUSE_FAKES=1: every dependency is real', boot.banner)
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export async function runPreflight(env: Env, world: PreflightWorld, options: PreflightOptions = DEFAULT_OPTIONS): Promise<PreflightReport> {
  const checks: CheckResult[] = []
  checks.push(...envChecks(env, world.fileExists))
  checks.push(disclosureCheck())
  const database = await databaseChecks(env, world)
  checks.push(...database.results)
  try {
    const rpc = await rpcChecks(env, world, options)
    checks.push(...rpc.results)
    checks.push(...(await signerChecks(env, world, options, rpc.endpoints)))
    checks.push(...(await xChecks(env, world, database.db)))
    checks.push(...(await telegramChecks(env, world, database.db)))
    checks.push(...(await priceChecks(env, world)))
    checks.push(...catalogChecks(env, world))
    checks.push(...(await screeningChecks(env, world)))
    checks.push(await creativeCheck(env, world))
    checks.push(await fleetCheck(env, world, database.db))
  } finally {
    if (database.db !== undefined) await database.db.close()
  }
  const summary = { pass: 0, fail: 0, skip: 0 }
  for (const check of checks) {
    if (check.verdict === 'PASS') summary.pass += 1
    else if (check.verdict === 'FAIL') summary.fail += 1
    else summary.skip += 1
  }
  return { tool: 'preflight', generatedAtUnix: world.nowUnix(), checks, summary, ok: summary.fail === 0 && summary.skip === 0 }
}

export function exitCodeOf(report: PreflightReport): 0 | 1 {
  return report.ok ? 0 : 1
}

export function renderReport(report: PreflightReport): string {
  const lines: string[] = []
  lines.push(`preflight - go-live checks at ${new Date(report.generatedAtUnix * 1000).toISOString()}`)
  let group = 0
  for (const check of report.checks) {
    if (check.group !== group) {
      group = check.group
      lines.push('', `${String(group).padStart(2)}. ${GROUP_TITLES[group] ?? ''}`)
    }
    lines.push(`  ${check.verdict.padEnd(4)} ${check.id.padEnd(28)} ${check.reason}`)
    for (const detail of check.details ?? []) lines.push(`       - ${detail}`)
  }
  lines.push('')
  const { pass: p, fail: f, skip: s } = report.summary
  lines.push(`${String(p)} PASS, ${String(f)} FAIL, ${String(s)} SKIP.`)
  lines.push(
    report.ok
      ? 'READY: every check passed. Exit 0.'
      : `NOT READY: ${String(f)} failure(s) and ${String(s)} subsystem(s) not asked for. A SKIP is a fake the fleet would run with; go-live needs every line PASS. Exit 1.`,
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// The live world
// ---------------------------------------------------------------------------

/** The one HTTP shape every Telegram adapter posts through (same as the fleet's). */
async function telegramPost(url: string, body: unknown): Promise<unknown> {
  const response = await globalThis.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  return (await response.json()) as unknown
}

const REFUSED_FAKES = /FLEET_REFUSE_FAKES=1 and these dependencies are fakes: (.+)$/

/** The startup banner out of captured stderr: the block between its two rule lines, verbatim. */
function bannerLines(captured: readonly string[]): string[] {
  const lines = captured.join('').split('\n')
  const first = lines.findIndex((l) => l.startsWith('====='))
  const last = lines.findLastIndex((l) => l.startsWith('====='))
  if (first === -1 || last <= first) return lines.filter((l) => l.trim().length > 0)
  return lines.slice(first + 1, last).filter((l) => l.trim().length > 0)
}

export function liveWorld(): PreflightWorld {
  return {
    nowUnix: () => Math.floor(Date.now() / 1000),
    fileExists: (path) => existsSync(path),
    async connectDb(url) {
      const connection = await connectPg(url)
      return { driver: new PgDriver(connection.client), close: () => connection.close() }
    },
    async pendingMigrations(driver) {
      const result = await migrate({
        driver,
        directory: migrationsDirectory(),
        nowUnix: () => Math.floor(Date.now() / 1000),
        lock: new PgAdvisoryLock(driver),
        dryRun: true,
      })
      return { pending: result.pending.map((m) => `${String(m.version).padStart(4, '0')}_${m.name}`), applied: result.alreadyApplied }
    },
    quorum(endpoints) {
      // One limiter per endpoint, as the fleet builds them (resolveLiveChain).
      const primary = new JsonRpcClient({ endpointId: 'primary', url: endpoints.primary, timeoutMs: endpoints.timeoutMs, fetchImpl: throttledFetch(endpoints.rps) })
      const secondary = new JsonRpcClient({ endpointId: 'secondary', url: endpoints.secondary, timeoutMs: endpoints.timeoutMs, fetchImpl: throttledFetch(endpoints.rps) })
      const quorum = new QuorumRpc(primary, secondary)
      return {
        chainIds: () => Promise.allSettled([primary.getChainId(), secondary.getChainId()]),
        heads: () => Promise.allSettled([primary.getBlockByTag('latest'), secondary.getBlockByTag('latest')]),
        recentAgreed: async (margin) => {
          // From each provider's OWN tip, not quorum.head(): a load-balanced
          // provider can answer `latest` from one replica and the follow-up
          // by-number read from another that has not seen it yet. Stepping
          // back from the lower tip is what gives every replica time to agree.
          const [a, b] = await Promise.all([primary.getBlockByTag('latest'), secondary.getBlockByTag('latest')])
          const lower = a.number < b.number ? a.number : b.number
          const target = lower > margin ? lower - margin : 0n
          const block = await quorum.blockByNumber(target)
          if (block === null) throw new Error(`neither provider has block ${String(target)}`)
          return { number: block.number, hash: block.hash }
        },
        getCode: (address, blockHash) => quorum.getCode(address, blockHash as Hex),
      }
    },
    async nativeBalanceWei(url, address, timeoutMs) {
      // The indexer's client has no eth_getBalance (nothing at runtime needs
      // one); this is the one raw call, with the User-Agent the primary
      // provider insists on.
      const response = await globalThis.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'fee-split-vaults/0.1' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error(`eth_getBalance returned HTTP ${String(response.status)}`)
      const payload = (await response.json()) as { result?: unknown; error?: { message?: string } }
      if (payload.error !== undefined) throw new Error(`eth_getBalance error: ${payload.error.message ?? 'unknown'}`)
      if (typeof payload.result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(payload.result)) throw new Error('eth_getBalance returned a non-hex result')
      return BigInt(payload.result)
    },
    signerAddress: (key) => new PrivateKeySigner(key).address,
    async botIdentity(token) {
      const raw = (await telegramPost(`https://api.telegram.org/bot${token}/getMe`, {})) as { ok?: boolean; result?: unknown; description?: string } | null
      if (raw === null || typeof raw !== 'object' || raw.ok !== true) throw new Error(`telegram getMe: ${typeof raw?.description === 'string' ? raw.description : 'call failed'}`)
      const me = raw.result
      if (me === null || typeof me !== 'object' || !('id' in me)) throw new Error('telegram getMe: no user id in reply')
      const record = me as { id: unknown; username?: unknown }
      return { id: String(record.id), username: typeof record.username === 'string' ? record.username : '?' }
    },
    async botRights(token, chatId) {
      const rights = await new TelegramModerationActions({ token, http: { post: telegramPost } }).rights(chatId)
      return {
        administrator: rights.administrator,
        can_delete_messages: rights.can_delete_messages,
        can_restrict_members: rights.can_restrict_members,
        can_pin_messages: rights.can_pin_messages,
      }
    },
    async priceQuote(ids, apiKey, asset) {
      const price = await new CoinGeckoPriceBook({ ids, ...(apiKey === undefined ? {} : { apiKey }) }).refresh(asset)
      return { centsPerWholeUnit: price.centsPerWholeUnit, pricedAtUnix: price.pricedAtUnix, source: price.source }
    },
    loadCatalog(dataDir, nowUnix) {
      const { catalog } = loadCatalog({ ...(dataDir === undefined ? {} : { dataDir }), nowUnix })
      return {
        vendors: catalog.vendors.map((v) => ({
          id: v.id,
          enabled: v.enabled,
          isRelatedParty: v.isRelatedParty,
          ...(v.kybVerifiedAtUnix === undefined ? {} : { kybVerifiedAtUnix: v.kybVerifiedAtUnix }),
          ...(v.ofacScreenedAtUnix === undefined ? {} : { ofacScreenedAtUnix: v.ofacScreenedAtUnix }),
        })),
        entries: catalog.entries.map((e) => ({ skuId: e.sku.id, vendorId: e.sku.vendorId, enabled: e.enabled, pricing: e.pricing })),
        rateCards: catalog.rateCards.length,
      }
    },
    async loadScreening(options, nowUnix) {
      const sources = await loadScreeningSources({ ...options, builtinLexicon: DEFAULT_LEXICON_SOURCE, sampleSdn: new SampleSdnSource(nowUnix) })
      return { lexiconReal: sources.lexiconReal, lexiconDetail: sources.lexiconDetail, sdnReal: sources.sdnReal, sdnDetail: sources.sdnDetail }
    },
    async renderProbe(fontFiles) {
      const [asset] = await renderCoinAssets(
        { coinRef: 'preflight', symbol: 'PRE', name: 'Preflight probe', narrative: null, kinds: ['avatar'] },
        fontFiles.length === 0 ? {} : { fontFiles },
      )
      if (asset === undefined) throw new Error('no asset rendered')
      return { sha256: asset.sha256 }
    },
    async credential(driver, sealingKeyHex, accountId) {
      const cred = await new PgAccountCredentialStore(driver, sealingKeyHex).get(accountId)
      return cred === null ? null : { expiresAtUnix: cred.expiresAtUnix, refreshable: cred.refreshToken !== null, scopes: cred.scopes }
    },
    async labelAttestation(driver, accountId) {
      const attestation = await new PgLabelAttestationStore(driver).get(accountId)
      return attestation === null ? null : { attestedBy: attestation.attestedBy, attestedAtUnix: attestation.attestedAtUnix, expiresAtUnix: attestation.expiresAtUnix }
    },
    async bootstrapPorts(env, driver, nowUnix) {
      // The ports module prints its startup banner to stderr and keeps its
      // ledger private; the banner is the record of what resolved, so stderr
      // is captured for the duration and returned rather than left in scrollback.
      const captured: string[] = []
      const original = process.stderr.write
      process.stderr.write = ((chunk: unknown): boolean => {
        captured.push(typeof chunk === 'string' ? chunk : String(chunk))
        return true
      }) as typeof process.stderr.write
      try {
        await createPorts({ driver, nowUnix: () => nowUnix, env })
      } catch (error) {
        const reason = message(error)
        const named = REFUSED_FAKES.exec(reason)
        if (named !== null && named[1] !== undefined) {
          throw new FleetRefused(reason, named[1].split(',').map((n) => n.trim()), bannerLines(captured))
        }
        throw error
      } finally {
        process.stderr.write = original
      }
      return { banner: bannerLines(captured) }
    },
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const PREFLIGHT_SPEC: CommandSpec = {
  name: 'preflight',
  summary: 'Go-live checks: exit 0 only when every dependency in both processes resolves to the real thing.',
  detail:
    'Reads the environment (optionally filled from --env), then asks the database, the two RPC endpoints, the ' +
    'signer, X, Telegram, CoinGecko, the catalog, the screening sources, the renderer and the fleet composition ' +
    'root whether they would run REAL. Nothing is signed, broadcast, posted or written. A SKIP names a subsystem ' +
    'nobody asked for and the fake the fleet would run with instead; go-live needs every line PASS.',
  options: [
    { name: 'env', type: 'string', placeholder: '<file>', describe: 'A .env file whose values fill variables the process does not already set (Node --env-file semantics).' },
    { name: 'max-head-lag', type: 'number', placeholder: '<blocks>', describe: 'How far apart the two providers\' heads may sit.', default: DEFAULT_OPTIONS.maxHeadLagBlocks },
    { name: 'min-signer-eth', type: 'string', placeholder: '<eth>', describe: 'Least native balance the operator signer must hold.', default: '0.005' },
  ],
  examples: ['node tools/preflight.ts --env .env.local', 'node tools/preflight.ts --json --out tools/artifacts/preflight.json'],
}

export function parseEth(value: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(value.trim())
  if (m === null) throw new CliError(`--min-signer-eth ${value} is not a decimal ETH amount`)
  const whole = BigInt(m[1] ?? '0')
  const frac = BigInt((m[2] ?? '').padEnd(18, '0'))
  return whole * 1_000_000_000_000_000_000n + frac
}

async function main(values: ParsedValues): Promise<void> {
  const envPath = getString(values, 'env')
  let fileVars: Record<string, string> | undefined
  if (envPath !== undefined) {
    const abs = resolve(envPath)
    if (!existsSync(abs)) throw new CliError(`--env ${envPath}: no such file`)
    fileVars = parseEnvFile(readFileSync(abs, 'utf8'))
    // Node's --env-file rule, applied to the process as well: code the fleet
    // reaches through process.env (the catalog's VENUE_DATA_DIR, the SDK's own
    // credential resolution) sees the same values the checks do.
    for (const [key, value] of Object.entries(fileVars)) {
      if (process.env[key] === undefined) process.env[key] = value
    }
  }
  const env = mergeEnv(process.env, fileVars)
  const options: PreflightOptions = {
    maxHeadLagBlocks: getNumber(values, 'max-head-lag', DEFAULT_OPTIONS.maxHeadLagBlocks),
    minSignerBalanceWei: parseEth(getString(values, 'min-signer-eth') ?? '0.005'),
  }
  const report = await runPreflight(env, liveWorld(), options)
  const serialized = JSON.stringify(report, null, 2)
  const outPath = getString(values, 'out')
  if (outPath !== undefined && outPath.length > 0) {
    await mkdir(dirname(outPath), { recursive: true })
    writeFileSync(outPath, `${serialized}\n`, 'utf8')
  }
  process.stdout.write(getBool(values, 'json') ? `${serialized}\n` : `${renderReport(report)}\n`)
  process.exitCode = exitCodeOf(report)
}

if (isEntrypoint(import.meta.url)) {
  await runCli(PREFLIGHT_SPEC, process.argv.slice(2), main)
}
