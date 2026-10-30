/**
 * The weekly report.
 *
 * Two things make this different from an ordinary usage summary.
 *
 * FIGURES COME FROM FLOWS, NOT BALANCES. The ledger's income:fees account is
 * credited on accrual and debited again on allocation, so its balance is
 * "recognised but not yet split" and reads as roughly zero for a healthy coin.
 * Every money figure here is read from FLOW totals via incomeSummary() and the
 * per-account cumulative movements, never off a balance.
 *
 * `whatWeDidNotDo` IS NOT DECORATION. It is a fixed section and it is populated
 * from the actual refusal record - gates that fired, screening restrictions,
 * tiers withheld, payments not made. A report that only lists what was bought
 * is a sales document; the refusals are the part a client cannot get anywhere
 * else and the part that makes the rest credible.
 *
 * NOTHING HERE IS MODEL-AUTHORED. Every string is a template filled from typed
 * data, so a compromised cognition plane cannot write a client's report.
 */

import type { Address, Asset, Receipt, WeeklyReport } from '@fee-split-vaults/core'
import type { Ledger, LedgerStore } from '@fee-split-vaults/ledger'
import { iterateEntries } from '@fee-split-vaults/ledger'
import type { PinnedUsdPrice, ReceiptStore } from '@fee-split-vaults/orchestrator'
import { centsToUsd, minorToCents } from '@fee-split-vaults/orchestrator'

export interface WithheldPayment {
  vendorId: string
  amountUsd: number
  reason: string
}

export interface RefusalRecord {
  /** Machine code from the gate, the screener, or the tick loop. */
  code: string
  atUnix: number
  detail?: string
}

/** What a report needs of a quote asset: identity and scale. The token contract states both. */
export type ReportAsset = Pick<Asset, 'address' | 'symbol' | 'decimals'>

export interface ReportInput {
  vault: Address
  asset: ReportAsset
  price: PinnedUsdPrice
  ledger: Ledger
  store: LedgerStore
  receipts: ReceiptStore
  periodStartUnix: number
  periodEndUnix: number
  /** Refusals recorded over the period. Drives `whatWeDidNotDo`. */
  refusals: readonly RefusalRecord[]
  withheldPayments?: readonly WithheldPayment[]
  /** Verified delivery evidence, already checked by the predicate registry. */
  verifiedReach?: { deliveries: number; verified: number; note?: string }
  attributedNewBuyers?: number
  /** True when the coin ran with paid media unavailable for the whole period. */
  paidMediaPermitted: boolean
  tier: string
}

const DEBIT_ACCOUNTS = new Set(['asset:escrow', 'asset:vault', 'expense:procurement', 'expense:cogs'])

/** Cumulative movement into an account over a window, in minor units. */
async function movementMinor(
  store: LedgerStore,
  vault: Address,
  asset: string,
  account: string,
  fromUnix: number,
  toUnix: number,
): Promise<bigint> {
  let total = 0n
  for await (const entry of iterateEntries(store, {
    vault,
    asset,
    fromUnix,
    toUnix,
    accountAnySide: account,
  })) {
    if (entry.debit === account) total += entry.amountMinor
    if (entry.credit === account) total -= entry.amountMinor
  }
  // Liabilities and income are credit-normal, so their natural movement is the
  // negation of the debit-positive sum.
  return DEBIT_ACCOUNTS.has(account) ? total : -total
}

/**
 * The fixed refusal section.
 *
 * Codes are mapped to plain sentences here rather than at the point of refusal,
 * so a new gate cannot ship a client-facing sentence without someone editing
 * this table. An UNKNOWN code is reported verbatim as a code rather than
 * dropped: a refusal nobody can explain is still a refusal the client is owed.
 */
const REFUSAL_SENTENCES: Readonly<Record<string, string>> = {
  solvency: 'We declined purchases that your coin had not already banked the money for.',
  commitment_rule:
    'We declined a commitment that exceeded your coin’s own escrowed budget. We never finance against projected flow.',
  rolling_cap: 'We declined purchases that would have exceeded your rolling spend cap.',
  lifetime_cap: 'We declined purchases that would have exceeded the lifetime cap on spend.',
  category_subcap: 'We declined purchases that would have concentrated your budget in one category.',
  human_approval_pending: 'We held purchases above the human-approval threshold until a person reviewed them.',
  vendor_reliability: 'We declined vendors whose recent delivery record did not meet our bar.',
  related_party: 'We declined related-party spend beyond its cap.',
  measurability: 'We declined purchases whose delivery we could not machine-verify.',
  screening_missing: 'We ran organic operations only, because no current content screening was on file.',
  screening_blocked: 'We suspended all operations under a content screening block.',
  paid_media_not_permitted: 'We ran organic operations only. No paid media was bought.',
  asset_kill_switch: 'We stopped drawing on a quote asset that we could not safely claim from.',
  spend_authority_inactive: 'We suspended spending while a chain condition needed a human look.',
  ledger_freeze: 'We froze new spend authorisation while a reconciliation variance was open.',
  divergence_purchases:
    'We froze purchases after your channel’s topic mix shifted sharply alongside a mention spike.',
  divergence_all: 'We froze all proposals after an anomalous signal pattern.',
  anti_snipe_hold: 'We did not begin charging until the launch anti-snipe window had passed.',
  qf_measurement_stale: 'We held your tier rather than act on a fee measurement we could not refresh.',
  signals_unavailable: 'We held your tier because we could not measure holder breadth this period.',
  rate_limit: 'We declined proposals beyond the per-hour rate limit.',
  invoice_missing: 'We declined reimbursement for purchases with no countersigned vendor invoice.',
}

