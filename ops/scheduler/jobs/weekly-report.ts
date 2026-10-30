/**
 * THE WEEKLY DEV REPORT.
 *
 * One report per client per ISO week, keyed on the week so a restart cannot send
 * it twice. Two properties are enforced here rather than trusted to the builder:
 *
 *   THE LAG. Line items for commitments that have not executed yet publish only
 *   after REPORTING.unexecutedCommitmentLagSeconds. Publishing them live would
 *   turn the receipts feed into a front-runnable purchase calendar - "we are
 *   about to buy trending placement for this coin" is a trade signal.
 *
 *   WHAT WE DID NOT DO. A report with an empty whatWeDidNotDo section is
 *   rejected, not sent. That section is the product: it is where a refusal, a
 *   withheld vendor payment, or a declined promotion is written down. A report
 *   that only lists wins is marketing, and this business is sold on receipts.
 *
 * The report is delivered through the publisher, which injects disclosure into
 * the body. Nothing here composes disclosure text; a disclosure this job wrote
 * would be a disclosure a model could later be asked to edit.
 */

import { WEEK } from '../../lib/time.js'
import { OBSERVED_STATES, REPORTING } from '../config.js'
import type { OpsPorts } from '../ports.js'
import { weeklyDue } from '../triggers.js'
import type { DueScopeInput, JobContext, JobDefinition, JobOutcome, ScheduledRun } from '../types.js'
import type { WeeklyReport } from '@fee-split-vaults/core'

export class ReportRejected extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ReportRejected'
  }
}

/**
 * Drop line items whose publish embargo has not expired, and refuse a report
 * that has lost its disclosure of inaction.
 */
export function applyPublicationRules(report: WeeklyReport, nowUnix: number): WeeklyReport {
  if (report.whatWeDidNotDo.length === 0) {
    throw new ReportRejected('missing_what_we_did_not_do', 'a weekly report must state what was not done')
  }
  if (report.periodEndUnix <= report.periodStartUnix) {
    throw new ReportRejected('invalid_period', 'report period is empty or inverted')
  }
  const lineItems = report.lineItems.filter((item) => item.publishAfterUnix <= nowUnix)
  const withheldCount = report.lineItems.length - lineItems.length
  if (withheldCount > 0) {
    // The dev is told the count, so an embargoed item is visible as a fact even
    // while its detail is not. Silence would look like nothing happened.
    return {
      ...report,
      lineItems,
      whatWeDidNotDo: [
        ...report.whatWeDidNotDo,
        `${withheldCount} committed line item(s) are held for ${Math.round(
          REPORTING.unexecutedCommitmentLagSeconds / 3600,
        )}h so this report is not a purchase calendar.`,
      ],
    }
  }
  return { ...report, lineItems }
}

export function weeklyReportJob(ports: OpsPorts): JobDefinition {
  return {
    id: 'report.weekly_dev',
    description: 'Builds and delivers the weekly client report, with the embargo and the “what we did not do” section.',
    triggers: [{ kind: 'weekly', dayOfWeekUtc: REPORTING.dayOfWeekUtc, atUtcHour: REPORTING.atUtcHour }],
    maxAttempts: 3,
    leaseSeconds: 900,
    timeoutSeconds: 300,
    retryBaseSeconds: 300,
    movesMoney: false,

    async dueScopes(input: DueScopeInput): Promise<ScheduledRun[]> {
      const vaults = await ports.vaults.listByState(OBSERVED_STATES)
      const out: ScheduledRun[] = []
      for (const vault of vaults) {
        const last = await input.lastSuccessUnix(vault.address)
        const due = weeklyDue(input.nowUnix, REPORTING.dayOfWeekUtc, REPORTING.atUtcHour, last)
        if (!due.due) continue
        out.push({
          jobId: 'report.weekly_dev',
          scope: vault.address,
          period: due.period,
          reason: { kind: 'weekly', weekKey: due.period },
        })
      }
      return out
    },

    async run(ctx: JobContext): Promise<JobOutcome> {
      const vault = await ports.vaults.get(ctx.scope)
      if (!vault) return { ok: false, code: 'unknown_vault' }

      const periodEndUnix = ctx.nowUnix
      const periodStartUnix = periodEndUnix - WEEK

      const built = await ports.reports.build({ vault: vault.address, periodStartUnix, periodEndUnix })

      let report: WeeklyReport
      try {
        report = applyPublicationRules(built, ctx.nowUnix)
      } catch (error) {
        if (error instanceof ReportRejected) {
          // Not sent, and not retried into a loop: the builder produced something
          // the publication rules refuse, and that is a code defect.
          ctx.log.error('report.weekly.rejected', { vault: vault.address, code: error.code })
          return { ok: false, code: `rejected_${error.code}` }
        }
        throw error
      }

      const delivery = await ports.reportDelivery.deliver(report)
      if (!delivery.delivered) {
        return { ok: false, code: 'delivery_failed', facts: { channel: delivery.channel } }
      }

      return {
        ok: true,
        code: 'delivered',
        facts: {
          vault: vault.address,
          channel: delivery.channel,
          external_id: delivery.externalId ?? 'none',
          line_items: report.lineItems.length,
          withheld_payments: report.withheldPayments.length,
          qf_received_usd: report.qfReceivedUsd,
          budget_spent_usd: report.budgetSpentUsd,
        },
      }
    },
  }
}
