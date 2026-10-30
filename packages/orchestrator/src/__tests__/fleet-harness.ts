/**
 * A FLEET of whole coins, wired end to end from real packages.
 *
 * harness.ts builds one coin against constants. This builds N coins that SHARE
 * exactly the things a real deployment shares and nothing else, because sharing
 * is where isolation is actually tested:
 *
 *   shared, as in production   the ledger store (rows scoped by vault), the
 *                              chain read model (rows scoped by vault), the
 *                              asset registry, the price book, the vault
 *                              repository, the screening store, the receipt
 *                              store, the fleet spend counters, the escalation
 *                              sink, the settlement port, the broker, the
 *                              publisher, and the one stateless ModelClient.
 *   per coin, by construction  the CoinTicker, its CoinRuntime, its cost
 *                              governor, its divergence detector, its message
 *                              source, its hashed user id, its budget leg.
 *
 * If any per-coin thing were reachable through a shared thing, these fixtures
 * would show it, because every shared object here is the REAL one.
 */

import type {
  Address,
  Asset,
  AssetAddress,
  Consent,
  QualificationSignals,
  ScreeningResult,
  Vault,
} from '@fee-split-vaults/core'
import type { SpendBroker } from '@fee-split-vaults/broker'
import { InMemoryLedgerStore, Ledger } from '@fee-split-vaults/ledger'
import type { CoinBinding, FeePosting, HaltNotice } from '@fee-split-vaults/indexer'
import {
  FakeModelClient,
  toolUseReply,
  type ModelContentBlock,
  type ModelRequest,
  type RawMessage,
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
  type Publisher,
} from '@fee-split-vaults/publisher'

import { TERMS, TIERS } from '../../../../config/protocol.js'
import type { TierId } from '../../../../config/protocol.js'
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
import type { SkuCategory } from '@fee-split-vaults/broker'
import { InMemoryFleetCounters, Orchestrator } from '../fleet.js'
import { InMemoryPriceBook } from '../prices.js'
import { InMemoryReceiptStore } from '../receipts.js'
import {
  fixedClock,
  type AllocationObservation,
  type ChainReadModel,
  type ClaimObservation,
  type FleetCounters,
  type FleetDisbursementRecord,
  type MessageSource,
} from '../ports.js'

import {
  DAY,
  LISTING_SKU,
  NOW,
  READER_EMISSION,
  SALT,
  TREASURY_ACCOUNT,
  USDG,
  makeAsset,
  makeBroker,
  seedInvoices,
  settlementsFor,
  usdgPrice,
} from './harness.js'

export { DAY, LISTING_SKU, NOW, SALT, TREASURY, USDG, VENDOR_PAYOUT, usdgPrice } from './harness.js'

/** A 20-byte address built from a two-nibble tag, so coins are visibly distinct. */
export function addressFrom(tag: string): Address {
  if (!/^[0-9a-f]{2}$/.test(tag)) throw new Error('tag must be two lowercase hex digits')
  return `0x${tag.repeat(20)}` as Address
}

export interface CoinSpec {
  coinRef: string
  /** Two lowercase hex digits. Derives the vault, token and dev payout. */
  tag: string
  ticker: string
  tier?: TierId
  /** Dollars of credited fees per day. Defaults to the T1 gate. */
  usdPerDay?: number
  days?: number
  /** False models fees that accrued but were never claimed or split. */
  settle?: boolean
  /** null puts no screening on file at all. */
  screening?: ScreeningResult | null
  /** null omits the signals provider entirely. */
  signals?: QualificationSignals | null
  seedMessages?: boolean
  relatedPartyOptIn?: boolean
}

