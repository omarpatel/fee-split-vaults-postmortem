/**
 * A whole coin, wired end to end from real packages.
 *
 * Nothing here is mocked at a boundary that matters: the ledger is the real
 * double-entry ledger over its in-memory store, the broker is the real gate
 * chain with a real signed policy token, and the publisher is the real pipeline
 * with fake transports. Only the model, the chain and settlement are faked, and
 * each of those is faked with the package's own published fake.
 */

import type {
  Asset,
  Consent,
  QualificationSignals,
  ScreeningResult,
  Sku,
  Vault,
  Vendor,
} from '@fee-split-vaults/core'
import {
  InMemoryPolicyService,
  PolicyKeyring,
  PolicyTokenSigner,
  PredicateRegistry,
  FakeEvidenceSource,
  SpendBroker,
  VendorCatalog,
  invoiceHashFor,
  type CatalogEntry,
  type OperatorTreasury,
  type VendorInvoice,
} from '@fee-split-vaults/broker'
import { InMemoryLedgerStore, Ledger } from '@fee-split-vaults/ledger'
import type { CoinBinding, FeePosting } from '@fee-split-vaults/indexer'
import {
  FakeModelClient,
  toolUseReply,
  type ModelContentBlock,
  type ModelRequest,
  type ScriptedReply,
} from '@fee-split-vaults/runtime'
import {
  createAutoApprovalGate,
  createFakeChannelSet,
  createFixedClock,
  createInMemoryAccountRegistry,
  createInMemoryEventLog,
  createInMemoryPostRegistry,
  createManualScheduler,
  createPublisher,
  type FakeChannelSet,
  type Publisher,
} from '@fee-split-vaults/publisher'

import { TERMS, TIERS } from '../../../../config/protocol.js'
import { CoinTicker, type CoinTickerConfig, type CoinTickerDeps } from '../coin.js'
import {
  FakeSettlementPort,
  InMemoryApprovalStore,
  InMemoryAssetRegistry,
  InMemoryChainReadModel,
  InMemoryEscalationSink,
  InMemoryInvoiceRegistry,
  InMemoryPendingPurchaseStore,
  InMemoryPredicateQueue,
  InMemoryMessageSource,
  InMemoryScreeningStore,
  InMemoryVaultRepository,
} from '../fakes.js'
import { InMemoryFleetCounters } from '../fleet.js'
import { InMemoryPriceBook } from '../prices.js'
import { InMemoryReceiptStore } from '../receipts.js'
import {
  fixedClock,
  type AllocationObservation,
  type ClaimObservation,
  type DeskPort,
  type PinnedUsdPrice,
} from '../ports.js'

export const DAY = 86_400
/** 2026-09-06T00:00:00Z, aligned to a 30-minute window and a UTC day. */
export const T0 = 1_788_652_800
/** Two minutes past a window boundary: the previous window has closed. */
export const NOW = T0 + 1_800 + 120

export const COIN = 'coin_alpha'
export const OTHER_COIN = 'coin_beta'
export const SALT = 'orchestrator-test-salt-at-least-32-characters'

export const VAULT = '0x1111111111111111111111111111111111111111'
export const TOKEN = '0x2222222222222222222222222222222222222222'
export const DEV_PAYOUT = '0x3333333333333333333333333333333333333333'
export const TREASURY = '0x4444444444444444444444444444444444444444'
export const VENDOR_PAYOUT = '0x5555555555555555555555555555555555555555'
export const USDG = '0x6666666666666666666666666666666666666666'
export const CURVE = '0x7777777777777777777777777777777777777777'
export const POOL_ID = '0xpool0000000000000000000000000000000000000000000000000000000001'

export const KEY_ID = 'policy-2026-09'
export const SERVICE_KEY = 'a-service-key-that-is-at-least-32-bytes-long'
export const LISTING_SKU = 'dexscreener.eti'

