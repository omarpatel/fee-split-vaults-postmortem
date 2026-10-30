/**
 * Weekly report delivery to the coin's Telegram chat.
 *
 * The chat is the one the operator bound to the coin in its directory entry
 * (the `telegram` account, which for this bot is a chat id) - never an id from
 * a message, a model, or the report. A coin with no bound chat is refused with
 * `chat_unbound`; there is no fallback channel, because a report sent to the
 * wrong room is a client's books in a stranger's hands.
 *
 * DISCLOSURE IS COMPOSED HERE, BY CODE. The message does not pass through the
 * publisher (a report is not a post: no approval queue, no promotional
 * classification, no account roster), so rule 7 is honoured directly with the
 * publisher's own `composeDisclosedMessage` - the same renderer, the same
 * token check, the same character budget - naming the operator from config
 * through core's placeholder guard. A placeholder operator name refuses.
 *
 * ONE DELIVERY PER PERIOD. ops_report_delivery is unique on (vault,
 * period_end); a retried job finds the row and reports the prior delivery
 * rather than sending the week twice.
 */

import { requireOperatorName, type WeeklyReport } from '@fee-split-vaults/core'
import {
  composeDisclosedMessage,
  receiptUrlFor,
  TELEGRAM_LIMITS,
  type TelegramTransport,
} from '@fee-split-vaults/publisher'
import { canonicalDigest, sha256Hex } from '../../lib/ids.js'
import type { Clock } from '../../lib/time.js'
import type { SqlDriver } from '../../migrations/driver.js'
import type { ReportDelivery } from '../ports.js'
import { OpsAdapterError, intOf, strOf } from './errors.js'

export interface TelegramReportDeliveryDeps {
  driver: SqlDriver
  transport: Pick<TelegramTransport, 'sendMessage'>
  /** The coin's bound Telegram chat, from the operator's directory. */
  chatFor(vault: string): string | undefined
  /** DISCLOSURE.operatorName from config; checked here, not trusted. */
  operatorName: string
  receiptsBaseUrl: string
  clock: Clock
}

const CHANNEL = 'telegram'

export function renderReportBody(report: WeeklyReport): string {
  const day = (unix: number): string => new Date(unix * 1000).toISOString().slice(0, 10)
  const usd = (value: number): string => `$${value.toFixed(2)}`
  const lines = [
    `Weekly report ${day(report.periodStartUnix)} to ${day(report.periodEndUnix)}`,
    '',
    `Fees recognised: ${usd(report.qfReceivedUsd)}`,
    `Your leg: ${usd(report.devLegUsd)}`,
    `Promotion budget spent: ${usd(report.budgetSpentUsd)}`,
    `Operator fee: ${usd(report.operatorFeeUsd)}`,
    `Referrer fee (out of the operator's share): ${usd(report.referrerFeeUsd)}`,
    '',
    `Reach: ${report.verifiedReachSummary}`,
  ]
  if (report.lineItems.length > 0) {
    lines.push('', 'Receipts:')
    for (const item of report.lineItems) {
      lines.push(`- ${day(item.occurredAtUnix)} ${item.kind} ${usd(item.amountUsd)}: ${item.description}`)
    }
  }
  if (report.withheldPayments.length > 0) {
    lines.push('', 'Payments withheld:')
    for (const w of report.withheldPayments) lines.push(`- ${w.vendorId} ${usd(w.amountUsd)}: ${w.reason}`)
  }
  lines.push('', 'What we did not do:')
  for (const statement of report.whatWeDidNotDo) lines.push(`- ${statement}`)
  return lines.join('\n')
}

export class TelegramReportDelivery implements ReportDelivery {
  constructor(private readonly deps: TelegramReportDeliveryDeps) {}

  async deliver(report: WeeklyReport): Promise<{ delivered: boolean; channel: string; externalId?: string }> {
    const vault = report.vault.toLowerCase()
    const prior = await this.deps.driver.query<{ external_id: string | null }>(
      `SELECT external_id FROM ops_report_delivery WHERE vault = $1 AND period_end_unix = $2`,
      [vault, report.periodEndUnix],
    )
    const priorRow = prior[0]
    if (priorRow !== undefined) {
      return {
        delivered: true,
        channel: CHANNEL,
        ...(priorRow.external_id === null ? {} : { externalId: strOf(priorRow.external_id, 'ops_report_delivery.external_id') }),
      }
    }

    const chatId = this.deps.chatFor(vault)
    if (chatId === undefined) {
      throw new OpsAdapterError('chat_unbound', `no telegram chat is bound to ${vault} in the coin directory`)
    }
    const operatorName = requireOperatorName(
      this.deps.operatorName,
      (message) => new OpsAdapterError('operator_unnamed', message),
    )
    const composed = composeDisclosedMessage({
      body: renderReportBody(report),
      spec: { operatorName, receiptUrl: receiptUrlFor(this.deps.receiptsBaseUrl, vault), paidPromotion: false },
      measure: TELEGRAM_LIMITS.measure,
      maxChars: TELEGRAM_LIMITS.maxChars,
    })
    if (!composed.ok) {
      throw new OpsAdapterError('delivery_failed', `${composed.rejection.reason}: ${composed.rejection.detail}`)
    }

    let messageId: number
    try {
      messageId = (await this.deps.transport.sendMessage({ chatId, text: composed.text })).messageId
    } catch (error) {
      throw new OpsAdapterError('delivery_failed', error instanceof Error ? error.message : String(error))
    }
    const externalId = `${chatId}:${String(intOf(messageId, 'telegram.message_id'))}`
    await this.deps.driver.execute(
      `INSERT INTO ops_report_delivery
           (id, vault, period_start_unix, period_end_unix, channel, external_id, body_hash, delivered_at_unix)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (vault, period_end_unix) DO NOTHING`,
      [
        `rd_${canonicalDigest({ vault, end: report.periodEndUnix }).slice(0, 32)}`,
        vault,
        report.periodStartUnix,
        report.periodEndUnix,
        CHANNEL,
        externalId,
        sha256Hex(composed.text),
        this.deps.clock.nowUnix(),
      ],
    )
    return { delivered: true, channel: CHANNEL, externalId }
  }
}