export interface CoinFixture {
  spec: Required<Pick<CoinSpec, 'coinRef' | 'ticker'>> & CoinSpec
  coinRef: string
  vault: Address
  token: Address
  accountId: string
  config: CoinTickerConfig
  deps: CoinTickerDeps
  ticker: CoinTicker
  messages: InMemoryMessageSource
  /** Mutable: assign to change what the planner says on the next window. */
  script: CoinScript
  chain: FaultInjectingChain
  fleet: FaultInjectingCounters
  postings: FeePosting[]
  /**
   * Extra rows added to EVERY prepared window, once each.
   *
   * A window whose volume or topic mix differs from the seven that warmed the
   * baseline trips the divergence detector, and a frozen window never calls the
   * planner. Any test that needs the planner to run on hostile input therefore
   * has to make that input the NORM, which is also the more realistic shape: a
   * channel that is persistently spammed rather than spammed once.
   */
  perWindow?: (windowStart: number) => RawMessage[]
}

export interface CoinScript {
  planner: Array<{ name: string; input: unknown }>
  /** Raw JSON text the reader emits. Default is a well-behaved emission. */
  reader?: (request: ModelRequest) => string
}

export const QUIET_PLAN: Array<{ name: string; input: unknown }> = [
  { name: 'propose_no_action', input: { reason: 'quiet window' } },
]

// ---------------------------------------------------------------------------
// Fault injection: real ports with a switch, never a stub that returns nothing
// ---------------------------------------------------------------------------

/**
 * Delegates to the shared chain read model, and can be told to throw.
 *
 * A throwing dependency is the realistic failure - an RPC quorum that cannot
 * agree, a store that is down - and the point of injecting it here rather than
 * mocking the ticker is that the tick's own try/catch structure is what decides
 * whether the fleet survives it.
 */
export class FaultInjectingChain implements ChainReadModel {
  failBinding = false
  failPostings = false
  failHalts = false
  failClaims = false

  constructor(private readonly inner: ChainReadModel) {}

  async binding(token: Address): Promise<CoinBinding | undefined> {
    if (this.failBinding) throw new Error('chain: binding read failed')
    return this.inner.binding(token)
  }

  async postings(
    vault: Address,
    fromUnix: number,
    toUnix: number,
  ): Promise<readonly FeePosting[]> {
    if (this.failPostings) throw new Error('chain: posting store unreachable')
    return this.inner.postings(vault, fromUnix, toUnix)
  }

  async halts(token: Address): Promise<readonly HaltNotice[]> {
    if (this.failHalts) throw new Error('chain: halt read failed')
    return this.inner.halts(token)
  }

  async claims(
    vault: Address,
    fromUnix: number,
    toUnix: number,
  ): Promise<readonly ClaimObservation[]> {
    if (this.failClaims) throw new Error('chain: claim read failed')
    return this.inner.claims(vault, fromUnix, toUnix)
  }

  async allocations(
    vault: Address,
    fromUnix: number,
    toUnix: number,
  ): Promise<readonly AllocationObservation[]> {
    return this.inner.allocations(vault, fromUnix, toUnix)
  }
}

export type CounterMethod =
  | 'disbursementsToday'
  | 'vendorSpendTodayCents'
  | 'vendorDisbursementsTodayForVault'
  | 'proposalsLastHour'
  | 'disbursementsTodayForVault'
  | 'relatedPartySpend30dCents'
  | 'categorySpend30dCents'

/**
 * The shared counters, with a switch that makes one READ throw.
 *
 * This is the fail-closed case the fleet's own doc comment names: a counter
 * store that cannot be reached must throw, because a confident zero opens every
 * cap that counter bounds.
 */
export class FaultInjectingCounters implements FleetCounters {
  readonly failing = new Set<CounterMethod>()

  constructor(private readonly inner: FleetCounters) {}

