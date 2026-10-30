/**
 * The in-memory fixture dataset.
 *
 * This is a real backend, not a screenshot. Every figure below is DERIVED:
 * the split legs come from the same splitCredit() the page renders and the
 * contract settles with, the creator rate comes from creatorNetBps() with each
 * coin's own buyback setting, and the commitments are placed on the timeline
 * relative to `nowUnix` so the 72-hour lag actually hides some of them when you
 * open the page. If the demo shows a number the production path could not
 * produce, that is a bug in this file rather than cosmetic licence.
 *
 * One coin at each tier, plus a RESTRICTED coin so the screening blocker is
 * visible without having to break something.
 */

import { bytesToHex } from '../../crypto/hex.js'
import { keccak256 } from '../../crypto/keccak.js'
import { splitCredit } from '../../domain/fees.js'
import { usdToCents, type Cents } from '../../domain/money.js'
import { WHAT_WE_DID_NOT_DO } from '../../domain/disclosure.js'
import { VENUE, TERMS, TIERS } from '../../protocol.js'
import { buildAgentFixture } from './agent.js'
import type * as M from '../model.js'

const HOUR = 3_600
const DAY = 24 * HOUR

/** Deterministic, valid-looking addresses. Same label always yields the same. */
function addressFrom(label: string): string {
  const digest = keccak256(new TextEncoder().encode(`fee-split-vaults/fixture/${label}`))
  return bytesToHex(digest.subarray(12)).toLowerCase()
}

function bytes32From(label: string): string {
  return bytesToHex(keccak256(new TextEncoder().encode(`fee-split-vaults/fixture32/${label}`)))
}

const WETH: M.Asset = { address: VENUE.contracts.weth, symbol: 'WETH', decimals: 18 }
const USDG: M.Asset = { address: addressFrom('asset/usdg'), symbol: 'USDG', decimals: 6 }

/** Pinned prices. Every USD figure derived from these carries this provenance. */
const PRICES = {
  weth: { usdPerToken: 2_431.18, source: 'venue-twap:WETH/USDG@30m' },
  usdg: { usdPerToken: 1.0, source: 'pinned:USDG=1.00' },
} as const

function wethMinorForUsd(usd: number): bigint {
  // 18 decimals, integer arithmetic after a single fixed-precision conversion.
  const microUsd = BigInt(Math.round(usd * 1_000_000))
  const microUsdPerToken = BigInt(Math.round(PRICES.weth.usdPerToken * 1_000_000))
  return (microUsd * 10n ** 18n) / microUsdPerToken
}

function usdgMinorForUsd(usd: number): bigint {
  return BigInt(Math.round(usd * 1_000_000))
}

function pricedUsd(usd: number, source: string, atUnix: number, blockHash: string) {
  return { cents: usdToCents(usd), priceSource: source, pricedAtUnix: atUnix, blockHash }
}

// ---------------------------------------------------------------------------
// Vendors and SKUs
// ---------------------------------------------------------------------------

interface FixtureVendor {
  id: string
  displayName: string
  isRelatedParty: boolean
  reliabilityScore: number
}

const VENDORS: Record<string, FixtureVendor> = {
  dexscreener: {
    id: 'dexscreener',
    displayName: 'Dexscreener',
    isRelatedParty: false,
    reliabilityScore: 0.99,
  },
  dextools: {
    id: 'dextools',
    displayName: 'DEXTools',
    isRelatedParty: false,
    reliabilityScore: 0.94,
  },
  kol_nozzle: {
    id: 'kol_nozzle',
    displayName: 'Nozzle (independent poster)',
    isRelatedParty: false,
    reliabilityScore: 0.71,
  },
  shieldmod: {
    id: 'shieldmod',
    displayName: 'ShieldMod',
    isRelatedParty: false,
    reliabilityScore: 0.97,
  },
  // Deliberately present. A related-party vendor is not forbidden; it is capped,
  // opt-in, and flagged everywhere it appears. A scorecard that quietly omitted
  // the affiliation would be the failure mode.
  venuedesk_media: {
    id: 'venuedesk_media',
    displayName: 'Venue Desk Media',
    isRelatedParty: true,
    reliabilityScore: 0.88,
  },
}

interface FixtureSku {
  id: string
  vendorId: string
  description: string
  unitCostUsd: number
  predicateKind: string
}