export function explainRefusals(refusals: readonly RefusalRecord[]): string[] {
  const seen = new Map<string, number>()
  for (const refusal of refusals) {
    seen.set(refusal.code, (seen.get(refusal.code) ?? 0) + 1)
  }
  const out: string[] = []
  for (const [code, count] of [...seen].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    const sentence = REFUSAL_SENTENCES[code]
    out.push(
      sentence === undefined
        ? `We refused ${String(count)} action(s) under the internal code "${code}".`
        : `${sentence} (${String(count)} time(s) this period.)`,
    )
  }
  return out
}

export async function buildWeeklyReport(input: ReportInput): Promise<WeeklyReport> {
  const { vault, asset, price, periodStartUnix, periodEndUnix } = input
  const assetKey = asset.address
  const usd = (minor: bigint): number => centsToUsd(minorToCents(minor, asset.decimals, price))

  const summaries = await input.ledger.incomeSummary({ vault, asset: assetKey })
  let recognizedAllTime = 0n
  for (const summary of summaries) recognizedAllTime += summary.recognizedMinor

  // The period figures come from movements inside the window; the all-time
  // recognition figure is reported alongside so a client can see the difference
  // between "earned this week" and "earned since we started".
  const qfMinor = await movementMinor(
    input.store,
    vault,
    assetKey,
    'income:fees',
    periodStartUnix,
    periodEndUnix,
  )
  const devMinor = await movementMinor(
    input.store,
    vault,
    assetKey,
    'liability:dev_claimable',
    periodStartUnix,
    periodEndUnix,
  )
  const operatorMinor = await movementMinor(
    input.store,
    vault,
    assetKey,
    'liability:operator_claimable',
    periodStartUnix,
    periodEndUnix,
  )
  const referrerMinor = await movementMinor(
    input.store,
    vault,
    assetKey,
    'liability:referrer_claimable',
    periodStartUnix,
    periodEndUnix,
  )
  const procurementMinor = await movementMinor(
    input.store,
    vault,
    assetKey,
    'expense:procurement',
    periodStartUnix,
    periodEndUnix,
  )

  const lineItems: Receipt[] = await input.receipts.list(vault, {
    fromUnix: periodStartUnix,
    toUnix: periodEndUnix,
    publishedOnly: true,
    nowUnix: periodEndUnix,
  })

  const budgetSpentUsd = usd(procurementMinor < 0n ? 0n : procurementMinor)
  const report: WeeklyReport = {
    vault,
    periodStartUnix,
    periodEndUnix,
    // The income movement is credit-normal; a period with accrual reads
    // positive. A negative reading means reversals exceeded accruals, which is
    // reported as zero received and shows up in the refusal section instead.
    qfReceivedUsd: usd(qfMinor < 0n ? 0n : qfMinor),
    devLegUsd: usd(devMinor < 0n ? 0n : devMinor),
    budgetSpentUsd,
    operatorFeeUsd: usd(operatorMinor < 0n ? 0n : operatorMinor),
    referrerFeeUsd: usd(referrerMinor < 0n ? 0n : referrerMinor),
    lineItems,
    verifiedReachSummary: renderReach(input),
    withheldPayments: [...(input.withheldPayments ?? [])],
    whatWeDidNotDo: renderWhatWeDidNotDo(input, recognizedAllTime, lineItems.length),
  }

  if (input.attributedNewBuyers !== undefined) {
    report.attributedNewBuyers = input.attributedNewBuyers
    if (input.attributedNewBuyers > 0 && budgetSpentUsd > 0) {
      report.costPerAttributedBuyerUsd = budgetSpentUsd / input.attributedNewBuyers
    }
  }
  return report
}

function renderReach(input: ReportInput): string {
  const reach = input.verifiedReach
  if (reach === undefined || reach.deliveries === 0) {
    return 'No paid deliveries this period, so there is nothing to verify and nothing to claim.'
  }
  const unverified = reach.deliveries - reach.verified
  const base =
    `${String(reach.verified)} of ${String(reach.deliveries)} purchased deliveries were ` +
    `machine-verified against their delivery predicate.`
  if (unverified <= 0) return reach.note === undefined ? base : `${base} ${reach.note}`
  return (
    `${base} ${String(unverified)} could not be verified and the corresponding payment was ` +
    `withheld or returned to your budget.`
  )
}

function renderWhatWeDidNotDo(
  input: ReportInput,
  recognizedAllTime: bigint,
  lineItemCount: number,
): string[] {
  const out: string[] = []

  if (!input.paidMediaPermitted) {
    out.push(
      'We bought no third-party paid media this period. Your tier or your current content ' +
        'screening does not permit it.',
    )
  }
  if (lineItemCount === 0) {
    out.push('We made no purchases on your behalf this period.')
  }
  out.push(...explainRefusals(input.refusals))

  // Fixed statements. These are true on every report and are here because they
  // are what a client most often assumes we DO.
  out.push(
    'We did not trade your token, hold it, or take any position in it. The operator is paid ' +
      'a share of credited fees and nothing else.',
  )
  out.push(
    'We did not move any of your money to a vendor. The operator buys media as principal in ' +
      'its own name and is reimbursed to its own treasury against a countersigned invoice.',
  )
  out.push(
    'We did not give price predictions, buy or sell advice, or any statement about future value, ' +
      'on any channel, to anyone who asked.',
  )
  if (recognizedAllTime === 0n) {
    out.push('We have recognised no fees for this coin at all, so nothing has been charged.')
  }
  return out
}
