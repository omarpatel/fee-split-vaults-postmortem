/**
 * The composition root.
 *
 * Everything the service needs that touches the outside world is wired in two
 * files and nowhere else: live.ts resolves it from the environment and says
 * what it could not resolve, and this file assembles whatever it was handed.
 *
 * It deliberately refuses to boot rather than start degraded: a missing RPC
 * quorum, a placeholder operator name, or an unset factory address are all
 * fatal at startup. A control plane that starts anyway and fails at the first
 * request has already told a dev their onboarding is progressing.
 *
 * createApp() is the seam. It takes every external dependency as an option;
 * whatever it is not handed is either an in-memory store (onboarding, receipts,
 * the ledger), a port that refuses (the deployer, the recipient reader, the
 * agent snapshot), or an unconfigured feature whose routes answer 503. main()
 * is the one caller that hands it the real things.
 */

import type { Server } from 'node:http'

import { VENUE } from '../../../config/protocol.js'
import type { Address } from '@fee-split-vaults/core'
import { Ledger, InMemoryLedgerStore, type LedgerStore } from '@fee-split-vaults/ledger'
import { InMemoryReceiptStore, type PinnedUsdPrice, type ReceiptStore } from '@fee-split-vaults/orchestrator'
import {
  DEFAULT_DILIGENCE_POLICY,
  DEFAULT_LEXICON_SOURCE,
  Lexicon,
  SampleSdnSource,
  SdnScreener,
  ScreeningEngine,
  FakeChainDiligenceProbe,
  type Adjudicator,
  type ChainDiligenceProbe,
  type DiligenceDeps,
} from '@fee-split-vaults/screening'
import { fetchNarrativeSource } from '@fee-split-vaults/adapters'
import type { SubstitutionLedger } from '@fee-split-vaults/fleet'
import {
  createXOAuth2Client,
  type AccountCredentialStore,
  type LabelAttestationStore,
  type MutableAccountRegistry,
} from '@fee-split-vaults/publisher'
import { deriveNarrativeCandidate, type ModelClient } from '@fee-split-vaults/runtime'

import { unwiredAgentPort, type AgentPort } from './agent.js'
import { ConfigError, loadConfig, describeConfig, type ApiConfig } from './config.js'
import { InMemoryKybAttestationStore, ManualKybAttestationProvider, type KybAttestationStore } from './diligence/kyb.js'
import { StartupRefused, resolveLiveDeps } from './live.js'
import {
  Onboarding,
  InMemoryOnboardingStore,
  type FleetStores,
  type OnboardingStore,
  type RecipientReader,
} from './onboarding.js'
import type { AccountDeps, CreativeDeps, NarrativeDeps, PurchaseDeps } from './promotion.js'
import { authScopeOf, buildRouter, type RouteDeps } from './routes.js'
import { createApiServer } from './http/server.js'
import type { Router } from './http/router.js'
import type { VaultDeployer } from './deploy.js'
import type { RefusalRecord } from './report.js'
import type { VaultOperatorPort, VaultStateReader } from './vault-chain.js'
import {
  InMemoryEscalationQueue,
  InMemoryOperatedAccounts,
  InMemoryProcurementOutcomes,
  InMemoryQfReader,
  InMemoryQuoteStore,
  type QuoteStore,
} from './v1/ports.js'
import type { ProtocolIdentity, V1Deps } from './v1/routes.js'
import { DevAuth, InMemoryDevSessionStore, type DevSessionStore } from './v1/sessions.js'

/** A recipient reader that refuses. The onboarding machine turns the throw into a refusal to activate. */
const UNWIRED_RECIPIENTS: RecipientReader = {
  creatorFeeRecipient(): Promise<Address> {
    return Promise.reject(new Error('recipient reader is not wired; refusing to guess who the fee recipient is'))
  },
  launchedAtUnix(): Promise<number> {
    return Promise.reject(new Error('launch time reader is not wired'))
  },
  launchTerms(): Promise<never> {
    return Promise.reject(new Error('launch factory reader is not wired; refusing to invent buyback or tax terms'))
  },
}

const UNWIRED_DEPLOYER: VaultDeployer = {
  deploy(): Promise<never> {
    return Promise.reject(new Error('vault deployer is not wired to a signer'))
  },
  isDeployed(): Promise<boolean> {
    return Promise.reject(new Error('vault deployer is not wired to a chain reader'))
  },
}

/** Bytes read from a narrative source before the read stops. */
const NARRATIVE_SOURCE_MAX_BYTES = 256_000
const NARRATIVE_FETCH_TIMEOUT_MS = 10_000