const SKUS: Record<string, FixtureSku> = {
  eti_listing: {
    id: 'eti_listing',
    vendorId: 'dexscreener',
    description: 'Enhanced Token Info listing',
    unitCostUsd: 299,
    predicateKind: 'eti_listing',
  },
  dex_boost_500: {
    id: 'dex_boost_500',
    vendorId: 'dexscreener',
    description: 'Boost pack, 500',
    unitCostUsd: 599,
    predicateKind: 'boost_delta',
  },
  dextools_trending_24h: {
    id: 'dextools_trending_24h',
    vendorId: 'dextools',
    description: 'Trending placement, 24h',
    unitCostUsd: 1_450,
    predicateKind: 'trending_rank',
  },
  kol_thread: {
    id: 'kol_thread',
    vendorId: 'kol_nozzle',
    description: 'Disclosed thread, 1 post + 1 quote',
    unitCostUsd: 420,
    predicateKind: 'kol_post',
  },
  moderation_week: {
    id: 'moderation_week',
    vendorId: 'shieldmod',
    description: 'Telegram moderation coverage, 7 days',
    unitCostUsd: 180,
    predicateKind: 'manual_attestation',
  },
  creative_pack: {
    id: 'creative_pack',
    vendorId: 'venuedesk_media',
    description: 'Creative pack: 6 statics, 2 short video',
    unitCostUsd: 640,
    predicateKind: 'manual_attestation',
  },
}

// ---------------------------------------------------------------------------
// Coin specifications
// ---------------------------------------------------------------------------

interface PurchaseSpec {
  skuId: string
  /** Days before now the purchase or commitment was made. */
  daysAgo: number
  quantity: number
  executed: boolean
  predicatePassed: boolean | null
  attributedNewBuyers: number
  withheldReason?: string
}

interface CoinSpec {
  key: string
  name: string
  symbol: string
  tier: M.PublicCoin['tier']
  state: M.VaultState
  qfPerDayUsd: number
  observedDays: number
  sustainedDays: number
  budgetBps: number
  budgetBpsMax: number
  referrerBps: number
  buybackEnabled: boolean
  creatorTaxBps: number
  graduated: boolean
  ageDays: number
  screening: { verdict: M.ScreeningVerdict; paidMediaPermitted: boolean; flags: string[] }
  purchases: PurchaseSpec[]
  accounts: Array<{ channel: string; handle: string }>
  /** What the dev named at onboarding, counted; and whether an operator has approved the derived narrative. */
  narrative: { linkCount: number; sourceCount: number; approved: boolean }
  /** Multiple of the trailing 7-day gross that the coin has earned for life. */
  lifetimeMultiple: number
  escalations: Array<{
    reason: string
    priority: M.EscalationPriority
    summary: string
    evidence: string[]
    hoursAgo: number
    acknowledged: boolean
  }>
}