export const OPERATOR_NAME = 'Venue Agency Ltd'
export const TREASURY_ACCOUNT: OperatorTreasury = { address: TREASURY, label: 'operator treasury' }

/** USDG at exactly $1.00, six decimals. */
export function usdgPrice(atUnix = NOW - 60): PinnedUsdPrice {
  return { asset: USDG, centsPerWholeUnit: 100n, source: 'test:pinned', pricedAtUnix: atUnix }
}

export function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    address: USDG,
    symbol: 'USDG',
    decimals: 6,
    isPausableProxy: true,
    enabled: true,
    ...overrides,
  }
}

function makeConsent(): Consent {
  return {
    devSigner: DEV_PAYOUT,
    devPayout: DEV_PAYOUT,
    token: TOKEN,
    termsHash: '0xterms',
    // The signed commercial terms, not a number this fixture gets to invent.
    // operatorBps is in the CREATE2 salt preimage, so a consent that disagreed
    // with config would model a vault that could not exist.
    operatorBps: TERMS.operatorBps,
    budgetBpsMax: TERMS.budgetBpsMax,
    adapter: '0x8888888888888888888888888888888888888888',
    referrer: '0x0000000000000000000000000000000000000000',
    referrerBps: 0,
    expiryUnix: NOW + 30 * DAY,
    nonce: '1',
  }
}

export function makeVault(overrides: Partial<Vault> = {}): Vault {
  return {
    address: VAULT,
    token: TOKEN,
    consent: makeConsent(),
    state: 'ACTIVE',
    tier: 'T1',
    budgetBps: TERMS.budgetBpsDefault,
    buybackEnabled: false,
    creatorTaxBps: 0,
    deployedAtUnix: NOW - 60 * DAY,
    activatedAtUnix: NOW - 50 * DAY,
    ...overrides,
  }
}

export function makeBinding(overrides: Partial<CoinBinding> = {}): CoinBinding {
  return {
    token: TOKEN,
    vault: VAULT,
    curve: CURVE,
    poolId: POOL_ID,
    quoteAsset: USDG,
    launchedAtUnix: NOW - 60 * DAY,
    launchBlockNumber: 1_000n,
    buybackEnabled: false,
    creatorTaxBps: 0,
    coverageStartUnix: NOW - 60 * DAY,
    ...overrides,
  }
}

export function makeScreening(overrides: Partial<ScreeningResult> = {}): ScreeningResult {
  return {
    token: TOKEN,
    verdict: 'CLEAR',
    flags: [],
    stagesRun: ['lexicon', 'trademark'],
    screenedAtUnix: NOW - 3_600,
    paidMediaPermitted: true,
    ...overrides,
  }
}

