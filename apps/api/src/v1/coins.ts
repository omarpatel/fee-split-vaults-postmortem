/**
 * The public coin record, as the receipts page reads it.
 *
 * THIS IS THE ARTIFACT ANYONE CAN CACHE. Every field is either already public
 * on chain (addresses, bps, states, credited amounts), a number this service
 * measured (QF/day, delivery checks), or an explicitly public-record fact of
 * the onboarding (the scrubbed name and symbol, the counts). What never
 * appears: links, narrative sources, socials, screening flags, the dev's
 * signature, anything a dev typed at full fidelity.
 *
 * MONEY LEAVES AS DECIMAL STRINGS. Minor units and cents are bigint here and
 * `String(bigint)` on the wire; a JSON number never carries an amount. Every
 * USD figure carries the price that produced it, and a coin with credits and
 * no pinned price REFUSES rather than printing a guess - the same rule the
 * weekly report holds.
 */

import type { Address, Receipt } from '@fee-split-vaults/core'
import type { Ledger, LedgerStore } from '@fee-split-vaults/ledger'
import { iterateEntries } from '@fee-split-vaults/ledger'
import type { PinnedUsdPrice, ReceiptStore } from '@fee-split-vaults/orchestrator'
import { minorToCents } from '@fee-split-vaults/orchestrator'
import type { CoinBinding } from '@fee-split-vaults/indexer'

import { safeEcho } from '../echo.js'
import { HttpError } from '../http/router.js'
import type { OnboardingRecord } from '../onboarding.js'
import { toVault } from '../onboarding.js'
import type { ReportAsset } from '../report.js'
import type { RouteDeps } from '../routes.js'
import type {
  EscalationRecord,
  OperatedAccounts,
  ProcurementOutcome,
  ProcurementOutcomes,
  QfReader,
  VendorSummary,
} from './ports.js'

/** Onboarding states at which a vault exists and the coin is a member of the directory. */
export const MEMBER_STATES: Readonly<Record<string, true>> = {
  deployed: true,
  awaiting_pointing: true,
  pointed: true,
  accepted: true,
  active: true,
}

export const RECEIPT_PAGE_SIZE = 25

const DAY = 86_400

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export interface PricedAsset {
  asset: ReportAsset
  price: PinnedUsdPrice | undefined
}

export function usdWire(minor: bigint, priced: PricedAsset): Record<string, unknown> {
  if (priced.price === undefined) {
    // Reachable only for a non-zero amount; the callers short-circuit zero.
    throw new HttpError(503, 'price_unavailable', 'no pinned price for this asset; refusing to state a USD figure')
  }
  return {
    cents: String(minorToCents(minor, priced.asset.decimals, priced.price)),
    priceSource: priced.price.source,
    pricedAtUnix: priced.price.pricedAtUnix,
    ...(priced.price.blockHash === undefined ? {} : { blockHash: priced.price.blockHash }),
  }
}

/** Cents as a decimal string; zero needs no price. */
export function centsOf(minor: bigint, priced: PricedAsset): string {
  if (minor === 0n) return '0'
  if (priced.price === undefined) {
    throw new HttpError(503, 'price_unavailable', 'no pinned price for this asset; refusing to state a USD figure')
  }
  return String(minorToCents(minor, priced.asset.decimals, priced.price))
}

/** Float USD from the receipts ledger to integer cents. Receipts are reporting figures. */
export function usdToCents(usd: number): string {
  return String(Math.round(usd * 100))
}

const DEBIT_ACCOUNTS: Readonly<Record<string, true>> = {
  'asset:escrow': true,
  'asset:vault': true,
  'expense:procurement': true,
  'expense:cogs': true,
}

interface Movements {
  fees: bigint
  dev: bigint
  budget: bigint
  operator: bigint
  referrer: bigint
  latestUnix: number
}

const MOVEMENT_ACCOUNTS: Readonly<Record<string, keyof Omit<Movements, 'latestUnix'>>> = {
  'income:fees': 'fees',
  'liability:dev_claimable': 'dev',
  'liability:budget': 'budget',
  'liability:operator_claimable': 'operator',
  'liability:referrer_claimable': 'referrer',
}

/** Natural-sign movement into each reported account over a window, one pass over the entries. */
async function movements(
  store: LedgerStore,
  vault: Address,
  asset: string,
  fromUnix: number,
  toUnix: number,
): Promise<Movements> {
  const out: Movements = { fees: 0n, dev: 0n, budget: 0n, operator: 0n, referrer: 0n, latestUnix: 0 }
  for await (const entry of iterateEntries(store, { vault, asset, fromUnix, toUnix })) {
    if (entry.occurredAtUnix > out.latestUnix) out.latestUnix = entry.occurredAtUnix
    for (const [account, key] of Object.entries(MOVEMENT_ACCOUNTS)) {
      let delta = 0n
      if (entry.debit === account) delta += entry.amountMinor
      if (entry.credit === account) delta -= entry.amountMinor
      if (delta === 0n) continue
      out[key] += DEBIT_ACCOUNTS[account] === true ? delta : -delta
    }
  }
  return out
}