const COIN_SPECS: CoinSpec[] = [
  {
    key: 'hydrant',
    name: 'Hydrant',
    symbol: 'HYDR',
    tier: 'T3',
    state: 'ACTIVE',
    qfPerDayUsd: 31_500,
    observedDays: 41,
    sustainedDays: 22,
    budgetBps: 2_500,
    budgetBpsMax: 4_000,
    referrerBps: 1_500,
    buybackEnabled: true,
    creatorTaxBps: 150,
    graduated: true,
    ageDays: 41,
    screening: { verdict: 'CLEAR', paidMediaPermitted: true, flags: [] },
    lifetimeMultiple: 5.4,
    accounts: [
      { channel: 'telegram', handle: 'hydrant_desk' },
      { channel: 'x_operator', handle: 'hydrant_ops' },
    ],
    narrative: { linkCount: 2, sourceCount: 2, approved: true },
    purchases: [
      { skuId: 'dextools_trending_24h', daysAgo: 12, quantity: 1, executed: true, predicatePassed: true, attributedNewBuyers: 214 },
      { skuId: 'eti_listing', daysAgo: 30, quantity: 1, executed: true, predicatePassed: true, attributedNewBuyers: 96 },
      { skuId: 'dex_boost_500', daysAgo: 9, quantity: 2, executed: true, predicatePassed: true, attributedNewBuyers: 158 },
      {
        skuId: 'kol_thread',
        daysAgo: 6,
        quantity: 1,
        executed: true,
        predicatePassed: false,
        attributedNewBuyers: 0,
        withheldReason: 'Post was deleted before the T+7d re-check. Payment withheld in full.',
      },
      { skuId: 'creative_pack', daysAgo: 17, quantity: 1, executed: true, predicatePassed: true, attributedNewBuyers: 0 },
      { skuId: 'moderation_week', daysAgo: 4, quantity: 1, executed: true, predicatePassed: true, attributedNewBuyers: 0 },
      // Inside the lag window. The public page must not show these.
      { skuId: 'dextools_trending_24h', daysAgo: 1.1, quantity: 1, executed: false, predicatePassed: null, attributedNewBuyers: 0 },
      { skuId: 'dex_boost_500', daysAgo: 0.3, quantity: 1, executed: false, predicatePassed: null, attributedNewBuyers: 0 },
      // Outside it. Committed but not yet executed, and old enough to publish.
      { skuId: 'eti_listing', daysAgo: 5, quantity: 1, executed: false, predicatePassed: null, attributedNewBuyers: 0 },
    ],
    escalations: [
      {
        reason: 'impersonation',
        priority: 'high',
        summary:
          'Three accounts posting a contract address that is not this token’s, in reply to the ' +
          'pinned fact sheet. Host defanged below; the desk has not messaged them.',
        evidence: ['host: hydrant-claim[.]app', 'first seen 4h ago', '3 distinct authors'],
        hoursAgo: 5,
        acknowledged: false,
      },
      {
        reason: 'fee_recipient_change_proposed',
        priority: 'critical',
        summary:
          'A creator-fee recipiency transfer was proposed on chain for this token. If you did not ' +
          'initiate this, act now: recipiency is self-service by the current recipient.',
        evidence: ['proposed 19h ago', 'target: 0x…9f31 (not this vault)'],
        hoursAgo: 19,
        acknowledged: false,
      },
    ],
  },
  {
    key: 'glint',
    name: 'Glint',
    symbol: 'GLINT',
    tier: 'T2',
    state: 'ACTIVE',
    qfPerDayUsd: 4_200,
    observedDays: 26,
    sustainedDays: 16,
    budgetBps: 2_000,
    budgetBpsMax: 4_000,
    referrerBps: 0,
    buybackEnabled: false,
    creatorTaxBps: 0,
    graduated: true,
    ageDays: 26,
    screening: { verdict: 'CLEAR', paidMediaPermitted: true, flags: [] },
    lifetimeMultiple: 3.1,
    accounts: [
      { channel: 'telegram', handle: 'glint_desk' },
      { channel: 'x_operator', handle: 'glint_ops' },
    ],
    narrative: { linkCount: 1, sourceCount: 1, approved: true },
    purchases: [
      { skuId: 'eti_listing', daysAgo: 18, quantity: 1, executed: true, predicatePassed: true, attributedNewBuyers: 71 },
      { skuId: 'dex_boost_500', daysAgo: 11, quantity: 1, executed: true, predicatePassed: true, attributedNewBuyers: 44 },
      { skuId: 'moderation_week', daysAgo: 3, quantity: 1, executed: true, predicatePassed: true, attributedNewBuyers: 0 },
      { skuId: 'kol_thread', daysAgo: 2.5, quantity: 1, executed: true, predicatePassed: true, attributedNewBuyers: 29 },
      { skuId: 'dex_boost_500', daysAgo: 0.8, quantity: 1, executed: false, predicatePassed: null, attributedNewBuyers: 0 },
    ],
    escalations: [
      {
        reason: 'unanswered_backlog',
        priority: 'low',
        summary:
          'Fourteen questions in the last 24h fell into refusal classes the desk will not answer ' +
          '(price direction, comparative merit). No answer was given; you may want to.',
        evidence: ['14 refusals in 24h', 'topic: price_question'],
        hoursAgo: 30,
        acknowledged: true,
      },
    ],
  },
  {
    key: 'toaster',
    name: 'Toaster',
    symbol: 'TOAST',
    tier: 'T1',
    state: 'ACTIVE',
    // A healthy desk client sits clear of the T1 gate, wherever the gate is.
    // Written as a multiple of TIERS.T1.gateQfPerDay and not as a number: a
    // demo coin badged "Desk" whose fee flow is below the published gate is a
    // coin the real pipeline would have refused.
    qfPerDayUsd: Math.round(TIERS.T1.gateQfPerDay * 1.2),
    observedDays: 14,
    sustainedDays: 9,
    budgetBps: 1_500,
    budgetBpsMax: 3_000,
    referrerBps: 0,
    // Buyback ON: the creator rate is 0.35%, not 0.70%. The page must branch.
    buybackEnabled: true,
    creatorTaxBps: 0,
    graduated: true,
    ageDays: 14,
    screening: { verdict: 'CLEAR', paidMediaPermitted: true, flags: [] },
    lifetimeMultiple: 1.9,
    accounts: [{ channel: 'telegram', handle: 'toaster_desk' }],
    narrative: { linkCount: 1, sourceCount: 1, approved: false },
    purchases: [
      { skuId: 'eti_listing', daysAgo: 7, quantity: 1, executed: true, predicatePassed: true, attributedNewBuyers: 23 },
      { skuId: 'moderation_week', daysAgo: 2, quantity: 1, executed: true, predicatePassed: true, attributedNewBuyers: 0 },
      { skuId: 'moderation_week', daysAgo: 0.5, quantity: 1, executed: false, predicatePassed: null, attributedNewBuyers: 0 },
    ],
    escalations: [],
  },
  {
    key: 'spud',
    name: 'Spud',
    symbol: 'SPUD',
    tier: 'T1',
    state: 'ACTIVE',
    // Clears the T1 gate but stays well under T2's, so the "toward Campaign"
    // progress bar has somewhere to go. Derived, for the same reason as above.
    qfPerDayUsd: Math.round(TIERS.T1.gateQfPerDay * 1.5),
    observedDays: 11,
    sustainedDays: 7,
    budgetBps: 2_000,
    budgetBpsMax: 4_000,
    referrerBps: 0,
    buybackEnabled: false,
    creatorTaxBps: 0,
    graduated: false,
    ageDays: 11,
    screening: {
      verdict: 'RESTRICTED',
      paidMediaPermitted: false,
      flags: ['trademark_similarity:medium', 'lexicon:food_brand_adjacent'],
    },
    lifetimeMultiple: 1.4,
    accounts: [{ channel: 'telegram', handle: 'spud_desk' }],
    narrative: { linkCount: 1, sourceCount: 0, approved: false },
    purchases: [
      { skuId: 'moderation_week', daysAgo: 5, quantity: 1, executed: true, predicatePassed: true, attributedNewBuyers: 0 },
    ],
    escalations: [
      {
        reason: 'human_required',
        priority: 'normal',
        summary:
          'Screening returned RESTRICTED on a trademark similarity. Organic operations continue; ' +
          'no paid media can be purchased until a human adjudicates.',
        evidence: ['stage: trademark', 'flag: trademark_similarity:medium'],
        hoursAgo: 48,
        acknowledged: false,
      },
    ],
  },
  {
    key: 'pebble',
    name: 'Pebble',
    symbol: 'PBL',
    tier: 'T0',
    state: 'ACTIVE',
    qfPerDayUsd: 12,
    observedDays: 4,
    sustainedDays: 4,
    budgetBps: 2_000,
    budgetBpsMax: 4_000,
    referrerBps: 0,
    buybackEnabled: false,
    creatorTaxBps: 0,
    graduated: false,
    ageDays: 4,
    screening: { verdict: 'CLEAR', paidMediaPermitted: true, flags: [] },
    lifetimeMultiple: 0.6,
    accounts: [{ channel: 'telegram', handle: 'pebble_desk' }],
    narrative: { linkCount: 0, sourceCount: 1, approved: false },
    purchases: [],
    escalations: [],
  },
]

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface FixtureCoin {
  summary: M.CoinSummary
  coin: M.PublicCoin
  receipts: M.ReceiptItem[]
  vendors: M.VendorScorecard[]
  reports: M.WeeklyReportView[]
  escalations: M.Escalation[]
  detail: M.DevVaultDetail
  /** The six roles, and whether each is awake at this coin's tier right now. */
  agent: M.CoinAgent
  /** Per-tick history, newest first, on the fixed 30-minute window cadence. */
  agentRuns: M.AgentRun[]
  /** The address that must sign to reach the dev dashboard for this coin. */
  devSigner: string
}

