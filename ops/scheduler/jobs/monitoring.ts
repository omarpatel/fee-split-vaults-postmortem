/**
 * MONITORING: the alert catalog, evaluated.
 *
 * ops/monitoring/alerts.ts is a catalog of pure predicates over a signal
 * snapshot, and until this job nothing outside the tests ever handed it one.
 * Every minute: collect the snapshot from the stores, evaluate, raise each
 * firing through the monitoring port (logged, then paged), and clear the
 * monitor's own open firings whose condition no longer holds.
 *
 * The evaluator's for-duration and dedupe state is in this process; the
 * durable record is ops_alert_firing, which is why a restart re-pages an open
 * condition at most once (the log refreshes the open row rather than opening a
 * second) and never loses one.
 */

import { AlertEvaluator } from '../../monitoring/evaluate.js'
import { MINUTE } from '../../lib/time.js'
import type { OpsPorts } from '../ports.js'
import { intervalDue } from '../triggers.js'
import { FLEET_SCOPE } from './scope.js'
import type { DueScopeInput, JobContext, JobDefinition, JobOutcome, ScheduledRun } from '../types.js'

export const MONITORING = {
  evaluateEverySeconds: 1 * MINUTE,
} as const

export function monitoringEvaluateJob(ports: OpsPorts, evaluator: AlertEvaluator = new AlertEvaluator()): JobDefinition {
  return {
    id: 'monitoring.evaluate',
    description: 'Collects the signal snapshot, evaluates the alert catalog against it, and pages what fires.',
    triggers: [{ kind: 'interval', everySeconds: MONITORING.evaluateEverySeconds }],
    maxAttempts: 2,
    leaseSeconds: 300,
    timeoutSeconds: 120,
    retryBaseSeconds: 30,
    movesMoney: false,

    async dueScopes(input: DueScopeInput): Promise<ScheduledRun[]> {
      const last = await input.lastSuccessUnix(FLEET_SCOPE)
      const due = intervalDue(input.nowUnix, last, MONITORING.evaluateEverySeconds)
      if (!due.due) return []
      return [
        {
          jobId: 'monitoring.evaluate',
          scope: FLEET_SCOPE,
          period: due.period,
          reason: { kind: 'interval', sinceLastSeconds: due.sinceLastSeconds },
        },
      ]
    },

    async run(ctx: JobContext): Promise<JobOutcome> {
      const signals = await ports.monitoring.collect(ctx.nowUnix)
      const result = evaluator.evaluate(signals)
      for (const firing of result.firing) {
        await ports.monitoring.raise({
          alertId: firing.alertId,
          severity: firing.severity,
          scope: firing.scope,
          summary: firing.summary,
          runbook: firing.runbook,
          facts: { ...firing.facts, auto_action: firing.autoAction },
          raisedAtUnix: ctx.nowUnix,
        })
      }
      const cleared = await ports.monitoring.clearResolved(new Set(evaluator.active()), ctx.nowUnix)
      return {
        ok: true,
        code: result.firing.length === 0 ? 'quiet' : 'fired',
        facts: { fired: result.firing.length, pending: result.pending.length, suppressed: result.suppressed.length, cleared },
      }
    },
  }
}
