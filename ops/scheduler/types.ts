/**
 * The scheduler's vocabulary.
 *
 * Four properties are structural here rather than left to each job author:
 *
 *   IDEMPOTENT   every run is keyed by (jobId, scope, period) and the key is a
 *                pure function, so a crash between "did the work" and "recorded
 *                the work" is recoverable and a retry is a no-op.
 *   SINGLETON    a lease-based lock keyed by (jobId, scope). Two schedulers on
 *                two boxes do not both sweep the same escrow.
 *   DEAD-LETTER  a job that exhausts its attempts is parked with its full
 *                context, never dropped and never retried forever.
 *   FAIL CLOSED  if the lock backend or the idempotency store cannot be reached,
 *                the job DOES NOT RUN. Uncertainty is not permission.
 */

import type { Logger } from '../lib/logging.js'

export type JobId =
  | 'escrow.sweep'
  | 'escrow.settle'
  | 'recon.structural'
  | 'recon.sweep_match'
  | 'recon.trial_balance'
  | 'recon.clean_room'
  | 'tier.reevaluate'
  | 'delivery.predicates'
  | 'report.weekly_dev'
  | 'screening.rescreen'
  | 'fleet.tick'
  | 'vault.heartbeat'
  | 'publishing.health'
  | 'monitoring.evaluate'

/** Named domain events the scheduler can be woken by. Closed set, on purpose. */
export type OpsEventName = 'token_metadata_changed' | 'sweep_completed' | 'vault_activated'

export interface OpsEvent {
  name: OpsEventName
  /** The scope the event concerns. A vault address, a token address, a sweep id. */
  scope: string
  occurredAtUnix: number
  /** Small, closed-vocabulary detail. Never free-form untrusted text. */
  detail?: Record<string, string | number | boolean>
}

export type Trigger =
  /** Fires every `everySeconds`, measured from the last successful completion. */
  | { kind: 'interval'; everySeconds: number }
  /** Fires once per UTC day at the given hour/minute. */
  | { kind: 'daily'; atUtcHour: number; atUtcMinute: number }
  /** Fires once per ISO week on the given UTC weekday (0 = Sunday). */
  | { kind: 'weekly'; dayOfWeekUtc: number; atUtcHour: number }
  /**
   * Fires when a named accumulator crosses a threshold. The scheduler does not
   * compute the accumulator; the job's `dueScopes` does, which is what keeps the
   * threshold logic testable and out of the dispatcher.
   */
  | { kind: 'threshold'; thresholdName: string }
  /** Fires when a domain event with this name is enqueued. */
  | { kind: 'event'; event: OpsEventName }

export type RunReason =
  | { kind: 'interval'; sinceLastSeconds: number }
  | { kind: 'daily'; dayKey: string }
  | { kind: 'weekly'; weekKey: string }
  | { kind: 'threshold'; thresholdName: string; detail: string }
  | { kind: 'event'; event: OpsEventName }
  | { kind: 'manual'; requestedBy: string }

/** One unit of work: a job applied to a scope for a period. */
export interface ScheduledRun {
  jobId: JobId
  /** 'fleet' for book-wide jobs; otherwise a vault address or entity id. */
  scope: string
  /** The bucket this run belongs to. Two runs with the same period are the same run. */
  period: string
  reason: RunReason
}

export interface JobContext {
  readonly jobId: JobId
  readonly scope: string
  readonly period: string
  readonly runKey: string
  readonly nowUnix: number
  readonly attempt: number
  readonly reason: RunReason
  readonly log: Logger
  /** Emit a domain event for other jobs. Delivered on the next tick. */
  emit(event: Omit<OpsEvent, 'occurredAtUnix'>): void
}

/**
 * What a job returns. `ok:false` without a thrown error is a HANDLED failure -
 * the job decided it could not complete. It is retried and dead-lettered exactly
 * like a throw, because "handled" is not "harmless".
 */
export interface JobOutcome {
  ok: boolean
  /** Short machine code. Goes in the log and in the dead-letter record. */
  code: string
  /** Counts, ids, amounts as strings. Never untrusted text. */
  facts?: Record<string, string | number | boolean>
}

export type RunDisposition =
  | 'completed'
  | 'skipped_already_done'
  | 'skipped_locked'
  | 'skipped_frozen'
  | 'retry_scheduled'
  | 'dead_lettered'
  | 'refused_backend_unavailable'

export interface JobRunResult {
  run: ScheduledRun
  disposition: RunDisposition
  attempt: number
  outcome?: JobOutcome
  errorCode?: string
  durationMs: number
}

export interface JobDefinition {
  readonly id: JobId
  /** One line, present tense, says what the job does to the world. */
  readonly description: string
  readonly triggers: readonly Trigger[]
  /**
   * Attempts before dead-lettering, inclusive of the first. A job that moves
   * money keeps this low: retrying a claim is how you claim twice.
   */
  readonly maxAttempts: number
  /** Lock lease. Must exceed the job's realistic worst-case runtime. */
  readonly leaseSeconds: number
  /** Hard wall-clock cap on a single attempt. */
  readonly timeoutSeconds: number
  /** Backoff base for retries. */
  readonly retryBaseSeconds: number
  /**
   * True when this job authorizes or moves money. A critical ledger variance
   * freeze blocks these and only these; reconciliation itself must keep running
   * during a freeze or the freeze can never be lifted.
   */
  readonly movesMoney: boolean
  /**
   * Which scopes are due right now, and why. Pure with respect to the world
   * except for the reads it makes through its ports. Returning [] is normal.
   */
  dueScopes(now: DueScopeInput): Promise<ScheduledRun[]>
  /** Do the work. Must be safe to call twice with the same runKey. */
  run(ctx: JobContext): Promise<JobOutcome>
}

export interface DueScopeInput {
  nowUnix: number
  /**
   * Last successful completion of THIS job for a scope, unix seconds. Absent
   * means never - and "never" is due, which is what makes a cold start catch up
   * rather than wait a full interval before doing anything.
   */
  lastSuccessUnix(scope: string): Promise<number | undefined>
  /** Events enqueued since the previous tick, already filtered to this job's triggers. */
  events: readonly OpsEvent[]
  log: Logger
}
