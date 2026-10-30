/**
 * Test fixtures. The default scenario is a healthy T1 client buying a $299
 * Dexscreener-style listing, and it passes every gate. Each test then breaks
 * exactly one thing, so a failure names the gate that caught it.
 */
import type {
  Asset,
  Consent,
  QfMeasurement,
  QualificationSignals,
  ScreeningResult,
  Sku,
  SpendProposal,
  UsdValue,
  Vault,
  Vendor,
} from '@fee-split-vaults/core'
import { SpendBroker } from '../broker.js'
import { VendorCatalog, type CatalogEntry, type RateCard } from '../catalog.js'
import { buildGateContext, type BudgetLedgerView, type GateContext, type SpendCounters, type SpendRequest } from '../context.js'
import { ROLLING_WINDOW_DAYS } from '../limits.js'
import { ceilCentsFromUsd, floorCentsFromUsd } from '../money.js'
import {
  InMemoryPolicyService,
  PolicyKeyring,
  PolicyTokenSigner,
  compiledPolicyLimits,
  verifyPolicyToken,
  type PolicyLimits,
} from '../policy.js'
import { FakeEvidenceSource, PredicateRegistry } from '../predicates.js'
import { SPEND_LIMITS, TERMS, TIERS } from '../protocol.js'
import type { TierId } from '../protocol.js'

export const NOW = 1_788_600_000
export const DAY = 24 * 60 * 60

export const VAULT_ADDRESS = '0x1111111111111111111111111111111111111111'
export const TOKEN_ADDRESS = '0x2222222222222222222222222222222222222222'
export const DEV_PAYOUT = '0x3333333333333333333333333333333333333333'
export const TREASURY_ADDRESS = '0x4444444444444444444444444444444444444444'
export const VENDOR_PAYOUT = '0x5555555555555555555555555555555555555555'
export const USDG_ADDRESS = '0x6666666666666666666666666666666666666666'
export const OTHER_VAULT_ADDRESS = '0x7777777777777777777777777777777777777777'

export const SERVICE_KEY = 'a-service-key-that-is-at-least-32-bytes-long'
export const KEY_ID = 'policy-2026-09'

export function usd(amount: number, pricedAtUnix = NOW - 60): UsdValue {
  return { usd: amount, priceSource: 'test:pinned', pricedAtUnix }
}

/**
 * A USD figure the ledger reads back as EXACTLY this many cents, in both
 * rounding directions.
 *
 * Boundary tests are only worth writing if the boundary is where the test says
 * it is: "one cent over the cap" has to survive the trip through USD and back,
 * and money.ts rounds owed amounts UP, so a value that does not round-trip would
 * quietly land two cents over instead of one. This refuses rather than rounds.
 */
export function usdCents(cents: bigint, pricedAtUnix = NOW - 60): UsdValue {
  const value = usd(Number(cents) / 100, pricedAtUnix)
  if (
    floorCentsFromUsd(value.usd, 'usdCents') !== cents ||
    ceilCentsFromUsd(value.usd, 'usdCents') !== cents
  ) {
    throw new Error(
      `usdCents(${cents}) does not survive the ledger's conversion to cents; pick a representable amount`,
    )
  }
  return value
}

// ---------------------------------------------------------------------------
// THE PREMISE. Every money figure below is derived from the coin's QF, the dev's
// dial and how long the vault has been live, so the fixture describes a coin
// that could actually exist. A ledger that contradicts its own QF is worse than
// an arbitrary one: it reads as a measured fact, and it is a trap for whoever
// tunes a limit against it next.
// ---------------------------------------------------------------------------

/**
 * The default client sits CLEAR of the T1 gate, not on it, so a test that breaks
 * one qualification conjunct fails on that conjunct rather than tripping the
 * gate on its way past. Derived from the gate itself: when TIERS.T1.gateQfPerDay
 * moves, the healthy fixture moves with it.
 */
export const HEALTHY_T1_QF_PER_DAY = Math.round(TIERS.T1.gateQfPerDay * 1.2)

/** Days the default vault has been live. Its all-time fees follow from it. */
export const ACTIVE_DAYS = 50

