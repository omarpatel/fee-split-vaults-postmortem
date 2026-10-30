/**
 * WHAT IS REAL IN THIS PROCESS, AND WHAT IS NOT.
 *
 * Every external dependency the control plane can reach is resolved HERE from
 * the environment, and each resolution is recorded in the same
 * SubstitutionLedger the fleet uses, so the boot banner names every fake in
 * the same words the runner would. The rule is the fleet's: a switch that is
 * set and cannot be satisfied is a STARTUP REFUSAL, never a quiet fall-back;
 * a switch that is unset is a recorded fake whose routes fail closed.
 *
 * The same adapters as the fleet, over the same variables: one DATABASE_URL,
 * one RPC pair, one OPERATOR_SIGNER_KEY, one PUBLISHER_TOKEN_KEY, one
 * COINGECKO_IDS. Two processes reading two copies of the truth would be the
 * first thing to drift.
 */

import { VENUE, TIERS } from '../../../config/protocol.js'
import type { Address } from '@fee-split-vaults/core'
import {
  AssetReadError,
  ChainAssetReader,
  ChainRecipientReader,
  ChainVaultDeployer,
  CoinGeckoPriceBook,
  CredentialMissingError,
  EscrowReadClient,
  PgAccountCredentialStore,
  PgAccountRegistry,
  PgImageAssetStore,
  PgIndexerStore,
  PgInvoiceRegistry,
  PgLabelAttestationStore,
  PgPendingPurchaseStore,
  PgReceiptStore,
  PgScreeningStore,
  PgVaultRepository,
  PrivateKeySigner,
  RecipientReadError,
  SignerKeyError,
  SourceUnavailableError,
  VaultOperatorClient,
  VaultReadClient,
  pgLedgerDriver,
  type SqlDriver,
} from '@fee-split-vaults/adapters'
import { loadCatalog } from '@fee-split-vaults/catalog'
import { SqlAgentRunStore, SubstitutionLedger, resolveModelClient, throttledFetch } from '@fee-split-vaults/fleet'
import { JsonRpcClient, QuorumRpc } from '@fee-split-vaults/indexer'
import { SqlLedgerStore } from '@fee-split-vaults/ledger'
import type { AgentRunStore, PinnedUsdPrice } from '@fee-split-vaults/orchestrator'
import {
  DEFAULT_LEXICON_SOURCE,
  DEFAULT_OFAC_SDN_URL,
  LexiconFileError,
  SampleSdnSource,
  SdnLoadError,
  createAnthropicAdjudicator,
  createAnthropicMessagesPort,
  loadScreeningSources,
  type ScreeningSourceOptions,
  type ScreeningSources,
} from '@fee-split-vaults/screening'

import { connectPg } from '../../../ops/lib/pg.js'
import { PgDriver } from '../../../ops/migrations/driver.js'
import { unwiredAgentPort, type AgentPort } from './agent.js'
import { settledReads } from './chain.js'
import type { ApiConfig } from './config.js'
import { PgKybAttestationStore } from './diligence/kyb.js'
import { ChainDiligenceProbe } from './diligence/probe.js'
import { HttpError } from './http/router.js'
import type { AppDeps } from './main.js'
import { InMemoryOnboardingStore, type OnboardingStore, type RecipientReader } from './onboarding.js'
import type { RefusalRecord, ReportAsset } from './report.js'
import type { RouteDeps } from './routes.js'
import { PgOnboardingStore } from './store/pg.js'
import { ChainTokenMetadata, ChainVaultViews } from './v1/chain.js'
import { PgDevSessionStore, PgEscalationQueue, PgOperatedAccounts, PgProcurementOutcomes, PgQfReader, PgQuoteStore } from './v1/pg.js'
import type { VendorDirectory, VendorSummary } from './v1/ports.js'

/** A dependency the environment asked for could not be built. Boot stops. */
export class StartupRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StartupRefused'
  }
}

export interface LiveDeps {
  deps: AppDeps
  ledger: SubstitutionLedger
  /** Releases what resolution opened: today, the database. */
  close(): Promise<void>
}

