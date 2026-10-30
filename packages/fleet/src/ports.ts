/**
 * THE PORTS MODULE. This is what OPS_PORTS_MODULE points at.
 *
 * ops/scheduler/main.ts refuses to start without one, and says why: the jobs
 * need real implementations, ops deliberately contains none, and running the
 * fakes in production would mean a scheduler that reports healthy while doing
 * nothing. This module is the answer to that requirement, and it takes the
 * refusal seriously in the one way that matters - it never lets a fake pass
 * itself off as the real thing.
 *
 * Run it as:
 *
 *   OPS_PORTS_MODULE=@fee-split-vaults/fleet/ports \
 *   DATABASE_URL=postgres://... node ops/scheduler/main.js
 *
 * WHAT IS REAL HERE. Everything `bootstrapFleet` resolved for the fleet, and
 * on top of it every operations-plane port, each built from the same stores
 * and chain clients the fleet uses: the vault directory over vault_record; the
 * asset registry over the token contracts and the quote_asset kill switch;
 * the escrow reader, the sweeper, the settlement executor, the enforcement
 * actions and the heartbeat over the operator key; the ledger operations over
 * the SQL ledger and the chain scan; the QF source over the fee indexer; the
 * tier registry; the report builder and its Telegram delivery; the metadata
 * watcher and the re-screening engine; the alert log and its webhook; the
 * monitoring collector.
 *
 * WHAT IS NOT, AND WHEN. Each port below has exactly one condition under which
 * it stays a fake, and that condition is an ABSENT INPUT, never a code path
 * that does not exist: no live chain, no operator key, no price feed, no alert
 * webhook, no Telegram token, no adjudicator key. Each such substitution is
 * recorded in the ledger with the input it lacks, printed in the banner, and
 * refused outright under FLEET_REFUSE_FAKES=1.
 */

import {
  ChainAssetReader,
  EscrowReadClient,
  PgAccountCredentialStore,
  PgAssetPolicy,
  PgChannelHealthStore,
  PrivateKeySigner,
  VaultOperatorClient,
  VaultReadClient,
} from '@fee-split-vaults/adapters'
import { Ledger } from '@fee-split-vaults/ledger'
import type { AssetRegistry, SignalsProvider } from '@fee-split-vaults/orchestrator'
import {
  createAttestedLabelProbe,
  createTelegramHttpTransport,
  createXHttpTransport,
  createXOAuth2Client,
} from '@fee-split-vaults/publisher'
import {
  DEFAULT_LEXICON_SOURCE,
  DEFAULT_OFAC_SDN_URL,
  LexiconFileError,
  SampleSdnSource,
  ScreeningEngine,
  SdnLoadError,
  createAnthropicAdjudicator,
  createAnthropicMessagesPort,
  loadScreeningSources,
  type ScreeningSourceOptions,
  type ScreeningSources,
} from '@fee-split-vaults/screening'
import { DISCLOSURE, VENUE } from '../../../config/protocol.js'
import { PgAlertLog, WebhookAlertSink, LoggedAlertSink } from '../../../ops/scheduler/adapters/alerts.js'
import { ChainAssetRegistry } from '../../../ops/scheduler/adapters/assets.js'
import { PgVaultDirectory } from '../../../ops/scheduler/adapters/directory.js'
import { ChainEnforcementActions } from '../../../ops/scheduler/adapters/enforcement.js'
import { ChainEscrowReader } from '../../../ops/scheduler/adapters/escrow.js'
import { ChainVaultHeartbeat } from '../../../ops/scheduler/adapters/heartbeat.js'
import { SqlLedgerOps } from '../../../ops/scheduler/adapters/ledger-ops.js'
import { ChainMetadataWatcher, TokenMetadataReader } from '../../../ops/scheduler/adapters/metadata.js'
import { PgPublishingHealth } from '../../../ops/scheduler/adapters/publishing-health.js'
import { IndexerQfSource } from '../../../ops/scheduler/adapters/qf.js'
import { TelegramReportDelivery } from '../../../ops/scheduler/adapters/report-delivery.js'
import { LedgerReportBuilder } from '../../../ops/scheduler/adapters/reports.js'
import { PgScreeningService } from '../../../ops/scheduler/adapters/screening-service.js'
import { ChainSettlementExecutor } from '../../../ops/scheduler/adapters/settlement.js'
import { ChainSweepExecutor } from '../../../ops/scheduler/adapters/sweeper.js'
import { PgTierRegistry } from '../../../ops/scheduler/adapters/tiers.js'
import { PgMonitoring, PgSignalCollector } from '../../../ops/monitoring/collect.js'
import { makeFakePorts } from '../../../ops/scheduler/fakes.js'
import type { OpsPorts } from '../../../ops/scheduler/ports.js'
import type { SqlDriver } from '../../../ops/migrations/driver.js'
import { minorToCents, centsToUsd } from '@fee-split-vaults/orchestrator'
import { bootstrapFleet } from './bootstrap.js'
import { startupBanner } from './credentials.js'
import { FleetStartupRefused } from './errors.js'
import { SqlAgentRunStore } from './store.js'