/**
 * A dial low enough that a catalog line can breach the coin's rolling cap.
 *
 * The cap is rollingCapOfMedian x ROLLING_WINDOW_DAYS x the daily accrual, and
 * the daily accrual is QF x dial. At the default 20% dial that is 1.68 x QF,
 * which on today's numbers is $2,016 - past four listings at the SKU's own
 * maxQuantity - so a cap test written against the default client would not bind.
 * A dev may elect any dial between 0 and TERMS.budgetBpsMax, and at 5% the same
 * coin banks $60/day and carries a $504 cap that a second listing does breach.
 *
 * That is a real client and not a smaller fiction: it still clears the
 * qualification floor, and the cap tests prove it by requiring an approval at
 * the boundary rather than only a refusal past it.
 */
export const LOW_DIAL_BPS = 500

/**
 * What a coin banks in a day: its QF times the dev's procurement dial. Floored
 * to whole cents, which is the direction that understates what may be spent.
 */
export function dailyAccrualUsd(
  qfPerDay: number = HEALTHY_T1_QF_PER_DAY,
  budgetBps: number = TERMS.budgetBpsDefault,
): number {
  return Math.floor(((qfPerDay * budgetBps) / 10_000) * 100) / 100
}

export function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    address: USDG_ADDRESS,
    symbol: 'USDG',
    decimals: 6,
    isPausableProxy: true,
    enabled: true,
    ...overrides,
  }
}

export function makeConsent(overrides: Partial<Consent> = {}): Consent {
  return {
    devSigner: DEV_PAYOUT,
    devPayout: DEV_PAYOUT,
    token: TOKEN_ADDRESS,
    termsHash: '0xterms',
    operatorBps: TERMS.operatorBps,
    budgetBpsMax: TERMS.budgetBpsMax,
    adapter: '0x8888888888888888888888888888888888888888',
    referrer: '0x0000000000000000000000000000000000000000',
    referrerBps: 0,
    expiryUnix: NOW + 30 * DAY,
    nonce: '1',
    ...overrides,
  }
}

export function makeVault(overrides: Partial<Vault> = {}): Vault {
  return {
    address: VAULT_ADDRESS,
    token: TOKEN_ADDRESS,
    consent: makeConsent(),
    state: 'ACTIVE',
    tier: 'T1',
    budgetBps: TERMS.budgetBpsDefault,
    buybackEnabled: false,
    creatorTaxBps: 0,
    deployedAtUnix: NOW - (ACTIVE_DAYS + 10) * DAY,
    activatedAtUnix: NOW - ACTIVE_DAYS * DAY,
    ...overrides,
  }
}

/** Exactly ROLLING_WINDOW_DAYS of banked budget accrual, oldest first. */
export function flatAccrual(perDayUsd = dailyAccrualUsd()): UsdValue[] {
  return Array.from({ length: ROLLING_WINDOW_DAYS }, (_, index) =>
    usd(perDayUsd, NOW - (ROLLING_WINDOW_DAYS - 1 - index) * DAY),
  )
}

/** The facts a ledger is derived from. Everything else is arithmetic on these. */
export interface LedgerPremise {
  /** Quote-denominated creator fees credited to this coin's vault, USD/day. */
  qfPerDay?: number
  /** The dev's procurement dial, in bps of QF. */
  budgetBps?: number
  /** Days since activation. The coin's all-time realized fees follow from it. */
  activeDays?: number
  /** The tier whose modelled cost to serve has been charged to the period. */
  tier?: TierId
}

/**
 * A ledger DERIVED from the premise: this coin's QF, the dev's dial, how long
 * the vault has been live, and the tier being served.
 *
 * Every figure here is that arithmetic and nothing else -
 *   daily accrual   = QF x dial
 *   banked          = the window's accrual, unspent
 *   30-day budget   = 30 days of it, and the sub-cap period is the trailing 30
 *                     days (see periodStartUnix in orchestrator/budget.ts), so
 *                     the period budget is the same figure
 *   realized fees   = QF x days live
 *   cost to serve   = the tier's cogsPerDay across the period, charged FIRST
 * - so a test that moves the QF or the dial can move the money with it instead
 * of leaving a ledger behind that describes some other coin.
 *
 * The client has bought nothing yet: lifetime spend, window spend and category
 * spend are all zero and stay consistent with each other. A test that wants a
 * prior purchase has to say so, and has to say so in every field a purchase
 * touches.
 */
