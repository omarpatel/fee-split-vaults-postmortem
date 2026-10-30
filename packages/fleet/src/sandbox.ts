/**
 * THE WORLD, AND WHAT IS FAKE IN IT.
 *
 * Everything a coin's team needs, built from whatever REAL instances the
 * adapter loader resolved and a labelled fake for each one it did not. It is
 * not a mock: the ledger is the real double-entry ledger, the broker is the
 * real gate chain with a real signed policy token, and the publisher is the
 * real pipeline. Only the things that require a key, a chain or a database -
 * the chain read model, the price feed, the stores, the message ingest, the
 * settlement submitter, the channel transports - are substituted when absent,
 * and every substitution is recorded in the ledger of fakes so that it reaches
 * the banner and the run record. A real instance supplied in `SandboxOptions`
 * is used as-is, records nothing here, and is NEVER seeded with a fixture.
 *
 * WHY THE FAKES ARE THE PACKAGES' OWN. Each package publishes the fake it wants
 * used, complete with the fail-closed behaviour the real one must have: the
 * message source REFUSES a cross-coin fetch rather than filtering, the screening
 * store returns undefined rather than inventing a CLEAR verdict, the settlement
 * port has nowhere to put a payee. A second set of fakes written here would be
 * a second, more forgiving definition of correct.
 *
 * ONE FIXTURE MESSAGE SOURCE PER COIN, not one for the fleet. InMemoryMessageSource
 * throws on a window containing another coin's message - which is exactly right,
 * because that is a bleed - so sharing one across coins would be a design that
 * only works while every coin is quiet. (The real Telegram source is ONE per
 * bot token by construction and filters by coin on read; it is handed in per
 * coin through the same factory and refuses a cross-coin row rather than
 * filtering it.)
 */

import type {
  Asset,
  Consent,
  ImageAssetSource,
  QualificationSignals,
  ScreeningResult,
  Sku,
  Vault,
  Vendor,
} from '@fee-split-vaults/core'
import {
  FakeEvidenceSource,
  InMemoryPolicyService,
  PolicyKeyring,
  PolicyTokenSigner,
  PredicateRegistry,
  SpendBroker,
  VendorCatalog,
  invoiceHashFor,
  type CatalogEntry,
  type EvidenceSource,
  type OperatorTreasury,
  type VendorInvoice,
} from '@fee-split-vaults/broker'
import { InMemoryImageAssetStore } from '@fee-split-vaults/creative'
import { SignalsUnavailableError, type CoinBinding, type FeePosting } from '@fee-split-vaults/indexer'
import { InMemoryLedgerStore, Ledger, type LedgerStore } from '@fee-split-vaults/ledger'
import type { ModelClient } from '@fee-split-vaults/runtime'
import {
  createAutoApprovalGate,
  createFakeChannelSet,
  createFixedClock,
  createInMemoryAccountRegistry,
  createInMemoryEventLog,
  createInMemoryPostRegistry,
  createManualScheduler,
  createPublisher,
  type Publisher,
} from '@fee-split-vaults/publisher'
import {
  FakeSettlementPort,
  InMemoryApprovalStore,
  InMemoryAssetRegistry,
  InMemoryChainReadModel,
  InMemoryEscalationSink,
  InMemoryFleetCounters,
  InMemoryInvoiceRegistry,
  InMemoryMessageSource,
  InMemoryPendingPurchaseStore,
  InMemoryPredicateQueue,
  InMemoryPriceBook,
  InMemoryReceiptStore,
  InMemoryScreeningStore,
  InMemoryVaultRepository,
  type AllocationObservation,
  type ApprovalStore,
  type AssetRegistry,
  type ClaimObservation,
  type ChainReadModel,
  type CoinTickerConfig,
  type CoinTickerDeps,
  type Clock,
  type DeskPort,
  type EscalationSink,
  type FleetCounters,
  type InvoiceRegistry,
  type MessageSource,
  type PendingPurchaseStore,
  type PinnedUsdPrice,
  type PredicateQueue,
  type ReceiptStore,
  type ScreeningStore,
  type SettlementPort,
  type SignalsProvider,
  type UsdPriceBook,
  type VaultRepository,
} from '@fee-split-vaults/orchestrator'
import { TERMS } from '../../../config/protocol.js'
import type { CoinDefinition } from './coins.js'
import type { SubstitutionLedger } from './credentials.js'

/** The key id the sandbox signs policy tokens under. Never valid beside a real money path. */
export const SANDBOX_POLICY_KEY_ID = 'policy-sandbox'
const SANDBOX_POLICY_KEY = 'a-sandbox-policy-key-at-least-32-bytes-long'

const DAY = 86_400
const WINDOW = 1_800