export interface AppDeps {
  config: ApiConfig
  /** Absent: in-memory, forgotten on restart. */
  onboardingStore?: OnboardingStore
  /** Absent: deployment refuses. */
  deployer?: VaultDeployer
  /** Absent: pointing confirmation and activation refuse. */
  recipients?: RecipientReader
  /** The operator's vault writes (bind, activate). Absent: those transitions refuse. */
  vaultOperator?: VaultOperatorPort
  /** CoinVault.state() at the settled pin. Absent: acceptance and activation refuse. */
  vaultReads?: VaultStateReader
  /** The runner's vault_record and screening_result. Absent: no row is written and the runner serves nothing. */
  fleet?: FleetStores
  /** The two stage-1 inputs. Absent: the builtin lexicon and the sample SDN list, which cannot clear. */
  screeningSources?: { lexicon: Lexicon; sdn: SdnScreener }
  /** Stage 3. Absent: every subject is RESTRICTED. */
  adjudicator?: Adjudicator
  /** The chain probe. Absent: the fake, which answers UNKNOWN so admission fails closed. */
  diligenceProbe?: ChainDiligenceProbe
  /** Absent: in-memory; attestations vanish with the process. */
  kyb?: KybAttestationStore
  /** Reader-plane model for narrative derivation. Absent: derive answers 503. */
  model?: ModelClient
  /** Operator bearer for reading x.com status sources. Absent: those sources are refused. */
  xReadBearerToken?: string
  /** The three publisher stores. All present or the /accounts/x routes answer 503. */
  publisher?: {
    credentials: AccountCredentialStore
    registry: MutableAccountRegistry
    labels: LabelAttestationStore
  }
  /** Both present or /purchases and /invoices answer 503. */
  purchases?: PurchaseDeps
  /** Absent: the creative routes answer 503 and approval renders nothing. */
  creative?: CreativeDeps
  /** Absent: in-memory. */
  receipts?: ReceiptStore
  ledgerStore?: LedgerStore
  /** Absent: no asset, no price, no refusals, T0, no paid media - the report refuses. */
  reporting?: RouteDeps['reporting']
  /** Absent: every agent route answers 503 agent_not_wired. */
  agent?: AgentPort
  fetch?: typeof fetch
  now?: () => number
  /** The dev dashboard's challenges and bearers. Absent: in-memory; every dev signs in again after a restart. */
  devSessions?: DevSessionStore
  /** The onboarding quote's narrative sources and handles, by nonce. Absent: in-memory. */
  quotes?: QuoteStore
  /** The operator's public addresses, for /v1/protocol. Absent: none are published. */
  operatorAddresses?: ProtocolIdentity['operatorAddresses']
  /** The /v1 read ports. Any absent one is its empty in-memory form; chain views absent answer 503. */
  v1?: Partial<Pick<V1Deps, 'bindings' | 'vaultViews' | 'escrow' | 'tokens' | 'escalations' | 'outcomes' | 'qf' | 'vendors' | 'accounts'>>
}

export interface App {
  router: Router
  server: Server
  onboarding: Onboarding
  close(): Promise<void>
}