function nonNegative(value: bigint): bigint {
  return value < 0n ? 0n : value
}

async function feeFlowPeriod(
  store: LedgerStore,
  vault: Address,
  priced: PricedAsset | undefined,
  fromUnix: number,
  toUnix: number,
): Promise<{ body: Record<string, unknown>; latestUnix: number }> {
  const empty = {
    periodStartUnix: fromUnix,
    periodEndUnix: toUnix,
    perAsset: [] as unknown[],
    qfGrossCents: '0',
    devLegCents: '0',
    budgetCents: '0',
    operatorFeeCents: '0',
    referrerCents: '0',
  }
  if (priced === undefined) return { body: empty, latestUnix: 0 }
  const moved = await movements(store, vault, priced.asset.address, fromUnix, toUnix)
  const credited = nonNegative(moved.fees)
  return {
    latestUnix: moved.latestUnix,
    body: {
      ...empty,
      perAsset:
        credited === 0n
          ? []
          : [
              {
                asset: { address: priced.asset.address, symbol: priced.asset.symbol, decimals: priced.asset.decimals },
                creditedMinor: String(credited),
                usd: usdWire(credited, priced),
              },
            ],
      qfGrossCents: centsOf(credited, priced),
      devLegCents: centsOf(nonNegative(moved.dev), priced),
      budgetCents: centsOf(nonNegative(moved.budget), priced),
      operatorFeeCents: centsOf(nonNegative(moved.operator), priced),
      referrerCents: centsOf(nonNegative(moved.referrer), priced),
    },
  }
}

// ---------------------------------------------------------------------------
// The coin
// ---------------------------------------------------------------------------

export interface CoinSources {
  fleetVaults?: { get(address: Address): Promise<{ state: string; tier: string; budgetBps: number; buybackEnabled: boolean; creatorTaxBps: number } | undefined> }
  bindings?: { bindingByToken(token: Address): Promise<CoinBinding | undefined> }
  qf: QfReader
  reporting: RouteDeps['reporting']
  ledger: Ledger
  ledgerStore: LedgerStore
  accounts: OperatedAccounts
  outcomes: ProcurementOutcomes
  now: () => number
}

/** The cheap facts every summary and every record needs. One vault-row read, one binding read. */
async function coinFacts(sources: CoinSources, record: OnboardingRecord) {
  const [row, binding, qf] = await Promise.all([
    sources.fleetVaults?.get(record.vault),
    sources.bindings?.bindingByToken(record.token),
    sources.qf.latest(record.vault),
  ])
  const implied = toVault(record, binding?.buybackEnabled ?? false, binding?.creatorTaxBps ?? 0)
  return {
    state: row?.state ?? implied.state,
    tier: row?.tier ?? 'T0',
    budgetBps: row?.budgetBps ?? 0,
    buybackEnabled: row?.buybackEnabled ?? implied.buybackEnabled,
    creatorTaxBps: row?.creatorTaxBps ?? implied.creatorTaxBps,
    graduated: binding?.graduatedAtUnix !== undefined,
    launchedAtUnix: record.launchedAtUnix ?? binding?.launchedAtUnix ?? 0,
    qf,
  }
}

export async function coinSummaryBody(sources: CoinSources, record: OnboardingRecord): Promise<Record<string, unknown>> {
  const facts = await coinFacts(sources, record)
  return {
    vault: record.vault,
    token: record.token,
    name: safeEcho(record.name, 'name'),
    symbol: safeEcho(record.symbol, 'symbol'),
    tier: facts.tier,
    state: facts.state,
    qfPerDayUsd: facts.qf?.qfPerDayUsd ?? 0,
    buybackEnabled: facts.buybackEnabled,
  }
}

/** The quote asset and its pinned price, or undefined when the vault has no known asset yet. */
export async function pricedAssetOf(sources: Pick<CoinSources, 'reporting' | 'now'>, vault: Address): Promise<PricedAsset | undefined> {
  const asset = await sources.reporting.assetFor(vault)
  if (asset === undefined) return undefined
  return { asset, price: await sources.reporting.priceFor(asset.address, sources.now()) }
}