export function makeLedgerFor(
  premise: LedgerPremise = {},
  overrides: Partial<BudgetLedgerView> = {},
): BudgetLedgerView {
  const qfPerDay = premise.qfPerDay ?? HEALTHY_T1_QF_PER_DAY
  const budgetBps = premise.budgetBps ?? TERMS.budgetBpsDefault
  const activeDays = premise.activeDays ?? ACTIVE_DAYS
  const perDay = dailyAccrualUsd(qfPerDay, budgetBps)
  return {
    finalizedBudget: usd(perDay * ROLLING_WINDOW_DAYS),
    // Today's credit, still inside the reorg window. Never spendable.
    unfinalizedBudget: usd(perDay),
    outstandingObligations: usd(0),
    dailyBudgetAccrual: flatAccrual(perDay),
    cumulativeRealizedFees: usd(qfPerDay * activeDays),
    lifetimeSpend: usd(0),
    rollingWindowSpend: usd(0),
    budget30d: usd(perDay * 30),
    periodBudget: usd(perDay * 30),
    inferenceChargedThisPeriod: usd(TIERS[premise.tier ?? 'T1'].cogsPerDay * 30),
    categorySpendThisPeriod: {},
    ...overrides,
  }
}

/**
 * The default client's ledger: makeQf()'s QF at makeVault()'s dial.
 *
 * A test that changes either of those and cares about the money must pass a
 * matching ledger from makeLedgerFor(); the conjunct tests that change the QF
 * and read none of these figures deliberately do not.
 */
export function makeLedger(overrides: Partial<BudgetLedgerView> = {}): BudgetLedgerView {
  return makeLedgerFor({}, overrides)
}

export function makeCounters(overrides: Partial<SpendCounters> = {}): SpendCounters {
  return {
    proposalsLastHourForVault: 0,
    disbursementsTodayForVault: 0,
    disbursementsTodayFleet: 0,
    vendorDisbursementsTodayForVault: 0,
    vendorSpendTodayFleet: usd(0),
    relatedPartySpend30d: usd(0),
    countedAtUnix: NOW - 10,
    ...overrides,
  }
}

