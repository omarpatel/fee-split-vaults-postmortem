/**
 * The weekly dev report, built from the books.
 *
 * Every number on it is derived from a store that something else wrote for
 * its own reasons - the ledger's flow entries, the receipt store, the tick's
 * run records, the predicate queue's withholds - and none of it is composed
 * by a model. The USD figures are the period's minor-unit flows priced at the
 * period end from the pinned book; an asset without a price refuses the whole
 * report rather than reporting the priced part as if it were the total.
 *
 * "WHAT WE DID NOT DO" is the product, and it is written from records rather
 * than prose: every refusal the coin's team recorded in the period, by phase
 * and code; every spend the gate declined; every proposal a freeze
 * suppressed; every vendor payment withheld. A period in which the team did
 * nothing at all still says so, because the section may not be empty.
 */

import type { Address, AssetAddress, LedgerEntry, Receipt, WeeklyReport } from '@fee-split-vaults/core'
import { accumulate, type LedgerStore, type PostingKind } from '@fee-split-vaults/ledger'
import { centsToUsd, minorToCents, requirePrice } from '@fee-split-vaults/orchestrator'
import type { AssetRegistry, ReceiptStore, UsdPriceBook } from '@fee-split-vaults/orchestrator'
import { DAY } from '../../lib/time.js'
import type { SqlDriver } from '../../migrations/driver.js'
import type { ReportBuilder } from '../ports.js'
import { OpsAdapterError, floatOf, strOf } from './errors.js'

export interface LedgerReportBuilderDeps {
  driver: SqlDriver
  store: LedgerStore
  receipts: ReceiptStore
  assets: AssetRegistry
  prices: UsdPriceBook
  /** Two days, the QF window's own limit. The report is a reading, not a spend. */
  maxPriceAgeSeconds?: number
}

const REPORT_PRICE_MAX_AGE_SECONDS = 2 * DAY

/** Free text on the report is a closed vocabulary rendered here, never a model's words. */
const PHASE_LABEL: Record<string, string> = {
  screening: 'the screening gate held',
  accrual: 'fee accrual could not be recorded',
  measure: 'QF could not be measured',
  tier: 'the tier was held',
  window: 'the cognition window did not run',
  plan: 'the planner did not run',
  spend: 'a purchase was refused',
  publish: 'a post was refused',
  desk: 'a holder question went unanswered',
}

interface RunRow {
  refusals_json: string
  spends_json: string
  suppressed_json: string
}

interface WithholdRow {
  vendor_id: string
  reason: string
  cost_usd: number | string
}

export class LedgerReportBuilder implements ReportBuilder {
  constructor(private readonly deps: LedgerReportBuilderDeps) {}

  async build(input: { vault: Address; periodStartUnix: number; periodEndUnix: number }): Promise<WeeklyReport> {
    const vault = input.vault.toLowerCase()
    const flows = await this.#periodFlows(vault, input.periodStartUnix, input.periodEndUnix)
    const usd = (kinds: readonly PostingKind[], negativeKinds: readonly PostingKind[] = []): number => {
      let cents = 0n
      for (const [asset, byKind] of flows) {
        let minor = 0n
        for (const kind of kinds) minor += byKind.get(kind) ?? 0n
        for (const kind of negativeKinds) minor -= byKind.get(kind) ?? 0n
        if (minor === 0n) continue
        cents += this.#cents(asset, minor, input.periodEndUnix)
      }
      return centsToUsd(cents)
    }

    const lineItems: Receipt[] = await this.deps.receipts.list(vault, {
      fromUnix: input.periodStartUnix,
      toUnix: input.periodEndUnix,
      publishedOnly: false,
    })
    const withheldPayments = await this.#withheld(vault, input.periodStartUnix, input.periodEndUnix)
    const whatWeDidNotDo = await this.#omissions(vault, input.periodStartUnix, input.periodEndUnix, lineItems, withheldPayments)

    const procurement = lineItems.filter((r) => r.kind === 'procurement')
    return {
      vault,
      periodStartUnix: input.periodStartUnix,
      periodEndUnix: input.periodEndUnix,
      qfReceivedUsd: usd(['accrue_income'], ['reverse_income']),
      devLegUsd: usd(['allocate_dev']),
      budgetSpentUsd: usd(['spend_procurement']),
      operatorFeeUsd: usd(['allocate_operator']),
      referrerFeeUsd: usd(['allocate_referrer']),
      lineItems,
      verifiedReachSummary:
        procurement.length === 0
          ? 'no paid placements this period, so no verified reach to report'
          : `${String(procurement.length)} paid placement(s) on the receipts ledger; delivery is verified by predicate, not by claim`,
      withheldPayments,
      whatWeDidNotDo,
    }
  }

