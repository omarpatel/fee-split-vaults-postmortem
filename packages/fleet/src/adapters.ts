/**
 * THE LOADER FOR THE REAL ADAPTERS.
 *
 * `packages/adapters` holds a real chain read model, a real fee indexer, real
 * Postgres stores for everything the tick loop keeps, a real price feed, a real
 * evidence source, a real settlement port and a real message ingest; the
 * publisher holds real channel transports; the catalog holds the vendor data
 * an operator actually verified. This file is the seam that reaches them, and
 * it is the difference between a fleet that ticks fixtures and a fleet that
 * ticks a chain, spends a budget and posts to a community.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE. Asking for a real dependency and
 * getting a fake one is the single most dangerous outcome available here,
 * because the process would report healthy while serving fiction. So every
 * resolution below is all-or-nothing: if `FLEET_CHAIN=live` is set and anything
 * needed to honour it is missing - an endpoint, a deployment block, a coin
 * directory that never named one - this THROWS `FleetStartupRefused` and the
 * fleet does not start. It never degrades quietly to the fixture. The
 * degradation path is the one where nothing was asked for in the first place,
 * and every dependency that takes it is recorded in the substitution ledger by
 * the sandbox world, so the banner names it.
 *
 * WHAT IS RESOLVED, AND FROM WHAT.
 *
 *   FLEET_CHAIN=live           VENUE_RPC_URL (+ VENUE_RPC_URL_SECONDARY): a
 *                              two-provider quorum, the vault movement scanner
 *                              and - with a database - the fee indexer.
 *   DATABASE_URL (the driver)  every durable store: vaults, screening,
 *                              receipts, approvals, invoices, the ledger, the
 *                              image store, the publisher's registries, the
 *                              predicate queue, the pending-purchase list, the
 *                              spend counters, the escalation sink.
 *   FLEET_PRICES=coingecko     COINGECKO_IDS (+ COINGECKO_API_KEY)
 *   FLEET_EVIDENCE=dexscreener DEXSCREENER_CHAIN_SLUG
 *   FLEET_CATALOG=data         the repository's data/ directory
 *   FLEET_SETTLEMENT=live      OPERATOR_SIGNER_KEY + OPERATOR_TREASURY_ADDRESS,
 *                              over the live chain's primary endpoint
 *   TELEGRAM_BOT_TOKEN         the Telegram message source, over the database
 *   FLEET_PUBLISHER=live       X_CLIENT_ID/X_CLIENT_SECRET/X_REDIRECT_URI,
 *                              PUBLISHER_TOKEN_KEY, PUBLISHER_RECEIPTS_BASE_URL,
 *                              PUBLISHER_ALLOWED_LINK_HOSTS, PUBLISHER_APPROVAL_URL
 *                              (+ PUBLISHER_APPROVAL_TOKEN), TELEGRAM_BOT_TOKEN,
 *                              and DISCLOSURE.operatorName from config
 */

import { fileURLToPath } from 'node:url'
import {
  HolderIndexer,
  JsonRpcClient,
  PostingsTradeSource,
  PostingsVolumeSource,
  QuorumRpc,
  VaultIndexer,
  computeQualificationSignals,
  decodeLaunchedToken,
  encodeAddressArgCall,
  GET_LAUNCHED_TOKEN_SELECTOR,
  type BlockRef,
  type CoinBinding,
  type Hex,
  type IndexedToken,
  type IndexerStore,
  type IssuedVault,
} from '@fee-split-vaults/indexer'
import {
  BotApiTelegramInbound,
  ChainAssetReader,
  ChainSettlementPort,
  CoinGeckoPriceBook,
  DexscreenerEvidenceSource,
  InMemoryChainCursorStore,
  InMemoryHaltStore,
  InMemoryVaultMovementStore,
  PgAccountCredentialStore,
  PgAccountRegistry,
  PgApprovalStore,
  PgAssetPolicy,
  PgChannelHealthStore,
  PgChainCursorStore,
  PgEscalationSink,
  PgFleetCounters,
  PgHaltStore,
  PgHolderBalanceStore,
  PgImageAssetStore,
  PgIndexerStore,
  PgInboundMessageStore,
  PgInvoiceRegistry,
  PgLabelAttestationStore,
  PgPendingPurchaseStore,
  PgPostRegistry,
  PgReceiptStore,
  PgScreeningStore,
  PgVaultMovementStore,
  PgVaultRepository,
  PrivateKeySigner,
  RpcChainReadModel,
  TelegramDeskPort,
  TelegramMessageSource,
  TelegramModerationActions,
  PgRefusalLog,
  PgXMentionStore,
  VenueDeskChainReader,
  XMentionsMessageSource,
  loadAssetRegistry,
  pgLedgerDriver,
  type ChainAssetRegistry,
  type ChainCursorStore,
  type PollResult,
  type SqlDriver,
  type SyncResult,
} from '@fee-split-vaults/adapters'
import { catalogToBrokerCatalog, loadCatalog } from '@fee-split-vaults/catalog'
import { PolicyKeyring, PredicateRegistry, type OperatorTreasury, type VendorCatalog } from '@fee-split-vaults/broker'
import { SqlLedgerStore } from '@fee-split-vaults/ledger'
import {
  toIndexerOracle,
  type ChainReadModel,
  type Clock,
  type DeskPort,
  type EscalationSink,
  type FleetCounters,
  type SignalsProvider,
  type UsdPriceBook,
} from '@fee-split-vaults/orchestrator'
import { AnthropicDeskModel, urlExplorer } from '@fee-split-vaults/desk'
import Anthropic from '@anthropic-ai/sdk'
import {
  PublisherConfigError,
  createAttestedLabelProbe,
  createDenyAllApprovalGate,
  createHttpApprovalGate,
  createJsonEventLog,
  createPublisher,
  createTelegramAdapter,
  createTelegramHttpTransport,
  createTimerScheduler,
  createXAdapter,
  createXHttpTransport,
  createXOAuth2Client,
  type ApprovalGate,
  type Publisher,
} from '@fee-split-vaults/publisher'
import { DISCLOSURE, VENUE } from '../../../config/protocol.js'
import { PgPredicateQueue } from '../../../ops/scheduler/store/predicates.js'
import { BrokerPredicateVerifier } from '../../../ops/scheduler/verifier.js'
import type { CoinDefinition } from './coins.js'
import { FleetStartupRefused } from './errors.js'
import type { SubstitutionLedger } from './credentials.js'
import { SANDBOX_POLICY_KEY_ID } from './sandbox.js'

/**
 * How far back a first scan reaches when a coin names no deployment block.
 *
 * There is no such default, on purpose, and this constant does not exist. The
 * comment is here because the absence is the decision: `TrackedVault` requires
 * `deployedAtBlock` and says why - starting at 0 is a multi-hour walk at this
 * chain's rate limit and starting at the head silently skips every settlement
 * that already happened. Both are wrong in ways that look like working. So a
 * coin without one is refused rather than defaulted.
 */