export async function publicCoinBody(sources: CoinSources, record: OnboardingRecord): Promise<Record<string, unknown>> {
  const now = sources.now()
  const facts = await coinFacts(sources, record)
  const priced = await pricedAssetOf(sources, record.vault)
  const [period, lifetime, accounts, outcomes, variances, recognitions] = await Promise.all([
    feeFlowPeriod(sources.ledgerStore, record.vault, priced, now - 7 * DAY, now),
    feeFlowPeriod(sources.ledgerStore, record.vault, priced, 0, now),
    sources.accounts.forVault(record.vault),
    sources.outcomes.forVault(record.vault),
    sources.ledgerStore.listVariances({ vault: record.vault }),
    sources.ledgerStore.listRecognitions({ vault: record.vault }),
  ])

  let budgetBalance = 0n
  let escrowBalance = 0n
  if (priced !== undefined) {
    budgetBalance = nonNegative(-(await sources.ledger.balanceOf(record.vault, priced.asset.address, 'liability:budget')))
    escrowBalance = nonNegative(await sources.ledger.balanceOf(record.vault, priced.asset.address, 'asset:escrow'))
  }

  const latestVariance = variances.reduce<(typeof variances)[number] | undefined>(
    (best, v) => (best === undefined || v.detectedAtUnix > best.detectedAtUnix ? v : best),
    undefined,
  )
  const lastRecognised = recognitions.reduce((max, r) => Math.max(max, r.lastObservedAtUnix), 0)

  return {
    identity: {
      vault: record.vault,
      token: record.token,
      name: safeEcho(record.name, 'name'),
      symbol: safeEcho(record.symbol, 'symbol'),
      graduated: facts.graduated,
      launchedAtUnix: facts.launchedAtUnix,
      buybackEnabled: facts.buybackEnabled,
      creatorTaxBps: facts.creatorTaxBps,
    },
    state: facts.state,
    tier: facts.tier,
    operatorBps: record.consent.operatorBps,
    budgetBps: facts.budgetBps,
    budgetBpsMax: record.consent.budgetBpsMax,
    referrerBps: record.consent.referrerBps,
    qfPerDayUsd: facts.qf?.qfPerDayUsd ?? 0,
    observedDays: facts.qf?.observedDays ?? 0,
    sustainedDays: facts.qf?.sustainedDays ?? 0,
    screening: {
      verdict: record.screening?.verdict ?? 'RESTRICTED',
      paidMediaPermitted: record.screening?.paidMediaPermitted ?? false,
      // The matcher that fired is operator-facing: publishing it is an evasion guide.
      flags: [],
    },
    period: period.body,
    lifetime: lifetime.body,
    budgetBalanceCents: priced === undefined ? '0' : centsOf(budgetBalance, priced),
    unprovenEscrowCents: priced === undefined ? '0' : centsOf(escrowBalance, priced),
    balancesObservedAtUnix: now,
    operatedAccounts: accounts,
    paidPromotionInUse: outcomes.length > 0,
    lastReconciledAtUnix: Math.max(latestVariance?.detectedAtUnix ?? 0, lastRecognised, lifetime.latestUnix),
    reconciliationVariance: latestVariance?.severity ?? 'none',
    subject: {
      name: safeEcho(record.name, 'name'),
      symbol: safeEcho(record.symbol, 'symbol'),
      linkCount: record.links.length,
      narrativeSourceCount: record.narrativeSources.length,
    },
    narrativeApproved: record.narrative !== undefined,
  }
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

function checkBody(check: ProcurementOutcome['checks'][number]): Record<string, unknown> {
  return {
    checkedAtUnix: check.checkedAtUnix,
    offsetSeconds: check.offsetSeconds,
    passed: check.passed,
    ...(check.evidenceUri === undefined ? {} : { evidenceUri: check.evidenceUri }),
    ...(check.evidenceHash === undefined ? {} : { evidenceHash: check.evidenceHash }),
    ...(check.note === undefined ? {} : { note: safeEcho(check.note, 'note') }),
  }
}

export function receiptItemBody(
  receipt: Receipt,
  outcome: ProcurementOutcome | undefined,
  vendors: ReadonlyMap<string, VendorSummary>,
): Record<string, unknown> {
  const vendor = outcome === undefined ? undefined : vendors.get(outcome.vendorId)
  return {
    id: receipt.id,
    kind: receipt.kind,
    description: safeEcho(receipt.description, 'description'),
    amountCents: usdToCents(receipt.amountUsd),
    occurredAtUnix: receipt.occurredAtUnix,
    publishAfterUnix: receipt.publishAfterUnix,
    // A procurement receipt is written when the money moves; what is still
    // open is whether delivery was proven, which the checks below carry.
    executed: true,
    ...(outcome === undefined
      ? {}
      : {
          vendorId: outcome.vendorId,
          ...(vendor === undefined ? {} : { vendorName: vendor.displayName, vendorIsRelatedParty: vendor.isRelatedParty }),
          skuId: outcome.skuId,
          predicateKind: outcome.predicateKind,
          ...(outcome.withheldReason === undefined ? {} : { withheldReason: outcome.withheldReason }),
        }),
    ...(receipt.evidenceUri === undefined ? {} : { permalink: receipt.evidenceUri }),
    predicateResults: outcome === undefined ? [] : outcome.checks.map(checkBody),
  }
}

/**
 * Published receipts, newest first, cursor-paged. The cursor is the position
 * in the published list; a bad one is refused rather than restarted.
 */
export async function receiptPageBody(
  receipts: ReceiptStore,
  outcomes: ProcurementOutcomes,
  vendors: ReadonlyMap<string, VendorSummary>,
  vault: Address,
  cursor: string | undefined,
  nowUnix: number,
): Promise<Record<string, unknown>> {
  const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10)
  if (cursor !== undefined && (!/^\d{1,9}$/.test(cursor) || !Number.isInteger(offset))) {
    throw new HttpError(400, 'bad_cursor', 'cursor must be a small non-negative integer')
  }
  const all = (await receipts.list(vault, { publishedOnly: true, nowUnix })).sort(
    (a, b) => b.occurredAtUnix - a.occurredAtUnix || (a.id < b.id ? 1 : -1),
  )
  const page = all.slice(offset, offset + RECEIPT_PAGE_SIZE)
  const items: Record<string, unknown>[] = []
  for (const receipt of page) {
    const outcome = receipt.disbursementId === undefined ? undefined : await outcomes.forDisbursement(receipt.disbursementId)
    items.push(receiptItemBody(receipt, outcome, vendors))
  }
  return {
    items,
    nextCursor: offset + RECEIPT_PAGE_SIZE < all.length ? String(offset + RECEIPT_PAGE_SIZE) : null,
  }
}