export function makeQf(overrides: Partial<QfMeasurement> = {}): QfMeasurement {
  return {
    vault: VAULT_ADDRESS,
    qfPerDay: HEALTHY_T1_QF_PER_DAY,
    observedDays: 14,
    sustainedDays: TIERS.T1.sustainedDays + 3,
    measuredAtUnix: NOW - 3_600,
    perAsset: [],
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

export function makeScreening(overrides: Partial<ScreeningResult> = {}): ScreeningResult {
  return {
    token: TOKEN_ADDRESS,
    verdict: 'CLEAR',
    flags: [],
    stagesRun: ['lexicon', 'trademark'],
    screenedAtUnix: NOW - 3_600,
    paidMediaPermitted: true,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const LISTING_SKU_ID = 'dexscreener.eti'
export const KOL_SKU_ID = 'kolnet.post.mid'
export const OPERATOR_SKU_ID = 'operator.desk.hour'
export const RELATED_SKU_ID = 'affiliate.boost.pack'

export function makeVendor(overrides: Partial<Vendor> = {}): Vendor {
  return {
    id: 'dexscreener',
    displayName: 'Dexscreener',
    payoutAddress: VENDOR_PAYOUT,
    kybVerifiedAtUnix: NOW - 30 * DAY,
    ofacScreenedAtUnix: NOW - 5 * DAY,
    isRelatedParty: false,
    reliabilityScore: 0.9,
    enabled: true,
    ...overrides,
  }
}

function sku(overrides: Partial<Sku> & Pick<Sku, 'id' | 'vendorId'>): Sku {
  return {
    description: 'test sku',
    unitCostUsd: 299,
    category: 'listing',
    predicate: {
      kind: 'eti_listing',
      verifyAtOffsetsSeconds: [DAY],
      params: { chain: '4663', pairSource: 'dexscreener_pairs_api', expectFieldPresent: 'info' },
    },
    availableAtTiers: ['T1', 'T2', 'T3'],
    ...overrides,
  }
}

export function makeEntries(): CatalogEntry[] {
  return [
    {
      sku: sku({ id: LISTING_SKU_ID, vendorId: 'dexscreener' }),
      pricing: 'third_party_pass_through',
      rateCardRef: { vendorId: 'dexscreener', sourceHash: 'card-hash-1' },
      enabled: true,
      observedDeliveries: 10,
      maxQuantity: 4,
    },
    {
      sku: sku({
        id: KOL_SKU_ID,
        vendorId: 'kolnet',
        unitCostUsd: 400,
        category: 'kol',
        predicate: {
          kind: 'kol_post',
          verifyAtOffsetsSeconds: [DAY, 7 * DAY],
          params: { minImpressions24h: 1_000, minImpressions7d: 2_000 },
        },
      }),
      pricing: 'third_party_pass_through',
      rateCardRef: { vendorId: 'kolnet', sourceHash: 'card-hash-2' },
      enabled: true,
      observedDeliveries: 8,
      maxQuantity: 2,
    },
    {
      sku: sku({
        id: OPERATOR_SKU_ID,
        vendorId: 'operator',
        unitCostUsd: 120,
        category: 'moderation',
        predicate: {
          kind: 'manual_attestation',
          verifyAtOffsetsSeconds: [DAY],
          params: {},
        },
      }),
      pricing: 'operator_service',
      publishedRateRef: 'rates/2026-09',
      enabled: true,
      observedDeliveries: 50,
      maxQuantity: 4,
    },
    {
      sku: sku({
        id: RELATED_SKU_ID,
        vendorId: 'affiliate',
        unitCostUsd: 150,
        category: 'boost',
        predicate: {
          kind: 'boost_delta',
          verifyAtOffsetsSeconds: [DAY],
          params: { expectedBoostDelta: 30, rankSnapshotCount: 1, effectWindowSeconds: DAY },
        },
      }),
      pricing: 'third_party_pass_through',
      rateCardRef: { vendorId: 'affiliate', sourceHash: 'card-hash-3' },
      enabled: true,
      observedDeliveries: 5,
      maxQuantity: 2,
    },
  ]
}

export function makeVendors(): Vendor[] {
  return [
    makeVendor(),
    makeVendor({ id: 'kolnet', displayName: 'KOLnet', reliabilityScore: 0.85 }),
    makeVendor({
      id: 'operator',
      displayName: 'Operator desk',
      isRelatedParty: true,
      reliabilityScore: 0.95,
      payoutAddress: undefined,
    }),
    makeVendor({
      id: 'affiliate',
      displayName: 'Operator affiliate',
      isRelatedParty: true,
      reliabilityScore: 0.8,
      payoutAddress: '0x9999999999999999999999999999999999999999',
    }),
  ]
}

export function makeCatalog(
  vendors: Vendor[] = makeVendors(),
  entries: CatalogEntry[] = makeEntries(),
): VendorCatalog {
  return new VendorCatalog(vendors, entries)
}

export function makeRateCards(): RateCard[] {
  return [
    {
      vendorId: 'dexscreener',
      archivedAtUnix: NOW - 3_600,
      sourceUri: 'https://vendor.example/rates',
      sourceHash: 'card-hash-1',
      listPriceUsd: { [LISTING_SKU_ID]: 299 },
    },
    {
      vendorId: 'kolnet',
      archivedAtUnix: NOW - 3_600,
      sourceUri: 'https://kolnet.example/rates',
      sourceHash: 'card-hash-2',
      listPriceUsd: { [KOL_SKU_ID]: 400 },
    },
    {
      vendorId: 'affiliate',
      archivedAtUnix: NOW - 3_600,
      sourceUri: 'https://affiliate.example/rates',
      sourceHash: 'card-hash-3',
      listPriceUsd: { [RELATED_SKU_ID]: 150 },
    },
  ]
}

// ---------------------------------------------------------------------------
// Policy and broker wiring
// ---------------------------------------------------------------------------

export function makeKeyring(): PolicyKeyring {
  return new PolicyKeyring({ [KEY_ID]: SERVICE_KEY })
}

export function makeSigner(keyring = makeKeyring()): PolicyTokenSigner {
  return new PolicyTokenSigner(keyring, KEY_ID)
}

export function makePolicyService(
  signer: PolicyTokenSigner,
  options: { limits?: Partial<PolicyLimits>; spendEnabled?: boolean; ttlSeconds?: number } = {},
): InMemoryPolicyService {
  const template: {
    tier: 'T1'
    enabledAssets: string[]
    spendEnabled?: boolean
    limits?: Partial<PolicyLimits>
    ttlSeconds?: number
  } = { tier: 'T1', enabledAssets: [USDG_ADDRESS] }
  if (options.spendEnabled !== undefined) template.spendEnabled = options.spendEnabled
  if (options.limits !== undefined) template.limits = options.limits
  if (options.ttlSeconds !== undefined) template.ttlSeconds = options.ttlSeconds
  return new InMemoryPolicyService(signer, template)
}

export function makePredicates(evidence = new FakeEvidenceSource()): PredicateRegistry {
  return new PredicateRegistry(evidence)
}

export function makeProposal(overrides: Partial<SpendProposal> = {}): SpendProposal {
  return {
    vault: VAULT_ADDRESS,
    skuId: LISTING_SKU_ID,
    quantity: 1,
    rationale: 'listing improves discoverability for holders asking how to buy',
    proposedAtUnix: NOW - 5,
    ...overrides,
  }
}

export function makeRequest(overrides: Partial<SpendRequest> = {}): SpendRequest {
  return {
    proposal: makeProposal(),
    vault: makeVault(),
    asset: makeAsset(),
    ledger: makeLedger(),
    qf: makeQf(),
    signals: makeSignals(),
    screening: makeScreening(),
    counters: makeCounters(),
    relatedPartyOptIn: false,
    ...overrides,
  }
}

/**
 * The same healthy client at the low dial, ledger derived from that dial.
 *
 * This is the fixture the rolling-cap tests run on, because the cap scales with
 * the dial and the default client's cap is out of reach of the catalog. Nothing
 * else about the coin changes, and it still clears the qualification floor.
 */
export function makeLowDialRequest(
  ledgerOverrides: Partial<BudgetLedgerView> = {},
  requestOverrides: Partial<SpendRequest> = {},
): SpendRequest {
  return makeRequest({
    vault: makeVault({ budgetBps: LOW_DIAL_BPS }),
    ledger: makeLedgerFor({ budgetBps: LOW_DIAL_BPS }, ledgerOverrides),
    ...requestOverrides,
  })
}

export function makeBroker(
  options: {
    catalog?: VendorCatalog
    policyService?: InMemoryPolicyService
    keyring?: PolicyKeyring
    predicates?: PredicateRegistry
  } = {},
): SpendBroker {
  const keyring = options.keyring ?? makeKeyring()
  const policyService = options.policyService ?? makePolicyService(makeSigner(keyring))
  return new SpendBroker({
    catalog: options.catalog ?? makeCatalog(),
    policyService,
    keyring,
    predicates: options.predicates ?? makePredicates(),
  })
}

/** Mints a token with the compiled ceiling, optionally tightened. */
export function signerToken(
  signer: PolicyTokenSigner,
  vault: string,
  nowUnix: number,
  options: {
    limits?: Partial<PolicyLimits>
    tier?: 'T0' | 'T1' | 'T2' | 'T3'
    spendEnabled?: boolean
    ttlSeconds?: number
    enabledAssets?: string[]
  } = {},
): string {
  return signer.sign({
    v: 1,
    vault,
    tier: options.tier ?? 'T1',
    spendEnabled: options.spendEnabled ?? true,
    enabledAssets: options.enabledAssets ?? [USDG_ADDRESS],
    limits: { ...compiledPolicyLimits(), ...options.limits },
    issuedAtUnix: nowUnix,
    expiresAtUnix: nowUnix + (options.ttlSeconds ?? SPEND_LIMITS.policyTokenTtlSeconds),
    nonce: `${vault}:${nowUnix}`,
  })
}

/** Builds a gate context directly, for tests that exercise the pure chain. */
export function makeContext(
  request: SpendRequest = makeRequest(),
  options: {
    catalog?: VendorCatalog
    nowUnix?: number
    limits?: Partial<PolicyLimits>
    tier?: 'T0' | 'T1' | 'T2' | 'T3'
  } = {},
): GateContext {
  const nowUnix = options.nowUnix ?? NOW
  const keyring = makeKeyring()
  const signer = makeSigner(keyring)
  const tokenOptions: { limits?: Partial<PolicyLimits>; tier?: 'T0' | 'T1' | 'T2' | 'T3' } = {}
  if (options.limits !== undefined) tokenOptions.limits = options.limits
  tokenOptions.tier = options.tier ?? request.vault.tier
  const token = signerToken(signer, request.vault.address, nowUnix, tokenOptions)
  const policy = verifyPolicyToken(token, keyring, request.vault.address, nowUnix)
  return buildGateContext(
    request,
    policy,
    options.catalog ?? makeCatalog(),
    makePredicates().kinds,
    nowUnix,
  )
}