  #guard(method: CounterMethod): void {
    if (this.failing.has(method)) throw new Error(`fleet counters: ${method} unreachable`)
  }

  async disbursementsToday(nowUnix: number): Promise<number> {
    this.#guard('disbursementsToday')
    return this.inner.disbursementsToday(nowUnix)
  }

  async disbursementsTodayForVault(vault: Address, nowUnix: number): Promise<number> {
    this.#guard('disbursementsTodayForVault')
    return this.inner.disbursementsTodayForVault(vault, nowUnix)
  }

  async vendorSpendTodayCents(vendorId: string, nowUnix: number): Promise<bigint> {
    this.#guard('vendorSpendTodayCents')
    return this.inner.vendorSpendTodayCents(vendorId, nowUnix)
  }

  async vendorDisbursementsTodayForVault(
    vault: Address,
    vendorId: string,
    nowUnix: number,
  ): Promise<number> {
    this.#guard('vendorDisbursementsTodayForVault')
    return this.inner.vendorDisbursementsTodayForVault(vault, vendorId, nowUnix)
  }

  async proposalsLastHour(vault: Address, nowUnix: number): Promise<number> {
    this.#guard('proposalsLastHour')
    return this.inner.proposalsLastHour(vault, nowUnix)
  }

  async relatedPartySpend30dCents(vault: Address, nowUnix: number): Promise<bigint> {
    this.#guard('relatedPartySpend30dCents')
    return this.inner.relatedPartySpend30dCents(vault, nowUnix)
  }

  async categorySpend30dCents(
    vault: Address,
    nowUnix: number,
  ): Promise<Partial<Record<SkuCategory, bigint>>> {
    this.#guard('categorySpend30dCents')
    return this.inner.categorySpend30dCents(vault, nowUnix)
  }

  async recordDisbursement(entry: FleetDisbursementRecord): Promise<void> {
    return this.inner.recordDisbursement(entry)
  }

  async recordProposal(vault: Address, atUnix: number): Promise<void> {
    return this.inner.recordProposal(vault, atUnix)
  }
}

/**
 * A message source that hands one coin ANOTHER coin's messages.
 *
 * The in-memory source refuses this itself, which is correct but means a test
 * built on it can never reach the runtime's own boundary. This one lies, so the
 * assembler's binding check is what has to catch it.
 */
export class BleedingMessageSource implements MessageSource {
  constructor(private readonly rows: readonly RawMessage[]) {}

  async since(_coinRef: string, fromUnix: number, toUnix: number): Promise<readonly RawMessage[]> {
    return this.rows.filter((m) => m.postedAtUnix >= fromUnix && m.postedAtUnix < toUnix)
  }
}

// ---------------------------------------------------------------------------
// Per-coin fixtures
// ---------------------------------------------------------------------------

function consentFor(devPayout: Address, token: Address, expiryUnix: number): Consent {
  return {
    devSigner: devPayout,
    devPayout,
    token,
    termsHash: '0xterms',
    operatorBps: TERMS.operatorBps,
    budgetBpsMax: TERMS.budgetBpsMax,
    adapter: addressFrom('88'),
    referrer: addressFrom('00'),
    referrerBps: 0,
    expiryUnix,
    nonce: '1',
  }
}

export function vaultFor(spec: CoinSpec, nowUnix: number): Vault {
  const vault = addressFrom(spec.tag)
  const token = addressFrom(tokenTag(spec.tag))
  const devPayout = addressFrom(devTag(spec.tag))
  return {
    address: vault,
    token,
    consent: consentFor(devPayout, token, nowUnix + 30 * DAY),
    state: 'ACTIVE',
    tier: spec.tier ?? 'T1',
    budgetBps: TERMS.budgetBpsDefault,
    buybackEnabled: false,
    creatorTaxBps: 0,
    deployedAtUnix: nowUnix - 60 * DAY,
    activatedAtUnix: nowUnix - 50 * DAY,
  }
}

function tokenTag(tag: string): string {
  return `${tag[1] ?? '0'}${tag[0] ?? '0'}`
}

function devTag(tag: string): string {
  return `${tag[0] ?? '0'}e`
}

export function bindingFor(spec: CoinSpec, nowUnix: number): CoinBinding {
  return {
    token: addressFrom(tokenTag(spec.tag)),
    vault: addressFrom(spec.tag),
    curve: addressFrom('77'),
    poolId: `0xpool${spec.tag.repeat(29)}`,
    quoteAsset: USDG,
    launchedAtUnix: nowUnix - 60 * DAY,
    launchBlockNumber: 1_000n,
    buybackEnabled: false,
    creatorTaxBps: 0,
    coverageStartUnix: nowUnix - 60 * DAY,
  }
}