export interface FixtureDataset {
  nowUnix: number
  protocol: M.ProtocolInfo
  order: string[]
  coins: Map<string, FixtureCoin>
  /** Vault addresses keyed by the dev address that controls them. */
  vaultsByDev: Map<string, string[]>
}

function buildFeeFlow(
  grossUsd: number,
  spec: CoinSpec,
  startUnix: number,
  endUnix: number,
  blockHash: string,
): M.FeeFlowPeriod {
  const grossCents = usdToCents(grossUsd)
  const charging = spec.state === 'ACTIVE'
  const split = splitCredit(
    grossCents,
    { operatorBps: TERMS.operatorBps, budgetBps: spec.budgetBps, referrerBps: spec.referrerBps },
    charging,
  )

  // Split the gross across the two quote assets the way real credits arrive.
  const wethShare = grossUsd * 0.62
  const usdgShare = grossUsd - wethShare

  return {
    periodStartUnix: startUnix,
    periodEndUnix: endUnix,
    perAsset: [
      {
        asset: WETH,
        creditedMinor: wethMinorForUsd(wethShare),
        usd: pricedUsd(wethShare, PRICES.weth.source, endUnix, blockHash),
      },
      {
        asset: USDG,
        creditedMinor: usdgMinorForUsd(usdgShare),
        usd: pricedUsd(usdgShare, PRICES.usdg.source, endUnix, blockHash),
      },
    ],
    qfGrossCents: grossCents,
    devLegCents: split.dev,
    budgetCents: split.budget,
    operatorFeeCents: split.operator,
    referrerCents: split.referrer,
  }
}