/** The demand profile a sandbox coin is given. Data, not behaviour. */
export interface SandboxSeed {
  definition: CoinDefinition
  /** Days of fee postings. Fourteen is enough for the T1 sustain requirement. */
  postingDays: number
  /** USD of quote-denominated creator fees credited per day. */
  usdPerDay: number
  /** 'missing' puts NO screening on file, which denies paid media by refusal. */
  screening: 'CLEAR' | 'RESTRICTED' | 'BLOCKED' | 'missing'
  /** Holder messages seeded into the window that has just closed. */
  windowMessages: number
  /** False models fees that accrued but were never claimed or split. */
  settled?: boolean
  vaultState?: Vault['state']
  /** An open halt notice suspends every spend, exactly as the indexer's does. */
  halted?: boolean
  devPayout: string
  /** Deterministic qualification signals. Absent blocks upgrades, not service. */
  signals?: Partial<QualificationSignals>
}

export interface SandboxWorld {
  /** What every coin reads. Owned by the caller; the system clock when a real transport is wired. */
  clock: Clock
  /** What the coins actually read. The real model when one was supplied. */
  chain: ChainReadModel
  /**
   * The fixture chain, always constructed and EMPTY on a live world.
   *
   * Exposed separately so a caller can tell the two apart. `world.chain` is
   * whatever the coins read; this is only ever the in-memory one.
   */
  fixtureChain: InMemoryChainReadModel
  ledger: Ledger
  ledgerStore: LedgerStore
  /** What every coin's fee arithmetic reads. The chain-described registry when one was supplied. */
  assets: AssetRegistry
  prices: UsdPriceBook
  vaults: VaultRepository
  screening: ScreeningStore
  fleetCounters: FleetCounters
  escalations: EscalationSink
  settlement: SettlementPort
  receipts: ReceiptStore
  invoices: InvoiceRegistry
  approvals: ApprovalStore
  predicates: PredicateQueue
  pending: PendingPurchaseStore
  images: ImageAssetSource
  publisher: Publisher
  /** Per coin, because message ingest is per coin by construction. */
  messages: Map<string, MessageSource>
  /** Ready-to-register ticker configuration and dependencies, per coin. */
  coins: Map<string, { config: CoinTickerConfig; deps: CoinTickerDeps; tier: Vault['tier'] }>
  /**
   * Re-seed the window that closed most recently, so a later tick has input.
   * A no-op when the message source is real: fixture text never enters a
   * real store.
   */
  seedWindow(coinRef: string, nowUnix: number): void
  /**
   * Re-pin every asset price at `nowUnix`, as a live feed would. A no-op when
   * the price book is real: a real book is refreshed, never pinned by hand.
   */
  repin(nowUnix: number): void
}

export const OPERATOR_NAME = 'Venue Agency Ltd'
/** The operator's own treasury. The only destination a reimbursement can name. */
export const SANDBOX_TREASURY = '0x4444444444444444444444444444444444444444'
const SANDBOX_VENDOR_PAYOUT = '0x5555555555555555555555555555555555555555'
const SANDBOX_ADAPTER = '0x8888888888888888888888888888888888888888'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const LISTING_SKU = 'dexscreener.eti'

/**
 * A salt is a secret, and a shared salt merges two clients' abuse history, so
 * this is derived per coin and is not a constant anyone can copy into
 * production. A real deployment supplies FLEET_USER_ID_SALT and this is unused.
 */
function sandboxSalt(coinRef: string): string {
  return `sandbox-user-id-salt-not-for-production-${coinRef}`
}

function sandboxConsent(definition: CoinDefinition, devPayout: string, nowUnix: number): Consent {
  return {
    devSigner: devPayout,
    devPayout,
    token: definition.token,
    termsHash: '0xterms',
    // The signed commercial terms, read from config rather than invented here:
    // operatorBps is in the CREATE2 salt preimage, so a consent that disagreed
    // with config would model a vault that could not exist.
    operatorBps: TERMS.operatorBps,
    budgetBpsMax: TERMS.budgetBpsMax,
    adapter: SANDBOX_ADAPTER,
    referrer: ZERO_ADDRESS,
    referrerBps: 0,
    expiryUnix: nowUnix + 30 * DAY,
    nonce: '1',
  }
}

/** One posting per day at `usdPerDay`, priced in a six-decimal dollar asset. */
function dailyPostings(seed: SandboxSeed, endUnix: number): FeePosting[] {
  const out: FeePosting[] = []
  for (let i = 0; i < seed.postingDays; i += 1) {
    const dayIndex = Math.floor(endUnix / DAY) - seed.postingDays + i
    const at = dayIndex * DAY + 3_600
    if (seed.usdPerDay <= 0) continue
    const minor = BigInt(Math.round(seed.usdPerDay * 1_000_000))
    const suffix = `${seed.definition.coinRef}${String(i).padStart(4, '0')}`
    out.push({
      id: `0x${suffix}:0`,
      vault: seed.definition.vault,
      token: seed.definition.token,
      asset: seed.definition.quoteAsset,
      creditedMinor: minor,
      grossFeeMinor: minor,
      derivation: 'explicit',
      volumeMinor: 0n,
      source: 'pool_fees_swept',
      phase: 'post_graduation',
      classification: 'trade',
      side: 'sweep',
      blockNumber: BigInt(1_000 + i),
      blockHash: `0x${'b'.repeat(63)}${(i % 16).toString(16)}`,
      txHash: `0x${suffix}`,
      logIndex: 0,
      occurredAtUnix: at,
      finalized: true,
    })
  }
  return out
}

