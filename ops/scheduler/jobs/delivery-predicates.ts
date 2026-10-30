/**
 * DELIVERY-PREDICATE RE-CHECKS.
 *
 * Every SKU carries a machine-checkable delivery predicate and a list of offsets
 * at which it is re-evaluated after funding. This job drains that queue.
 *
 * THE T+7d KOL CHECK IS THE POINT. The failure mode is not "the post never
 * appeared" - that is caught at T+24h and is rare, because a vendor who takes
 * money and does nothing gets caught immediately. The failure mode is "the post
 * appeared, was paid for, and was quietly deleted a day later", or "the
 * disclosure was edited out". Only a second check a week later sees that, and it
 * is also the only mechanism by which the disclosure obligation survives contact
 * with a third party we do not control.
 *
 * FAIL CLOSED. The verifier returns a PredicateResult; transport failure,
 * malformed evidence and negative evidence are all `passed: false`. A vendor
 * that goes dark is a vendor that does not get paid.
 *
 * A KOL SKU whose spec does not contain BOTH required offsets is refused rather
 * than checked. A missing offset is not a lenient configuration; it is a hole.
 */

import type { DeliveryPredicateSpec } from '@fee-split-vaults/core'
import { publishDeliveredReceipt } from '@fee-split-vaults/orchestrator'
import { PREDICATES } from '../config.js'
import type { DuePredicateCheck, OpsPorts } from '../ports.js'
import { intervalDue } from '../triggers.js'
import { FLEET_SCOPE } from './scope.js'
import type { DueScopeInput, JobContext, JobDefinition, JobOutcome, ScheduledRun } from '../types.js'

/**
 * The later of the two mandatory KOL checkpoints. A failure at or after this
 * offset means the post existed at T+24h and is gone (or undisclosed) now, which
 * is a different incident from "it never appeared".
 */
export const LATE_KOL_OFFSET_SECONDS = Math.max(...PREDICATES.requiredKolOffsetsSeconds)

/** True when a kol_post spec is missing one of the two mandatory checkpoints. */
export function kolOffsetsIncomplete(spec: DeliveryPredicateSpec): boolean {
  if (spec.kind !== 'kol_post') return false
  return PREDICATES.requiredKolOffsetsSeconds.some((required) => !spec.verifyAtOffsetsSeconds.includes(required))
}

/** The offset a check belongs to, rendered for logs and alerts. */
export function offsetLabel(offsetSeconds: number): string {
  if (offsetSeconds % 86_400 === 0) return `T+${offsetSeconds / 86_400}d`
  if (offsetSeconds % 3_600 === 0) return `T+${offsetSeconds / 3_600}h`
  return `T+${offsetSeconds}s`
}

