/**
 * The scheduler.
 *
 * It is small on purpose. Everything that decides WHETHER work happens lives
 * here, in one readable pipeline, so the safety argument is one function long:
 *
 *   1. freeze gate      - a critical ledger variance blocks money-moving jobs.
 *                         Reconciliation jobs are exempt, or a freeze could
 *                         never be lifted.
 *   2. run record       - refuse if this (job, scope, period) already completed.
 *                         Backend unreachable -> REFUSE, do not run.
 *   3. singleton lock   - refuse if another worker holds it. Backend
 *                         unreachable -> REFUSE, do not run.
 *   4. execute          - with a wall-clock timeout.
 *   5. settle           - complete, or retry, or dead-letter. The lock is always
 *                         released in a finally.
 *
 * The order matters. The run record is claimed BEFORE the lock so that a lock
 * backend that hands out the same lease twice still cannot produce two attempts
 * for one period, and the lock is released AFTER the record is settled so a
 * fast retry cannot start before the previous attempt's bookkeeping is durable.
 */

import { lockKey as makeLockKey, tickId } from '../lib/ids.js'
import type { Logger } from '../lib/logging.js'
import { backoffSeconds } from '../lib/time.js'
import type { Clock } from '../lib/time.js'
import type { DeadLetterQueue } from './deadletter.js'
import { RunStoreUnavailable, type RunStore } from './idempotency.js'
import { LockBackendUnavailable, type Lease, type LockBackend } from './lock.js'
import type {
  DueScopeInput,
  JobContext,
  JobDefinition,
  JobId,
  JobOutcome,
  JobRunResult,
  OpsEvent,
  RunReason,
  ScheduledRun,
  Trigger,
} from './types.js'

/**
 * Authorization freeze. `true` means no money-moving job may run for that scope.
 * Implemented by the ledger's freeze table; the port keeps ops decoupled from it.
 */
export interface FreezeGate {
  /** Scope is a vault address or 'fleet'. A global freeze must answer true for both. */
  authorizationFrozen(scope: string): Promise<boolean>
}

export class AlwaysOpenFreezeGate implements FreezeGate {
  async authorizationFrozen(): Promise<boolean> {
    return false
  }
}

/** Test double and local-dev implementation. */
export class InMemoryFreezeGate implements FreezeGate {
  #global = false
  readonly #scopes = new Set<string>()

  freezeGlobal(): void {
    this.#global = true
  }

  clearGlobal(): void {
    this.#global = false
  }

  freezeScope(scope: string): void {
    this.#scopes.add(scope)
  }

  clearScope(scope: string): void {
    this.#scopes.delete(scope)
  }

  async authorizationFrozen(scope: string): Promise<boolean> {
    return this.#global || this.#scopes.has(scope)
  }
}

export interface SchedulerOptions {
  clock: Clock
  runs: RunStore
  locks: LockBackend
  deadLetters: DeadLetterQueue
  freeze: FreezeGate
  log: Logger
  /** Identifies this process in lock ownership. Hostname + pid in production. */
  workerId: string
  /** Cap on runs dispatched per tick, so one busy job cannot starve the others. */
  maxRunsPerTick?: number
}

export interface TickReport {
  tickId: string
  atUnix: number
  considered: number
  results: JobRunResult[]
}

export class Scheduler {
  readonly #jobs = new Map<JobId, JobDefinition>()
  readonly #opts: SchedulerOptions
  readonly #pendingEvents: OpsEvent[] = []
  #tickSeq = 0

  constructor(options: SchedulerOptions) {
    this.#opts = options
  }