/**
 * The claim and the settle() split that follow each posting.
 *
 * Without these the ledger accrues income forever and the budget leg stays at
 * zero, so every spend refuses on solvency - which is correct, and is why this
 * is modelled rather than short-circuited with a number. The dev leg absorbs the
 * integer remainder, matching the on-chain split, so rounding can only favour
 * the client.
 */
function settlementsFor(
  postings: readonly FeePosting[],
  budgetBps: number,
): { claims: ClaimObservation[]; allocations: AllocationObservation[] } {
  const claims: ClaimObservation[] = []
  const allocations: AllocationObservation[] = []
  for (const p of postings) {
    claims.push({
      vault: p.vault,
      asset: p.asset,
      amountMinor: p.creditedMinor,
      occurredAtUnix: p.occurredAtUnix + 1,
      txHash: `${p.txHash}c`,
      logIndex: 0,
      blockHash: p.blockHash,
    })
    const budgetMinor = (p.creditedMinor * BigInt(budgetBps)) / 10_000n
    const operatorMinor = (p.creditedMinor * BigInt(TERMS.operatorBps)) / 10_000n
    allocations.push({
      vault: p.vault,
      asset: p.asset,
      devMinor: p.creditedMinor - budgetMinor - operatorMinor,
      budgetMinor,
      operatorMinor,
      referrerMinor: 0n,
      occurredAtUnix: p.occurredAtUnix + 2,
      txHash: `${p.txHash}s`,
      logIndex: 0,
      blockHash: p.blockHash,
    })
  }
  return { claims, allocations }
}

function sandboxAsset(address: string): Asset {
  return {
    address,
    symbol: 'USDG',
    decimals: 6,
    isPausableProxy: true,
    enabled: true,
    maxTransferMinor: 500_000_000n,
  }
}

function sandboxBinding(seed: SandboxSeed, nowUnix: number): CoinBinding {
  return {
    token: seed.definition.token,
    vault: seed.definition.vault,
    curve: '0x7777777777777777777777777777777777777777',
    poolId: `0xpool${seed.definition.coinRef.padEnd(58, '0')}`.slice(0, 66),
    quoteAsset: seed.definition.quoteAsset,
    launchedAtUnix: nowUnix - 60 * DAY,
    launchBlockNumber: 1_000n,
    buybackEnabled: false,
    creatorTaxBps: 0,
    coverageStartUnix: nowUnix - 60 * DAY,
  }
}

function sandboxScreening(seed: SandboxSeed, nowUnix: number): ScreeningResult | undefined {
  if (seed.screening === 'missing') return undefined
  return {
    token: seed.definition.token,
    verdict: seed.screening,
    flags: seed.screening === 'CLEAR' ? [] : ['sandbox_fixture'],
    stagesRun: ['lexicon', 'trademark'],
    screenedAtUnix: nowUnix - 3_600,
    paidMediaPermitted: seed.screening === 'CLEAR',
  }
}

function sandboxSku(id: string, vendorId: string): Sku {
  return {
    id,
    vendorId,
    description: 'enhanced token info listing',
    unitCostUsd: 299,
    category: 'listing',
    predicate: { kind: 'eti_listing', verifyAtOffsetsSeconds: [DAY], params: {} },
    availableAtTiers: ['T1', 'T2', 'T3'],
  }
}

function sandboxVendors(nowUnix: number): Vendor[] {
  return [
    {
      id: 'dexscreener',
      displayName: 'Dexscreener',
      payoutAddress: SANDBOX_VENDOR_PAYOUT,
      kybVerifiedAtUnix: nowUnix - 30 * DAY,
      ofacScreenedAtUnix: nowUnix - 5 * DAY,
      isRelatedParty: false,
      reliabilityScore: 0.9,
      enabled: true,
    },
  ]
}

function sandboxEntries(): CatalogEntry[] {
  return [
    {
      sku: sandboxSku(LISTING_SKU, 'dexscreener'),
      pricing: 'third_party_pass_through',
      rateCardRef: { vendorId: 'dexscreener', sourceHash: 'card-hash-1' },
      enabled: true,
      observedDeliveries: 10,
      maxQuantity: 4,
    },
  ]
}

/**
 * The fixture invoice: a listing the operator "already bought" as principal.
 *
 * Its hash is COMPUTED the way a real vendor's would be, because the broker
 * refuses an invoice whose hash does not match its body. A hard-coded hash
 * would be a fixture that stopped working the day the check landed, and
 * silently: the spend path would refuse with `invoice_hash_mismatch` and the
 * fixture fleet would look like a fleet that never gets an invoice.
 */