function buildReceipts(spec: CoinSpec, vault: string, nowUnix: number): M.ReceiptItem[] {
  const items: M.ReceiptItem[] = spec.purchases.map((purchase, index) => {
    const sku = SKUS[purchase.skuId]
    if (sku === undefined) throw new Error(`fixture references unknown sku ${purchase.skuId}`)
    const vendor = VENDORS[sku.vendorId]
    if (vendor === undefined) throw new Error(`fixture references unknown vendor ${sku.vendorId}`)

    const occurredAtUnix = Math.round(nowUnix - purchase.daysAgo * DAY)
    const costCents = usdToCents(sku.unitCostUsd * purchase.quantity)

    const predicateResults: M.DeliveryCheck[] =
      purchase.predicatePassed === null
        ? []
        : purchase.predicatePassed
          ? [
              {
                checkedAtUnix: occurredAtUnix + 24 * HOUR,
                offsetSeconds: 24 * HOUR,
                passed: true,
                evidenceUri: `https://receipts.invalid/evidence/${spec.key}-${index}-t24`,
                evidenceHash: bytes32From(`${spec.key}/${index}/t24`),
              },
              {
                checkedAtUnix: occurredAtUnix + 7 * DAY,
                offsetSeconds: 7 * DAY,
                passed: true,
                evidenceUri: `https://receipts.invalid/evidence/${spec.key}-${index}-t7d`,
                evidenceHash: bytes32From(`${spec.key}/${index}/t7d`),
              },
            ]
          : [
              {
                checkedAtUnix: occurredAtUnix + 24 * HOUR,
                offsetSeconds: 24 * HOUR,
                passed: true,
                evidenceUri: `https://receipts.invalid/evidence/${spec.key}-${index}-t24`,
                evidenceHash: bytes32From(`${spec.key}/${index}/t24`),
              },
              {
                checkedAtUnix: occurredAtUnix + 7 * DAY,
                offsetSeconds: 7 * DAY,
                passed: false,
                note: 'Post not found at re-check.',
              },
            ]

    return {
      id: `${spec.key}-r${index}`,
      kind: 'procurement',
      description: `${sku.description}${purchase.quantity > 1 ? ` ×${purchase.quantity}` : ''}`,
      amountCents: costCents,
      occurredAtUnix,
      // The server's own reveal time. The client re-derives the 72h floor and
      // takes the later of the two, so this value can only ever delay.
      publishAfterUnix: purchase.executed ? occurredAtUnix : occurredAtUnix + 72 * HOUR,
      executed: purchase.executed,
      vendorId: vendor.id,
      vendorName: vendor.displayName,
      vendorIsRelatedParty: vendor.isRelatedParty,
      skuId: sku.id,
      skuDescription: sku.description,
      invoiceHash: bytes32From(`${spec.key}/invoice/${index}`),
      permalink: purchase.executed
        ? `https://receipts.invalid/${vault}/disbursement/${spec.key}-r${index}`
        : undefined,
      predicateKind: sku.predicateKind,
      predicateResults,
      ...(purchase.withheldReason === undefined
        ? {}
        : { withheldReason: purchase.withheldReason }),
    }
  })

  return items.sort((a, b) => b.occurredAtUnix - a.occurredAtUnix)
}