export interface PortsContext {
  driver: SqlDriver
  nowUnix: () => number
  /** Defaults to process.env. Injected so the wiring is testable. */
  env?: Record<string, string | undefined>
}

/**
 * The shape main.ts requires. Async, because resolving a model credential means
 * constructing a client and finding out.
 */
export async function createPorts(context: PortsContext): Promise<OpsPorts> {
  const env = context.env ?? process.env
  const nowUnix = context.nowUnix()
  const boot = await bootstrapFleet({
    nowUnix,
    env,
    // Run records go to Postgres, alongside every other durable store the
    // driver makes real inside bootstrapFleet.
    store: new SqlAgentRunStore(context.driver),
    driver: context.driver,
  })

  // The scheduler always passes a driver, so the durable half is never absent
  // here. Asserted rather than assumed: a ports module that silently handed the
  // scheduler an in-memory predicate queue would run the delivery job against
  // checks nobody enqueued.
  const persistence = boot.adapters.persistence
  if (persistence === undefined) {
    throw new FleetStartupRefused('the ops ports module was constructed without a database driver')
  }

  const { substitutions } = boot
  const clock = { nowUnix: context.nowUnix }
  const fakes = makeFakePorts(clock)
  const driver = context.driver
  const chain = boot.adapters.chain
  const prices = boot.adapters.prices
  // Loaded by the fleet from the token contracts and quote_asset. Absent without a live chain.
  const assets: AssetRegistry | undefined = boot.adapters.assets
  const signals: SignalsProvider | undefined = boot.adapters.signals
  const ledger = new Ledger(persistence.ledgerStore, { now: context.nowUnix })
  const usdOf = (asset: string, amountMinor: bigint, atUnix: number): number | undefined => {
    if (prices === undefined || assets === undefined) return undefined
    const known = assets.get(asset)
    const price = prices.priceAt(asset, atUnix)
    if (known === undefined || price === undefined) return undefined
    return centsToUsd(minorToCents(amountMinor, known.decimals, price))
  }

  // ---- always real with a database
  const vaults = new PgVaultDirectory(persistence.vaults)
  const tiers = new PgTierRegistry(driver, persistence.vaults)
  const alertLog = new PgAlertLog(driver)
  substitutions.real('ops.vaults', 'Postgres vault_record via the vault repository')
  substitutions.real('ops.tiers', 'Postgres vault_record.tier + ops_tier_history / ops_qf_observation')

  // ---- alerts: log always; the pager needs a webhook
  const webhookUrl = env.OPS_ALERT_WEBHOOK_URL?.trim()
  let alerts: OpsPorts['alerts'] = fakes.alerts
  let webhook: OpsPorts['alerts'] | undefined
  if (webhookUrl !== undefined && webhookUrl.length > 0) {
    webhook = new WebhookAlertSink({ url: webhookUrl, ...(env.OPS_ALERT_WEBHOOK_TOKEN === undefined ? {} : { authToken: env.OPS_ALERT_WEBHOOK_TOKEN }) })
    alerts = new LoggedAlertSink(alertLog, webhook, 'job')
    substitutions.real('ops.alerts', `Postgres ops_alert_firing, paged to ${new URL(webhookUrl).host}`)
  } else {
    substitutions.fake('ops.alerts', 'no OPS_ALERT_WEBHOOK_URL; firings are neither logged nor paged', false)
  }

  // ---- chain-backed ports
  let ports: Partial<OpsPorts> = {}
  if (chain === undefined || assets === undefined || prices === undefined) {
    const why = chain === undefined ? 'FLEET_CHAIN=live is not set' : assets === undefined ? 'no asset registry was loaded' : 'FLEET_PRICES=coingecko is not set'
    for (const name of ['assets', 'escrow', 'sweeper', 'settlement', 'ledger', 'qf', 'metadata', 'screening', 'enforcement', 'heartbeat'] as const) {
      substitutions.fake(`ops.${name}`, why, name === 'escrow' || name === 'sweeper' || name === 'settlement' || name === 'ledger')
    }
  } else {
    const rpc = chain.primary
    const reads = new VaultReadClient({ rpc })
    const escrowReads = new EscrowReadClient({ rpc })
    const policy = new PgAssetPolicy(driver)
    const opsAssets = new ChainAssetRegistry({ reader: new ChainAssetReader(chain.rpc, policy), policy, head: () => rpc.getBlockByTag('latest') })
    ports.assets = opsAssets
    ports.escrow = new ChainEscrowReader({ escrow: escrowReads, reads, assets: opsAssets, prices, clock })
    ports.ledger = new SqlLedgerOps({ driver, store: persistence.ledgerStore, ledger, chain: chain.model, usdOf, clock })
    ports.qf = new IndexerQfSource({ chain: chain.model, vaults: persistence.vaults, assets, prices, ...(signals === undefined ? {} : { signals }) })
    const metadataReader = new TokenMetadataReader(rpc)
    ports.metadata = new ChainMetadataWatcher({ driver, rpc, reader: metadataReader, vaults, clock })
    substitutions.real('ops.assets', 'token contracts at head, governed by Postgres quote_asset')
    substitutions.real('ops.escrow', `Venue escrow ${VENUE.contracts.v2FeeEscrow} credits per active vault, priced from the book`)
    substitutions.real('ops.ledger', 'Postgres ledger_* + ops_sweep_match, matched against the chain scan')
    substitutions.real('ops.qf', signals === undefined ? 'computeQf over Postgres indexer_fee_posting; signals REFUSE (no FLEET_HOLDERS=index)' : 'computeQf + qualification signals over the fee and holder indexes')
    substitutions.real('ops.metadata', 'ERC-20 name()/symbol() at head into Postgres token_metadata_observation')

    // Re-screening: the same sources the onboarding screen uses.
    const screening = await resolveScreeningEngine(env, context.nowUnix, substitutions)
    ports.screening = new PgScreeningService({ driver, store: persistence.screening, engine: screening, reader: metadataReader, clock })

    const key = env.OPERATOR_SIGNER_KEY?.trim()
    if (key === undefined || key.length === 0) {
      for (const name of ['sweeper', 'settlement', 'enforcement', 'heartbeat'] as const) {
        substitutions.fake(`ops.${name}`, 'no OPERATOR_SIGNER_KEY; nothing can sign an operator transaction', name !== 'heartbeat')
      }
    } else {
      let signer: PrivateKeySigner
      try {
        signer = new PrivateKeySigner(key)
      } catch (error) {
        throw new FleetStartupRefused(`OPERATOR_SIGNER_KEY refused: ${error instanceof Error ? error.message : String(error)}`)
      }
      const operator = new VaultOperatorClient({ rpc, signer, chainId: VENUE.chainId, confirmations: 2, clock })
      ports.sweeper = new ChainSweepExecutor({ rpc, operator, driver, clock })
      ports.settlement = new ChainSettlementExecutor({ rpc, operator, assets: opsAssets, driver, clock })
      ports.enforcement = new ChainEnforcementActions({ operator, reads, screening: persistence.screening, alerts, clock })
      ports.heartbeat = new ChainVaultHeartbeat({ operator, reads })
      substitutions.real('ops.sweeper', `CoinVault.claim/claimToken signed by ${signer.address}, outbox in Postgres`)
      substitutions.real('ops.settlement', `CoinVault.settle signed by ${signer.address}`)
      substitutions.real('ops.enforcement', `CoinVault.suspend signed by ${signer.address}; paid-media halts recorded in screening_result`)
      substitutions.real('ops.heartbeat', `CoinVault.heartbeat signed by ${signer.address}`)
    }
  }

  // ---- reports: ledger + receipts always; delivery needs a bot token and a named operator
  if (assets === undefined || prices === undefined) {
    substitutions.fake('ops.reports', 'no asset registry or price feed to value the period', false)
  } else {
    ports.reports = new LedgerReportBuilder({ driver, store: persistence.ledgerStore, receipts: persistence.receipts, assets, prices })
    substitutions.real('ops.reports', 'Postgres ledger_entry, receipt, ops_agent_run, ops_predicate_withhold priced at period end')
  }
  const reportToken = env.OPS_REPORT_TELEGRAM_BOT_TOKEN?.trim() || env.TELEGRAM_BOT_TOKEN?.trim()
  const receiptsBaseUrl = env.PUBLISHER_RECEIPTS_BASE_URL?.trim()
  if (reportToken === undefined || reportToken.length === 0 || receiptsBaseUrl === undefined || receiptsBaseUrl.length === 0) {
    substitutions.fake('ops.reportDelivery', 'needs OPS_REPORT_TELEGRAM_BOT_TOKEN (or TELEGRAM_BOT_TOKEN) and PUBLISHER_RECEIPTS_BASE_URL', false)
  } else {
    const chats = new Map<string, string>()
    for (const coin of boot.directory.list()) {
      const chat = coin.accounts.get('telegram')
      if (chat !== undefined) chats.set(coin.vault.toLowerCase(), chat)
    }
    ports.reportDelivery = new TelegramReportDelivery({
      driver,
      transport: createTelegramHttpTransport({ botToken: reportToken }),
      chatFor: (vault) => chats.get(vault.toLowerCase()),
      operatorName: DISCLOSURE.operatorName,
      receiptsBaseUrl,
      clock,
    })
    substitutions.real('ops.reportDelivery', `Telegram sendMessage to each coin's bound chat, disclosure by code, ${String(chats.size)} chat(s) bound`)
  }

  // ---- monitoring: the collector reads Pg plus the real escrow/halts when present
  const escrow = ports.escrow
  if (chain === undefined || escrow === undefined || webhook === undefined) {
    substitutions.fake('ops.monitoring', chain === undefined ? 'no live chain to collect from' : escrow === undefined ? 'no escrow reader' : 'no OPS_ALERT_WEBHOOK_URL', false)
  } else {
    const collector = new PgSignalCollector({ driver, ledgerStore: persistence.ledgerStore, vaults, halts: chain.model, escrow })
    ports.monitoring = new PgMonitoring(collector, alertLog, webhook)
    substitutions.real('ops.monitoring', 'signals from Postgres + escrow reads; firings logged to ops_alert_firing and paged')
  }

  // ---- publishing health: the same sealed credentials and OAuth client the live publisher posts with
  const tokenKey = env.PUBLISHER_TOKEN_KEY?.trim()
  const xClientId = env.X_CLIENT_ID?.trim()
  const xRedirectUri = env.X_REDIRECT_URI?.trim()
  if (!tokenKey || !xClientId || !xRedirectUri) {
    substitutions.fake('ops.publishingHealth', 'needs PUBLISHER_TOKEN_KEY, X_CLIENT_ID and X_REDIRECT_URI to probe X accounts under their own tokens', false)
  } else {
    let credentials: PgAccountCredentialStore
    try {
      credentials = new PgAccountCredentialStore(driver, tokenKey)
    } catch (error) {
      throw new FleetStartupRefused(`PUBLISHER_TOKEN_KEY refused: ${error instanceof Error ? error.message : String(error)}`)
    }
    const xClientSecret = env.X_CLIENT_SECRET?.trim()
    const transport = createXHttpTransport({
      credentials,
      oauth: createXOAuth2Client({ clientId: xClientId, redirectUri: xRedirectUri, nowUnix: context.nowUnix, ...(xClientSecret ? { clientSecret: xClientSecret } : {}) }),
      labelProbe: createAttestedLabelProbe(persistence.labels, clock),
      nowUnix: context.nowUnix,
    })
    ports.publishingHealth = new PgPublishingHealth({ driver, transport, store: new PgChannelHealthStore(driver), clock })
    substitutions.real('ops.publishingHealth', 'GET /2/users/me per bound X account, verdicts appended to Postgres publisher_account_health')
  }

  const verifier = boot.adapters.predicateVerifier
  if (verifier === undefined) substitutions.fake('ops.predicateVerifier', 'no FLEET_EVIDENCE=dexscreener', false)

  // Rendered HERE, not taken from the bootstrap: the ops ports recorded above
  // have to be on it.
  process.stderr.write(`${startupBanner(substitutions, boot.provenance)}\n`)

  if (env.FLEET_REFUSE_FAKES === '1' && substitutions.anyFake) {
    throw new FleetStartupRefused(`FLEET_REFUSE_FAKES=1 and these dependencies are fakes: ${substitutions.names().join(', ')}`)
  }

  return {
    ...fakes,
    ...ports,
    alerts,
    vaults,
    tiers,
    fleet: boot.fleet,
    predicates: persistence.predicates,
    receipts: boot.world.receipts,
    ...(verifier === undefined ? {} : { predicateVerifier: verifier }),
  }
}

