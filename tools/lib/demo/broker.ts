/**
 * demo broker - the deterministic spend gate.
 *
 * WHAT A VIEWER SHOULD TAKE AWAY. This is the only component that decides
 * whether money moves, and there is no model anywhere in it. Every decision is
 * an ordered chain of pure functions over integer cents, so a disputed spend can
 * be replayed from the audit log and re-adjudicated by someone who does not
 * trust the operator.
 *
 * Each scene below breaks exactly ONE thing about an otherwise healthy client,
 * and the report names the gate that caught it and the arithmetic it used. The
 * client is the same coin throughout, and every money figure is derived from its
 * qualified fee, the dev's dial and how long the vault has been live - a ledger
 * that contradicts its own premise reads as a measured fact and is a trap for
 * whoever tunes a limit against it next.
 *
 * NOTE THE ASYMMETRY THAT MAKES THIS SURVIVABLE: the planner selects a catalog
 * id and a quantity. The broker prices it. No method here accepts a payee, an
 * address, an amount, or free text that is later parsed for one, so a fully
 * compromised cognition plane can pick the wrong SKU and nothing else.
 */

import type {
  Asset,
  Consent,
  QfMeasurement,
  QualificationSignals,
  ScreeningResult,
  Sku,
  SpendDecision,
  SpendProposal,
  UsdValue,
  Vault,
  Vendor,
} from '@fee-split-vaults/core'
import {
  CATEGORY_SUBCAP_BPS,
  FakeEvidenceSource,
  GATE_NAMES,
  InMemoryPolicyService,
  PolicyKeyring,
  PolicyTokenSigner,
  PredicateRegistry,
  ROLLING_WINDOW_DAYS,
  SpendBroker,
  VendorCatalog,
  type BudgetLedgerView,
  type CatalogEntry,
  type SpendCounters,
  type SpendRequest,
} from '@fee-split-vaults/broker'
import {
  QUALIFICATION_FLOOR_MONTHLY_USD,
  SPEND_LIMITS,
  TERMS,
  TIERS,
} from '../../../config/protocol.ts'
import { table, usd } from '../format.ts'
import {
  AFFILIATE_PAYOUT,
  COIN,
  DAY,
  NOW,
  OPERATOR_TREASURY,
  VENUE_ADAPTER,
  QUOTE_ASSET,
  VENDOR_PAYOUT,
} from './fixtures.ts'
import { ok, refused, summarise, type DemoResult, type Pair, type Scene } from './render.ts'

/** Obviously not a real key. The signer needs 32 bytes; this is 44 of them. */
const SERVICE_KEY = 'demo-only-policy-service-key-not-a-secret-01'
const KEY_ID = 'policy-2026-09'

// ---------------------------------------------------------------------------
// THE PREMISE. Everything below is arithmetic on these four numbers.
// ---------------------------------------------------------------------------

/** Clear of the T1 gate, not sitting on it, so a broken conjunct is visible. */
const HEALTHY_QF_PER_DAY = Math.round(TIERS.T1.gateQfPerDay * 1.2)
const ACTIVE_DAYS = 50

function usdAt(amount: number, pricedAtUnix = NOW - 60): UsdValue {
  return { usd: amount, priceSource: 'demo:pinned', pricedAtUnix }
}

/** What the coin banks in a day: its QF times the dev's dial, floored to cents. */
function dailyAccrualUsd(qfPerDay: number, budgetBps: number): number {
  return Math.floor(((qfPerDay * budgetBps) / 10_000) * 100) / 100
}

interface Premise {
  qfPerDay?: number
  budgetBps?: number
  activeDays?: number
}

/**
 * A ledger DERIVED from the premise. Nothing here is a free parameter:
 *   daily accrual = QF x dial
 *   banked        = the rolling window's accrual, unspent
 *   30-day budget = 30 days of it; the sub-cap period is the trailing 30 days
 *   realized fees = QF x days live
 *   cost to serve = the tier's cogsPerDay across the period, charged FIRST
 */