export async function createApp(deps: AppDeps): Promise<App> {
  const { config } = deps
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000))
  const fetchImpl = deps.fetch ?? fetch
  const ledgerStore = deps.ledgerStore ?? new InMemoryLedgerStore()
  const receipts = deps.receipts ?? new InMemoryReceiptStore()

  const kyb = deps.kyb ?? new InMemoryKybAttestationStore()

  const onboarding = new Onboarding({
    factory: config.factory,
    domain: config.domain,
    deployer: deps.deployer ?? UNWIRED_DEPLOYER,
    recipients: deps.recipients ?? UNWIRED_RECIPIENTS,
    store: deps.onboardingStore ?? new InMemoryOnboardingStore(),
    ...(deps.vaultOperator === undefined ? {} : { vaultOperator: deps.vaultOperator }),
    ...(deps.vaultReads === undefined ? {} : { vaultReads: deps.vaultReads }),
    ...(deps.fleet === undefined ? {} : { fleet: deps.fleet }),
    antiSnipeHoldSeconds: config.antiSnipeHoldSeconds,
    now,
  })

  const screening = new ScreeningEngine({
    // Without an operator-supplied slur list (SCREENING_LEXICON_FILE) and an
    // authoritative SDN download (OFAC_SDN_URL / OFAC_SDN_FILE) stage 1 cannot
    // clear anything; live.ts resolves both and records what it could not.
    lexicon: deps.screeningSources?.lexicon ?? new Lexicon([DEFAULT_LEXICON_SOURCE]),
    // The sample list's published-at time is `now` so it is never ALSO stale:
    // the refusal a reviewer sees is "not authoritative", the real reason.
    sdn: deps.screeningSources?.sdn ?? new SdnScreener(new SampleSdnSource(now())),
    ...(deps.adjudicator === undefined ? {} : { adjudicator: deps.adjudicator }),
    clock: now,
  })

  const diligence: DiligenceDeps = {
    probe: deps.diligenceProbe ?? new FakeChainDiligenceProbe(),
    identity: new ManualKybAttestationProvider(kyb, now),
    policy: {
      ...DEFAULT_DILIGENCE_POLICY,
      // The launch locker holds graduated positions; the factory custodies a
      // pre-graduation curve. Both are the protocol's, neither is the dev's.
      allowedLockers: [VENUE.contracts.v2LaunchLocker, VENUE.contracts.v2Factory],
    },
  }

  const model = deps.model
  const narrative: NarrativeDeps | undefined =
    model === undefined
      ? undefined
      : {
          fetchSource: (url) =>
            fetchNarrativeSource(url, {
              fetch: fetchImpl,
              maxBytes: NARRATIVE_SOURCE_MAX_BYTES,
              timeoutMs: NARRATIVE_FETCH_TIMEOUT_MS,
              ...(deps.xReadBearerToken === undefined ? {} : { xBearerToken: deps.xReadBearerToken }),
            }),
          derive: (sources) => deriveNarrativeCandidate(sources, model, { nowUnix: now }),
        }

  const accounts: AccountDeps | undefined =
    config.x === undefined || deps.publisher === undefined
      ? undefined
      : {
          oauth: createXOAuth2Client({
            clientId: config.x.clientId,
            ...(config.x.clientSecret === undefined ? {} : { clientSecret: config.x.clientSecret }),
            redirectUri: config.x.redirectUri,
            fetch: fetchImpl,
          }),
          credentials: deps.publisher.credentials,
          registry: deps.publisher.registry,
          labels: deps.publisher.labels,
        }

  const ledger = new Ledger(ledgerStore, { now })
  const reporting: RouteDeps['reporting'] = deps.reporting ?? {
    assetFor: () => Promise.resolve(undefined),
    priceFor: (): Promise<PinnedUsdPrice | undefined> => Promise.resolve(undefined),
    refusalsFor: (): Promise<RefusalRecord[]> => Promise.resolve([]),
    tierFor: (): Promise<string> => Promise.resolve('T0'),
    paidMediaPermitted: (): Promise<boolean> => Promise.resolve(false),
  }

  const devAuth = new DevAuth({
    store: deps.devSessions ?? new InMemoryDevSessionStore(),
    issuer: config.operatorName,
    now,
  })
  const v1: V1Deps = {
    auth: devAuth,
    quotes: deps.quotes ?? new InMemoryQuoteStore(),
    onboarding,
    screening,
    factory: config.factory,
    domain: config.domain,
    protocol: {
      operatorLegalName: config.operatorName,
      operatorAddresses: deps.operatorAddresses ?? [],
      receiptsBaseUrl: config.receiptsBaseUrl,
      ...(config.terms === undefined ? {} : { terms: { ...config.terms, adapter: config.terms.adapter as Address } }),
    },
    recipients: deps.recipients ?? UNWIRED_RECIPIENTS,
    ledger,
    ledgerStore,
    receipts,
    reporting,
    now,
    ...(deps.fleet === undefined ? {} : { fleetVaults: deps.fleet.vaults }),
    ...(deps.v1?.bindings === undefined ? {} : { bindings: deps.v1.bindings }),
    ...(deps.v1?.vaultViews === undefined ? {} : { vaultViews: deps.v1.vaultViews }),
    ...(deps.v1?.escrow === undefined ? {} : { escrow: deps.v1.escrow }),
    ...(deps.v1?.tokens === undefined ? {} : { tokens: deps.v1.tokens }),
    escalations: deps.v1?.escalations ?? new InMemoryEscalationQueue(),
    outcomes: deps.v1?.outcomes ?? new InMemoryProcurementOutcomes(),
    qf: deps.v1?.qf ?? new InMemoryQfReader(),
    vendors: deps.v1?.vendors ?? { all: () => [] },
    accounts: deps.v1?.accounts ?? new InMemoryOperatedAccounts(),
  }

  const router = buildRouter({
    onboarding,
    screening,
    diligence,
    kyb,
    factory: config.factory,
    domain: config.domain,
    ledger,
    ledgerStore,
    receipts,
    reporting,
    agent: deps.agent ?? unwiredAgentPort('this process holds no fleet handle; the agent routes are served by the runner'),
    screeningMaxAgeSeconds: config.screeningMaxAgeSeconds,
    now,
    v1,
    ...(narrative === undefined ? {} : { narrative }),
    ...(accounts === undefined ? {} : { accounts }),
    ...(deps.purchases === undefined ? {} : { purchases: deps.purchases }),
    ...(deps.creative === undefined ? {} : { creative: deps.creative }),
  })

  const server = createApiServer({
    router,
    operatorToken: config.operatorToken,
    // public | dev | operator per path; see routes.ts authScopeOf. The dev
    // bearer is a wallet-signed session, never an address on its own.
    scopeOf: authScopeOf,
    devSessions: devAuth,
  })

  return {
    router,
    server,
    onboarding,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

export async function main(): Promise<void> {
  const config = loadConfig()
  const live = await resolveLiveDeps(config)
  const app = await createApp(live.deps)

  const shutdown = (): void => {
    void app.close().then(live.close).finally(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  app.server.listen(config.port, () => {
    process.stdout.write(`${JSON.stringify(describeConfig(config))}\n`)
    process.stdout.write(`\n${app.router.describe()}\n\n`)
    process.stdout.write(`${startupBanner(live.ledger)}\n`)
  })
}

/**
 * The boot banner: what resolved to the real thing and what did not, in the
 * fleet's format. The fleet's own banner is not reused because its headline is
 * about scripted MODEL OUTPUT, and this process never serves any - without a
 * live client the derive route answers 503 - so that line would be a lie here.
 */
export function startupBanner(ledger: SubstitutionLedger): string {
  const rule = '='.repeat(78)
  const lines = [rule]
  if (!ledger.anyFake) {
    lines.push('API: every dependency resolved to a real implementation.')
  } else if (ledger.anyFakeInMoneyPath) {
    lines.push('PARTLY FAKED API - FAKES IN THE MONEY PATH. Every one of them REFUSES rather than answers.')
  } else {
    lines.push('PARTLY FAKED API - SOME DEPENDENCIES ARE FAKED. See the list below.')
  }
  lines.push(rule)
  if (ledger.realDependencies.length > 0) {
    lines.push('real:')
    for (const entry of [...ledger.realDependencies].sort((a, b) => a.dependency.localeCompare(b.dependency))) {
      lines.push(`  ${entry.dependency.padEnd(22)} ${entry.detail}`)
    }
  }
  if (ledger.anyFake) {
    lines.push('faked:')
    for (const s of [...ledger.substitutions].sort((a, b) => a.dependency.localeCompare(b.dependency))) {
      lines.push(`  ${s.dependency.padEnd(22)} ${s.reason}${s.inMoneyPath ? ' [MONEY PATH]' : ''}`)
    }
  }
  lines.push(rule)
  return lines.join('\n')
}

/**
 * A misconfiguration is an operating condition, not a defect, so it gets a
 * message and a fix rather than a stack trace.
 *
 * This mattered more than it looks. The shipped failure was
 *
 *   ConfigError: config: VENUE_VAULT_INIT_CODE_HASH is required and has no safe default
 *
 * printed as a 12-line V8 trace, with nothing anywhere in the repository saying
 * where such a value comes from -- so the correct fail-closed refusal read as a
 * dead end. It is derivable, and `npm run bootstrap` derives it.
 *
 * The refusal itself is unchanged. Only its presentation is.
 */
function reportBootFailure(error: unknown): never {
  if (error instanceof ConfigError || error instanceof StartupRefused) {
    process.stderr.write(`${error.message}\n\n`)
    process.stderr.write('The service refuses to start on a missing or unsafe value; that is deliberate.\n')
    process.stderr.write('To generate a local environment with every derivable value filled in:\n\n')
    process.stderr.write('  npm run bootstrap -- --dev-identity      # writes .env.local\n')
    process.stderr.write('  npm run start:api                        # reads it\n\n')
    process.stderr.write('docs/RUNNING-LOCALLY.md lists every variable, what reads it, and which values\n')
    process.stderr.write('are DEV-ONLY and must never reach production. .env.example is the full reference.\n')
    process.exit(2)
  }
  throw error
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith('main.js')
if (invokedDirectly) {
  main().catch(reportBootFailure)
}