/** Blocks a deploy receipt must be buried before the vault counts as deployed. */
const DEPLOY_CONFIRMATIONS = 2
/** How many times a read may ask the quorum again after a disagreement or a node error. */
const QUORUM_ATTEMPTS = 6
const QUORUM_PAUSE_MS = 1_500
/** Blocks below the lower reported head the API pins its reads (~5 minutes; see chain.ts). */
const PIN_DEPTH = 2_000n

export async function resolveLiveDeps(config: ApiConfig, env: NodeJS.ProcessEnv = process.env): Promise<LiveDeps> {
  const ledger = new SubstitutionLedger()
  const now = (): number => Math.floor(Date.now() / 1000)

  // THE CHAIN. Two endpoints, one limiter each, every read agreed by both.
  const [primaryUrl, secondaryUrl] = config.rpcUrls
  const primary = new JsonRpcClient({
    endpointId: 'primary',
    url: primaryUrl,
    timeoutMs: config.rpcTimeoutMs,
    fetchImpl: throttledFetch(config.rpcRps),
  })
  const secondary = new JsonRpcClient({
    endpointId: 'secondary',
    url: secondaryUrl,
    timeoutMs: config.rpcTimeoutMs,
    fetchImpl: throttledFetch(config.rpcRps),
  })
  const quorum = new QuorumRpc(primary, secondary, { chainId: config.chainId })
  const reads = settledReads({
    quorum,
    clients: [primary, secondary],
    depth: PIN_DEPTH,
    attempts: QUORUM_ATTEMPTS,
    pauseMs: QUORUM_PAUSE_MS,
  })
  ledger.real(
    'chain',
    `quorum of ${new URL(primaryUrl).host} + ${new URL(secondaryUrl).host}, chain ${config.chainId}; reads pinned ${PIN_DEPTH} blocks below the head, ${QUORUM_ATTEMPTS} attempts each`,
  )
  const launches = new ChainRecipientReader({ rpc: reads })
  const recipients: RecipientReader = {
    creatorFeeRecipient: (token) => launches.creatorFeeRecipient(token),
    launchedAtUnix: (token) => launches.launchedAtUnix(token),
    async launchTerms(token) {
      const { launched } = await launches.launchedToken(token)
      return { buybackEnabled: launched.buybackEnabled, creatorTaxBps: launched.creatorTaxBps }
    },
  }
  ledger.real('recipients', 'getLaunchedToken on the Venue factory at the pinned block; TokenLaunched dates the launch')
  const assets = new ChainAssetReader(reads)
  const vaultReads = new VaultReadClient({ rpc: reads })
  ledger.real('vault.reads', 'CoinVault.state() over the quorum at the settled pin; acceptance and activation read it')

  // THE OPERATOR SIGNER. Deploys, binds and activates - or every one of the
  // three refuses. There is no in-memory deployment and no pretend bind.
  let deployer: AppDeps['deployer']
  let vaultOperator: AppDeps['vaultOperator']
  let operatorAddresses: AppDeps['operatorAddresses']
  if (config.operatorSignerKey !== undefined) {
    let signer: PrivateKeySigner
    try {
      signer = new PrivateKeySigner(config.operatorSignerKey)
    } catch (error) {
      if (error instanceof SignerKeyError) throw new StartupRefused(`OPERATOR_SIGNER_KEY refused: ${error.message}`)
      throw error
    }
    deployer = new ChainVaultDeployer({
      rpc: primary,
      reads,
      signer,
      factory: config.factory,
      chainId: config.chainId,
      confirmations: DEPLOY_CONFIRMATIONS,
    })
    ledger.real('deployer', `VaultFactory.deploy at ${config.factory.factory} signed by ${signer.address}, ${DEPLOY_CONFIRMATIONS} confirmations`)
    vaultOperator = new VaultOperatorClient({
      rpc: primary,
      signer,
      chainId: config.chainId,
      confirmations: DEPLOY_CONFIRMATIONS,
    })
    ledger.real('vault.operator', `CoinVault.bind after deployment and CoinVault.activate after the dev's acceptService, signed by ${signer.address}; every write is simulated first`)
    operatorAddresses = [{ label: 'operator signer', address: signer.address, role: 'deploys, binds and activates vaults' }]
  } else {
    ledger.fake('deployer', 'no OPERATOR_SIGNER_KEY; every vault deployment REFUSES')
    ledger.fake('vault.operator', 'no OPERATOR_SIGNER_KEY; bind and activate REFUSE (operator_unwired)', true)
  }

  // THE DEV DASHBOARD'S CHAIN VIEWS. Read-only, over the same pin.
  const v1Chain = {
    vaultViews: new ChainVaultViews(reads),
    escrow: new EscrowReadClient({ rpc: reads }),
    tokens: new ChainTokenMetadata(reads),
  }
  ledger.real('dev.views', 'CoinVault dial and legs, the escrow credit and ERC-20 metadata over the quorum at the settled pin')

  // THE VENDOR DIRECTORY. The same sealed catalog the fleet buys from.
  let vendors: VendorDirectory
  try {
    const loaded = loadCatalog()
    const summaries: VendorSummary[] = loaded.catalog.vendors.map((vendor) => ({
      id: vendor.id,
      displayName: vendor.displayName,
      isRelatedParty: vendor.isRelatedParty,
      reliabilityScore: vendor.reliabilityScore,
      enabled: vendor.enabled,
    }))
    vendors = { all: () => summaries }
    ledger.real('vendors', `${summaries.length} vendor(s) from the sealed catalog at ${loaded.dataDir}`)
  } catch (error) {
    throw new StartupRefused(`the vendor catalog did not load: ${error instanceof Error ? error.message : String(error)}`)
  }

  // THE DATABASE. One driver, every durable store, or none of them.
  let driver: SqlDriver | undefined
  let close: () => Promise<void> = async () => undefined
  if (config.databaseUrl !== undefined) {
    const connection = await connectPg(config.databaseUrl)
    driver = new PgDriver(connection.client)
    close = connection.close
    ledger.real(
      'persistence',
      'postgres: onboarding, publisher stores, images, invoices, pending purchases, receipts, ledger, vault records, agent runs',
    )
  } else {
    ledger.fake('persistence', 'no DATABASE_URL; onboarding, receipts and the ledger are in-memory and vanish with the process', true)
  }
  const onboardingStore: OnboardingStore = driver === undefined ? new InMemoryOnboardingStore() : new PgOnboardingStore(driver)

  // THE MODEL. Only a confirmed live client derives narratives; a scripted one
  // would hand the operator fiction to approve.
  let model: AppDeps['model']
  const apiKey = env.ANTHROPIC_API_KEY?.trim()
  if (apiKey === undefined || apiKey.length === 0) {
    ledger.fake('model', 'no ANTHROPIC_API_KEY; narrative derivation answers 503')
  } else {
    const resolved = await resolveModelClient({ env })
    if (resolved.provenance === 'live') {
      model = resolved.client
      ledger.real('model', resolved.detail)
    } else {
      // The fleet's detail ends in "running scripted"; this process never does.
      ledger.fake('model', `${resolved.detail.replace(/; running scripted$/, '')}; narrative derivation answers 503`)
    }
  }

  if (config.xReadBearerToken === undefined) {
    ledger.fake('x.read', 'no X_READ_BEARER_TOKEN; x.com narrative sources are refused')
  } else {
    ledger.real('x.read', 'app-only bearer for GET /2/tweets/:id')
  }

  // THE PUBLISHER STORES. The X application, its token key and a database, or the routes answer 503.
  let publisher: AppDeps['publisher']
  if (config.x !== undefined && config.publisherTokenKey !== undefined && driver !== undefined) {
    publisher = {
      credentials: new PgAccountCredentialStore(driver, config.publisherTokenKey),
      registry: new PgAccountRegistry(driver),
      labels: new PgLabelAttestationStore(driver),
    }
    ledger.real('publisher.stores', 'sealed credentials, account bindings and label attestations in postgres')
  } else {
    ledger.fake(
      'publisher.stores',
      config.x === undefined
        ? 'no X_CLIENT_ID; the /accounts/x routes answer 503'
        : 'X is configured but there is no DATABASE_URL to hold a sealed credential; the /accounts/x routes answer 503',
    )
  }

  let purchases: AppDeps['purchases']
  let creative: AppDeps['creative']
  let receipts: AppDeps['receipts']
  let ledgerStore: AppDeps['ledgerStore']
  let runs: AgentRunStore | undefined
  let vaults: PgVaultRepository | undefined
  let screening: PgScreeningStore | undefined
  let fleet: AppDeps['fleet']
  let kyb: AppDeps['kyb']
  let devSessions: AppDeps['devSessions']
  let quotes: AppDeps['quotes']
  let v1Stores: Pick<NonNullable<AppDeps['v1']>, 'bindings' | 'escalations' | 'outcomes' | 'qf' | 'accounts'> = {}
  if (driver !== undefined) {
    purchases = { pending: new PgPendingPurchaseStore(driver), invoices: new PgInvoiceRegistry(driver, now) }
    ledger.real('purchases', 'pending_purchase and vendor_invoice rows shared with the runner')
    creative = { images: new PgImageAssetStore(driver), fontFiles: config.creativeFontFiles }
    ledger.real(
      'creative',
      config.creativeFontFiles.length === 0
        ? 'renders into image_asset with the host fonts (CREATIVE_FONT_FILES unset: hashes are per host)'
        : `renders into image_asset with ${config.creativeFontFiles.length} pinned font file(s)`,
    )
    receipts = new PgReceiptStore(driver, now)
    ledgerStore = new SqlLedgerStore(pgLedgerDriver(driver))
    runs = new SqlAgentRunStore(driver)
    vaults = new PgVaultRepository(driver)
    screening = new PgScreeningStore(driver)
    fleet = { vaults, screening }
    kyb = new PgKybAttestationStore(driver)
    ledger.real('agent.runs', 'ops_agent_run rows the runner wrote')
    ledger.real('fleet.stores', 'vault_record written on every transition from deployed on, screening_result on every verdict; the runner serves exactly these coins')
    ledger.real('diligence.identity', 'kyb_attestation rows recorded by operators via POST /diligence/kyb/attest; unexpired attestation passes, anything else is UNKNOWN')
    devSessions = new PgDevSessionStore(driver)
    quotes = new PgQuoteStore(driver)
    v1Stores = {
      bindings: new PgIndexerStore(driver),
      escalations: new PgEscalationQueue(driver),
      outcomes: new PgProcurementOutcomes(driver),
      qf: new PgQfReader(driver),
      accounts: new PgOperatedAccounts(driver),
    }
    ledger.real('dev.sessions', 'dev_auth_challenge and dev_session rows; a bearer survives a restart, a challenge is consumed once')
    ledger.real('web.reads', 'indexer bindings, ops_escalation, ops_predicate_check, ops_tier_history and publisher bindings behind /v1')
  } else {
    ledger.fake('purchases', 'no DATABASE_URL to share pending purchases with the runner; /purchases and /invoices answer 503', true)
    ledger.fake('creative', 'no DATABASE_URL to hold rendered assets; the creative routes answer 503')
    ledger.fake('agent.runs', 'no DATABASE_URL; the agent run routes answer 503')
    ledger.fake('fleet.stores', 'no DATABASE_URL; no vault_record or screening_result is written, so the runner serves no coin onboarded here', true)
    ledger.fake('diligence.identity', 'no DATABASE_URL; identity attestations are in-memory and vanish with the process')
    ledger.fake('dev.sessions', 'no DATABASE_URL; dev sessions are in-memory and every dev signs in again after a restart')
    ledger.fake('web.reads', 'no DATABASE_URL; /v1 serves no escalations, no delivery checks and no QF measurement', true)
  }
  ledger.fake('agent.snapshot', 'this process holds no fleet handle; GET /coins/:vault/agent answers 503')

  // SCREENING INPUTS. The slur list is named by SCREENING_LEXICON_FILE; the
  // SDN list by OFAC_SDN_FILE, else OFAC_SDN_URL, else OFAC's own download.
  // A source the operator NAMED and that cannot be loaded is a startup
  // refusal. The unnamed default download failing is a recorded fake: an
  // offline laptop still boots, and the banner says the sample list is in.
  const lexiconFile = env.SCREENING_LEXICON_FILE?.trim()
  const sdnFile = env.OFAC_SDN_FILE?.trim()
  const sdnUrl = env.OFAC_SDN_URL?.trim()
  const sdnNamed = (sdnFile !== undefined && sdnFile.length > 0) || (sdnUrl !== undefined && sdnUrl.length > 0)
  const baseSources: ScreeningSourceOptions = {
    builtinLexicon: DEFAULT_LEXICON_SOURCE,
    sampleSdn: new SampleSdnSource(now()),
    ...(lexiconFile === undefined || lexiconFile.length === 0 ? {} : { lexiconFile }),
  }
  let sources: ScreeningSources
  let sdnDefaultFailure: string | undefined
  try {
    sources = await loadScreeningSources({
      ...baseSources,
      ...(sdnFile !== undefined && sdnFile.length > 0
        ? { sdnFile }
        : { sdnUrl: sdnUrl === undefined || sdnUrl.length === 0 ? DEFAULT_OFAC_SDN_URL : sdnUrl }),
    })
  } catch (error) {
    if (error instanceof LexiconFileError) throw new StartupRefused(`SCREENING_LEXICON_FILE refused: ${error.message}`)
    if (!(error instanceof SdnLoadError)) throw error
    if (sdnNamed) throw new StartupRefused(`OFAC SDN list refused (OFAC_SDN_FILE / OFAC_SDN_URL): ${error.message}`)
    sdnDefaultFailure = error.message
    sources = await loadScreeningSources(baseSources)
  }
  if (sources.lexiconReal) ledger.real('screening.lexicon', sources.lexiconDetail)
  else ledger.fake('screening.lexicon', sources.lexiconDetail)
  if (sources.sdnReal) ledger.real('screening.sdn', sources.sdnDetail)
  else if (sdnDefaultFailure !== undefined) ledger.fake('screening.sdn', `default download failed (${sdnDefaultFailure}); ${sources.sdnDetail}`)
  else ledger.fake('screening.sdn', sources.sdnDetail)

  let adjudicator: AppDeps['adjudicator']
  if (apiKey === undefined || apiKey.length === 0) {
    ledger.fake('screening.adjudicator', 'no ANTHROPIC_API_KEY; stage 3 is unavailable and every verdict is RESTRICTED')
  } else {
    adjudicator = createAnthropicAdjudicator(createAnthropicMessagesPort({ apiKey }))
    ledger.real('screening.adjudicator', 'Anthropic Messages API, fixed rubric, forced tool output')
  }

  const diligenceProbe = new ChainDiligenceProbe({ rpc: reads, launches })
  ledger.real('diligence.probe', ChainDiligenceProbe.describe())

  // PRICES. CoinGecko, asked for by name, with every mapped asset described by
  // its own contract at boot - or no price at all, and the report refuses.
  let priceBook: CoinGeckoPriceBook | undefined
  if (config.prices !== undefined) {
    priceBook = new CoinGeckoPriceBook({
      ids: config.prices.ids,
      nowUnix: now,
      ...(config.prices.apiKey === undefined ? {} : { apiKey: config.prices.apiKey }),
    })
    const described: string[] = []
    for (const address of Object.keys(config.prices.ids)) {
      let asset: ReportAsset
      try {
        asset = await assets.describe(address)
      } catch (error) {
        throw new StartupRefused(
          `FLEET_PRICES=coingecko maps ${address}, and the chain could not describe it: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      described.push(`${asset.symbol}/${asset.decimals}`)
    }
    ledger.real('prices', `CoinGecko for ${described.join(', ')}`)
    ledger.real('assets', `decimals and symbol read on chain at the agreed head for ${described.length} quote asset(s)`)
  } else {
    ledger.fake('prices', 'no FLEET_PRICES=coingecko; the weekly report refuses without a pinned price', true)
    ledger.real('assets', 'decimals and symbol read on chain at the agreed head, on demand')
  }

  // What this process cannot make real, said in the banner rather than hidden.
  if (driver === undefined) {
    ledger.fake('reporting', 'no DATABASE_URL; the report shows tier T0, no paid media and no refusals', true)
  } else {
    ledger.real('reporting', 'tier and screening from vault_record + screening_result, refusals from ops_agent_run')
  }

  const reporting: RouteDeps['reporting'] = {
    async assetFor(vault: Address): Promise<ReportAsset | undefined> {
      const record = (await onboardingStore.list()).find((r) => r.vault.toLowerCase() === vault.toLowerCase())
      if (record === undefined) return undefined
      let pairToken: string
      try {
        pairToken = (await launches.launchedToken(record.token)).launched.pairToken
      } catch (error) {
        if (error instanceof RecipientReadError) throw new HttpError(409, error.code, error.message)
        throw error
      }
      try {
        return await assets.describe(pairToken)
      } catch (error) {
        if (error instanceof AssetReadError) throw new HttpError(503, 'asset_unreadable', error.message)
        throw error
      }
    },
    async priceFor(asset: string, atUnix: number): Promise<PinnedUsdPrice | undefined> {
      if (priceBook === undefined) return undefined
      try {
        await priceBook.refresh(asset)
      } catch (error) {
        if (error instanceof CredentialMissingError || error instanceof SourceUnavailableError) return undefined
        throw error
      }
      return priceBook.priceAt(asset, atUnix)
    },
    async refusalsFor(vault: Address, fromUnix: number, toUnix: number): Promise<RefusalRecord[]> {
      if (runs === undefined) return []
      const refusals: RefusalRecord[] = []
      let cursor: string | undefined
      // Newest first; stop at the first run older than the window.
      for (;;) {
        const page = await runs.list(vault, { limit: 100, ...(cursor === undefined ? {} : { cursor }) })
        for (const run of page.runs) {
          if (run.atUnix < fromUnix) return refusals
          if (run.atUnix > toUnix) continue
          for (const refusal of run.refusals) {
            refusals.push({ code: refusal.code, atUnix: run.atUnix, detail: `${refusal.phase}: ${refusal.detail}` })
          }
        }
        if (page.nextCursor === undefined) return refusals
        cursor = page.nextCursor
      }
    },
    async tierFor(vault: Address): Promise<string> {
      return (await vaults?.get(vault))?.tier ?? 'T0'
    },
    async paidMediaPermitted(vault: Address): Promise<boolean> {
      const record = await vaults?.get(vault)
      if (record === undefined || screening === undefined) return false
      const latest = await screening.latest(record.token)
      return TIERS[record.tier].paidMedia && latest?.paidMediaPermitted === true
    },
  }

  const agent: AgentPort = {
    ...unwiredAgentPort('this process holds no fleet handle; the agent snapshot is served by the runner'),
    ...(runs === undefined ? {} : { runs }),
  }

  return {
    deps: {
      config,
      onboardingStore,
      ...(deployer === undefined ? {} : { deployer }),
      recipients,
      vaultReads,
      ...(vaultOperator === undefined ? {} : { vaultOperator }),
      ...(fleet === undefined ? {} : { fleet }),
      screeningSources: { lexicon: sources.lexicon, sdn: sources.sdn },
      ...(adjudicator === undefined ? {} : { adjudicator }),
      diligenceProbe,
      ...(kyb === undefined ? {} : { kyb }),
      ...(model === undefined ? {} : { model }),
      ...(config.xReadBearerToken === undefined ? {} : { xReadBearerToken: config.xReadBearerToken }),
      ...(publisher === undefined ? {} : { publisher }),
      ...(purchases === undefined ? {} : { purchases }),
      ...(creative === undefined ? {} : { creative }),
      ...(receipts === undefined ? {} : { receipts }),
      ...(ledgerStore === undefined ? {} : { ledgerStore }),
      reporting,
      agent,
      ...(devSessions === undefined ? {} : { devSessions }),
      ...(quotes === undefined ? {} : { quotes }),
      ...(operatorAddresses === undefined ? {} : { operatorAddresses }),
      v1: { ...v1Chain, ...v1Stores, vendors },
    },
    ledger,
    close,
  }
}