export function screeningFor(spec: CoinSpec, nowUnix: number): ScreeningResult {
  return {
    token: addressFrom(tokenTag(spec.tag)),
    verdict: 'CLEAR',
    flags: [],
    stagesRun: ['lexicon', 'trademark'],
    screenedAtUnix: nowUnix - 3_600,
    paidMediaPermitted: true,
  }
}

export function signalsFor(overrides: Partial<QualificationSignals> = {}): QualificationSignals {
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

/** One posting per day for one coin. Ids are namespaced so a SHARED chain
 *  read model holds both coins' rows without either one shadowing the other. */
export function postingsFor(spec: CoinSpec, nowUnix: number): FeePosting[] {
  const days = spec.days ?? 14
  const usdPerDay = spec.usdPerDay ?? TIERS.T1.gateQfPerDay
  const vault = addressFrom(spec.tag)
  const token = addressFrom(tokenTag(spec.tag))
  const out: FeePosting[] = []
  for (let i = 0; i < days; i += 1) {
    const dayIndex = Math.floor(nowUnix / DAY) - days + i
    const at = dayIndex * DAY + 3_600
    if (usdPerDay <= 0) continue
    const txHash = `0x${spec.tag}${String(i).padStart(60, '0')}`
    out.push({
      id: `${txHash}:0`,
      vault,
      token,
      asset: USDG,
      creditedMinor: BigInt(Math.round(usdPerDay * 1_000_000)),
      grossFeeMinor: BigInt(Math.round(usdPerDay * 1_000_000)),
      derivation: 'explicit',
      volumeMinor: 0n,
      source: 'pool_fees_swept',
      phase: 'post_graduation',
      classification: 'trade',
      side: 'sweep',
      blockNumber: BigInt(1_000 + i),
      blockHash: `0x${spec.tag}${'b'.repeat(61)}${i.toString(16)}`,
      txHash,
      logIndex: 0,
      occurredAtUnix: at,
      finalized: true,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// The fleet
// ---------------------------------------------------------------------------

export interface FleetHarness {
  orchestrator: Orchestrator
  clock: ReturnType<typeof fixedClock>
  ledger: Ledger
  ledgerStore: InMemoryLedgerStore
  chainStore: InMemoryChainReadModel
  assets: InMemoryAssetRegistry
  prices: InMemoryPriceBook
  vaults: InMemoryVaultRepository
  screening: InMemoryScreeningStore
  fleetCounters: InMemoryFleetCounters
  escalations: InMemoryEscalationSink
  settlement: FakeSettlementPort
  receipts: InMemoryReceiptStore
  invoices: InMemoryInvoiceRegistry
  predicates: InMemoryPredicateQueue
  approvals: InMemoryApprovalStore
  pending: InMemoryPendingPurchaseStore
  model: FakeModelClient
  broker: SpendBroker
  publisher: Publisher
  coins: Map<string, CoinFixture>
  coin(coinRef: string): CoinFixture
  /** Register one more coin into the SAME shared state. */
  add(spec: CoinSpec): CoinFixture
  /**
   * Rebuild every ticker from the persisted stores, as a process restart does.
   * Returns a fleet holding the same shared objects and brand-new tickers.
   */
  restart(): FleetHarness
  /** Re-pin the price and seed the closed window for every coin. */
  prepareWindow(): void
  warmUp(windows?: number): Promise<void>
}

export interface FleetOptions {
  nowUnix?: number
  coins?: CoinSpec[]
  /** Applied to the InMemoryAssetRegistry. */
  assetEnabled?: boolean
  withInvoice?: boolean
}

export const ALPHA: CoinSpec = { coinRef: 'coin_alpha', tag: 'a1', ticker: 'ALPHA' }
export const BETA: CoinSpec = { coinRef: 'coin_beta', tag: 'b2', ticker: 'BETA' }

export function makeFleet(options: FleetOptions = {}): FleetHarness {
  const nowUnix = options.nowUnix ?? NOW
  const specs = options.coins ?? [ALPHA, BETA]
  const shared = makeSharedState(nowUnix, options)
  return buildFleet(shared, specs, nowUnix, options)
}

interface SharedState {
  clock: ReturnType<typeof fixedClock>
  ledgerStore: InMemoryLedgerStore
  ledger: Ledger
  assets: InMemoryAssetRegistry
  prices: InMemoryPriceBook
  chainStore: InMemoryChainReadModel
  vaults: InMemoryVaultRepository
  screening: InMemoryScreeningStore
  fleetCounters: InMemoryFleetCounters
  escalations: InMemoryEscalationSink
  settlement: FakeSettlementPort
  receipts: InMemoryReceiptStore
  invoices: InMemoryInvoiceRegistry
  predicates: InMemoryPredicateQueue
  /** One batch of invoices is seeded per vault as each coin registers. */
  withInvoice: boolean
  approvals: InMemoryApprovalStore
  pending: InMemoryPendingPurchaseStore
  broker: SpendBroker
  publisher: Publisher
  accounts: ReturnType<typeof createInMemoryAccountRegistry>
  scripts: Map<string, CoinScript>
  model: FakeModelClient
  messages: Map<string, InMemoryMessageSource>
  seeded: Set<string>
}

function makeSharedState(nowUnix: number, options: FleetOptions): SharedState {
  const clock = fixedClock(nowUnix)
  const ledgerStore = new InMemoryLedgerStore()
  const ledger = new Ledger(ledgerStore, { now: () => clock.nowUnix() })

  const assetOverrides: Partial<Asset> = options.assetEnabled === false ? { enabled: false } : {}
  const assets = new InMemoryAssetRegistry([makeAsset(assetOverrides)])
  const prices = new InMemoryPriceBook(
    Array.from({ length: 61 }, (_, i) => usdgPrice(nowUnix - (60 - i) * DAY)),
  )

  const invoices = new InMemoryInvoiceRegistry()

  const accounts = createInMemoryAccountRegistry()
  const publisherClock = createFixedClock(nowUnix)
  const channels = createFakeChannelSet({
    operatorName: 'Venue Agency Ltd',
    nowUnix: () => publisherClock.nowUnix(),
  })
  const publisher = createPublisher({
    policy: {
      operatorName: 'Venue Agency Ltd',
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
    scheduler: createManualScheduler(publisherClock),
    clock: publisherClock,
  })

  const scripts = new Map<string, CoinScript>()
  const model = new FakeModelClient((request: ModelRequest): ScriptedReply => {
    const coinRef = (request.traceId ?? '').split(':')[0] ?? ''
    const script = scripts.get(coinRef)
    if (script === undefined) {
      throw new Error(`fleet model: no script registered for "${coinRef}"`)
    }
    if (request.tools === undefined) {
      const text = script.reader?.(request) ?? READER_EMISSION
      const content: ModelContentBlock[] = [{ type: 'text', text }]
      return { content, stopReason: 'end_turn' }
    }
    return toolUseReply(script.planner)
  })

  return {
    clock,
    ledgerStore,
    ledger,
    assets,
    prices,
    chainStore: new InMemoryChainReadModel(),
    vaults: new InMemoryVaultRepository(),
    screening: new InMemoryScreeningStore(),
    fleetCounters: new InMemoryFleetCounters(),
    escalations: new InMemoryEscalationSink(),
    settlement: new FakeSettlementPort(() => clock.nowUnix()),
    receipts: new InMemoryReceiptStore(),
    invoices,
    predicates: new InMemoryPredicateQueue(),
    withInvoice: options.withInvoice !== false,
    approvals: new InMemoryApprovalStore(),
    pending: new InMemoryPendingPurchaseStore(),
    broker: makeBroker(),
    publisher,
    accounts,
    scripts,
    model,
    messages: new Map(),
    seeded: new Set(),
  }
}

function buildFleet(
  shared: SharedState,
  specs: readonly CoinSpec[],
  nowUnix: number,
  options: FleetOptions,
): FleetHarness {
  const orchestrator = new Orchestrator()
  const coins = new Map<string, CoinFixture>()

  const harness: FleetHarness = {
    orchestrator,
    clock: shared.clock,
    ledger: shared.ledger,
    ledgerStore: shared.ledgerStore,
    chainStore: shared.chainStore,
    assets: shared.assets,
    prices: shared.prices,
    vaults: shared.vaults,
    screening: shared.screening,
    fleetCounters: shared.fleetCounters,
    escalations: shared.escalations,
    settlement: shared.settlement,
    receipts: shared.receipts,
    invoices: shared.invoices,
    predicates: shared.predicates,
    approvals: shared.approvals,
    pending: shared.pending,
    model: shared.model,
    broker: shared.broker,
    publisher: shared.publisher,
    coins,
    coin(coinRef: string): CoinFixture {
      const found = coins.get(coinRef)
      if (found === undefined) throw new Error(`no coin fixture for ${coinRef}`)
      return found
    },
    add(spec: CoinSpec): CoinFixture {
      const fixture = registerCoin(shared, orchestrator, spec, nowUnix)
      coins.set(spec.coinRef, fixture)
      return fixture
    },
    restart(): FleetHarness {
      // Everything in `shared` is the persisted state. The tickers, their
      // runtimes, governors, detectors and in-process cursors are not.
      return buildFleet(shared, specs, nowUnix, options)
    },
    prepareWindow(): void {
      const now = shared.clock.nowUnix()
      shared.prices.pin(usdgPrice(now - 30))
      const windowStart = Math.floor(now / 1_800) * 1_800 - 1_800
      for (const [coinRef, fixture] of coins) {
        if (fixture.spec.seedMessages !== false) seedWindowFor(shared, coinRef, windowStart)
        if (fixture.perWindow === undefined) continue
        const key = `${coinRef}:${String(windowStart)}:extra`
        if (shared.seeded.has(key)) continue
        shared.seeded.add(key)
        fixture.messages.add(...fixture.perWindow(windowStart))
      }
    },
    async warmUp(windows = 7): Promise<void> {
      for (let i = 0; i < windows; i += 1) {
        const now = shared.clock.nowUnix()
        harness.prepareWindow()
        await orchestrator.tickAll(now)
        shared.clock.set(now + 1_800)
      }
      harness.prepareWindow()
    },
  }

  for (const spec of specs) harness.add(spec)
  return harness
}

/** Six ordinary questions inside one window, seeded once per (coin, window). */
export function seedWindowFor(
  shared: { messages: Map<string, InMemoryMessageSource>; seeded: Set<string> },
  coinRef: string,
  windowStart: number,
  count = 6,
): void {
  const key = `${coinRef}:${String(windowStart)}`
  if (shared.seeded.has(key)) return
  shared.seeded.add(key)
  const source = shared.messages.get(coinRef)
  if (source === undefined) return
  for (let i = 0; i < count; i += 1) {
    source.add({
      sourceId: `${key}-${String(i)}`,
      authorId: `holder-${String(i)}`,
      text: 'how do I buy this and where is the contract listed',
      postedAtUnix: windowStart + 60 * i,
      origin: 'telegram',
      boundCoinRef: coinRef,
    })
  }
}

function registerCoin(
  shared: SharedState,
  orchestrator: Orchestrator,
  spec: CoinSpec,
  nowUnix: number,
): CoinFixture {
  const vaultAddress = addressFrom(spec.tag)
  const token = addressFrom(tokenTag(spec.tag))
  const accountId = `tg-${spec.coinRef}`

  // Chain + vault + screening rows land in the SHARED stores, once. A restart
  // must not re-seed them, or the "no double-claim" assertion would be testing
  // the fixture instead of the ledger.
  const already = shared.messages.has(spec.coinRef)
  const postings = postingsFor(spec, nowUnix)
  if (!already) {
    shared.chainStore.putBinding(bindingFor(spec, nowUnix))
    shared.chainStore.putPostings(...postings)
    if (spec.settle !== false) {
      const { claims, allocations } = settlementsFor(postings)
      for (const claim of claims) shared.chainStore.putClaim(claim)
      for (const allocation of allocations) shared.chainStore.putAllocation(allocation)
    }
    void shared.vaults.put(vaultFor(spec, nowUnix))
    // Keyed by vault, not coinRef: a clone coin aimed at a ticked vault must
    // be refused by the orchestrator, not tripped up by a duplicate invoice.
    if (shared.withInvoice && !shared.seeded.has(`invoices:${vaultAddress}`)) {
      shared.seeded.add(`invoices:${vaultAddress}`)
      seedInvoices(shared.invoices, vaultAddress)
    }
    if (spec.screening !== null) {
      void shared.screening.put(spec.screening ?? screeningFor(spec, nowUnix))
    }
    shared.accounts.bind({
      accountId,
      coinRef: spec.coinRef,
      channel: 'telegram',
      vault: vaultAddress,
      token,
      ticker: spec.ticker,
      delegated: false,
    })
    shared.messages.set(spec.coinRef, new InMemoryMessageSource())
    shared.scripts.set(spec.coinRef, { planner: [...QUIET_PLAN] })
  }

  const messages = shared.messages.get(spec.coinRef) as InMemoryMessageSource
  const script = shared.scripts.get(spec.coinRef) as CoinScript
  const chain = new FaultInjectingChain(shared.chainStore)
  const fleet = new FaultInjectingCounters(shared.fleetCounters)

  const config: CoinTickerConfig = {
    coinRef: spec.coinRef,
    vault: vaultAddress,
    token,
    quoteAsset: USDG,
    userIdSalt: SALT,
    catalog: [
      {
        id: LISTING_SKU,
        description: 'listing on a major aggregator',
        category: 'listing',
        costBand: 'medium',
      },
    ],
    linkRefs: [{ id: 'receipts', description: 'this coin’s public receipts page' }],
    linkUrls: new Map([['receipts', `https://receipts.example.test/v/${vaultAddress}`]]),
    imageRefs: [],
    narrative: null,
    accounts: new Map([['telegram', accountId]]),
    relatedPartyOptIn: spec.relatedPartyOptIn ?? false,
    sweepIntervalSeconds: 3_600,
  }

  const deps: CoinTickerDeps = {
    clock: shared.clock,
    chain,
    ledger: shared.ledger,
    ledgerStore: shared.ledgerStore,
    assets: shared.assets,
    prices: shared.prices,
    vaults: shared.vaults,
    screening: shared.screening,
    messages,
    model: shared.model,
    ...(spec.signals === null
      ? {}
      : {
          signals: {
            compute: async (): Promise<QualificationSignals> =>
              spec.signals ?? signalsFor(),
          },
        }),
    fleet,
    escalations: shared.escalations,
    spend: {
      broker: shared.broker,
      treasury: TREASURY_ACCOUNT,
      invoices: shared.invoices,
      approvals: shared.approvals,
      settlement: shared.settlement,
      receipts: shared.receipts,
      predicates: shared.predicates,
      pending: shared.pending,
    },
    publish: { publisher: shared.publisher },
  }

  const ticker = orchestrator.register(config, deps, spec.tier ?? 'T1')

  return {
    spec: spec as CoinFixture['spec'],
    coinRef: spec.coinRef,
    vault: vaultAddress,
    token,
    accountId,
    config,
    deps,
    ticker,
    messages,
    script,
    chain,
    fleet,
    postings,
  }
}

/** The purchase plan. The rationale is advisory text, never parsed for a value. */
export function purchasePlan(
  quantity = 1,
  rationale = 'a listing answers the how-to-buy backlog',
): Array<{ name: string; input: unknown }> {
  return [{ name: 'propose_purchase', input: { skuId: LISTING_SKU, quantity, rationale } }]
}

/** USD cents the ledger records against a vault's budget leg. */
export async function budgetMinor(
  ledger: Ledger,
  vault: Address,
  asset: AssetAddress = USDG,
): Promise<bigint> {
  return -(await ledger.balanceOf(vault, asset, 'liability:budget'))
}