  register(job: JobDefinition): this {
    if (this.#jobs.has(job.id)) throw new Error(`duplicate job id ${job.id}`)
    this.#jobs.set(job.id, job)
    return this
  }

  registerAll(jobs: readonly JobDefinition[]): this {
    for (const job of jobs) this.register(job)
    return this
  }

  jobs(): readonly JobDefinition[] {
    return [...this.#jobs.values()]
  }

  /** Enqueue a domain event. Delivered to matching jobs on the next tick only. */
  enqueueEvent(event: OpsEvent): void {
    this.#pendingEvents.push(event)
  }

  async tick(): Promise<TickReport> {
    const atUnix = this.#opts.clock.nowUnix()
    this.#tickSeq += 1
    const id = tickId(atUnix, this.#tickSeq)
    const log = this.#opts.log.child({ tick_id: id })

    // Events are drained once per tick. A job that is skipped because it is
    // locked does not lose its event: the emitting side re-emits, or the job's
    // safety-net interval trigger picks the work up. Draining here is what
    // bounds the queue.
    const events = this.#pendingEvents.splice(0, this.#pendingEvents.length)

    const runs: ScheduledRun[] = []
    for (const job of this.#jobs.values()) {
      const jobEvents = events.filter((e) => triggersOnEvent(job.triggers, e.name))
      let due: ScheduledRun[]
      try {
        due = await job.dueScopes(this.#dueInput(job.id, atUnix, jobEvents, log.child({ job_id: job.id })))
      } catch (error) {
        // A job that cannot decide whether it is due is not due. Fail closed.
        log.error('scheduler.due_scopes_failed', { job_id: job.id, error: errorCode(error) })
        continue
      }
      for (const run of due) {
        if (run.jobId !== job.id) {
          log.error('scheduler.due_scope_job_mismatch', { job_id: job.id, returned: run.jobId })
          continue
        }
        runs.push(run)
      }
    }

    const limit = this.#opts.maxRunsPerTick ?? 200
    const selected = runs.slice(0, limit)
    if (runs.length > selected.length) {
      log.warn('scheduler.tick_truncated', { considered: runs.length, dispatched: selected.length })
    }

    const results: JobRunResult[] = []
    for (const run of selected) {
      results.push(await this.execute(run, log))
    }

    log.info('scheduler.tick', {
      considered: runs.length,
      dispatched: results.length,
      completed: results.filter((r) => r.disposition === 'completed').length,
      dead_lettered: results.filter((r) => r.disposition === 'dead_lettered').length,
      pending_events: this.#pendingEvents.length,
    })

    return { tickId: id, atUnix, considered: runs.length, results }
  }

  /** Run one job for one scope out of band. Same pipeline, different reason. */
  async runNow(jobId: JobId, scope: string, requestedBy: string): Promise<JobRunResult> {
    const job = this.#jobs.get(jobId)
    if (!job) throw new Error(`unknown job ${jobId}`)
    const nowUnix = this.#opts.clock.nowUnix()
    const reason: RunReason = { kind: 'manual', requestedBy }
    return this.execute({ jobId, scope, period: `manual-${nowUnix}`, reason }, this.#opts.log)
  }

  async execute(run: ScheduledRun, parentLog: Logger): Promise<JobRunResult> {
    const job = this.#jobs.get(run.jobId)
    if (!job) throw new Error(`unknown job ${run.jobId}`)

    const key = `${run.jobId}:${run.scope}:${run.period}`
    const log = parentLog.child({ job_id: run.jobId, scope: run.scope, period: run.period, run_key: key })
    const startedMs = Date.now()

    // 1. freeze gate.
    if (job.movesMoney) {
      let frozen: boolean
      try {
        frozen = await this.#opts.freeze.authorizationFrozen(run.scope)
      } catch (error) {
        log.error('job.freeze_gate_unavailable', { error: errorCode(error) })
        return result(run, 'refused_backend_unavailable', 0, startedMs, errorCode(error))
      }
      if (frozen) {
        log.warn('job.skipped_frozen', { reason: run.reason.kind })
        return result(run, 'skipped_frozen', 0, startedMs)
      }
    }

    // 2. run record.
    let record
    try {
      record = await this.#opts.runs.begin({
        runKey: key,
        jobId: run.jobId,
        scope: run.scope,
        period: run.period,
        nowUnix: this.#opts.clock.nowUnix(),
        leaseSeconds: job.leaseSeconds,
        maxAttempts: job.maxAttempts,
      })
    } catch (error) {
      if (error instanceof RunStoreUnavailable) {
        log.error('job.run_store_unavailable', { error: errorCode(error) })
        return result(run, 'refused_backend_unavailable', 0, startedMs, 'run_store_unavailable')
      }
      throw error
    }
    if (!record) {
      log.debug('job.skipped_already_done')
      return result(run, 'skipped_already_done', 0, startedMs)
    }

    // 3. singleton lock.
    let lease: Lease | null
    try {
      lease = await this.#opts.locks.acquire(makeLockKey(run.jobId, run.scope), job.leaseSeconds, this.#opts.workerId)
    } catch (error) {
      // We already claimed an attempt. Release it back to `retry` so the next
      // tick can pick it up once the lock backend is healthy again.
      await this.#safeFail(key, 'lock_backend_unavailable', true, log)
      log.error('job.lock_backend_unavailable', { error: errorCode(error) })
      return result(run, 'refused_backend_unavailable', record.attempt, startedMs, 'lock_backend_unavailable')
    }
    if (!lease) {
      await this.#safeFail(key, 'locked', true, log)
      log.debug('job.skipped_locked')
      return result(run, 'skipped_locked', record.attempt, startedMs)
    }

    // 4. execute.
    const emitted: OpsEvent[] = []
    const ctx: JobContext = {
      jobId: run.jobId,
      scope: run.scope,
      period: run.period,
      runKey: key,
      nowUnix: this.#opts.clock.nowUnix(),
      attempt: record.attempt,
      reason: run.reason,
      log,
      emit: (event) => {
        emitted.push({ ...event, occurredAtUnix: this.#opts.clock.nowUnix() })
      },
    }

    let outcome: JobOutcome | undefined
    let thrown: unknown
    try {
      outcome = await withTimeout(job.run(ctx), job.timeoutSeconds, run.jobId)
    } catch (error) {
      thrown = error
    } finally {
      // 5a. The lock is released whatever happened, including a timeout that
      // left the job's own promise still running. The idempotency record, not
      // the lock, is what protects the money in that case.
      try {
        await this.#opts.locks.release(lease)
      } catch (error) {
        if (!(error instanceof LockBackendUnavailable)) throw error
        log.error('job.lock_release_failed', { error: errorCode(error) })
      }
    }

    // 5b. settle.
    const now = this.#opts.clock.nowUnix()
    const durationMs = Date.now() - startedMs

    if (thrown === undefined && outcome !== undefined && outcome.ok) {
      await this.#opts.runs.complete(key, now, outcome.code)
      for (const event of emitted) this.enqueueEvent(event)
      log.info('job.completed', { attempt: record.attempt, code: outcome.code, duration_ms: durationMs, ...outcome.facts })
      return { run, disposition: 'completed', attempt: record.attempt, outcome, durationMs }
    }

    const code = thrown !== undefined ? errorCode(thrown) : (outcome?.code ?? 'unspecified_failure')
    const willRetry = record.attempt < job.maxAttempts
    await this.#safeFail(key, code, willRetry, log)

    if (willRetry) {
      const delay = backoffSeconds(record.attempt, job.retryBaseSeconds, 6 * 3600, hashSeed(key))
      log.warn('job.retry_scheduled', {
        attempt: record.attempt,
        max_attempts: job.maxAttempts,
        error_code: code,
        retry_in_seconds: delay,
        duration_ms: durationMs,
      })
      return { run, disposition: 'retry_scheduled', attempt: record.attempt, errorCode: code, durationMs }
    }

    const facts: Record<string, string | number | boolean> = { ...(outcome?.facts ?? {}) }
    await this.#opts.deadLetters.park({
      jobId: run.jobId,
      scope: run.scope,
      period: run.period,
      runKey: key,
      attempts: record.attempt,
      errorCode: code,
      facts,
      reason: run.reason,
      firstFailedAtUnix: record.startedAtUnix,
      lastFailedAtUnix: now,
    })
    log.error('job.dead_lettered', {
      attempts: record.attempt,
      error_code: code,
      duration_ms: durationMs,
      ...facts,
    })
    return { run, disposition: 'dead_lettered', attempt: record.attempt, errorCode: code, durationMs }
  }

  #dueInput(jobId: JobId, nowUnix: number, events: readonly OpsEvent[], log: Logger): DueScopeInput {
    // Memoized per tick: a job with 400 vaults asks about each one once, and a
    // job that asks about the same scope twice does not pay for it twice.
    const cache = new Map<string, Promise<number | undefined>>()
    return {
      nowUnix,
      events,
      log,
      lastSuccessUnix: (scope: string) => {
        const hit = cache.get(scope)
        if (hit) return hit
        const pending = this.#opts.runs.lastSuccessUnix(jobId, scope)
        cache.set(scope, pending)
        return pending
      },
    }
  }

  /** Last successful completion of a job for a scope. Exposed for status endpoints. */
  async lastSuccess(jobId: JobId, scope: string): Promise<number | undefined> {
    return this.#opts.runs.lastSuccessUnix(jobId, scope)
  }

  async #safeFail(runKey: string, code: string, willRetry: boolean, log: Logger): Promise<void> {
    try {
      await this.#opts.runs.fail(runKey, this.#opts.clock.nowUnix(), code, willRetry)
    } catch (error) {
      // The record is stuck in_progress with a lease. It will be reclaimed when
      // the lease expires. Loud, because it means the store is degraded.
      log.error('job.fail_record_write_failed', { error: errorCode(error), code })
    }
  }
}

function result(
  run: ScheduledRun,
  disposition: JobRunResult['disposition'],
  attempt: number,
  startedMs: number,
  errorCodeValue?: string,
): JobRunResult {
  const base: JobRunResult = { run, disposition, attempt, durationMs: Date.now() - startedMs }
  return errorCodeValue === undefined ? base : { ...base, errorCode: errorCodeValue }
}

export function triggersOnEvent(triggers: readonly Trigger[], event: string): boolean {
  return triggers.some((t) => t.kind === 'event' && t.event === event)
}

export class JobTimeout extends Error {
  constructor(jobId: string, seconds: number) {
    super(`job ${jobId} exceeded ${seconds}s`)
    this.name = 'JobTimeout'
  }
}

export async function withTimeout<T>(promise: Promise<T>, seconds: number, jobId: string): Promise<T> {
  if (seconds <= 0) return promise
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new JobTimeout(jobId, seconds)), seconds * 1000)
        if (typeof timer.unref === 'function') timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Stable short error code. Never the remote service's message text. */
export function errorCode(error: unknown): string {
  if (error instanceof JobTimeout) return 'timeout'
  if (error instanceof Error) return error.name === 'Error' ? snake(error.constructor.name) : snake(error.name)
  return 'non_error_thrown'
}

function snake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
}

function hashSeed(value: string): number {
  let h = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}