function sandboxInvoice(nowUnix: number): VendorInvoice {
  const body = {
    vendorId: 'dexscreener',
    skuId: LISTING_SKU,
    quantity: 1,
    amountUsd: 299,
    issuedAtUnix: nowUnix - 600,
  }
  return {
    ...body,
    invoiceHash: invoiceHashFor(body),
    vendorCountersig: `0x${'f'.repeat(130)}`,
  }
}

function defaultSignals(overrides: Partial<QualificationSignals> = {}): QualificationSignals {
  return {
    uniqueBuyers7d: 500,
    top10HolderSharePct: 40,
    deployerSupplySharePct: 5,
    selfTradeSharePct: 3,
    venuePoolVolumeSharePct: 60,
    coinAgeDays: 30,
    ...overrides,
  }
}

export interface SandboxOptions {
  nowUnix: number
  seeds: readonly SandboxSeed[]
  model: ModelClient
  /** Every substitution below is recorded here. Required, not optional. */
  ledger: SubstitutionLedger
  /**
   * The operator's user-id salt. Absent means a per-coin derived salt, which
   * is recorded as a fake: it is derivable from the coin ref, so a real
   * holder's id hashed under it is a real holder's id with a thin coat.
   */
  userIdSalt?: string
  /**
   * The clock every coin reads. The caller owns it: the bootstrap hands in a
   * settable clock it moves before each fixture tick, or the system clock when
   * any real transport or settlement is wired - a real send stamped with a
   * fixture time is a real send with a false record.
   */
  clock: Clock
  /**
   * A REAL chain read model, when one resolved.
   *
   * Supplying this changes two things and only two. The coins' dependencies
   * point at it instead of the in-memory model, and NO chain fixtures are
   * seeded - no synthetic bindings, no fabricated fee postings, no invented
   * claims. That second half is the important one: seeding fixtures into a
   * world whose chain is real would leave every coin holding a budget that
   * came from nowhere, and it would be indistinguishable, downstream, from a
   * budget the chain actually paid.
   *
   * THE SAME RULE APPLIES TO EVERY REAL STORE BELOW. A real invoice registry
   * gets no fixture invoice, a real screening store gets no fixture verdict, a
   * real price book gets no hand pins, a real vault repository gets no fixture
   * vault record. Each fixture exists to give a sandbox coin something to
   * reason about; written into a real store it is a forgery.
   */
  chain?: ChainReadModel
  /** Real, durable spend counters. Absent means in-memory, which reset on restart. */
  fleetCounters?: FleetCounters
  /** A real escalation sink. Absent means in-memory. */
  escalations?: EscalationSink
  /** A real price book. Absent means USD pinned at 1.00. */
  prices?: UsdPriceBook
  /** A real vault repository. Absent means in-memory, seeded from the definitions. */
  vaults?: VaultRepository
  /** A real screening store. Absent means in-memory, seeded from each seed's verdict. */
  screening?: ScreeningStore
  /** A real receipt store. Absent means in-memory. */
  receipts?: ReceiptStore
  /** A real invoice registry. Absent means in-memory with one fixture invoice per vault. */
  invoices?: InvoiceRegistry
  /** A real human-approval store. Absent means in-memory. */
  approvals?: ApprovalStore
  /**
   * The operator treasury every reimbursement is paid to. REQUIRED alongside a
   * real settlement port: the broker names this address as the pull's
   * destination and the port refuses any other, so a real port with the
   * sandbox treasury would refuse every pull it was ever handed.
   */
  treasury?: OperatorTreasury
  /** A real settlement port. Absent means a fake that records and never broadcasts. */
  settlement?: SettlementPort
  /** A real predicate queue. Absent means in-memory. */
  predicates?: PredicateQueue
  /** A real pending-purchase list. Absent means in-memory, so the operator's to-do list vanishes with the process. */
  pending?: PendingPurchaseStore
  /** A real message source per coin. Absent means in-memory, seeded with fixture text. */
  messages?: (coinRef: string) => MessageSource
  /** A real publisher. Absent means the real pipeline over fake transports. */
  publisher?: Publisher
  /** A real vendor catalog, shared by every coin. Absent means the sandbox vendor. */
  catalog?: VendorCatalog
  /** A real evidence source. Absent means the fake, which observes nothing. */
  evidence?: EvidenceSource
  /** A real ledger store. Absent means in-memory. */
  ledgerStore?: LedgerStore
  /** A real image store. Absent means an empty in-memory one, so every image ref is refused. */
  images?: ImageAssetSource
  /**
   * The chain-described, operator-governed asset registry. Absent means the
   * sandbox's six-decimal dollar stablecoin, which is what every fee figure
   * in a sandbox is arithmetic over.
   */
  assets?: AssetRegistry
  /**
   * Real qualification signals. Absent means the seed's fixed numbers, which
   * pass every conjunct by construction and are recorded as a money-path fake:
   * they are what decides whether a coin may be upgraded and may spend.
   */
  signals?: SignalsProvider
  /** The operator's policy-token keyring. Absent means the sandbox key, recorded as a money-path fake. */
  policyKeyring?: { keyring: PolicyKeyring; keyId: string }
  /** The holder desk, one instance for the fleet. Absent means the desk phase records `desk_unavailable`. */
  desk?: DeskPort
}