export interface LiveChain {
  readonly model: ChainReadModel
  /** Advance every tracked vault's cursor. Incremental, forward-only. */
  sync(nowUnix: number): Promise<SyncResult>
  readonly cursors: ChainCursorStore
  readonly endpoints: readonly string[]
  readonly vaults: ReadonlyArray<{ coinRef: string; vault: string; fromBlock: bigint }>
  /** The primary endpoint on its own: what the settlement port broadcasts through. */
  readonly primary: JsonRpcClient
  /** The two-provider quorum every money read goes through. */
  readonly rpc: QuorumRpc
  /** Present when a database made a fee indexer possible; absent means fee reads REFUSE. */
  readonly indexer?: VaultIndexer
  /** The indexer's own store, when there is one. Bindings and postings are read from it. */
  readonly indexerStore?: IndexerStore
  /** How far behind the wall clock a coverage watermark may sit before a tick is refused. */
  readonly maxCoverageLagSeconds: number
}

/** The holder replay, when FLEET_HOLDERS=index resolved. Ticked beside the chain sync. */
export interface LiveHolders {
  readonly indexer: HolderIndexer
  /** Advance every token's Transfer replay to the finalized head. */
  sync(nowUnix: number): Promise<{ stillBehind: readonly string[] }>
}

/** The policy-token keyring the broker signs with. One key id, one secret, from the operator. */
export interface ResolvedKeyring {
  readonly keyring: PolicyKeyring
  readonly keyId: string
}

/** Every durable store the driver made real. All or none: one database, one set. */
export interface Persistence {
  readonly vaults: PgVaultRepository
  readonly screening: PgScreeningStore
  readonly receipts: PgReceiptStore
  readonly approvals: PgApprovalStore
  readonly invoices: PgInvoiceRegistry
  readonly ledgerStore: SqlLedgerStore
  readonly images: PgImageAssetStore
  readonly accounts: PgAccountRegistry
  readonly posts: PgPostRegistry
  readonly labels: PgLabelAttestationStore
  readonly predicates: PgPredicateQueue
  readonly pending: PgPendingPurchaseStore
}

export interface LiveSettlement {
  readonly port: ChainSettlementPort
  readonly treasury: OperatorTreasury
  readonly signerAddress: string
}

export interface LiveMessages {
  /** One source for the fleet: one bot token is one update stream with one offset. */
  readonly source: TelegramMessageSource
  /** Drain the stream into the store. Called before a tick reads a window. */
  poll(): Promise<PollResult>
}

export interface ResolvedAdapters extends Foundation {
  /** Present only when FLEET_CHAIN=live resolved completely. */
  chain?: LiveChain
  counters?: FleetCounters
  escalations?: EscalationSink
  prices?: CoinGeckoPriceBook
  evidence?: DexscreenerEvidenceSource
  /** The ops-plane verifier over the real evidence, so the delivery job checks what the broker would. */
  predicateVerifier?: BrokerPredicateVerifier
  settlement?: LiveSettlement
  messages?: LiveMessages
  publisher?: Publisher
  /** Present when FLEET_HOLDERS=index resolved: a live chain, a database, and the fee indexer's bindings. */
  holders?: LiveHolders
  /** POLICY_SIGNING_KEY_ID + POLICY_SIGNING_KEY. Absent means the sandbox key, which no real money path may use. */
  policyKeyring?: ResolvedKeyring
  /** The holder desk, when TELEGRAM_BOT_TOKEN, a live chain and a database all resolved. */
  desk?: { readonly port: DeskPort; load(): Promise<void> }
  /** X mentions of every bound x_* account, when the live publisher's credential store exists. */
  mentions?: { readonly source: XMentionsMessageSource; readonly pollSeconds: number; poll(): Promise<unknown> }
  /**
   * The quote assets, described by their contracts and governed by quote_asset.
   * Loaded by `resolveLiveAssets` after the sync resolvers, because it reads the chain.
   */
  assets?: ChainAssetRegistry
  /** Real qualification signals. Built by `resolveSignals` once the assets are loaded. */
  signals?: SignalsProvider
}

/** The one HTTP shape every Telegram adapter in this process posts through. */
async function telegramHttp(url: string, body: unknown): Promise<unknown> {
  const response = await globalThis.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await response.json()) as unknown
}

/**
 * The dependencies that exist BEFORE the coin directory does: the durable
 * stores a database directory reads its coins out of, and the catalog it
 * derives each coin's planner view from. Everything else needs the coins.
 */
export interface Foundation {
  persistence?: Persistence
  catalog?: VendorCatalog
}

export interface ResolveFoundationOptions {
  env: Record<string, string | undefined>
  substitutions: SubstitutionLedger
  /**
   * The clock every real store and transport stamps with. The system clock
   * when any real transport or settlement was asked for (see
   * `realTransportsRequested`), the sandbox's settable one otherwise.
   */
  clock: Clock
  /** A Postgres driver, when the process has one. */
  driver?: SqlDriver
}

export interface ResolveAdaptersOptions extends ResolveFoundationOptions {
  coins: readonly CoinDefinition[]
  /** What `resolveFoundation` built. Resolved first because the coin directory reads it. */
  foundation: Foundation
}

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

function requireEnv(env: Record<string, string | undefined>, name: string, why: string): string {
  const value = env[name]
  if (value === undefined || value.trim().length === 0) {
    throw new FleetStartupRefused(`${name} is required because ${why}`)
  }
  return value.trim()
}

function optionalEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim()
  return value === undefined || value.length === 0 ? undefined : value
}

/**
 * A mode switch: unset means "not asked for", `expected` means asked for, and
 * ANY other value is refused. The dangerous alternative is not a crash - it is
 * treating a typo as "not live" and starting a fixture fleet under a name
 * someone chose deliberately.
 */
