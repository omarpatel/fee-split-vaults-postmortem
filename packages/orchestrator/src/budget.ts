/**
 * Turning the ledger into the exact view the broker's gates need.
 *
 * The broker consumes BudgetLedgerView and SpendCounters and validates their
 * freshness; deriving them idempotently from the double-entry book is named as
 * a followup by both packages and is done here.
 *
 * THE FINALITY SPLIT. The ledger has no concept of finality - it recognises
 * what the chain reported. The indexer knows which postings are finalized. So
 * `finalizedBudget` is the ledger's banked budget MINUS the budget share of
 * postings still inside the reorg window, and `unfinalizedBudget` is that
 * subtracted amount. The broker's solvency gate reads only the first; the
 * second exists so a reviewer can see what was excluded rather than infer it.
 *
 * Every figure is derived in bigint minor units, converted to cents at a pinned
 * price, and only then widened to the `number` USD the shared contract uses.
 * Balances floor and obligations ceil, so rounding always favours the client.
 */

import type { Address, Asset, LedgerAccount, UsdValue } from '@fee-split-vaults/core'
import type { BudgetLedgerView, SpendCounters, SkuCategory } from '@fee-split-vaults/broker'
import { ROLLING_WINDOW_DAYS } from '@fee-split-vaults/broker'
import type { Ledger, LedgerStore } from '@fee-split-vaults/ledger'
import { iterateEntries } from '@fee-split-vaults/ledger'
import type { FeePosting } from '@fee-split-vaults/indexer'
import { FailClosed } from './errors.js'
import type { FleetCounters, PinnedUsdPrice } from './ports.js'
import { toUsdValue, usdFromCents, zeroUsd } from './prices.js'

const DAY_SECONDS = 86_400

export interface BudgetViewInput {
  ledger: Ledger
  /** Read side for the per-day walk. The Ledger facade has no entry listing. */
  store: LedgerStore
  vault: Address
  asset: Asset
  price: PinnedUsdPrice
  /** Postings the indexer has NOT yet marked finalized, for this vault+asset. */
  unfinalizedPostings: readonly FeePosting[]
  /** The dev's dial, in bps. Decides the budget share of an unfinalized credit. */
  budgetBps: number
  /** Metered inference and cost-to-serve already charged this period. */
  inferenceChargedMinor: bigint
  /**
   * Procurement spend this period by SKU category, in USD CENTS.
   *
   * CENTS, NOT MINOR UNITS, and the difference matters. This figure comes from
   * the disbursement counters, which record what was actually paid in cents,
   * and the gate compares it in cents. Carrying it through minor units would
   * mean dividing by a pinned price and multiplying back, and `minorToCents`
   * floors - so the value the gate finally saw would be a cent or two BELOW
   * what was really spent. Under-counting a spend counter opens the cap it
   * bounds, so the round trip is not a rounding nicety, it is the wrong
   * direction. The value is carried in the unit it was measured in.
   */
  categorySpendCents: Partial<Record<SkuCategory, bigint>>
  /** Obligations signed but not yet disbursed. */
  outstandingObligationsMinor: bigint
  nowUnix: number
  /** Start of the current sub-cap period. Defaults to the trailing 30 days. */
  periodStartUnix?: number
}

function dayIndex(unix: number): number {
  return Math.floor(unix / DAY_SECONDS)
}

/**
 * Sum a signed balance for one account. Balances are stored debit-positive, so
 * a liability's natural (credit) balance is the negation.
 */
async function accountBalanceMinor(
  ledger: Ledger,
  vault: Address,
  asset: string,
  account: LedgerAccount,
): Promise<bigint> {
  const signed = await ledger.balanceOf(vault, asset, account)
  return account.startsWith('liability:') || account.startsWith('income:') ? -signed : signed
}

/**
 * Daily budget accrual over exactly ROLLING_WINDOW_DAYS, oldest first,
 * zero-filled. The broker refuses a short or long series rather than padding
 * one at read time, and zero-filling biases the median DOWN, which is the
 * conservative direction.
 */
export async function dailyBudgetAccrualMinor(
  store: LedgerStore,
  vault: Address,
  asset: string,
  nowUnix: number,
  days: number = ROLLING_WINDOW_DAYS,
): Promise<bigint[]> {
  const lastDay = dayIndex(nowUnix)
  const firstDay = lastDay - days + 1
  const buckets = new Array<bigint>(days).fill(0n)

  for await (const entry of iterateEntries(store, {
    vault,
    asset,
    fromUnix: firstDay * DAY_SECONDS,
    toUnix: (lastDay + 1) * DAY_SECONDS - 1,
    accountAnySide: 'liability:budget',
  })) {
    // Only the ALLOCATION leg is accrual. A release out of the budget leg is a
    // spend, and counting it here would let spending inflate the cap that
    // bounds spending.
    if (entry.credit !== 'liability:budget') continue
    const slot = dayIndex(entry.occurredAtUnix) - firstDay
    if (slot < 0 || slot >= days) continue
    buckets[slot] = (buckets[slot] ?? 0n) + entry.amountMinor
  }
  return buckets
}

/** Cumulative procurement spend, all time and inside the rolling window. */
async function spendMinor(
  store: LedgerStore,
  vault: Address,
  asset: string,
  fromUnix?: number,
): Promise<bigint> {
  let total = 0n
  const filter = fromUnix === undefined
    ? { vault, asset, accountAnySide: 'expense:procurement' }
    : { vault, asset, accountAnySide: 'expense:procurement', fromUnix }
  for await (const entry of iterateEntries(store, filter)) {
    if (entry.debit === 'expense:procurement') total += entry.amountMinor
    else if (entry.credit === 'expense:procurement') total -= entry.amountMinor
  }
  return total < 0n ? 0n : total
}