function buildVendorScorecards(spec: CoinSpec, nowUnix: number): M.VendorScorecard[] {
  const byVendor = new Map<
    string,
    {
      purchases: number
      spendCents: Cents
      buyers: number
      passed: number
      failed: number
      withheld: Cents
      last: number | null
    }
  >()

  for (const purchase of spec.purchases) {
    if (!purchase.executed) continue
    const sku = SKUS[purchase.skuId]
    if (sku === undefined) continue
    const current = byVendor.get(sku.vendorId) ?? {
      purchases: 0,
      spendCents: 0n,
      buyers: 0,
      passed: 0,
      failed: 0,
      withheld: 0n,
      last: null,
    }
    const cost = usdToCents(sku.unitCostUsd * purchase.quantity)
    const occurredAtUnix = Math.round(nowUnix - purchase.daysAgo * DAY)
    const paid = purchase.predicatePassed !== false

    byVendor.set(sku.vendorId, {
      purchases: current.purchases + 1,
      // A withheld payment is not spend. Counting it would flatter the vendor's
      // cost per buyer AND overstate what the coin's budget actually paid out.
      spendCents: current.spendCents + (paid ? cost : 0n),
      buyers: current.buyers + purchase.attributedNewBuyers,
      passed: current.passed + (purchase.predicatePassed === true ? 1 : 0),
      failed: current.failed + (purchase.predicatePassed === false ? 1 : 0),
      withheld: current.withheld + (paid ? 0n : cost),
      last: current.last === null ? occurredAtUnix : Math.max(current.last, occurredAtUnix),
    })
  }

  return [...byVendor.entries()].map(([vendorId, totals]) => {
    const vendor = VENDORS[vendorId]
    if (vendor === undefined) throw new Error(`fixture references unknown vendor ${vendorId}`)
    return {
      vendorId,
      displayName: vendor.displayName,
      isRelatedParty: vendor.isRelatedParty,
      enabled: true,
      reliabilityScore: vendor.reliabilityScore,
      purchases: totals.purchases,
      spendCents: totals.spendCents,
      attributedNewBuyers: totals.buyers,
      // null, not zero: a vendor whose deliverable is moderation has no buyer
      // attribution, and rendering "$0.00 per buyer" would read as a triumph.
      costPerAttributedBuyerCents:
        totals.buyers > 0 ? totals.spendCents / BigInt(totals.buyers) : null,
      predicatesPassed: totals.passed,
      predicatesFailed: totals.failed,
      withheldCents: totals.withheld,
      lastPurchaseAtUnix: totals.last,
    }
  })
}

function buildReports(
  spec: CoinSpec,
  vault: string,
  receipts: M.ReceiptItem[],
  nowUnix: number,
): M.WeeklyReportView[] {
  const weeks = Math.min(4, Math.max(1, Math.floor(spec.observedDays / 7)))
  const reports: M.WeeklyReportView[] = []

  for (let week = 0; week < weeks; week++) {
    const periodEndUnix = nowUnix - week * 7 * DAY
    const periodStartUnix = periodEndUnix - 7 * DAY
    // Older weeks ran a little lighter; a flat series would be a giveaway that
    // nothing here was measured.
    const decay = 1 - week * 0.18
    const grossUsd = spec.qfPerDayUsd * 7 * decay
    const grossCents = usdToCents(grossUsd)
    const split = splitCredit(grossCents, {
      operatorBps: TERMS.operatorBps,
      budgetBps: spec.budgetBps,
      referrerBps: spec.referrerBps,
    })

    const lineItems = receipts.filter(
      (item) => item.occurredAtUnix >= periodStartUnix && item.occurredAtUnix < periodEndUnix,
    )
    const buyers = lineItems.reduce((sum, item) => {
      const spent = spec.purchases.find(
        (purchase) => Math.round(nowUnix - purchase.daysAgo * DAY) === item.occurredAtUnix,
      )
      return sum + (spent?.attributedNewBuyers ?? 0)
    }, 0)
    const spentCents = lineItems
      .filter((item) => item.executed && item.withheldReason === undefined)
      .reduce((sum, item) => sum + item.amountCents, 0n)

    reports.push({
      vault,
      periodStartUnix,
      periodEndUnix,
      qfReceivedCents: grossCents,
      devLegCents: split.dev,
      budgetSpentCents: spentCents,
      operatorFeeCents: split.operator,
      lineItems,
      verifiedReachSummary:
        lineItems.length === 0
          ? 'Nothing was purchased this week. The procurement budget accrued and stayed in escrow.'
          : lineItems.length === 1
            ? '1 purchase, with a delivery predicate re-checked at T+24h and T+7d.'
            : `${lineItems.length} purchases, each with a delivery predicate re-checked at ` +
              'T+24h and T+7d.',
      attributedNewBuyers: buyers > 0 ? buyers : null,
      costPerAttributedBuyerCents: buyers > 0 ? spentCents / BigInt(buyers) : null,
      withheldPayments: lineItems
        .filter((item) => item.withheldReason !== undefined)
        .map((item) => ({
          vendorId: item.vendorId ?? 'unknown',
          vendorName: item.vendorName ?? 'unknown',
          amountCents: item.amountCents,
          reason: item.withheldReason ?? '',
        })),
      whatWeDidNotDo: [...WHAT_WE_DID_NOT_DO],
    })
  }

  return reports
}