function modeEnv(env: Record<string, string | undefined>, name: string, expected: string, unsetAlias?: string): boolean {
  const raw = optionalEnv(env, name)
  if (raw === undefined) return false
  const mode = raw.toLowerCase()
  if (mode === expected) return true
  if (unsetAlias !== undefined && mode === unsetAlias) return false
  throw new FleetStartupRefused(
    `${name}=${raw} is not a mode this build knows. Use "${expected}"` +
      (unsetAlias === undefined ? ' or leave it unset.' : `, "${unsetAlias}", or leave it unset.`),
  )
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`

/**
 * Does this environment ask for anything that stamps a real record with the
 * current time - a broadcast, a post, an ingested message? Decided from the
 * environment alone so the clock can be chosen BEFORE the adapters are built:
 * the stores need it at construction, and a resolution that fails afterwards
 * refuses the whole start anyway.
 */
export function realTransportsRequested(env: Record<string, string | undefined>): boolean {
  return (
    modeEnv(env, 'FLEET_SETTLEMENT', 'live') ||
    modeEnv(env, 'FLEET_PUBLISHER', 'live') ||
    optionalEnv(env, 'TELEGRAM_BOT_TOKEN') !== undefined
  )
}

/**
 * Everything a dry run must NOT be given. A dry run forces the scripted model
 * and persists nothing; a dry run that also broadcast, posted, ingested or
 * priced for real would be a live run with a misleading label. Refused rather
 * than downgraded, because "you asked for live settlement and got the fake"
 * is exactly the outcome this file exists to prevent.
 */
export function assertDryRunAsksForNothingReal(env: Record<string, string | undefined>): void {
  const asked: string[] = []
  if (modeEnv(env, 'FLEET_SETTLEMENT', 'live')) asked.push('FLEET_SETTLEMENT=live')
  if (modeEnv(env, 'FLEET_PUBLISHER', 'live')) asked.push('FLEET_PUBLISHER=live')
  if (optionalEnv(env, 'TELEGRAM_BOT_TOKEN') !== undefined) asked.push('TELEGRAM_BOT_TOKEN')
  if (modeEnv(env, 'FLEET_PRICES', 'coingecko')) asked.push('FLEET_PRICES=coingecko')
  if (modeEnv(env, 'FLEET_EVIDENCE', 'dexscreener')) asked.push('FLEET_EVIDENCE=dexscreener')
  if (asked.length > 0) {
    throw new FleetStartupRefused(
      `a dry run forces every fake, and the environment asks for the real thing: ${asked.join(', ')}. ` +
        'Unset them for a dry run, or drop --dry-run to run live.',
    )
  }
}

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------

/**
 * The indexer store this process does not have.
 *
 * `RpcChainReadModel` needs one for `binding()` and `postings()` - the fee
 * streams, which are written by the fee indexer. With a database the indexer
 * runs IN this process (see `resolveLiveChain`) and this store is not used.
 * Without one there is nowhere durable for an indexer to keep its cursors, no
 * poller runs, and the honest representation of that is a store whose every
 * method REFUSES.
 *
 * That is not a stub standing in for a working thing. `postings()` refusing
 * with "nothing is scanning the fee streams in this process" is a true
 * statement that stops a tick, whereas an empty array would be the false
 * statement "this coin has earned nothing", and a coin that has earned nothing
 * is a coin with no budget, no tier and no complaint. The refusal is the
 * feature.
 */
function refusingIndexerStore(): IndexerStore {
  const refuse = (method: string) => (): never => {
    throw new FleetStartupRefused(
      `the chain read model asked for ${method}, but this process runs no fee indexer and has ` +
        'no indexer store: a fee indexer needs a database for its cursors, and none was configured. ' +
        'Set DATABASE_URL, or accept that a live chain can answer movements but not fee history.',
    )
  }
  return {
    bindingByToken: refuse('bindingByToken'),
    postings: refuse('postings'),
  } as unknown as IndexerStore
}

/**
 * A fetch that will not exceed `rps` requests per second on this endpoint.
 *
 * WHY THIS IS HERE AND NOT IN THE INDEXER. `JsonRpcClient` takes `fetchImpl`
 * precisely so the transport policy belongs to the deployment rather than to
 * the decoder. The rate is a fact about the endpoint an operator pointed this
 * process at, not a fact about how to parse a log.
 *
 * WHY IT SERIALISES RATHER THAN COUNTING. Each call waits for the slot the
 * previous call reserved, so ten concurrent requests take ten slots and come
 * out spaced - which is the behaviour this chain actually requires. A token
 * bucket that allowed a burst would let a single `sync()` fire its whole batch
 * at once, and the first live run of this fleet did exactly that and came back
 * with an HTTP 429. The read model turned that into a refusal rather than a
 * short result, which is correct, but a refusal caused by our own impatience
 * is an outage we inflicted.
 */
export function throttledFetch(rps: number, sleep = defaultSleep): typeof globalThis.fetch {
  const minIntervalMs = 1_000 / rps
  let nextFreeAt = 0
  type FetchArgs = Parameters<typeof globalThis.fetch>
  return async (input: FetchArgs[0], init?: FetchArgs[1]): Promise<Response> => {
    const now = Date.now()
    const startAt = Math.max(now, nextFreeAt)
    // Reserved BEFORE awaiting, so concurrent callers queue behind each other
    // instead of all reading the same "free" slot and firing together.
    nextFreeAt = startAt + minIntervalMs
    if (startAt > now) await sleep(startAt - now)
    return globalThis.fetch(input, init)
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Parse a deployment block from the coin directory.
 *
 * Accepts a decimal string or a number, and refuses anything else rather than
 * coercing. `Number` on a hex string, on undefined, or on a value with a stray
 * space all produce something - 0, NaN, or a wrong number - and every one of
 * those becomes a scan that starts in the wrong place.
 */
export function parseDeployBlock(coinRef: string, raw: unknown): bigint {
  if (typeof raw === 'bigint' && raw >= 0n) return raw
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return BigInt(raw)
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw.trim())) return BigInt(raw.trim())
  throw new FleetStartupRefused(
    `coin "${coinRef}" has no usable vaultDeployedAtBlock (${typeof raw === 'bigint' ? String(raw) : JSON.stringify(raw)}). ` +
      'A live chain scan needs the block the vault came into existence at: starting at 0 is an ' +
      'hours-long walk at this chain\'s rate limit and starting at the head silently skips every ' +
      'settlement that has already happened, so it is asked for rather than guessed.',
  )
}

export interface RpcEndpoints {
  primary: string
  secondary: string
  timeoutMs: number
  rps: number
}

/**
 * The two endpoints, from the environment, or a refusal.
 *
 * TWO ENDPOINTS, ALWAYS. `QuorumRpc` takes a primary and a secondary and makes
 * them agree; a single endpoint would turn "the chain says" into "one provider
 * says", which is the assumption this system is least able to afford when the
 * answer decides whether money moves.
 */
export function resolveRpcEndpoints(env: Record<string, string | undefined>): RpcEndpoints {
  const primary = requireEnv(env, 'VENUE_RPC_URL', 'FLEET_CHAIN=live needs a chain to read')
  const secondary =
    optionalEnv(env, 'VENUE_RPC_URL_SECONDARY') ??
    // Not a silent fallback to a single endpoint: the default second provider
    // is a named, independent one, and the pair is printed in the banner.
    'https://rpc.ordofi.network'
  if (secondary === primary) {
    throw new FleetStartupRefused(
      'VENUE_RPC_URL and VENUE_RPC_URL_SECONDARY are the same endpoint; a quorum of one provider ' +
        'agreeing with itself is not a quorum',
    )
  }
  const timeoutMs = Number.parseInt(env.VENUE_RPC_TIMEOUT_MS ?? '20000', 10)
  const rps = Number.parseFloat(env.VENUE_HTTP_RPS ?? '0.8')
  if (!(rps > 0)) {
    throw new FleetStartupRefused(`VENUE_HTTP_RPS=${String(env.VENUE_HTTP_RPS)} is not a positive rate`)
  }
  return { primary, secondary, timeoutMs, rps }
}

/** The primary endpoint as a client of its own, with its own limiter. */
export function primaryRpcClient(endpoints: RpcEndpoints): JsonRpcClient {
  return new JsonRpcClient({
    endpointId: 'primary',
    url: endpoints.primary,
    timeoutMs: endpoints.timeoutMs,
    fetchImpl: throttledFetch(endpoints.rps),
  })
}

/** Build the live chain read model, or refuse. */
export function resolveLiveChain(options: ResolveAdaptersOptions): LiveChain {
  const { env, coins, clock } = options
  const endpoints = resolveRpcEndpoints(env)

  // ONE LIMITER PER ENDPOINT, because the two providers are separate services
  // with separate limits - throttling them jointly would halve the throughput
  // of both for no reason, and throttling neither is how this run earned an
  // HTTP 429 the first time it was pointed at the real chain.
  const primary = primaryRpcClient(endpoints)
  const rpc = new QuorumRpc(
    primary,
    new JsonRpcClient({
      endpointId: 'secondary',
      url: endpoints.secondary,
      timeoutMs: endpoints.timeoutMs,
      fetchImpl: throttledFetch(endpoints.rps),
    }),
  )

  // DURABLE WHEN THERE IS SOMEWHERE TO PUT THEM. With a driver the cursors,
  // the movement observations and the open halts outlive the process: a
  // restart resumes the scan where it stopped instead of re-walking from the
  // deploy block, and a halt raised before the restart is still a halt after
  // it. Without one they are in-memory, which is honest for a one-off run and
  // the reason the scheduler always passes its driver.
  const driver = options.driver
  const cursors = driver === undefined ? new InMemoryChainCursorStore() : new PgChainCursorStore(driver)
  const movements = driver === undefined ? new InMemoryVaultMovementStore() : new PgVaultMovementStore(driver)
  const halts = driver === undefined ? new InMemoryHaltStore() : new PgHaltStore(driver)

  const tracked: Array<{ coinRef: string; vault: string; fromBlock: bigint }> = []
  const issued: IssuedVault[] = []
  for (const coin of coins) {
    const fromBlock = parseDeployBlock(coin.coinRef, coin.vaultDeployedAtBlock)
    tracked.push({ coinRef: coin.coinRef, vault: coin.vault, fromBlock })
    issued.push({
      token: coin.token,
      vault: coin.vault,
      // What the consent CLAIMS; the indexer reads the chain's values from
      // getLaunchedToken and applies them with a warning where they differ.
      buybackEnabled: false,
      creatorTaxBps: 0,
      coverageStartUnix: clock.nowUnix(),
      spendAuthorityActive: true,
    })
  }

  // THE FEE INDEXER, when there is a database to keep its cursors in. It scans
  // from the earliest vault deployment, watches the factory for launches and
  // recipient changes and the hook for sweeps, and writes bindings and postings
  // into the same store the read model reads. `RpcChainReadModel.sync()` ticks
  // it before advancing the movement cursors, so one call moves both.
  let indexer: VaultIndexer | undefined
  if (driver !== undefined) {
    const startBlock = tracked.reduce<bigint | undefined>(
      (min, v) => (min === undefined || v.fromBlock < min ? v.fromBlock : min),
      undefined,
    )
    if (startBlock === undefined) throw new FleetStartupRefused('the coin directory is empty')
    indexer = new VaultIndexer({
      rpc,
      store: new PgIndexerStore(driver),
      registry: { issued: async () => issued },
      haltSink: halts,
      config: {
        startBlock,
        sweepIntervalSeconds: Math.min(...coins.map((c) => c.sweepIntervalSeconds)),
        registryContract: VENUE.contracts.v2Factory,
        hookContract: VENUE.contracts.v2MemeHook,
      },
    })
  }

  // CHUNK AND RANGE BUDGET, from the chain's measured rate limit.
  //
  // Venue answers about 0.8 requests a second, and a batch of ten JSON-RPC calls
  // spends ten slots rather than one. A tick that scans a thousand blocks in
  // hundred-block chunks is ten requests per vault before any block lookups, so
  // the budget is small on purpose and the scan is INCREMENTAL: it starts from
  // the stored cursor and moves forward, and a run that does not reach the head
  // says so through `stillBehind` rather than pretending it caught up.
  const chunkBlocks = BigInt(env.VENUE_LOG_CHUNK_BLOCKS ?? '10000')
  const maxRangesPerSync = Number.parseInt(env.FLEET_MAX_RANGES_PER_SYNC ?? '2', 10)
  const maxCoverageLagSeconds = Number.parseInt(env.FLEET_MAX_COVERAGE_LAG_SECONDS ?? '3600', 10)
  if (!(maxCoverageLagSeconds > 0)) {
    throw new FleetStartupRefused(`FLEET_MAX_COVERAGE_LAG_SECONDS=${String(env.FLEET_MAX_COVERAGE_LAG_SECONDS)} is not a positive number of seconds`)
  }

  const indexerStore = driver === undefined ? undefined : new PgIndexerStore(driver)
  const model = new RpcChainReadModel(
    {
      rpc,
      indexerStore: indexerStore ?? refusingIndexerStore(),
      cursors,
      movements,
      halts,
      ...(indexer === undefined ? {} : { feeIndexer: indexer }),
    },
    {
      chunkBlocks,
      maxRangesPerSync,
      maxCoverageLagSeconds,
    },
  )
  for (const v of tracked) {
    const coin = coins.find((c) => c.coinRef === v.coinRef)
    if (coin === undefined) continue
    model.track({ vault: coin.vault, token: coin.token, deployedAtBlock: v.fromBlock })
  }

  return {
    model,
    sync: (nowUnix: number) => model.sync(nowUnix),
    cursors,
    endpoints: [endpoints.primary, endpoints.secondary],
    vaults: tracked,
    primary,
    rpc,
    maxCoverageLagSeconds,
    ...(indexer === undefined ? {} : { indexer }),
    ...(indexerStore === undefined ? {} : { indexerStore }),
  }
}

// ---------------------------------------------------------------------------
// Holders, signals, assets, keyring
// ---------------------------------------------------------------------------

/**
 * The Transfer replay behind the concentration signals, or a refusal.
 *
 * It needs the live chain (the quorum), a database (balances are a ledger, and
 * a ledger that vanishes with the process re-walks every token from launch on
 * every restart) and the fee indexer's bindings (which name each token's
 * launch block). The deployer comes from getLaunchedToken, read once per
 * token at the agreed head and kept: it is immutable on the factory.
 */
function resolveHolders(env: Record<string, string | undefined>, chain: LiveChain | undefined, driver: SqlDriver | undefined): LiveHolders {
  if (chain === undefined) {
    throw new FleetStartupRefused('FLEET_HOLDERS=index needs FLEET_CHAIN=live: a holder table is replayed from the chain, and there is none to replay')
  }
  const store = chain.indexerStore
  if (driver === undefined || store === undefined) {
    throw new FleetStartupRefused(
      'FLEET_HOLDERS=index needs DATABASE_URL: balances are a ledger with a cursor, and the fee indexer whose bindings ' +
        'name each launch block runs only with a database',
    )
  }
  const chunkBlocks = BigInt(env.VENUE_LOG_CHUNK_BLOCKS ?? '10000')
  const maxRangesPerTick = Number.parseInt(env.FLEET_MAX_RANGES_PER_SYNC ?? '2', 10)
  const deployers = new Map<string, string>()
  const rpc = chain.rpc

  const tokens = async (): Promise<readonly IndexedToken[]> => {
    const out: IndexedToken[] = []
    let head: BlockRef | undefined
    for (const binding of await store.bindings()) {
      let deployer = deployers.get(binding.token)
      if (deployer === undefined) {
        head ??= await rpc.head()
        const launched = decodeLaunchedToken(
          await rpc.call({
            to: VENUE.contracts.v2Factory,
            data: encodeAddressArgCall(GET_LAUNCHED_TOKEN_SELECTOR, binding.token),
            blockHash: head.hash,
          }),
        )
        if (!launched.exists) continue
        deployer = launched.deployer.toLowerCase()
        deployers.set(binding.token, deployer)
      }
      out.push({ token: binding.token, launchBlockNumber: binding.launchBlockNumber, deployer })
    }
    return out
  }

  const indexer = new HolderIndexer({
    rpc,
    store: new PgHolderBalanceStore(driver),
    tokens,
    config: { chunkBlocks, maxRangesPerTick, hookContract: VENUE.contracts.v2MemeHook },
  })
  return {
    indexer,
    sync: async (nowUnix: number) => ({ stillBehind: (await indexer.tick(nowUnix)).stillBehind }),
  }
}

/**
 * The policy-token keyring, or a refusal. Both halves or neither: a key id
 * without its secret, or a secret under the sandbox's id, would sign tokens
 * nobody can attribute to an operator decision.
 */
function resolvePolicyKeyring(env: Record<string, string | undefined>): ResolvedKeyring | undefined {
  const keyId = optionalEnv(env, 'POLICY_SIGNING_KEY_ID')
  const key = optionalEnv(env, 'POLICY_SIGNING_KEY')
  if (keyId === undefined && key === undefined) return undefined
  if (keyId === undefined || key === undefined) {
    throw new FleetStartupRefused('POLICY_SIGNING_KEY_ID and POLICY_SIGNING_KEY are set together or not at all')
  }
  if (keyId === SANDBOX_POLICY_KEY_ID) {
    throw new FleetStartupRefused(`POLICY_SIGNING_KEY_ID must not be the sandbox id "${SANDBOX_POLICY_KEY_ID}"`)
  }
  try {
    return { keyring: new PolicyKeyring({ [keyId]: key }), keyId }
  } catch (error) {
    throw new FleetStartupRefused(`POLICY_SIGNING_KEY refused: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * The quote assets, described by their contracts at the agreed head and
 * governed by the quote_asset table. Every coin's quote asset is read; one
 * that nobody approved, or whose row contradicts its contract, refuses the
 * whole start - a fleet that priced one coin's fees on assumed decimals is
 * the failure this registry exists to end.
 */
export async function resolveLiveAssets(
  chain: LiveChain,
  driver: SqlDriver,
  coins: readonly CoinDefinition[],
  substitutions: SubstitutionLedger,
): Promise<ChainAssetRegistry> {
  await chain.rpc.assertChain()
  const at = await chain.rpc.head()
  let registry: ChainAssetRegistry
  try {
    registry = await loadAssetRegistry({
      reader: new ChainAssetReader(chain.rpc, new PgAssetPolicy(driver)),
      addresses: coins.map((coin) => coin.quoteAsset),
      at,
    })
  } catch (error) {
    throw new FleetStartupRefused(
      `the quote assets could not be resolved from the chain and quote_asset: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  substitutions.real(
    'assets',
    `decimals and symbol read on chain at block ${String(at.number)}; enabled/pausable/cap from Postgres quote_asset ` +
      `for ${registry
        .all()
        .map((a) => `${a.symbol}/${String(a.decimals)}${a.enabled ? '' : ' (DISABLED)'}`)
        .join(', ')}`,
  )
  return registry
}

export interface ResolveSignalsOptions {
  readonly chain: LiveChain
  readonly holders: LiveHolders
  readonly assets: ChainAssetRegistry
  readonly prices: UsdPriceBook
  /** The aggregator side of the pool-share ratio. Absent means post-graduation samples refuse. */
  readonly evidence?: DexscreenerEvidenceSource
  readonly clock: Clock
}

/**
 * The real qualification signals: breadth from the indexed trades, concentration
 * from the holder replay, pool share from the postings against the aggregator.
 * Every input refuses rather than defaults, and `computeQualificationSignals`
 * turns each refusal into SignalsUnavailableError, which the tick records as
 * `signals_unavailable` and which blocks an upgrade and nothing else.
 */
export function resolveSignals(options: ResolveSignalsOptions): SignalsProvider {
  const { chain, holders, assets, prices, evidence, clock } = options
  const model = chain.model
  const volume = new PostingsVolumeSource({
    binding: (token) => model.binding(token),
    postings: (vault, fromUnix, toUnix) => model.postings(vault, fromUnix, toUnix),
    prices: toIndexerOracle(prices),
    decimals: (asset) => assets.get(asset)?.decimals,
    ...(evidence === undefined ? {} : { external: evidence }),
    nowUnix: () => clock.nowUnix(),
  })
  return {
    compute: async (binding: CoinBinding, nowUnix: number) =>
      computeQualificationSignals({
        binding,
        trades: {
          window: async (token, fromUnix, toUnix) => {
            // The fee scan reaches back to the launch block, so coverage runs
            // from launch: a window that opens before launch is fully covered
            // (nothing traded before the token existed), and `postings()` has
            // already refused if the watermark does not reach `toUnix`.
            const postings = await model.postings(binding.vault, fromUnix, toUnix)
            return new PostingsTradeSource(postings, Math.min(binding.launchedAtUnix, fromUnix), toUnix).window(
              token,
              fromUnix,
              toUnix,
            )
          },
        },
        holders: holders.indexer,
        volume,
        options: { nowUnix },
      }),
  }
}

// ---------------------------------------------------------------------------
// Everything else
// ---------------------------------------------------------------------------

function resolvePersistence(driver: SqlDriver, clock: Clock): Persistence {
  const nowUnix = (): number => clock.nowUnix()
  return {
    vaults: new PgVaultRepository(driver),
    screening: new PgScreeningStore(driver),
    receipts: new PgReceiptStore(driver, nowUnix),
    approvals: new PgApprovalStore(driver),
    invoices: new PgInvoiceRegistry(driver, nowUnix),
    ledgerStore: new SqlLedgerStore(pgLedgerDriver(driver)),
    images: new PgImageAssetStore(driver),
    accounts: new PgAccountRegistry(driver),
    posts: new PgPostRegistry(driver),
    labels: new PgLabelAttestationStore(driver),
    predicates: new PgPredicateQueue(driver, clock),
    pending: new PgPendingPurchaseStore(driver),
  }
}

function resolvePrices(env: Record<string, string | undefined>): CoinGeckoPriceBook {
  const raw = requireEnv(env, 'COINGECKO_IDS', 'FLEET_PRICES=coingecko needs to know which CoinGecko id prices each quote asset')
  let ids: unknown
  try {
    ids = JSON.parse(raw)
  } catch (error) {
    throw new FleetStartupRefused(`COINGECKO_IDS is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof ids !== 'object' || ids === null || Array.isArray(ids)) {
    throw new FleetStartupRefused('COINGECKO_IDS must be a JSON object of asset address -> CoinGecko id')
  }
  const map: Record<string, string> = {}
  for (const [asset, id] of Object.entries(ids as Record<string, unknown>)) {
    if (!ADDRESS.test(asset) || typeof id !== 'string' || id.trim().length === 0) {
      throw new FleetStartupRefused(`COINGECKO_IDS entry ${asset} -> ${JSON.stringify(id)} is not an address -> id pair`)
    }
    map[asset.toLowerCase()] = id.trim()
  }
  if (Object.keys(map).length === 0) throw new FleetStartupRefused('COINGECKO_IDS maps no asset')
  const apiKey = optionalEnv(env, 'COINGECKO_API_KEY')
  try {
    return new CoinGeckoPriceBook({ ids: map, ...(apiKey === undefined ? {} : { apiKey }) })
  } catch (error) {
    throw new FleetStartupRefused(`the CoinGecko price book refused to construct: ${String(error)}`)
  }
}

function resolveEvidence(env: Record<string, string | undefined>): DexscreenerEvidenceSource {
  const chainSlug = requireEnv(
    env,
    'DEXSCREENER_CHAIN_SLUG',
    'FLEET_EVIDENCE=dexscreener needs Dexscreener\'s own path segment for this chain, which has no default',
  )
  return new DexscreenerEvidenceSource({ chain: String(VENUE.chainId), chainSlug })
}

function resolveCatalog(clock: Clock): VendorCatalog {
  const dataDir = fileURLToPath(new URL('../../../data/', import.meta.url))
  try {
    return catalogToBrokerCatalog(loadCatalog({ dataDir, nowUnix: clock.nowUnix() }).catalog)
  } catch (error) {
    throw new FleetStartupRefused(
      `FLEET_CATALOG=data and the data directory did not load: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function resolveSettlement(
  env: Record<string, string | undefined>,
  chain: LiveChain | undefined,
  clock: Clock,
): LiveSettlement {
  if (chain === undefined) {
    throw new FleetStartupRefused(
      'FLEET_SETTLEMENT=live needs FLEET_CHAIN=live: a reimbursement is broadcast on the chain the ' +
        'fleet reads, and there is no chain to broadcast on',
    )
  }
  const key = requireEnv(env, 'OPERATOR_SIGNER_KEY', 'FLEET_SETTLEMENT=live signs a pullBudget transaction')
  const treasuryAddress = requireEnv(
    env,
    'OPERATOR_TREASURY_ADDRESS',
    'FLEET_SETTLEMENT=live pays every reimbursement to the operator treasury and nowhere else',
  )
  if (!ADDRESS.test(treasuryAddress)) {
    throw new FleetStartupRefused('OPERATOR_TREASURY_ADDRESS is not a 20-byte address')
  }
  if (treasuryAddress.toLowerCase() === ZERO_ADDRESS) {
    throw new FleetStartupRefused('OPERATOR_TREASURY_ADDRESS is the zero address; a reimbursement paid there is burned')
  }
  let signer: PrivateKeySigner
  try {
    signer = new PrivateKeySigner(key)
  } catch (error) {
    throw new FleetStartupRefused(`OPERATOR_SIGNER_KEY refused: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (signer.address === ZERO_ADDRESS) {
    throw new FleetStartupRefused('OPERATOR_SIGNER_KEY derives the zero address')
  }
  if (signer.address === treasuryAddress.toLowerCase()) {
    throw new FleetStartupRefused(
      'OPERATOR_SIGNER_KEY derives the treasury address itself; the hot signing key and the treasury ' +
        'it pays into must be different keys, or a leaked signer is a leaked treasury',
    )
  }
  const treasury: OperatorTreasury = { address: treasuryAddress.toLowerCase(), label: 'operator treasury' }
  return {
    port: new ChainSettlementPort({
      rpc: chain.primary,
      signer,
      treasury,
      chainId: VENUE.chainId,
      confirmations: 2,
      clock,
    }),
    treasury,
    signerAddress: signer.address,
  }
}

function resolveMessages(
  token: string,
  driver: SqlDriver | undefined,
  coins: readonly CoinDefinition[],
): LiveMessages {
  if (driver === undefined) {
    throw new FleetStartupRefused(
      'TELEGRAM_BOT_TOKEN is set and there is no DATABASE_URL: getUpdates is a consuming stream, so ' +
        'messages must be stored somewhere durable or every restart loses the window it was polling',
    )
  }
  const chatBindings: Record<string, string> = {}
  for (const coin of coins) {
    const chatId = coin.accounts.get('telegram')
    if (chatId === undefined) continue
    const held = chatBindings[chatId]
    if (held !== undefined) {
      throw new FleetStartupRefused(
        `telegram chat ${chatId} is bound to both "${held}" and "${coin.coinRef}"; one chat belongs to one coin`,
      )
    }
    chatBindings[chatId] = coin.coinRef
  }
  if (Object.keys(chatBindings).length === 0) {
    throw new FleetStartupRefused(
      'TELEGRAM_BOT_TOKEN is set and no coin names a telegram account; a bot with nothing to listen to is misconfiguration',
    )
  }
  const inbound = new BotApiTelegramInbound(token, { post: telegramHttp })
  const source = new TelegramMessageSource(inbound, new PgInboundMessageStore(driver), { chatBindings })
  return { source, poll: () => source.poll() }
}

function resolveApprovalGate(env: Record<string, string | undefined>, clock: Clock): { gate: ApprovalGate; detail: string } {
  const endpoint = optionalEnv(env, 'PUBLISHER_APPROVAL_URL')
  if (endpoint === undefined) {
    // FAIL CLOSED. No review queue means no approval, and no approval means a
    // promotional post is refused. The alternative - auto-approve because
    // nobody configured a reviewer - is the one thing an approval step must
    // never do.
    return {
      gate: createDenyAllApprovalGate('no approval endpoint configured (PUBLISHER_APPROVAL_URL)', () => clock.nowUnix()),
      detail: 'DENY-ALL: PUBLISHER_APPROVAL_URL unset, so every post needing approval is refused',
    }
  }
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new FleetStartupRefused(`PUBLISHER_APPROVAL_URL "${endpoint}" is not a URL`)
  }
  if (url.protocol !== 'https:') throw new FleetStartupRefused('PUBLISHER_APPROVAL_URL must be https')
  const apiToken = requireEnv(env, 'PUBLISHER_APPROVAL_TOKEN', 'PUBLISHER_APPROVAL_URL names a review queue that authenticates its callers')
  return {
    gate: createHttpApprovalGate({ endpoint, apiToken, nowUnix: () => clock.nowUnix() }),
    detail: `HTTP review queue at ${url.host}`,
  }
}

function resolvePublisher(
  env: Record<string, string | undefined>,
  persistence: Persistence | undefined,
  driver: SqlDriver | undefined,
  clock: Clock,
): { publisher: Publisher; detail: string } {
  if (persistence === undefined || driver === undefined) {
    throw new FleetStartupRefused(
      'FLEET_PUBLISHER=live needs DATABASE_URL: account bindings, OAuth tokens and the post registry ' +
        'live in Postgres, and a publisher that forgot its posts on restart could not verify them',
    )
  }
  const tokenKey = requireEnv(env, 'PUBLISHER_TOKEN_KEY', 'X OAuth tokens are stored sealed, never in the clear')
  let credentials: PgAccountCredentialStore
  try {
    credentials = new PgAccountCredentialStore(driver, tokenKey)
  } catch (error) {
    throw new FleetStartupRefused(`PUBLISHER_TOKEN_KEY refused: ${error instanceof Error ? error.message : String(error)}`)
  }
  const clientId = requireEnv(env, 'X_CLIENT_ID', 'FLEET_PUBLISHER=live refreshes X tokens through the X OAuth client')
  const redirectUri = requireEnv(env, 'X_REDIRECT_URI', 'the X OAuth client is registered with one redirect URI')
  const clientSecret = optionalEnv(env, 'X_CLIENT_SECRET')
  const receiptsBaseUrl = requireEnv(env, 'PUBLISHER_RECEIPTS_BASE_URL', 'every disclosure links the coin\'s receipts page')
  const allowedLinkHosts = (optionalEnv(env, 'PUBLISHER_ALLOWED_LINK_HOSTS') ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0)
  const telegramToken = requireEnv(env, 'TELEGRAM_BOT_TOKEN', 'FLEET_PUBLISHER=live posts to Telegram through the bot')

  const oauth = createXOAuth2Client({
    clientId,
    redirectUri,
    nowUnix: () => clock.nowUnix(),
    ...(clientSecret === undefined ? {} : { clientSecret }),
  })
  const nowUnix = (): number => clock.nowUnix()
  const xTransport = createXHttpTransport({
    credentials,
    oauth,
    labelProbe: createAttestedLabelProbe(persistence.labels, clock),
    nowUnix,
  })
  const images = persistence.images
  const approvals = resolveApprovalGate(env, clock)

  let publisher: Publisher
  try {
    publisher = createPublisher({
      policy: {
        // From config, on purpose. The shipped constant is a placeholder and
        // createPublisher refuses it, which is README gate (e): a live
        // publisher cannot be constructed until an operator is named.
        operatorName: DISCLOSURE.operatorName,
        receiptsBaseUrl,
        allowedLinkHosts,
        allowedRouterAddresses: [],
        maxAccountLabelAgeSeconds: 24 * 3_600,
      },
      adapters: {
        x_operator: createXAdapter({ channel: 'x_operator', transport: xTransport, images, nowUnix }),
        x_client_delegated: createXAdapter({ channel: 'x_client_delegated', transport: xTransport, images, nowUnix }),
        telegram: createTelegramAdapter({
          transport: createTelegramHttpTransport({ botToken: telegramToken }),
          images,
          nowUnix,
        }),
      },
      accounts: persistence.accounts,
      posts: persistence.posts,
      images,
      // The publishing.health job's verdicts. An X account with no fresh ok is refused at channel_suspended.
      health: new PgChannelHealthStore(driver),
      log: createJsonEventLog((line) => process.stderr.write(`${line}\n`)),
      approvals: approvals.gate,
      scheduler: createTimerScheduler((id, error) => {
        process.stderr.write(`publisher read-back ${id} failed: ${String(error)}\n`)
      }),
      clock,
    })
  } catch (error) {
    if (error instanceof PublisherConfigError) {
      throw new FleetStartupRefused(
        `FLEET_PUBLISHER=live and the publisher refused to construct: ${error.message}. ` +
          'DISCLOSURE.operatorName in config/protocol.ts must name the operator before launch.',
      )
    }
    throw error
  }
  return {
    publisher,
    detail:
      `X (${clientId.slice(0, 6)}...) and Telegram over HTTP; receipts at ${new URL(receiptsBaseUrl).host}; ` +
      `${String(allowedLinkHosts.length)} allowed link host(s); approval ${approvals.detail}`,
  }
}

// ---------------------------------------------------------------------------

/**
 * Resolve what the coin directory needs before it can be read: the durable
 * stores and the vendor catalog. Recorded here, once; `resolveAdapters` takes
 * the result rather than building a second copy.
 */
export function resolveFoundation(options: ResolveFoundationOptions): Foundation {
  const { env, substitutions, driver, clock } = options
  const foundation: Foundation = {}

  if (driver !== undefined) {
    foundation.persistence = resolvePersistence(driver, clock)
    substitutions.real('vaults', 'Postgres vault_record')
    substitutions.real('screening', 'Postgres screening_result')
    substitutions.real('receipts', 'Postgres receipt')
    substitutions.real('approvals', 'Postgres human_approval')
    substitutions.real('invoices', 'Postgres vendor_invoice')
    substitutions.real('ledgerStore', 'Postgres ledger_*')
    substitutions.real('images', 'Postgres image_asset')
    substitutions.real('predicateQueue', 'Postgres ops_predicate_check')
    substitutions.real('pendingPurchases', 'Postgres pending_purchase')
  }

  if (modeEnv(env, 'FLEET_CATALOG', 'data')) {
    foundation.catalog = resolveCatalog(clock)
    substitutions.real('catalog', 'data/vendors.json + data/skus.json + sealed rate cards')
  }

  return foundation
}

/**
 * A resolver from a deploy transaction to the block it landed in, over the
 * live chain's primary endpoint. Built only under FLEET_CHAIN=live; a sandbox
 * fleet has no chain to ask and no block to need. A malformed hash refuses
 * rather than being sent to the node as a query for nothing.
 */
export function deployBlockResolver(env: Record<string, string | undefined>): (txHash: string) => Promise<bigint | undefined> {
  const rpc = primaryRpcClient(resolveRpcEndpoints(env))
  return async (txHash: string): Promise<bigint | undefined> => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new FleetStartupRefused(`deploy transaction "${txHash}" is not a 32-byte hash`)
    }
    const receipt = await rpc.getTransactionReceipt(txHash as Hex)
    return receipt === null ? undefined : receipt.blockNumber
  }
}

/**
 * Resolve every adapter this process has been asked for.
 *
 * Each block below is "was it asked for, and can it be honoured" - never "can
 * it be honoured, and if not quietly do something else". Every real one is
 * recorded, so the banner's `real:` section is exactly this function's output
 * plus `resolveFoundation`'s.
 */
export function resolveAdapters(options: ResolveAdaptersOptions): ResolvedAdapters {
  const { env, substitutions, driver, clock, coins, foundation } = options
  const resolved: ResolvedAdapters = { ...foundation }

  if (modeEnv(env, 'FLEET_CHAIN', 'live', 'sandbox')) {
    const chain = resolveLiveChain(options)
    resolved.chain = chain
    const startBlock = chain.vaults.reduce((min, v) => (v.fromBlock < min ? v.fromBlock : min), chain.vaults[0]?.fromBlock ?? 0n)
    substitutions.real(
      'chain',
      `Venue chain ${String(VENUE.chainId)} over a 2-provider quorum (${chain.endpoints.join(', ')}), ` +
        `${String(chain.vaults.length)} vault(s) tracked from their deployment blocks; ` +
        (chain.indexer === undefined
          ? 'NO FEE INDEXER (no database), so fee history and bindings REFUSE'
          : `fee indexer over Postgres indexer_* from block ${String(startBlock)}`),
    )
  }

  // The counters and the escalation sink are the two pieces of state that must
  // outlive a process, and they are the reason DATABASE_URL matters here: spend
  // counters held in memory reset every restart, and a cap that resets is a cap
  // that can be cleared by crashing.
  if (driver !== undefined) {
    resolved.counters = new PgFleetCounters(driver)
    resolved.escalations = new PgEscalationSink(driver)
    substitutions.real('fleetCounters', 'Postgres fleet_disbursement / fleet_proposal')
    substitutions.real('escalations', 'Postgres fleet_escalation')
  }

  if (modeEnv(env, 'FLEET_PRICES', 'coingecko')) {
    resolved.prices = resolvePrices(env)
    substitutions.real('prices', 'CoinGecko simple/price, refreshed before every tick')
  }

  if (modeEnv(env, 'FLEET_EVIDENCE', 'dexscreener')) {
    const evidence = resolveEvidence(env)
    resolved.evidence = evidence
    resolved.predicateVerifier = new BrokerPredicateVerifier(new PredicateRegistry(evidence), clock)
    substitutions.real('evidence', `Dexscreener token-pairs on chain ${String(VENUE.chainId)} (${String(env.DEXSCREENER_CHAIN_SLUG)})`)
    substitutions.real('predicateVerifier', 'broker PredicateRegistry over Dexscreener evidence')
  }

  if (modeEnv(env, 'FLEET_SETTLEMENT', 'live')) {
    const settlement = resolveSettlement(env, resolved.chain, clock)
    resolved.settlement = settlement
    substitutions.real(
      'settlement',
      `CoinVault.pullBudget signed by ${settlement.signerAddress}, paid to ${settlement.treasury.address}, 2 confirmations`,
    )
  }

  const telegramToken = optionalEnv(env, 'TELEGRAM_BOT_TOKEN')
  if (telegramToken !== undefined) {
    resolved.messages = resolveMessages(telegramToken, driver, coins)
    substitutions.real('messages', 'Telegram getUpdates into Postgres inbound_message, one stream for the fleet')
  }

  if (modeEnv(env, 'FLEET_PUBLISHER', 'live')) {
    const { publisher, detail } = resolvePublisher(env, foundation.persistence, driver, clock)
    resolved.publisher = publisher
    substitutions.real('publisher.transports', detail)
  }

  // THE DESK answers holders in the coin's Telegram chat. It needs the bot
  // (moderation and the admin check), the quorum (the FactSheet reads) and a
  // database (the refusal log outlives the process). Absent any of them the
  // desk phase records `desk_unavailable`; nothing is answered by a fake.
  if (telegramToken !== undefined && resolved.chain !== undefined && driver !== undefined) {
    const refusalLog = new PgRefusalLog(driver)
    const anthropicKey = optionalEnv(env, 'ANTHROPIC_API_KEY')
    resolved.desk = {
      port: new TelegramDeskPort({
        moderation: new TelegramModerationActions({ token: telegramToken, http: { post: telegramHttp }, clock: () => clock.nowUnix() }),
        chainReader: new VenueDeskChainReader(resolved.chain.primary),
        explorer: urlExplorer(requireEnv(env, 'VENUE_EXPLORER_BASE_URL', 'the desk cites the block explorer in every fact reply')),
        refusalLog,
        operatorName: DISCLOSURE.operatorName,
        ...(anthropicKey === undefined ? {} : { model: new AnthropicDeskModel(new Anthropic({ apiKey: anthropicKey }).messages) }),
        clock: () => clock.nowUnix(),
      }),
      load: async () => {
        await refusalLog.load(clock.nowUnix() - 86_400)
      },
    }
    substitutions.real(
      'desk',
      `Telegram desk over the quorum FactSheet reader, refusals in Postgres desk_refusal, ${anthropicKey === undefined ? 'T0 commands only (no ANTHROPIC_API_KEY)' : 'T1 model answers'}`,
    )
  } else {
    substitutions.fake(
      'desk',
      'no TELEGRAM_BOT_TOKEN + FLEET_CHAIN=live + DATABASE_URL together; holder questions are corpus only (desk_unavailable)',
    )
  }

  // X MENTIONS ride the publisher's credential store: the same sealed tokens
  // that post are the ones that read, and every bound x_* account is polled.
  if (resolved.publisher !== undefined && driver !== undefined) {
    const accountBindings: Record<string, string> = {}
    for (const coin of coins) {
      for (const channel of ['x_operator', 'x_client_delegated'] as const) {
        const accountId = coin.accounts.get(channel)
        if (accountId !== undefined) accountBindings[accountId] = coin.coinRef
      }
    }
    if (Object.keys(accountBindings).length > 0) {
      const pollSeconds = Number.parseInt(env.X_MENTIONS_POLL_SECONDS ?? '120', 10)
      if (!(pollSeconds > 0)) throw new FleetStartupRefused(`X_MENTIONS_POLL_SECONDS=${String(env.X_MENTIONS_POLL_SECONDS)} is not a positive number of seconds`)
      const source = new XMentionsMessageSource({
        credentials: new PgAccountCredentialStore(driver, requireEnv(env, 'PUBLISHER_TOKEN_KEY', 'X OAuth tokens are stored sealed')),
        oauth: createXOAuth2Client({
          clientId: requireEnv(env, 'X_CLIENT_ID', 'reading mentions refreshes X tokens'),
          redirectUri: requireEnv(env, 'X_REDIRECT_URI', 'the X OAuth client is registered with one redirect URI'),
          nowUnix: () => clock.nowUnix(),
          ...(optionalEnv(env, 'X_CLIENT_SECRET') === undefined ? {} : { clientSecret: String(optionalEnv(env, 'X_CLIENT_SECRET')) }),
        }),
        store: new PgXMentionStore(driver),
        accountBindings,
        clock: () => clock.nowUnix(),
      })
      resolved.mentions = { source, pollSeconds, poll: () => source.poll() }
      substitutions.real('mentions', `X mentions of ${String(Object.keys(accountBindings).length)} bound account(s) every ${String(pollSeconds)}s into inbound_message`)
    }
  }

  if (modeEnv(env, 'FLEET_HOLDERS', 'index')) {
    resolved.holders = resolveHolders(env, resolved.chain, driver)
    substitutions.real(
      'holders',
      'ERC-20 Transfer replay per bound token into Postgres token_holder_balance, to the finalized head',
    )
  }

  const keyring = resolvePolicyKeyring(env)
  if (keyring !== undefined) {
    resolved.policyKeyring = keyring
    substitutions.real('policyKeyring', `policy tokens signed under key id "${keyring.keyId}"`)
  }
  // A REAL MONEY PATH REFUSES THE SANDBOX KEY. The policy token is what the
  // broker checks before it authorises a pull or reads a catalog quote; a
  // token under a key that ships in the source is a token anyone can mint.
  if (keyring === undefined && (resolved.settlement !== undefined || resolved.catalog !== undefined)) {
    const asked = [
      ...(resolved.settlement === undefined ? [] : ['FLEET_SETTLEMENT=live']),
      ...(resolved.catalog === undefined ? [] : ['FLEET_CATALOG=data']),
    ]
    throw new FleetStartupRefused(
      `${asked.join(' and ')} need POLICY_SIGNING_KEY_ID and POLICY_SIGNING_KEY: the broker's policy tokens would ` +
        'otherwise be signed with the sandbox key that ships in the source, and a real settlement or a real catalog ' +
        'quote authorised by that key is authorised by nobody',
    )
  }

  return resolved
}

export type { BlockRef, SyncResult }