function makeLedger(premise: Premise = {}, overrides: Partial<BudgetLedgerView> = {}): BudgetLedgerView {
  const qfPerDay = premise.qfPerDay ?? HEALTHY_QF_PER_DAY
  const budgetBps = premise.budgetBps ?? TERMS.budgetBpsDefault
  const activeDays = premise.activeDays ?? ACTIVE_DAYS
  const perDay = dailyAccrualUsd(qfPerDay, budgetBps)
  return {
    finalizedBudget: usdAt(perDay * ROLLING_WINDOW_DAYS),
    // Today's credit, still inside the reorg window. Never spendable.
    unfinalizedBudget: usdAt(perDay),
    outstandingObligations: usdAt(0),
    dailyBudgetAccrual: Array.from({ length: ROLLING_WINDOW_DAYS }, (_, i) =>
      usdAt(perDay, NOW - (ROLLING_WINDOW_DAYS - 1 - i) * DAY),
    ),
    cumulativeRealizedFees: usdAt(qfPerDay * activeDays),
    lifetimeSpend: usdAt(0),
    rollingWindowSpend: usdAt(0),
    budget30d: usdAt(perDay * 30),
    periodBudget: usdAt(perDay * 30),
    inferenceChargedThisPeriod: usdAt(TIERS.T1.cogsPerDay * 30),
    categorySpendThisPeriod: {},
    ...overrides,
  }
}

function makeConsent(overrides: Partial<Consent> = {}): Consent {
  return {
    devSigner: COIN.devSigner,
    devPayout: COIN.devPayout,
    token: COIN.token,
    termsHash: '0x8f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f',
    operatorBps: TERMS.operatorBps,
    budgetBpsMax: TERMS.budgetBpsMax,
    adapter: VENUE_ADAPTER,
    referrer: '0x0000000000000000000000000000000000000000',
    referrerBps: 0,
    expiryUnix: NOW + 30 * DAY,
    nonce: '1',
    ...overrides,
  }
}