// ---------------------------------------------------------------------------
// Vendor scorecards: measured, not vendor-reported
// ---------------------------------------------------------------------------

export function vendorScorecardsBody(
  vendors: readonly VendorSummary[],
  outcomes: readonly ProcurementOutcome[],
): Record<string, unknown>[] {
  return vendors.map((vendor) => {
    const own = outcomes.filter((o) => o.vendorId === vendor.id)
    let spendCents = 0n
    let withheldCents = 0n
    let passed = 0
    let failed = 0
    let last: number | null = null
    for (const outcome of own) {
      const cents = BigInt(usdToCents(outcome.costUsd))
      spendCents += cents
      if (outcome.withheldReason !== undefined) withheldCents += cents
      for (const check of outcome.checks) {
        if (check.passed) passed += 1
        else failed += 1
      }
      if (last === null || outcome.fundedAtUnix > last) last = outcome.fundedAtUnix
    }
    return {
      vendorId: vendor.id,
      displayName: vendor.displayName,
      isRelatedParty: vendor.isRelatedParty,
      enabled: vendor.enabled,
      reliabilityScore: vendor.reliabilityScore,
      purchases: own.length,
      spendCents: String(spendCents),
      // No deliverable carries buyer attribution today. Zero renders as
      // "n/a" on the page, and a cost-per-buyer would be a false positive.
      attributedNewBuyers: 0,
      costPerAttributedBuyerCents: null,
      predicatesPassed: passed,
      predicatesFailed: failed,
      withheldCents: String(withheldCents),
      lastPurchaseAtUnix: last,
    }
  })
}

// ---------------------------------------------------------------------------
// Escalations, as the dev sees them
// ---------------------------------------------------------------------------

const PRIORITY_BY_KIND: Readonly<Record<string, 'low' | 'normal' | 'high' | 'critical'>> = {
  ledger_freeze: 'critical',
  divergence_freeze: 'critical',
  settlement_failed: 'critical',
  indexer_halt: 'high',
  screening_blocked: 'high',
  screening_missing: 'high',
  planner_escalation: 'normal',
  desk_escalation: 'normal',
  tier_downgrade: 'low',
}

const SLA_SECONDS: Readonly<Record<'low' | 'normal' | 'high' | 'critical', number>> = {
  critical: 4 * 3_600,
  high: 24 * 3_600,
  normal: 3 * DAY,
  low: 7 * DAY,
}

export function escalationBody(row: EscalationRecord): Record<string, unknown> {
  const priority = PRIORITY_BY_KIND[row.kind] ?? 'normal'
  return {
    id: row.id,
    vault: row.vault,
    reason: `${row.kind}:${row.code}`,
    priority,
    summary: safeEcho(row.detail, 'detail'),
    evidence: [],
    openedAtUnix: row.raisedAtUnix,
    slaDueAtUnix: row.raisedAtUnix + SLA_SECONDS[priority],
    acknowledgedAtUnix: row.acknowledgedAtUnix ?? null,
    resolution: row.resolvedAtUnix !== undefined ? 'resolved' : (row.ackDecision ?? null),
  }
}