export function makeSignals(overrides: Partial<QualificationSignals> = {}): QualificationSignals {
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

/** One posting per day, `usdPerDay` dollars of credit at $1.00 USDG. */
export function dailyPostings(
  days: number,
  usdPerDay: number | ((dayOffset: number) => number),
  endUnix = NOW,
): FeePosting[] {
  const out: FeePosting[] = []
  for (let i = 0; i < days; i += 1) {
    const dayIndex = Math.floor(endUnix / DAY) - days + i
    const at = dayIndex * DAY + 3_600
    const usd = typeof usdPerDay === 'function' ? usdPerDay(i) : usdPerDay
    if (usd <= 0) continue
    out.push({
      id: `0xtx${String(i).padStart(4, '0')}:0`,
      vault: VAULT,
      token: TOKEN,
      asset: USDG,
      creditedMinor: BigInt(Math.round(usd * 1_000_000)),
      grossFeeMinor: BigInt(Math.round(usd * 1_000_000)),
      derivation: 'explicit',
      volumeMinor: 0n,
      source: 'pool_fees_swept',
      phase: 'post_graduation',
      classification: 'trade',
      side: 'sweep',
      blockNumber: BigInt(1_000 + i),
      blockHash: `0x${'b'.repeat(63)}${i.toString(16)}`,
      txHash: `0xtx${String(i).padStart(4, '0')}`,
      logIndex: 0,
      occurredAtUnix: at,
      finalized: true,
    })
  }
  return out
}

/**
 * The on-chain claim and settle() split that follows each fee posting.
 *
 * Without these the ledger accrues income forever and the budget leg stays at
 * zero, so every spend refuses on solvency - which is correct, and is exactly
 * why the harness has to model them rather than hand the broker a number.
 *
 * The dev leg absorbs the integer remainder, matching the on-chain split, so
 * rounding can only ever favour the client.
 */
export function settlementsFor(
  postings: readonly FeePosting[],
  budgetBps = TERMS.budgetBpsDefault,
  operatorBps = TERMS.operatorBps,
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
    const operatorMinor = (p.creditedMinor * BigInt(operatorBps)) / 10_000n
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

// ---------------------------------------------------------------------------
// Catalog + broker
// ---------------------------------------------------------------------------

function sku(overrides: Partial<Sku> & Pick<Sku, 'id' | 'vendorId'>): Sku {
  return {
    description: 'enhanced token info listing',
    unitCostUsd: 299,
    category: 'listing',
    predicate: { kind: 'eti_listing', verifyAtOffsetsSeconds: [DAY], params: {} },
    availableAtTiers: ['T1', 'T2', 'T3'],
    ...overrides,
  }
}

export function makeVendors(): Vendor[] {
  return [
    {
      id: 'dexscreener',
      displayName: 'Dexscreener',
      payoutAddress: VENDOR_PAYOUT,
      kybVerifiedAtUnix: NOW - 30 * DAY,
      ofacScreenedAtUnix: NOW - 5 * DAY,
      isRelatedParty: false,
      reliabilityScore: 0.9,
      enabled: true,
    },
  ]
}

export function makeEntries(): CatalogEntry[] {
  return [
    {
      sku: sku({ id: LISTING_SKU, vendorId: 'dexscreener' }),
      pricing: 'third_party_pass_through',
      rateCardRef: { vendorId: 'dexscreener', sourceHash: 'card-hash-1' },
      enabled: true,
      observedDeliveries: 10,
      maxQuantity: 4,
    },
  ]
}

export function makeInvoice(overrides: Partial<VendorInvoice> = {}): VendorInvoice {
  const body = {
    vendorId: 'dexscreener',
    skuId: LISTING_SKU,
    quantity: 1,
    amountUsd: 299,
    issuedAtUnix: NOW - 600,
    ...overrides,
  }
  return {
    invoiceHash: invoiceHashFor(body),
    vendorCountersig: '0x' + 'f'.repeat(130),
    ...body,
  }
}

/**
 * An invoice is evidence of ONE purchase and is consumed by the reimbursement
 * that cites it, so a fixture that expects a coin to buy repeatedly needs one
 * invoice per purchase. Enough for the longest multi-tick loop in the suite.
 */
export const SEEDED_INVOICES = 64

export function seedInvoices(registry: InMemoryInvoiceRegistry, vault: string): void {
  for (let i = 0; i < SEEDED_INVOICES; i += 1) {
    void registry.put(vault, makeInvoice({ issuedAtUnix: NOW - 600 - i }))
  }
}

export function makeBroker(catalog = new VendorCatalog(makeVendors(), makeEntries())): SpendBroker {
  const keyring = new PolicyKeyring({ [KEY_ID]: SERVICE_KEY })
  const signer = new PolicyTokenSigner(keyring, KEY_ID)
  const policyService = new InMemoryPolicyService(signer, {
    tier: 'T1',
    enabledAssets: [USDG],
  })
  return new SpendBroker({
    catalog,
    policyService,
    keyring,
    predicates: new PredicateRegistry(new FakeEvidenceSource()),
  })
}

// ---------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------

export function makePublisher(nowUnix = NOW): { publisher: Publisher; channels: FakeChannelSet } {
  const clock = createFixedClock(nowUnix)
  const channels = createFakeChannelSet({
    operatorName: OPERATOR_NAME,
    nowUnix: () => clock.nowUnix(),
  })
  const accounts = createInMemoryAccountRegistry(
    [
      {
        accountId: 'tg-alpha',
        coinRef: COIN,
        channel: 'telegram',
        vault: VAULT,
        token: TOKEN,
        ticker: 'ALPHA',
        delegated: false,
      },
    ],
    [{ vault: VAULT, token: TOKEN, ticker: 'ALPHA' }],
  )
  const publisher = createPublisher({
    policy: {
      operatorName: OPERATOR_NAME,
      receiptsBaseUrl: 'https://receipts.example.test',
      allowedLinkHosts: ['receipts.example.test'],
      allowedRouterAddresses: [],
      maxAccountLabelAgeSeconds: 3_600,
    },
    adapters: channels.adapters,
    accounts,
    posts: createInMemoryPostRegistry(),
    log: createInMemoryEventLog(),
    approvals: createAutoApprovalGate('test-approver'),
    scheduler: createManualScheduler(clock),
    clock,
  })
  return { publisher, channels }
}

// ---------------------------------------------------------------------------
// Model script
// ---------------------------------------------------------------------------

export const READER_EMISSION = JSON.stringify({
  topicCounts: { how_to_buy: 4, sentiment_positive: 2 },
  signals: ['quiet'],
  gists: ['several holders ask where to buy'],
  readerRefusals: 0,
})

function isReader(request: ModelRequest): boolean {
  return request.tools === undefined
}

export interface PlannerScript {
  calls: Array<{ name: string; input: unknown }>
}

export const QUIET: Array<{ name: string; input: unknown }> = [
  { name: 'propose_no_action', input: { reason: 'quiet window' } },
]

/**
 * Reader always emits; the planner emits whatever the (mutable) script says.
 *
 * The script is a box rather than a value so a test can warm the divergence
 * baseline with quiet windows and only then propose a purchase - which is the
 * order a real coin experiences, and the only order in which a purchase is not
 * frozen by the cold-start rule.
 */
export function scriptedModel(script: PlannerScript): FakeModelClient {
  return new FakeModelClient((request: ModelRequest): ScriptedReply => {
    if (isReader(request)) {
      const content: ModelContentBlock[] = [{ type: 'text', text: READER_EMISSION }]
      return { content, stopReason: 'end_turn' }
    }
    return toolUseReply(script.calls)
  })
}

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

/** Six ordinary questions inside one window, so the corpus is not empty. */
export function seedWindow(
  messages: InMemoryMessageSource,
  coinRef: string,
  windowStart: number,
  count = 6,
): void {
  for (let i = 0; i < count; i += 1) {
    messages.add({
      sourceId: `seed-${String(windowStart)}-${String(i)}`,
      authorId: `holder-${String(i)}`,
      text: 'how do I buy this and where is the contract listed',
      postedAtUnix: windowStart + 60 * i,
      origin: 'telegram',
      boundCoinRef: coinRef,
    })
  }
}

export interface Harness {
  ticker: CoinTicker
  clock: ReturnType<typeof fixedClock>
  ledger: Ledger
  ledgerStore: InMemoryLedgerStore
  chain: InMemoryChainReadModel
  assets: InMemoryAssetRegistry
  prices: InMemoryPriceBook
  vaults: InMemoryVaultRepository
  screening: InMemoryScreeningStore
  messages: InMemoryMessageSource
  fleet: InMemoryFleetCounters
  escalations: InMemoryEscalationSink
  settlement: FakeSettlementPort
  receipts: InMemoryReceiptStore
  invoices: InMemoryInvoiceRegistry
  predicates: InMemoryPredicateQueue
  approvals: InMemoryApprovalStore
  pending: InMemoryPendingPurchaseStore
  model: FakeModelClient
  script: PlannerScript
  broker: SpendBroker
  config: CoinTickerConfig
  deps: CoinTickerDeps
  /** The fake transports behind the publisher, so a test can read what went on the wire. */
  channels: FakeChannelSet
}

export interface HarnessOptions {
  nowUnix?: number
  coinRef?: string
  vault?: Partial<Vault>
  screening?: ScreeningResult | null
  postings?: FeePosting[]
  binding?: CoinBinding | null
  signals?: QualificationSignals | null
  plannerCalls?: Array<{ name: string; input: unknown }>
  assetEnabled?: boolean
  withInvoice?: boolean
  /** False leaves the window empty, so no model call happens at all. */
  seedMessages?: boolean
  /** False models a coin whose fees accrued but were never claimed or split. */
  settle?: boolean
  /**
   * The clock the SETTLEMENT RECEIPT is stamped with.
   *
   * Defaults to the tick clock, which is what almost every fixture wants. In
   * PRODUCTION the two are not the same clock: settledAtUnix is a block
   * timestamp reported by whatever settled the pull, so it drifts from the tick
   * clock and can land on the far side of a UTC midnight the tick clock has not
   * reached. Override this to model that skew on purpose - see the day-boundary
   * test in orchestrator.spec.ts, which is the test that holds the money gates
   * to reading and writing their daily counters under the SAME clock.
   */
  settlementNowUnix?: () => number
  /** Wired as `deps.desk`. Absent means the tick records `desk_unavailable`. */
  desk?: DeskPort
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const nowUnix = options.nowUnix ?? NOW
  const coinRef = options.coinRef ?? COIN
  const clock = fixedClock(nowUnix)

  const ledgerStore = new InMemoryLedgerStore()
  const ledger = new Ledger(ledgerStore, { now: () => clock.nowUnix() })

  const assets = new InMemoryAssetRegistry([
    makeAsset(options.assetEnabled === false ? { enabled: false } : {}),
  ])
  // One pin per day for sixty days. A single old pin is NOT enough: the
  // indexer refuses a price older than its staleness bound at the moment being
  // priced, so a historical posting with no pin near it is unpriceable and the
  // whole measurement refuses rather than assuming a dollar.
  const prices = new InMemoryPriceBook(
    Array.from({ length: 61 }, (_, i) => usdgPrice(nowUnix - (60 - i) * DAY)),
  )

  const chain = new InMemoryChainReadModel()
  if (options.binding !== null) chain.putBinding(options.binding ?? makeBinding())
  // The default coin is a HEALTHY T1 DESK: fourteen days of credits that clear
  // the T1 gate, so the tier holds and the whole pipeline downstream of it -
  // cognition, spend, publish - actually runs. Read the gate from config rather
  // than restating it: the day the gate moves, this fixture moves with it and
  // every end-to-end test keeps testing what it was written to test.
  const postings = options.postings ?? dailyPostings(14, TIERS.T1.gateQfPerDay)
  chain.putPostings(...postings)
  if (options.settle !== false) {
    const { claims, allocations } = settlementsFor(postings)
    for (const claim of claims) chain.putClaim(claim)
    for (const allocation of allocations) chain.putAllocation(allocation)
  }

  const vaults = new InMemoryVaultRepository([makeVault(options.vault ?? {})])

  const screening = new InMemoryScreeningStore()
  if (options.screening !== null) {
    void screening.put(options.screening ?? makeScreening())
  }

  const messages = new InMemoryMessageSource()
  if (options.seedMessages !== false) {
    // Inside the window that has closed at NOW, i.e. [T0, T0+1800).
    seedWindow(messages, coinRef, Math.floor(nowUnix / 1_800) * 1_800 - 1_800)
  }
  const fleet = new InMemoryFleetCounters()
  const escalations = new InMemoryEscalationSink()
  // THE FIXTURE CLOCK, not the wall clock. settledAtUnix stamps the ledger's
  // disbursement row, and the rolling-window and daily counters are read back
  // against the TICK clock. Leaving this on the default put every disbursement
  // in whatever UTC day the suite happened to run on, which is a different day
  // from the one the gates were reading - so the counters read low and the caps
  // they bound only appeared to hold.
  const settlement = new FakeSettlementPort(options.settlementNowUnix ?? (() => clock.nowUnix()))
  const receipts = new InMemoryReceiptStore()
  const invoices = new InMemoryInvoiceRegistry()
  if (options.withInvoice !== false) seedInvoices(invoices, options.vault?.address ?? VAULT)
  const approvals = new InMemoryApprovalStore()
  const predicates = new InMemoryPredicateQueue()
  const pending = new InMemoryPendingPurchaseStore()

  const script: PlannerScript = { calls: options.plannerCalls ?? QUIET }
  const model = scriptedModel(script)
  const broker = makeBroker()
  const { publisher, channels } = makePublisher(nowUnix)

  const signals = options.signals
  const config: CoinTickerConfig = {
    coinRef,
    vault: VAULT,
    token: TOKEN,
    quoteAsset: USDG,
    userIdSalt: SALT,
    catalog: [
      { id: LISTING_SKU, description: 'listing on a major aggregator', category: 'listing', costBand: 'medium' },
    ],
    linkRefs: [{ id: 'receipts', description: 'this coin’s public receipts page' }],
    linkUrls: new Map([['receipts', `https://receipts.example.test/v/${VAULT}`]]),
    imageRefs: [],
    narrative: null,
    accounts: new Map([['telegram', 'tg-alpha']]),
    relatedPartyOptIn: false,
    sweepIntervalSeconds: 3_600,
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
    messages,
    model,
    ...(signals === null
      ? {}
      : {
          signals: {
            compute: async (): Promise<QualificationSignals> => signals ?? makeSignals(),
          },
        }),
    fleet,
    escalations,
    spend: {
      broker,
      treasury: TREASURY_ACCOUNT,
      invoices,
      approvals,
      settlement,
      receipts,
      predicates,
      pending,
    },
    publish: { publisher },
    ...(options.desk === undefined ? {} : { desk: options.desk }),
  }

  const ticker = new CoinTicker(config, deps, options.vault?.tier ?? 'T1')

  return {
    ticker,
    clock,
    ledger,
    ledgerStore,
    chain,
    assets,
    prices,
    vaults,
    screening,
    messages,
    fleet,
    escalations,
    settlement,
    receipts,
    invoices,
    predicates,
    approvals,
    pending,
    model,
    script,
    broker,
    config,
    deps,
    channels,
  }
}

/**
 * Tick the coin forward over `windows` closed windows, seeding each one.
 *
 * The divergence detector freezes PURCHASES until it has a baseline (six
 * windows by default), which is deliberate: a coin whose first window proposes
 * a purchase has no history to judge that proposal against. Any test that wants
 * to exercise the spend path has to earn the baseline first, exactly as a real
 * coin does.
 */
export async function warmUp(h: Harness, windows = 7): Promise<void> {
  for (let i = 0; i < windows; i += 1) {
    const now = h.clock.nowUnix()
    // A live price feed re-pins continuously. The spend path refuses a price
    // older than 900 seconds, so a book that stops at t=0 refuses every spend.
    h.prices.pin(usdgPrice(now - 30))
    seedWindow(h.messages, h.config.coinRef, Math.floor(now / 1_800) * 1_800 - 1_800)
    await h.ticker.tick()
    h.clock.set(now + 1_800)
  }
  // Leave the caller's next tick with a non-empty window and a fresh price.
  const now = h.clock.nowUnix()
  h.prices.pin(usdgPrice(now - 30))
  seedWindow(h.messages, h.config.coinRef, Math.floor(now / 1_800) * 1_800 - 1_800)
}