function makeVault(overrides: Partial<Vault> = {}): Vault {
  return {
    address: COIN.vault,
    token: COIN.token,
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

function makeAsset(): Asset {
  return { address: QUOTE_ASSET, symbol: 'USDG', decimals: 6, isPausableProxy: true, enabled: true }
}

function makeQf(overrides: Partial<QfMeasurement> = {}): QfMeasurement {
  return {
    vault: COIN.vault,
    qfPerDay: HEALTHY_QF_PER_DAY,
    observedDays: 14,
    sustainedDays: TIERS.T1.sustainedDays + 3,
    measuredAtUnix: NOW - 3_600,
    perAsset: [],
    ...overrides,
  }
}

function makeSignals(overrides: Partial<QualificationSignals> = {}): QualificationSignals {
  return {
    uniqueBuyers7d: 512,
    top10HolderSharePct: 38,
    deployerSupplySharePct: 4,
    selfTradeSharePct: 3,
    venuePoolVolumeSharePct: 61,
    coinAgeDays: 55,
    ...overrides,
  }
}

function makeScreening(): ScreeningResult {
  return {
    token: COIN.token,
    verdict: 'CLEAR',
    flags: [],
    stagesRun: ['lexicon', 'trademark', 'adjudication'],
    screenedAtUnix: NOW - 3_600,
    paidMediaPermitted: true,
  }
}

function makeCounters(overrides: Partial<SpendCounters> = {}): SpendCounters {
  return {
    proposalsLastHourForVault: 1,
    disbursementsTodayForVault: 0,
    disbursementsTodayFleet: 11,
    vendorDisbursementsTodayForVault: 0,
    vendorSpendTodayFleet: usdAt(2_400),
    relatedPartySpend30d: usdAt(0),
    countedAtUnix: NOW - 10,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Catalog. Real shapes at real list prices; every payee is an allowlisted,
// KYB'd, sanctions-screened vendor and nothing here can name any other address.
// ---------------------------------------------------------------------------

const LISTING_SKU = 'dexscreener.eti'
const KOL_SKU = 'kolnet.post.mid'
const AFFILIATE_SKU = 'affiliate.boost.pack'

function sku(base: Partial<Sku> & Pick<Sku, 'id' | 'vendorId'>): Sku {
  return {
    description: 'Enhanced token info listing',
    unitCostUsd: 299,
    category: 'listing',
    predicate: {
      kind: 'eti_listing',
      verifyAtOffsetsSeconds: [DAY],
      params: { chain: '4663', pairSource: 'dexscreener_pairs_api', expectFieldPresent: 'info' },
    },
    availableAtTiers: ['T1', 'T2', 'T3'],
    ...base,
  }
}

function makeVendors(overrides: Partial<Vendor> & { id?: string } = {}): Vendor[] {
  const base = (v: Partial<Vendor> & Pick<Vendor, 'id' | 'displayName'>): Vendor => ({
    payoutAddress: VENDOR_PAYOUT,
    kybVerifiedAtUnix: NOW - 90 * DAY,
    ofacScreenedAtUnix: NOW - 5 * DAY,
    isRelatedParty: false,
    reliabilityScore: 0.9,
    enabled: true,
    ...v,
    ...(overrides.id === v.id ? overrides : {}),
  })
  return [
    base({ id: 'dexscreener', displayName: 'Dexscreener' }),
    base({ id: 'kolnet', displayName: 'KOLnet', reliabilityScore: 0.85 }),
    base({
      id: 'affiliate',
      displayName: 'Northgate Boost (operator affiliate)',
      isRelatedParty: true,
      reliabilityScore: 0.8,
      payoutAddress: AFFILIATE_PAYOUT,
    }),
  ]
}

function makeEntries(): CatalogEntry[] {
  return [
    {
      sku: sku({ id: LISTING_SKU, vendorId: 'dexscreener' }),
      pricing: 'third_party_pass_through',
      rateCardRef: { vendorId: 'dexscreener', sourceHash: 'card-hash-1' },
      enabled: true,
      observedDeliveries: 12,
      maxQuantity: 4,
    },
    {
      sku: sku({
        id: KOL_SKU,
        vendorId: 'kolnet',
        description: 'Mid-tier KOL post, verified at T+24h and T+7d',
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
        id: AFFILIATE_SKU,
        vendorId: 'affiliate',
        description: 'Boost pack from an operator-affiliated vendor',
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
      observedDeliveries: 6,
      maxQuantity: 2,
    },
  ]
}

function makeBroker(vendorOverride: (Partial<Vendor> & { id?: string }) | undefined): SpendBroker {
  const keyring = new PolicyKeyring({ [KEY_ID]: SERVICE_KEY })
  return new SpendBroker({
    catalog: new VendorCatalog(makeVendors(vendorOverride ?? {}), makeEntries()),
    policyService: new InMemoryPolicyService(new PolicyTokenSigner(keyring, KEY_ID), {
      tier: 'T1',
      enabledAssets: [QUOTE_ASSET],
    }),
    keyring,
    predicates: new PredicateRegistry(new FakeEvidenceSource()),
  })
}

function makeProposal(overrides: Partial<SpendProposal> = {}): SpendProposal {
  return {
    vault: COIN.vault,
    skuId: LISTING_SKU,
    quantity: 1,
    rationale: 'holders keep asking how to find the pair; an ETI listing answers it once',
    proposedAtUnix: NOW - 5,
    ...overrides,
  }
}

function makeRequest(overrides: Partial<SpendRequest> = {}): SpendRequest {
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

// ---------------------------------------------------------------------------
// Scene construction
// ---------------------------------------------------------------------------

interface Case {
  id: string
  title: string
  proves: string
  /** The single thing that differs from the healthy client. */
  broke: string
  request: SpendRequest
  vendorOverride?: Partial<Vendor> & { id?: string }
  /** Extra key/value lines showing the arithmetic the gate used. */
  arithmetic?: Pair[]
}

function traceTable(trace: Array<{ gate: string; decision: SpendDecision }>): string {
  return table(trace, [
    {
      header: '',
      value: (t) =>
        t.decision.approved ? (t.decision.requiresHumanApproval ? '!' : 'ok') : 'REFUSED',
    },
    { header: 'gate', value: (t) => t.gate },
    { header: 'reason', value: (t) => t.decision.reason },
  ])
}

async function runCase(c: Case): Promise<Scene> {
  const broker = makeBroker(c.vendorOverride)
  const { decision, trace } = await broker.trace(c.request, NOW)
  const gatesRun = trace.length

  const verdict = !decision.approved
    ? refused(
        `AT GATE ${String(decision.failedGate ?? 'unknown').toUpperCase()}`,
        decision.reason,
      )
    : decision.requiresHumanApproval
      ? refused('HELD FOR A HUMAN', decision.reason)
      : ok('APPROVED', decision.reason)

  const given: Pair[] = [
    { label: 'sku', value: `${c.request.proposal.skuId} x${String(c.request.proposal.quantity)}` },
    { label: 'quoted', value: usd(decision.quotedCostUsd ?? null) },
    { label: 'broke', value: c.broke },
  ]
  for (const pair of c.arithmetic ?? []) given.push(pair)

  return {
    id: c.id,
    title: c.title,
    proves: c.proves,
    verdict,
    given,
    path: [
      'fetched the signed policy object and verified its HMAC, vault, tier and expiry',
      'resolved every money figure to integer cents with its price provenance checked',
      `ran the ${String(GATE_NAMES.length)}-gate chain in fixed order; ${String(gatesRun)} gates evaluated before the chain stopped`,
      'the chain read no clock, performed no I/O and allocated no random number, so this decision replays identically forever',
    ],
    blocks: [{ label: 'the gate chain, in order', text: traceTable(trace), plain: true }],
  }
}

export async function runBrokerDemo(): Promise<DemoResult> {
  const perDay = dailyAccrualUsd(HEALTHY_QF_PER_DAY, TERMS.budgetBpsDefault)
  const banked = perDay * ROLLING_WINDOW_DAYS
  const rollingCap = SPEND_LIMITS.rollingCapOfMedian * perDay * ROLLING_WINDOW_DAYS
  const budget30d = perDay * 30
  const procurement = budget30d - TIERS.T1.cogsPerDay * 30

  const cases: Case[] = [
    {
      id: 'broker.approved',
      title: 'Approved: a $299 listing for a healthy T1 client',
      proves:
        'The healthy path exists and is unremarkable. Every gate below has a reason attached, so the receipt for this spend is the same object a disputing client would replay.',
      broke: 'nothing - this is the reference client',
      request: makeRequest(),
      arithmetic: [
        { label: 'qf/day', value: usd(HEALTHY_QF_PER_DAY) },
        { label: 'dial', value: `${String(TERMS.budgetBpsDefault)}bps -> ${usd(perDay)}/day banked` },
        { label: 'banked', value: `${usd(banked)} over ${String(ROLLING_WINDOW_DAYS)} days` },
        { label: 'caps', value: `rolling ${usd(rollingCap)}, human approval above ${usd(SPEND_LIMITS.humanApprovalThresholdUsd)}` },
      ],
    },
    {
      id: 'broker.solvency',
      title: 'Refused at SOLVENCY: the budget is already committed',
      proves:
        'Solvency runs against the FINALIZED budget alone, less outstanding obligations. The unfinalized figure - credited but still inside the reorg window - is resolved and reported so a reviewer can see what was excluded, and no gate is permitted to read it.',
      broke: `outstandingObligations raised to ${usd(banked - 100)}, leaving $100 available`,
      request: makeRequest({
        ledger: makeLedger({}, { outstandingObligations: usdAt(banked - 100) }),
      }),
      arithmetic: [
        { label: 'finalized', value: usd(banked) },
        { label: 'committed', value: usd(banked - 100) },
        { label: 'available', value: usd(100) },
        { label: 'unfinalized', value: `${usd(perDay)} - resolved, reported, and unreadable by any gate` },
      ],
    },
    {
      id: 'broker.commitment_rule',
      title: 'Refused at COMMITMENT_RULE: funded from a credit line',
      proves:
        'No obligation may exceed the coin\'s own banked budget at signing. This single rule resolves the hold-up problem, forward commitments and cross-coin subsidy together, and it has no exception for the best client. A load-time tripwire refuses to start the broker at all if the config flag is ever flipped.',
      broke: 'the obligation declares fundingSource "credit_line"',
      request: makeRequest({
        obligation: {
          totalObligationUsd: 299,
          dueNowUsd: 299,
          fundingSource: 'credit_line',
        },
      }),
      arithmetic: [
        { label: 'banked', value: `${usd(banked)} - enough to pay for this outright` },
        { label: 'refused anyway', value: 'because of where the money would have come from, not how much' },
      ],
    },
    {
      id: 'broker.rolling_cap',
      title: 'Refused at ROLLING_CAP: the window is spent',
      proves:
        'The cap is the MEDIAN daily accrual extended over the window, times a configured fraction. Taking the median first is the whole point: one day of wash volume moves a mean and does not move a median, so manufactured flow cannot buy a bigger budget.',
      broke: `${usd(1_800)} already spent inside the ${String(ROLLING_WINDOW_DAYS)}-day window`,
      request: makeRequest({
        ledger: makeLedger(
          {},
          { rollingWindowSpend: usdAt(1_800), lifetimeSpend: usdAt(1_800) },
        ),
      }),
      arithmetic: [
        { label: 'median/day', value: usd(perDay) },
        {
          label: 'cap',
          value: `${usd(rollingCap)} = ${String(SPEND_LIMITS.rollingCapOfMedian * 100)}% x ${usd(perDay)} x ${String(ROLLING_WINDOW_DAYS)} days`,
        },
        { label: 'projected', value: `${usd(1_800)} + ${usd(299)} = ${usd(2_099)}` },
      ],
    },
    {
      id: 'broker.lifetime_cap',
      title: 'Refused at LIFETIME_CAP: a young coin has not earned this much spend',
      proves:
        'Lifetime spend may never exceed a fraction of cumulative REALIZED fees. A coin twelve days old has banked twelve days of fees, and the cap moves with what it actually produced rather than with what anyone hopes it will.',
      broke: 'the same client, twelve days live instead of fifty, with $7,000 already spent',
      request: makeRequest({
        vault: makeVault({
          activatedAtUnix: NOW - 12 * DAY,
          deployedAtUnix: NOW - 14 * DAY,
        }),
        qf: makeQf({ observedDays: 12 }),
        signals: makeSignals({ coinAgeDays: 14 }),
        ledger: makeLedger(
          { activeDays: 12 },
          { lifetimeSpend: usdAt(7_000), rollingWindowSpend: usdAt(400) },
        ),
      }),
      arithmetic: [
        { label: 'realized fees', value: `${usd(HEALTHY_QF_PER_DAY * 12)} over 12 days` },
        {
          label: 'cap',
          value: `${usd(HEALTHY_QF_PER_DAY * 12 * SPEND_LIMITS.lifetimeCapOfRealizedFees)} = ${String(SPEND_LIMITS.lifetimeCapOfRealizedFees * 100)}% of realized fees`,
        },
        { label: 'projected', value: `${usd(7_000)} + ${usd(299)} = ${usd(7_299)}` },
      ],
    },
    {
      id: 'broker.qualification_floor',
      title: 'Refused at QUALIFIED_FEE: the dial is below the qualification floor',
      proves:
        'A tier whose procurement slice cannot buy its own cheapest deliverable is not a product. The coin clears the T1 fee gate and the dev is entitled to any dial they like - but at 415bps the monthly budget is below the floor, and the honest answer is that this client cannot be served at this tier rather than that we will try.',
      broke: 'the dev set the procurement dial to 415bps',
      request: makeRequest({
        vault: makeVault({ budgetBps: 415 }),
        ledger: makeLedger({ budgetBps: 415 }),
      }),
      arithmetic: [
        { label: 'qf/day', value: `${usd(HEALTHY_QF_PER_DAY)} - clear of the ${usd(TIERS.T1.gateQfPerDay)} T1 gate` },
        {
          label: 'monthly budget',
          value: `${usd(Math.floor((HEALTHY_QF_PER_DAY * 415 * 30) / 10_000))} = qf x 415bps x 30`,
        },
        { label: 'floor', value: usd(QUALIFICATION_FLOOR_MONTHLY_USD) },
      ],
    },
    {
      id: 'broker.payee_allowlist',
      title: 'Refused at PAYEE_ALLOWLIST: the vendor sanctions screen went stale',
      proves:
        'The payee set is configuration, not something a proposal can extend. A vendor already on the allowlist still has to carry a current KYB record and a fresh sanctions screen, and an expired screen is not a screen.',
      broke: "dexscreener's OFAC screen is 45 days old against a 30-day limit",
      request: makeRequest(),
      vendorOverride: { id: 'dexscreener', ofacScreenedAtUnix: NOW - 45 * DAY },
      arithmetic: [
        { label: 'payee', value: `${VENDOR_PAYOUT} (allowlisted, immutable, not proposal-supplied)` },
        { label: 'screened', value: '45 days ago' },
        { label: 'limit', value: '30 days' },
      ],
    },
    {
      id: 'broker.related_party',
      title: 'Refused at RELATED_PARTY: the operator affiliate is at its cap',
      proves:
        'The operator may sell to its own clients, disclosed, with a per-dev opt-in recorded off the model path and a hard cap as a fraction of the coin\'s 30-day budget. Self-dealing is bounded by arithmetic rather than by a promise.',
      broke: `$1,700 already routed to operator affiliates inside 30 days`,
      request: makeRequest({
        proposal: makeProposal({
          skuId: AFFILIATE_SKU,
          rationale: 'boost pack from the operator affiliate, disclosed, dev has opted in',
        }),
        relatedPartyOptIn: true,
        ledger: makeLedger(
          {},
          {
            rollingWindowSpend: usdAt(1_700),
            lifetimeSpend: usdAt(1_700),
            categorySpendThisPeriod: { moderation: usdAt(900), boost: usdAt(800) },
          },
        ),
        counters: makeCounters({ relatedPartySpend30d: usdAt(1_700) }),
      }),
      arithmetic: [
        { label: 'dev opt-in', value: 'yes - without it this refuses one clause earlier' },
        { label: '30-day budget', value: usd(budget30d) },
        {
          label: 'cap',
          value: `${usd(budget30d * SPEND_LIMITS.relatedPartyCapOf30dBudget)} = ${String(SPEND_LIMITS.relatedPartyCapOf30dBudget * 100)}% of the 30-day budget`,
        },
        { label: 'projected', value: `${usd(1_700)} + ${usd(150)} = ${usd(1_850)}` },
      ],
    },
    {
      id: 'broker.rate_limit',
      title: 'Refused at RATE_LIMIT: twelve proposals for this vault in an hour',
      proves:
        'A compromised planner that has satisfied every economic gate still cannot issue proposals faster than a human could review them. The rate limits are per-vault, per-vendor and fleet-wide, and stale counters are treated as unknown - which means no.',
      broke: 'proposalsLastHourForVault is at the per-vault hourly ceiling',
      request: makeRequest({ counters: makeCounters({ proposalsLastHourForVault: 12 }) }),
      arithmetic: [
        { label: 'proposals/hour', value: '12 seen, 12 permitted' },
        { label: 'counter age', value: '10s (older than 300s is refused as unknown)' },
      ],
    },
    {
      id: 'broker.human_approval',
      title: 'Held at HUMAN_APPROVAL: $800 is above the autonomous threshold',
      proves:
        'The last gate does not refuse, it ESCALATES - and escalations accumulate rather than short-circuit, so a human is shown every reason at once. Above the threshold the chain can approve all day and nothing disburses until a person signs.',
      broke: `two KOL posts at $400 each, against a ${usd(SPEND_LIMITS.humanApprovalThresholdUsd)} threshold`,
      request: makeRequest({
        proposal: makeProposal({
          skuId: KOL_SKU,
          quantity: 2,
          rationale: 'two mid-tier posts in the same week, both verified at T+24h and T+7d',
        }),
      }),
      arithmetic: [
        { label: 'threshold', value: usd(SPEND_LIMITS.humanApprovalThresholdUsd) },
        { label: 'predicate', value: 'kol_post, checked at T+24h AND T+7d - one check cannot catch a deleted post' },
      ],
    },
  ]

  const scenes: Scene[] = []
  for (const c of cases) scenes.push(await runCase(c))

  // The caps this client is operating under, computed by the same exported
  // functions the gates call, so the table cannot drift from the decisions.
  const reference = makeRequest()
  const referenceBroker = makeBroker(undefined)
  const { trace } = await referenceBroker.trace(reference, NOW)
  const capsRun = trace.length

  const facts: Pair[] = [
    { label: 'gates in the chain', value: `${String(GATE_NAMES.length)}, fixed order, first refusal wins` },
    { label: 'gates evaluated for the approved case', value: String(capsRun) },
    { label: 'models consulted', value: '0 - no model runs in this package' },
    { label: 'client qf/day', value: usd(HEALTHY_QF_PER_DAY) },
    { label: "dev's dial", value: `${String(TERMS.budgetBpsDefault)}bps` },
    { label: 'banked and spendable', value: usd(banked) },
    { label: 'rolling window cap', value: usd(rollingCap) },
    { label: 'procurement budget this period', value: `${usd(procurement)} (period budget less inference, charged FIRST)` },
    {
      label: 'listing sub-cap',
      value: `${usd((procurement * CATEGORY_SUBCAP_BPS.listing) / 10_000)} (${String(CATEGORY_SUBCAP_BPS.listing)}bps of procurement)`,
    },
    { label: 'operator treasury', value: `${OPERATOR_TREASURY} - a constructor immutable, never a parameter` },
  ]

  return summarise(
    'broker',
    'ten spend proposals, one deterministic chain, and the gate that fired named every time',
    [
      'One client, one catalog, one chain of eighteen gates. The first proposal is approved and',
      'the next nine each break exactly one thing - and the report names the gate that caught it',
      'and the arithmetic it used. No model runs anywhere in this package: given the same inputs',
      'the chain returns the same decision forever, which is what lets a disputed spend be',
      'replayed and re-adjudicated by someone who does not trust us. An amount inside a gate',
      'reason is integer MINOR UNITS - 29900 is $299.00 - because no gate ever touches a float.',
    ],
    scenes,
    facts,
  )
}