/**
 * Build the world and every coin's dependencies in it.
 *
 * The substitutions are recorded as they are made rather than listed at the end,
 * so a dependency added later cannot be silently omitted from the banner: the
 * only way to get one into this function is to write the line that records it.
 * Every `fake(...)` below is conditional on the real one being ABSENT; the
 * adapter loader records the real ones, so exactly one of the two records
 * exists for each dependency.
 */
export function createSandboxWorld(options: SandboxOptions): SandboxWorld {
  const { nowUnix, seeds, clock, ledger: substitutions } = options

  // A REAL chain is recorded by the adapter loader that resolved it, so it must
  // not also be recorded as a fake here. `liveChain` therefore gates both the
  // substitution record and the fixture seeding below - one flag, so the banner
  // and the data can never disagree about whether this world touched a chain.
  const liveChain = options.chain !== undefined
  if (!liveChain) {
    substitutions.fake('chain', 'no indexed chain store; postings and splits are fixtures', true)
  }
  if (options.prices === undefined) {
    substitutions.fake('prices', 'no price oracle credential; USD is pinned at 1.00', true)
  }
  if (options.vaults === undefined) {
    substitutions.fake('vaults', 'no vault directory service; vault records are fixtures')
  }
  if (options.screening === undefined) {
    substitutions.fake('screening', 'no screening service; verdicts are fixtures')
  }
  if (options.messages === undefined) {
    substitutions.fake('messages', 'no channel ingest credential; holder messages are fixtures')
  }
  if (options.settlement === undefined) {
    substitutions.fake('settlement', 'no signer; a reimbursement pull is recorded, never broadcast', true)
  }
  if (options.invoices === undefined) {
    substitutions.fake('invoices', 'no vendor invoice feed; a countersigned invoice is a fixture')
  }
  if (options.publisher === undefined) {
    substitutions.fake('publisher.transports', 'no channel token; posts are recorded, never sent')
  }
  if (options.receipts === undefined) {
    substitutions.fake('receipts', 'no durable receipt store; receipts vanish with the process')
  }
  if (options.approvals === undefined) {
    substitutions.fake('approvals', 'no durable approval store; a human approval cannot be on file', true)
  }
  if (options.predicates === undefined) {
    substitutions.fake('predicateQueue', 'no durable predicate queue; delivery checks are never run', true)
  }
  if (options.pending === undefined) {
    substitutions.fake('pendingPurchases', 'no durable pending-purchase list; approved purchases awaiting an invoice vanish with the process')
  }
  if (options.ledgerStore === undefined) {
    substitutions.fake('ledgerStore', 'no durable ledger; balances vanish with the process', true)
  }
  if (options.catalog === undefined) {
    substitutions.fake('catalog', 'no vendor data directory; one sandbox vendor and one listing SKU', true)
  }
  if (options.evidence === undefined) {
    substitutions.fake('evidence', 'no evidence source credential; delivery predicates observe nothing')
  }
  if (options.images === undefined) {
    substitutions.fake('images', 'no image store; every image reference is refused')
  }

  const ledgerStore: LedgerStore = options.ledgerStore ?? new InMemoryLedgerStore()
  const ledger = new Ledger(ledgerStore, { now: () => clock.nowUnix() })
  const fixtureAssets = new InMemoryAssetRegistry()
  const assets: AssetRegistry = options.assets ?? fixtureAssets
  const fixturePrices = new InMemoryPriceBook()
  const prices: UsdPriceBook = options.prices ?? fixturePrices
  const vaults: VaultRepository = options.vaults ?? new InMemoryVaultRepository()
  const screening: ScreeningStore = options.screening ?? new InMemoryScreeningStore()
  // The fixture chain is built either way, because `SandboxWorld.chain` is what
  // the seeding helpers write to. When a real model was supplied it is the one
  // the coins actually read, and the fixture below is left empty and unused.
  const fixtureChain = new InMemoryChainReadModel()
  const chain: ChainReadModel = options.chain ?? fixtureChain
  const fleetCounters: FleetCounters = options.fleetCounters ?? new InMemoryFleetCounters()
  const escalations: EscalationSink = options.escalations ?? new InMemoryEscalationSink()
  const settlement: SettlementPort = options.settlement ?? new FakeSettlementPort(() => clock.nowUnix())
  const receipts: ReceiptStore = options.receipts ?? new InMemoryReceiptStore()
  const invoices: InvoiceRegistry = options.invoices ?? new InMemoryInvoiceRegistry()
  const approvals: ApprovalStore = options.approvals ?? new InMemoryApprovalStore()
  const predicates: PredicateQueue = options.predicates ?? new InMemoryPredicateQueue()
  const pending: PendingPurchaseStore = options.pending ?? new InMemoryPendingPurchaseStore()
  const images: ImageAssetSource = options.images ?? new InMemoryImageAssetStore()
  const evidence: EvidenceSource = options.evidence ?? new FakeEvidenceSource()
  const catalog: VendorCatalog = options.catalog ?? new VendorCatalog(sandboxVendors(nowUnix), sandboxEntries())
  const messages = new Map<string, MessageSource>()
  /** The fixture sources only; a real source is never seeded. */
  const fixtureMessages = new Map<string, InMemoryMessageSource>()
  const seededWindows = new Set<string>()

  // THE SIGNALS DECIDE WHETHER A COIN MAY BE UPGRADED AND MAY SPEND, so the
  // fixture numbers - which pass every conjunct by construction - are a fake
  // in the money path, and were once the one substitution this file forgot
  // to record: a live chain ticked with 500 invented buyers per coin and the
  // banner said nothing. On a LIVE chain the fixture is not offered at all:
  // a coin whose fees are real and whose buyers are invented is exactly the
  // farmed median the conjuncts exist to stop, so without a holder index the
  // signals refuse - typed, per tick, blocking an upgrade and nothing else.
  if (options.signals === undefined) {
    substitutions.fake(
      'signals',
      liveChain
        ? 'no holder index (FLEET_HOLDERS=index unset); qualification signals REFUSE every tick, so no upgrade and no spend'
        : 'no holder index or volume source; qualification signals are the seed\'s fixed numbers and pass every conjunct',
      true,
    )
  }
  const refusingSignals: SignalsProvider = {
    compute: async () => {
      throw new SignalsUnavailableError(
        'uniqueBuyers7d',
        'FLEET_CHAIN=live without FLEET_HOLDERS=index: no holder replay and no volume sample exist, and a live ' +
          'coin is not given the sandbox\'s invented numbers',
      )
    },
  }

  // THE POLICY KEY signs the token the broker checks before every pull. The
  // sandbox key ships in this file, so a token under it is a token anyone
  // can mint; the adapter loader refuses a real settlement or catalog beside
  // it, and here it is recorded so a sandbox banner says which key is in use.
  const keyring = options.policyKeyring?.keyring ?? new PolicyKeyring({ [SANDBOX_POLICY_KEY_ID]: SANDBOX_POLICY_KEY })
  const keyId = options.policyKeyring?.keyId ?? SANDBOX_POLICY_KEY_ID
  if (options.policyKeyring === undefined) {
    substitutions.fake('policyKeyring', `no POLICY_SIGNING_KEY; policy tokens signed under the sandbox key "${SANDBOX_POLICY_KEY_ID}"`, true)
  }

  // THE SALT pseudonymises holder ids before they reach a model or a store.
  // The derived one is a function of the coin ref, which anyone can compute,
  // so a real holder's id under it is barely hidden; it is a fake, and the
  // bootstrap refuses it beside anything real.
  if (options.userIdSalt === undefined) {
    substitutions.fake('userIdSalt', 'no FLEET_USER_ID_SALT; user ids are hashed under a salt derived from the coin ref')
  }

  // One pin per day for sixty days, plus one at `now`. A single old pin is not
  // enough: the measurement refuses a price older than its staleness bound at
  // the instant being priced, so a historical posting with no pin near it is
  // unpriceable and the whole measurement correctly refuses. A REAL book gets
  // none of these: a pin it did not fetch is a price nobody quoted. A REAL
  // registry gets no fixture asset: the six-decimal dollar record is what a
  // sandbox's fee arithmetic runs on, and written over a chain-described
  // registry it would be a decimals nobody read.
  const quoteAssets = new Set(seeds.map((s) => s.definition.quoteAsset))
  if (options.assets === undefined) {
    substitutions.fake(
      'assets',
      `no chain-described asset registry; ${String(quoteAssets.size)} quote asset(s) assumed to be a 6-decimal dollar stablecoin`,
      true,
    )
  }
  for (const address of quoteAssets) {
    if (options.assets === undefined) fixtureAssets.put(sandboxAsset(address))
    if (options.prices !== undefined) continue
    for (let i = 0; i <= 60; i += 1) {
      fixturePrices.pin(pin(address, nowUnix - (60 - i) * DAY))
    }
    fixturePrices.pin(pin(address, nowUnix - 30))
  }

  const publisher = options.publisher ?? sandboxPublisher(seeds, nowUnix, images)

  if (options.settlement !== undefined && options.treasury === undefined) {
    throw new Error('a real settlement port needs the operator treasury it settles to')
  }
  const treasury: OperatorTreasury = options.treasury ?? { address: SANDBOX_TREASURY, label: 'operator treasury' }
  const coins = new Map<string, { config: CoinTickerConfig; deps: CoinTickerDeps; tier: Vault['tier'] }>()

  for (const seed of seeds) {
    const definition = seed.definition

    // A vault record built from the definition carries a FIXTURE consent -
    // terms hash '0xterms', a synthetic adapter - and is written only into the
    // in-memory repository. A real repository holds the consent the dev
    // actually signed, and the directory that loaded the coin is responsible
    // for it being there.
    if (options.vaults === undefined) {
      void vaults.put({
        address: definition.vault,
        token: definition.token,
        consent: sandboxConsent(definition, seed.devPayout, nowUnix),
        state: seed.vaultState ?? 'ACTIVE',
        tier: definition.tier,
        budgetBps: definition.budgetBps,
        buybackEnabled: false,
        creatorTaxBps: 0,
        deployedAtUnix: nowUnix - 60 * DAY,
        activatedAtUnix: nowUnix - 50 * DAY,
      })
    }

    // NO CHAIN FIXTURES WHEN THE CHAIN IS REAL.
    //
    // Every line below invents chain history: a binding nobody deployed, fees
    // nobody paid, claims and splits that never settled. Against the fixture
    // chain that is the whole point - it is what gives a sandbox coin a budget
    // to reason about. Against a REAL chain it would be forgery: the budget
    // leg would fill from fabricated postings and, from that point on, nothing
    // downstream could tell that money apart from money the chain actually
    // paid. A coin on a live chain has exactly the history the chain has, and
    // if that is none, the honest consequence is a coin that cannot spend.
    if (!liveChain) {
      fixtureChain.putBinding(sandboxBinding(seed, nowUnix))
      const postings = dailyPostings(seed, nowUnix)
      fixtureChain.putPostings(...postings)
      if (seed.settled !== false) {
        const { claims, allocations } = settlementsFor(postings, definition.budgetBps)
        for (const claim of claims) fixtureChain.putClaim(claim)
        for (const allocation of allocations) fixtureChain.putAllocation(allocation)
      }
      if (seed.halted === true) {
        fixtureChain.putHalt(definition.token, {
          vault: definition.vault,
          token: definition.token,
          reason: 'watch_stale',
          detectedAtUnix: nowUnix - 60,
          detail: 'sandbox fixture halt',
        })
      }
    }

    if (options.screening === undefined) {
      const verdict = sandboxScreening(seed, nowUnix)
      if (verdict !== undefined) void screening.put(verdict)
    }

    // One fixture invoice per vault, so the fixture desk can reach the
    // reimbursement path once. A real registry holds what vendors actually
    // countersigned and nothing else.
    if (options.invoices === undefined) {
      void invoices.put(definition.vault, sandboxInvoice(nowUnix))
    }

    let source: MessageSource
    if (options.messages === undefined) {
      const fixture = new InMemoryMessageSource()
      fixtureMessages.set(definition.coinRef, fixture)
      source = fixture
    } else {
      source = options.messages(definition.coinRef)
    }
    messages.set(definition.coinRef, source)

    const broker = new SpendBroker({
      catalog,
      // The policy token is signed per coin and carries this coin's tier. A
      // fleet-wide policy service would hand one coin another coin's authority.
      policyService: new InMemoryPolicyService(new PolicyTokenSigner(keyring, keyId), {
        tier: definition.tier,
        enabledAssets: [definition.quoteAsset],
      }),
      keyring,
      predicates: new PredicateRegistry(evidence),
    })

    const config: CoinTickerConfig = {
      coinRef: definition.coinRef,
      vault: definition.vault,
      token: definition.token,
      quoteAsset: definition.quoteAsset,
      userIdSalt: options.userIdSalt ?? sandboxSalt(definition.coinRef),
      catalog: definition.catalog,
      linkRefs: definition.linkRefs,
      linkUrls: definition.linkUrls,
      imageRefs: definition.imageRefs,
      narrative: definition.narrative,
      accounts: definition.accounts,
      relatedPartyOptIn: definition.relatedPartyOptIn,
      sweepIntervalSeconds: definition.sweepIntervalSeconds,
    }

    const deps: CoinTickerDeps = {
      clock,
      chain,
      ledger,
      ledgerStore,
      assets,
      prices,
      vaults,
      screening,
      messages: source,
      model: options.model,
      signals: options.signals ?? (liveChain ? refusingSignals : { compute: async () => defaultSignals(seed.signals) }),
      ...(options.desk === undefined ? {} : { desk: options.desk }),
      fleet: fleetCounters,
      escalations,
      spend: { broker, treasury, invoices, approvals, settlement, receipts, predicates, pending },
      publish: { publisher },
    }

    coins.set(definition.coinRef, { config, deps, tier: definition.tier })
  }

  const world: SandboxWorld = {
    clock,
    chain,
    fixtureChain,
    ledger,
    ledgerStore,
    assets,
    prices,
    vaults,
    screening,
    fleetCounters,
    escalations,
    settlement,
    receipts,
    invoices,
    approvals,
    predicates,
    pending,
    images,
    publisher,
    messages,
    coins,
    seedWindow(coinRef: string, atUnix: number): void {
      const source = fixtureMessages.get(coinRef)
      const seed = seeds.find((s) => s.definition.coinRef === coinRef)
      if (source === undefined || seed === undefined) return
      // The window that has most recently CLOSED, which is the only one the
      // cadence will hand to the runtime.
      const start = Math.floor(atUnix / WINDOW) * WINDOW - WINDOW
      // Seed each window ONCE. Seeding twice does not double the corpus - the
      // assembler dedupes on text, so it silently produces a window of one
      // admitted message and eleven drops, which reads as a flood that never
      // happened.
      const key = `${coinRef}:${String(start)}`
      if (seededWindows.has(key)) return
      seededWindows.add(key)
      for (let i = 0; i < seed.windowMessages; i += 1) {
        source.add({
          sourceId: `${coinRef}-${String(start)}-${String(i)}`,
          authorId: `holder-${String(i)}`,
          // Distinct texts, because holders are distinct people. Identical
          // fixture text collapses under the assembler's dedupe and would make
          // every window look like one message from one author.
          text: HOLDER_QUESTIONS[i % HOLDER_QUESTIONS.length] ?? 'how do I buy this',
          postedAtUnix: start + 60 * i,
          origin: 'telegram',
          boundCoinRef: coinRef,
        })
      }
    },
    repin(atUnix: number): void {
      if (options.prices !== undefined) return
      for (const address of quoteAssets) fixturePrices.pin(pin(address, atUnix - 30))
    },
  }

  for (const seed of seeds) world.seedWindow(seed.definition.coinRef, nowUnix)
  return world
}