async function accrualSinceMinor(
  store: LedgerStore,
  vault: Address,
  asset: string,
  fromUnix: number,
): Promise<bigint> {
  let total = 0n
  for await (const entry of iterateEntries(store, {
    vault,
    asset,
    fromUnix,
    accountAnySide: 'liability:budget',
  })) {
    if (entry.credit === 'liability:budget') total += entry.amountMinor
  }
  return total
}

export async function buildBudgetLedgerView(input: BudgetViewInput): Promise<BudgetLedgerView> {
  const { ledger, store, vault, asset, price, nowUnix } = input
  const assetKey = asset.address
  if (assetKey.toLowerCase() !== price.asset.toLowerCase()) {
    throw new FailClosed('spend', 'price_asset_mismatch', 'budget price is for another asset')
  }

  const bankedBudget = await accountBalanceMinor(ledger, vault, assetKey, 'liability:budget')

  // The budget share of anything the chain has not finalized. It is banked in
  // the ledger's eyes and unspendable in the broker's, and the difference is
  // exactly this number.
  let unfinalizedCredit = 0n
  for (const posting of input.unfinalizedPostings) {
    if (posting.asset.toLowerCase() !== assetKey.toLowerCase()) continue
    if (posting.finalized) continue
    unfinalizedCredit += (posting.creditedMinor * BigInt(input.budgetBps)) / 10_000n
  }
  const unfinalized = unfinalizedCredit > bankedBudget ? bankedBudget : unfinalizedCredit
  const finalized = bankedBudget - unfinalized

  // NOT the income:fees balance. That account is credited on accrual and
  // debited again on allocation, so its balance is "recognised but not yet
  // split", which reads as zero for a healthy coin. The cumulative figure lives
  // in the FLOW totals, which is what incomeSummary() reads.
  const summaries = await ledger.incomeSummary({ vault, asset: assetKey })
  let cumulativeFees = 0n
  for (const summary of summaries) cumulativeFees += summary.recognizedMinor
  const lifetimeSpend = await spendMinor(store, vault, assetKey)
  const rollingFrom = nowUnix - ROLLING_WINDOW_DAYS * DAY_SECONDS
  const rollingSpend = await spendMinor(store, vault, assetKey, rollingFrom)
  const budget30d = await accrualSinceMinor(store, vault, assetKey, nowUnix - 30 * DAY_SECONDS)
  const periodStart = input.periodStartUnix ?? nowUnix - 30 * DAY_SECONDS
  const periodBudget = await accrualSinceMinor(store, vault, assetKey, periodStart)
  const daily = await dailyBudgetAccrualMinor(store, vault, assetKey, nowUnix)

  const usd = (minor: bigint): UsdValue => toUsdValue(minor, asset, price)

  const categorySpendThisPeriod: Partial<Record<SkuCategory, UsdValue>> = {}
  for (const [category, cents] of Object.entries(input.categorySpendCents)) {
    if (cents === undefined) continue
    categorySpendThisPeriod[category as SkuCategory] = usdFromCents(cents, price)
  }

  return {
    finalizedBudget: usd(finalized),
    unfinalizedBudget: usd(unfinalized),
    outstandingObligations: usd(input.outstandingObligationsMinor),
    dailyBudgetAccrual: daily.map((m) => (m === 0n ? zeroUsd(price) : usd(m))),
    cumulativeRealizedFees: usd(cumulativeFees < 0n ? 0n : cumulativeFees),
    lifetimeSpend: usd(lifetimeSpend),
    rollingWindowSpend: usd(rollingSpend),
    budget30d: usd(budget30d),
    periodBudget: usd(periodBudget),
    inferenceChargedThisPeriod: usd(input.inferenceChargedMinor),
    categorySpendThisPeriod,
  }
}

export interface CountersInput {
  fleet: FleetCounters
  vault: Address
  vendorId: string
  nowUnix: number
}

/**
 * Fleet-wide counters, freshly counted.
 *
 * `countedAtUnix` is set to the moment of counting rather than carried from a
 * cache, because the broker refuses counters older than 300 seconds and a stale
 * counter must present as unknown - and unknown means no spend.
 */
export async function buildSpendCounters(input: CountersInput): Promise<SpendCounters> {
  const { fleet, vault, vendorId, nowUnix } = input

  const [
    proposalsLastHourForVault,
    disbursementsTodayForVault,
    disbursementsTodayFleet,
    vendorDisbursementsTodayForVault,
    vendorSpendTodayFleetCents,
    relatedPartySpend30dCents,
  ] = await Promise.all([
    fleet.proposalsLastHour(vault, nowUnix),
    fleet.disbursementsTodayForVault(vault, nowUnix),
    fleet.disbursementsToday(nowUnix),
    fleet.vendorDisbursementsTodayForVault(vault, vendorId, nowUnix),
    fleet.vendorSpendTodayCents(vendorId, nowUnix),
    fleet.relatedPartySpend30dCents(vault, nowUnix),
  ])

  // The fleet counters are already USD cents, so they do not go through an
  // asset price. Widening happens once, here, and the UsdValue records that the
  // provenance is the counter store rather than a market price.
  const fromCents = (cents: bigint): UsdValue => ({
    usd: Number(cents) / 100,
    priceSource: 'fleet_counters',
    pricedAtUnix: nowUnix,
  })

  return {
    proposalsLastHourForVault,
    disbursementsTodayForVault,
    disbursementsTodayFleet,
    vendorDisbursementsTodayForVault,
    vendorSpendTodayFleet: fromCents(vendorSpendTodayFleetCents),
    relatedPartySpend30d: fromCents(relatedPartySpend30dCents),
    countedAtUnix: nowUnix,
  }
}