/**
 * The re-screening engine, from the same env the API reads: a named lexicon
 * or SDN source that fails to load REFUSES; the unnamed OFAC default failing
 * is a recorded fake (the sample list is in). Without ANTHROPIC_API_KEY there
 * is no adjudicator and every verdict is RESTRICTED - recorded as such.
 */
async function resolveScreeningEngine(
  env: Record<string, string | undefined>,
  nowUnix: () => number,
  substitutions: { real(name: string, detail: string): void; fake(name: string, detail: string, money: boolean): void },
): Promise<ScreeningEngine> {
  const lexiconFile = env.SCREENING_LEXICON_FILE?.trim()
  const sdnFile = env.OFAC_SDN_FILE?.trim()
  const sdnUrl = env.OFAC_SDN_URL?.trim()
  const sdnNamed = (sdnFile !== undefined && sdnFile.length > 0) || (sdnUrl !== undefined && sdnUrl.length > 0)
  const base: ScreeningSourceOptions = {
    builtinLexicon: DEFAULT_LEXICON_SOURCE,
    sampleSdn: new SampleSdnSource(nowUnix()),
    ...(lexiconFile === undefined || lexiconFile.length === 0 ? {} : { lexiconFile }),
  }
  let sources: ScreeningSources
  try {
    sources = await loadScreeningSources({
      ...base,
      ...(sdnFile !== undefined && sdnFile.length > 0 ? { sdnFile } : { sdnUrl: sdnUrl === undefined || sdnUrl.length === 0 ? DEFAULT_OFAC_SDN_URL : sdnUrl }),
    })
  } catch (error) {
    if (error instanceof LexiconFileError) throw new FleetStartupRefused(`SCREENING_LEXICON_FILE refused: ${error.message}`)
    if (!(error instanceof SdnLoadError)) throw error
    if (sdnNamed) throw new FleetStartupRefused(`OFAC SDN list refused (OFAC_SDN_FILE / OFAC_SDN_URL): ${error.message}`)
    sources = await loadScreeningSources(base)
  }
  if (sources.lexiconReal) substitutions.real('ops.screening.lexicon', sources.lexiconDetail)
  else substitutions.fake('ops.screening.lexicon', sources.lexiconDetail, false)
  if (sources.sdnReal) substitutions.real('ops.screening.sdn', sources.sdnDetail)
  else substitutions.fake('ops.screening.sdn', sources.sdnDetail, false)

  const apiKey = env.ANTHROPIC_API_KEY?.trim()
  const adjudicator = apiKey === undefined || apiKey.length === 0 ? undefined : createAnthropicAdjudicator(createAnthropicMessagesPort({ apiKey }))
  if (adjudicator === undefined) substitutions.fake('ops.screening.adjudicator', 'no ANTHROPIC_API_KEY; every re-screen verdict is RESTRICTED', false)
  else substitutions.real('ops.screening.adjudicator', 'Anthropic messages adjudicator')
  substitutions.real('ops.screening', 'ScreeningEngine over chain name()/symbol(), verdicts to Postgres screening_result')
  return new ScreeningEngine({ lexicon: sources.lexicon, sdn: sources.sdn, clock: nowUnix, ...(adjudicator === undefined ? {} : { adjudicator }) })
}