export function deliveryPredicatesJob(ports: OpsPorts): JobDefinition {
  return {
    id: 'delivery.predicates',
    description: 'Re-checks each funded SKU’s delivery predicate at its offsets, including T+24h and T+7d for KOL posts.',
    triggers: [{ kind: 'interval', everySeconds: PREDICATES.pollEverySeconds }],
    maxAttempts: 3,
    leaseSeconds: 1800,
    timeoutSeconds: 900,
    retryBaseSeconds: 60,
    movesMoney: false,

    async dueScopes(input: DueScopeInput): Promise<ScheduledRun[]> {
      const last = await input.lastSuccessUnix(FLEET_SCOPE)
      const due = intervalDue(input.nowUnix, last, PREDICATES.pollEverySeconds)
      if (!due.due) return []
      return [
        {
          jobId: 'delivery.predicates',
          scope: FLEET_SCOPE,
          period: due.period,
          reason: { kind: 'interval', sinceLastSeconds: due.sinceLastSeconds },
        },
      ]
    },

    async run(ctx: JobContext): Promise<JobOutcome> {
      const due = await ports.predicates.listDue(ctx.nowUnix, PREDICATES.batchSize)
      let passed = 0
      let failed = 0
      let refused = 0
      let receiptsMissing = 0

      for (const check of due) {
        if (kolOffsetsIncomplete(check.spec)) {
          refused += 1
          await refuseIncompleteSpec(ports, check, ctx)
          continue
        }

        const result = await ports.predicateVerifier.verify(check)
        await ports.predicates.recordResult({
          disbursementId: check.disbursementId,
          offsetSeconds: check.offsetSeconds,
          result,
        })

        if (result.passed) {
          passed += 1
          // The receipt was written withheld in the tick that funded the
          // purchase; the first passing check is what makes it publishable.
          // A pass with nothing to re-issue is a divergence, never a shrug.
          const reissued = await publishDeliveredReceipt(ports.receipts, check.disbursementId, result.evidenceUri)
          if (reissued === undefined) {
            receiptsMissing += 1
            const facts: Record<string, string | number | boolean> = {
              disbursement_id: check.disbursementId,
              vault: check.vault,
              sku_id: check.skuId,
              vendor_id: check.vendorId,
              offset: offsetLabel(check.offsetSeconds),
              code: 'procurement_receipt_missing',
            }
            await ports.alerts.raise({
              alertId: 'procurement_receipt_missing',
              severity: 'ticket',
              scope: check.vault,
              summary: 'Delivery check passed but no procurement receipt exists to re-issue as delivered',
              runbook: 'ops/runbooks/vendor-non-delivery-dispute.md',
              facts,
              raisedAtUnix: ctx.nowUnix,
            })
            ctx.log.error('delivery.receipt_missing', facts)
          }
          continue
        }

        failed += 1
        const isLateKolFailure = check.spec.kind === 'kol_post' && check.offsetSeconds >= LATE_KOL_OFFSET_SECONDS

        await ports.predicates.withholdPayment({
          disbursementId: check.disbursementId,
          vendorId: check.vendorId,
          reason: isLateKolFailure
            ? `kol post absent or disclosure missing at ${offsetLabel(check.offsetSeconds)}`
            : `delivery predicate ${check.spec.kind} failed at ${offsetLabel(check.offsetSeconds)}`,
        })
        await ports.predicates.penalizeVendor({
          vendorId: check.vendorId,
          reason: `predicate_failed:${check.spec.kind}:${offsetLabel(check.offsetSeconds)}`,
        })

        const facts: Record<string, string | number | boolean> = {
          disbursement_id: check.disbursementId,
          vault: check.vault,
          sku_id: check.skuId,
          vendor_id: check.vendorId,
          predicate: check.spec.kind,
          offset: offsetLabel(check.offsetSeconds),
          cost_usd: check.costUsd,
          evidence_hash: result.evidenceHash ?? 'none',
        }
        await ports.alerts.raise({
          alertId: isLateKolFailure ? 'kol_post_deleted_or_undisclosed' : 'delivery_predicate_failed',
          severity: isLateKolFailure ? 'page' : 'ticket',
          scope: check.vault,
          summary: isLateKolFailure
            ? 'Paid KOL post is gone or lost its disclosure at the T+7d re-check'
            : `Delivery predicate failed at ${offsetLabel(check.offsetSeconds)}`,
          runbook: 'ops/runbooks/vendor-non-delivery-dispute.md',
          facts,
          raisedAtUnix: ctx.nowUnix,
        })
        ctx.log.warn('delivery.predicate_failed', facts)
      }

      return {
        ok: true,
        code: failed === 0 && refused === 0 && receiptsMissing === 0 ? 'all_delivered' : 'failures_recorded',
        facts: { checked: due.length, passed, failed, refused, receipts_missing: receiptsMissing },
      }
    },
  }
}

async function refuseIncompleteSpec(ports: OpsPorts, check: DuePredicateCheck, ctx: JobContext): Promise<void> {
  const facts: Record<string, string | number | boolean> = {
    disbursement_id: check.disbursementId,
    sku_id: check.skuId,
    vendor_id: check.vendorId,
    offsets: check.spec.verifyAtOffsetsSeconds.join(','),
    required: PREDICATES.requiredKolOffsetsSeconds.join(','),
  }
  // The payment is withheld, not merely flagged. A KOL SKU we cannot verify at
  // T+7d is a SKU we cannot honestly say was delivered.
  await ports.predicates.withholdPayment({
    disbursementId: check.disbursementId,
    vendorId: check.vendorId,
    reason: 'kol_post SKU is missing a required verification offset; delivery is unverifiable',
  })
  await ports.alerts.raise({
    alertId: 'sku_predicate_misconfigured',
    severity: 'page',
    scope: check.vault,
    summary: 'A funded KOL SKU is missing the T+24h or T+7d verification offset',
    runbook: 'ops/runbooks/vendor-non-delivery-dispute.md',
    facts,
    raisedAtUnix: ctx.nowUnix,
  })
  ctx.log.error('delivery.predicate_spec_incomplete', facts)
}