  /** Per asset, per posting kind, the period's minor-unit total. */
  async #periodFlows(vault: string, fromUnix: number, toUnix: number): Promise<Map<string, Map<PostingKind, bigint>>> {
    const entries: LedgerEntry[] = []
    let cursor: string | undefined
    do {
      const page = await this.deps.store.listEntries({ vault, fromUnix, toUnix }, cursor)
      entries.push(...page.entries)
      cursor = page.cursor
    } while (cursor !== undefined)
    const out = new Map<string, Map<PostingKind, bigint>>()
    for (const flow of accumulate(entries).flows) {
      const asset = flow.asset.toLowerCase()
      const byKind = out.get(asset) ?? new Map<PostingKind, bigint>()
      byKind.set(flow.kind, (byKind.get(flow.kind) ?? 0n) + flow.amountMinor)
      out.set(asset, byKind)
    }
    return out
  }

  #cents(asset: AssetAddress, minor: bigint, atUnix: number): bigint {
    const known = this.deps.assets.get(asset)
    if (known === undefined) throw new OpsAdapterError('asset_unknown', `${asset} has fee flow but no registry entry`)
    let price
    try {
      price = requirePrice(this.deps.prices, asset, atUnix, this.deps.maxPriceAgeSeconds ?? REPORT_PRICE_MAX_AGE_SECONDS, 'measure')
    } catch (error) {
      throw new OpsAdapterError('price_missing', error instanceof Error ? error.message : String(error))
    }
    return minorToCents(minor, known.decimals, price)
  }

  async #withheld(vault: string, fromUnix: number, toUnix: number): Promise<WeeklyReport['withheldPayments']> {
    const rows = await this.deps.driver.query<WithholdRow>(
      `SELECT w.vendor_id, w.reason, MAX(c.cost_usd) AS cost_usd
         FROM ops_predicate_withhold w
         JOIN ops_predicate_check c ON c.disbursement_id = w.disbursement_id
        WHERE c.vault = $1 AND w.withheld_at_unix > $2 AND w.withheld_at_unix <= $3
        GROUP BY w.disbursement_id, w.vendor_id, w.reason
        ORDER BY w.disbursement_id`,
      [vault, fromUnix, toUnix],
    )
    return rows.map((row) => ({
      vendorId: strOf(row.vendor_id, 'ops_predicate_withhold.vendor_id'),
      amountUsd: floatOf(row.cost_usd, 'ops_predicate_check.cost_usd'),
      reason: strOf(row.reason, 'ops_predicate_withhold.reason'),
    }))
  }

  async #omissions(
    vault: string,
    fromUnix: number,
    toUnix: number,
    lineItems: readonly Receipt[],
    withheld: WeeklyReport['withheldPayments'],
  ): Promise<string[]> {
    const rows = await this.deps.driver.query<RunRow>(
      `SELECT refusals_json, spends_json, suppressed_json FROM ops_agent_run
        WHERE vault = $1 AND at_unix > $2 AND at_unix <= $3`,
      [vault, fromUnix, toUnix],
    )
    const refusals = new Map<string, number>()
    let spendsRefused = 0
    let suppressed = 0
    for (const row of rows) {
      for (const refusal of parseArray(row.refusals_json, 'ops_agent_run.refusals_json')) {
        const key = `${strOf(refusal.phase, 'refusal.phase')}:${strOf(refusal.code, 'refusal.code')}`
        refusals.set(key, (refusals.get(key) ?? 0) + 1)
      }
      for (const spend of parseArray(row.spends_json, 'ops_agent_run.spends_json')) {
        if (spend.approved !== true) spendsRefused += 1
      }
      suppressed += parseArray(row.suppressed_json, 'ops_agent_run.suppressed_json').length
    }

    const out: string[] = []
    for (const [key, count] of [...refusals.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const [phase, code] = key.split(':')
      const label = PHASE_LABEL[phase ?? ''] ?? `phase ${phase ?? 'unknown'} refused`
      out.push(`${label} (${code ?? 'unknown'}) on ${String(count)} tick(s).`)
    }
    if (spendsRefused > 0) out.push(`${String(spendsRefused)} proposed purchase(s) were declined by the spend gate.`)
    if (suppressed > 0) out.push(`${String(suppressed)} proposal(s) were suppressed by a freeze.`)
    for (const w of withheld) out.push(`Payment to ${w.vendorId} was withheld: ${w.reason}.`)
    if (lineItems.every((r) => r.kind !== 'procurement')) out.push('No paid promotion was purchased this period.')
    if (rows.length === 0) out.push('The coin’s team recorded no tick this period.')
    return out
  }
}

function parseArray(text: unknown, field: string): Array<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(strOf(text, field))
  if (!Array.isArray(parsed)) throw new OpsAdapterError('row_malformed', `${field} is not an array`)
  return parsed.map((item) => {
    if (typeof item !== 'object' || item === null) throw new OpsAdapterError('row_malformed', `${field} holds a non-object`)
    return item as Record<string, unknown>
  })
}