/**
 * The real publisher pipeline over FAKE transports.
 *
 * The policy, the classifier, the disclosure, the approval step and the
 * read-back all run for real; only the last hop - the thing that would hit a
 * platform API - is a recording fake. The account bindings are seeded from
 * the coin definitions because there is no registry to read them from; a
 * real publisher reads its bindings from the durable registry the control
 * plane writes.
 */
function sandboxPublisher(seeds: readonly SandboxSeed[], nowUnix: number, images: ImageAssetSource): Publisher {
  const publisherClock = createFixedClock(nowUnix)
  const channels = createFakeChannelSet({
    operatorName: OPERATOR_NAME,
    nowUnix: () => publisherClock.nowUnix(),
    images,
  })
  const accountRecords = seeds.flatMap((seed) =>
    [...seed.definition.accounts].map(([channel, accountId]) => ({
      accountId,
      channel,
      coinRef: seed.definition.coinRef,
      vault: seed.definition.vault,
      token: seed.definition.token,
      ticker: seed.definition.symbol,
      delegated: false,
    })),
  )
  return createPublisher({
    policy: {
      operatorName: OPERATOR_NAME,
      receiptsBaseUrl: 'https://receipts.example.test',
      allowedLinkHosts: ['receipts.example.test'],
      allowedRouterAddresses: [],
      maxAccountLabelAgeSeconds: 3_600,
    },
    adapters: channels.adapters,
    accounts: createInMemoryAccountRegistry(
      accountRecords,
      seeds.map((seed) => ({
        vault: seed.definition.vault,
        token: seed.definition.token,
        ticker: seed.definition.symbol,
      })),
    ),
    posts: createInMemoryPostRegistry(),
    images,
    log: createInMemoryEventLog(),
    approvals: createAutoApprovalGate('sandbox-approver'),
    scheduler: createManualScheduler(publisherClock),
    clock: publisherClock,
  })
}

/**
 * What holders actually ask, as fixture text.
 *
 * Mundane on purpose. These stand in for attacker-authored input, so they are
 * exactly the kind of thing the reader is supposed to turn into a count and
 * nothing more - and none of them carries an address, a link or an amount,
 * because a fixture that did would be testing the scrubber rather than the
 * pipeline.
 */
const HOLDER_QUESTIONS: readonly string[] = [
  'how do I buy this on the app',
  'where is the contract listed, I cannot find it',
  'is there a pinned guide for new holders',
  'why did the fee split change this week',
  'who is running the account, is this official',
  'when does the next update get posted',
  'can someone explain the vault to me',
  'is the team doxxed or anonymous',
]

/** USDG at exactly $1.00. Integer cents per whole unit; never a float. */
function pin(asset: string, atUnix: number): PinnedUsdPrice {
  return { asset, centsPerWholeUnit: 100n, source: 'sandbox:pinned', pricedAtUnix: atUnix }
}