export function buildFixtureDataset(nowUnix: number): FixtureDataset {
  const factory = addressFrom('factory')
  const protocol: M.ProtocolInfo = {
    chainId: VENUE.chainId,
    // Placeholder until DISCLOSURE.operatorName is set. The page renders it as
    // an unmissable defect rather than quietly printing a placeholder.
    operatorLegalName: 'SET_ME_BEFORE_LAUNCH',
    operatorAddresses: [
      {
        label: 'Operator treasury',
        address: addressFrom('operator/treasury'),
        role: 'Receives the operator fee, and is reimbursed for media bought as principal.',
      },
      {
        label: 'Operator relayer',
        address: addressFrom('operator/relayer'),
        role: 'Submits sweeps and claims. Holds no authority over any dev leg.',
      },
    ],
    factory,
    vaultDeployer: addressFrom('vaultDeployer'),
    vaultInitCodeHash: bytes32From('vaultInitCodeHash'),
    adapter: addressFrom('adapter/venue-v2'),
    termsUrl: 'https://receipts.invalid/terms/msa-v1',
    termsHash: bytes32From('terms/msa-v1'),
    operatorBps: TERMS.operatorBps,
    budgetBpsMaxOffered: TERMS.budgetBpsMax,
    receiptsBaseUrl: 'https://receipts.invalid',
  }

  const coins = new Map<string, FixtureCoin>()
  const vaultsByDev = new Map<string, string[]>()
  const order: string[] = []

  for (const [specIndex, spec] of COIN_SPECS.entries()) {
    const vault = addressFrom(`vault/${spec.key}`)
    const token = addressFrom(`token/${spec.key}`)
    const devSigner = addressFrom(`dev/${spec.key}`)
    const devPayout = addressFrom(`devpayout/${spec.key}`)
    const blockHash = bytes32From(`block/${spec.key}`)

    const periodEnd = nowUnix
    const periodStart = nowUnix - 7 * DAY
    const period = buildFeeFlow(spec.qfPerDayUsd * 7, spec, periodStart, periodEnd, blockHash)
    const lifetime = buildFeeFlow(
      spec.qfPerDayUsd * 7 * spec.lifetimeMultiple,
      spec,
      nowUnix - spec.ageDays * DAY,
      periodEnd,
      blockHash,
    )

    const receipts = buildReceipts(spec, vault, nowUnix)
    const vendors = buildVendorScorecards(spec, nowUnix)
    const reports = buildReports(spec, vault, receipts, nowUnix)

    const spentAllTime = receipts
      .filter((item) => item.executed && item.withheldReason === undefined)
      .reduce((sum, item) => sum + item.amountCents, 0n)
    const budgetBalanceCents =
      lifetime.budgetCents - spentAllTime > 0n ? lifetime.budgetCents - spentAllTime : 0n
    const unprovenEscrowCents = receipts
      .filter((item) => !item.executed)
      .reduce((sum, item) => sum + item.amountCents, 0n)

    const coin: M.PublicCoin = {
      identity: {
        vault,
        token,
        name: spec.name,
        symbol: spec.symbol,
        graduated: spec.graduated,
        launchedAtUnix: nowUnix - spec.ageDays * DAY,
        buybackEnabled: spec.buybackEnabled,
        creatorTaxBps: spec.creatorTaxBps,
      },
      state: spec.state,
      tier: spec.tier,
      operatorBps: TERMS.operatorBps,
      budgetBps: spec.budgetBps,
      budgetBpsMax: spec.budgetBpsMax,
      referrerBps: spec.referrerBps,
      qfPerDayUsd: spec.qfPerDayUsd,
      observedDays: spec.observedDays,
      sustainedDays: spec.sustainedDays,
      screening: { ...spec.screening, flags: [...spec.screening.flags] },
      period,
      lifetime,
      budgetBalanceCents,
      unprovenEscrowCents,
      balancesObservedAtUnix: nowUnix - 11 * 60,
      operatedAccounts: spec.accounts.map((account) => ({
        channel: account.channel,
        handle: account.handle,
        url:
          account.channel === 'telegram'
            ? `https://t.me/${account.handle}`
            : `https://x.com/${account.handle}`,
      })),
      paidPromotionInUse: spec.purchases.some((purchase) => purchase.executed),
      lastReconciledAtUnix: nowUnix - 42 * 60,
      reconciliationVariance: 'none',
      subject: {
        name: spec.name,
        symbol: spec.symbol,
        linkCount: spec.narrative.linkCount,
        narrativeSourceCount: spec.narrative.sourceCount,
      },
      narrativeApproved: spec.narrative.approved,
    }

    const summary: M.CoinSummary = {
      vault,
      token,
      name: spec.name,
      symbol: spec.symbol,
      tier: spec.tier,
      state: spec.state,
      qfPerDayUsd: spec.qfPerDayUsd,
      buybackEnabled: spec.buybackEnabled,
    }

    const escalations: M.Escalation[] = spec.escalations.map((escalation, index) => ({
      id: `${spec.key}-e${index}`,
      vault,
      reason: escalation.reason,
      priority: escalation.priority,
      summary: escalation.summary,
      evidence: [...escalation.evidence],
      openedAtUnix: nowUnix - escalation.hoursAgo * HOUR,
      slaDueAtUnix:
        nowUnix -
        escalation.hoursAgo * HOUR +
        (escalation.priority === 'critical'
          ? 15 * 60
          : escalation.priority === 'high'
            ? HOUR
            : escalation.priority === 'normal'
              ? 4 * HOUR
              : 24 * HOUR),
      acknowledgedAtUnix: escalation.acknowledged ? nowUnix - escalation.hoursAgo * HOUR + 900 : null,
      resolution: escalation.acknowledged ? 'Acknowledged by the dev. No further action requested.' : null,
    }))

    const devLegWethUsd = Number(period.devLegCents) / 100 / 2
    const devLegUsdgUsd = Number(period.devLegCents) / 100 / 2

    const detail: M.DevVaultDetail = {
      coin,
      devPayout,
      claimable: [
        {
          asset: WETH,
          devMinor: wethMinorForUsd(devLegWethUsd),
          usd: pricedUsd(devLegWethUsd, PRICES.weth.source, nowUnix - 11 * 60, blockHash),
        },
        {
          asset: USDG,
          devMinor: usdgMinorForUsd(devLegUsdgUsd),
          usd: pricedUsd(devLegUsdgUsd, PRICES.usdg.source, nowUnix - 11 * 60, blockHash),
        },
      ],
      pendingDial:
        spec.key === 'glint'
          ? { pendingBudgetBps: 1_000, effectiveAtUnix: nowUnix + 4 * DAY }
          : null,
      operatorNoticeUnix: null,
      deadManUnix: nowUnix + TERMS.deadManDays * DAY,
      lastHeartbeatUnix: nowUnix - 8 * 60,
    }

    // The team is derived from the same spec the fee flow is: a coin badged T0
    // gets a team with no model in it, and a RESTRICTED coin gets a broker that
    // is dormant with the screening verdict as its stated reason.
    const { agent, runs: agentRuns } = buildAgentFixture({
      key: spec.key,
      // Opaque and operator-assigned, exactly as the real config requires: it
      // is never the token address.
      coinRef: `coin_${spec.key}`,
      vault,
      tier: spec.tier,
      state: spec.state,
      screening: { ...spec.screening, flags: [...spec.screening.flags] },
      accountCount: spec.accounts.length,
      skuId: spec.purchases[0]?.skuId ?? null,
      // Position in the seed list, used only to alternate which window gets the
      // mention flood. A hash of the key was tried and put every coin on the
      // same window, which left the demo unable to show a live freeze at all.
      specIndex,
      nowUnix,
    })

    coins.set(vault, {
      summary,
      coin,
      receipts,
      vendors,
      reports,
      escalations,
      detail,
      agent,
      agentRuns,
      devSigner,
    })
    order.push(vault)
    vaultsByDev.set(devSigner, [...(vaultsByDev.get(devSigner) ?? []), vault])
  }

  return { nowUnix, protocol, order, coins, vaultsByDev }
}

/** Exposed so the demo can offer a "sign in as this coin's dev" shortcut. */
export function fixtureDevAddressFor(key: string): string {
  return addressFrom(`dev/${key}`)
}

export { SKUS as FIXTURE_SKUS, VENDORS as FIXTURE_VENDORS, TIERS as FIXTURE_TIERS, addressFrom as fixtureAddressFor, bytes32From as fixtureBytes32For }
