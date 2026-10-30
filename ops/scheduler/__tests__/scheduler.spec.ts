/**
 * The scheduler's safety properties.
 *
 * Each test here corresponds to a way the operations plane could lose or double
 * money. They are written against the pipeline rather than against a job,
 * because the pipeline is where the guarantee lives - a job author gets
 * idempotency and singleton execution for free or not at all.
 */

import { describe, expect, it } from 'vitest'
import { MemoryLogSink, StructuredLogger, type Logger } from '../../lib/logging.js'
import { FixedClock } from '../../lib/time.js'
import { InMemoryDeadLetterQueue } from '../deadletter.js'
import { InMemoryRunStore } from '../idempotency.js'
import { InMemoryLockBackend } from '../lock.js'
import { sleepSecondsUntilDue } from '../main.js'
import { InMemoryFreezeGate, Scheduler, errorCode, withTimeout, JobTimeout } from '../scheduler.js'
import type { JobDefinition, JobId, JobOutcome, ScheduledRun } from '../types.js'

const START = Math.floor(Date.UTC(2026, 8, 7, 12, 0, 0) / 1000)

function makeLogger(): { log: Logger; sink: MemoryLogSink; clock: FixedClock } {
  const clock = new FixedClock(START)
  const sink = new MemoryLogSink()
  const log = new StructuredLogger({ sink: sink.sink, nowUnix: () => clock.nowUnix(), minLevel: 'debug' })
  return { log, sink, clock }
}

interface TestJobOptions {
  id?: JobId
  movesMoney?: boolean
  maxAttempts?: number
  run: (attempt: number) => Promise<JobOutcome>
  due?: () => ScheduledRun[]
  timeoutSeconds?: number
}

function testJob(options: TestJobOptions): { job: JobDefinition; calls: number[] } {
  const id = options.id ?? 'recon.structural'
  const calls: number[] = []
  const job: JobDefinition = {
    id,
    description: 'test job',
    triggers: [{ kind: 'interval', everySeconds: 60 }],
    maxAttempts: options.maxAttempts ?? 2,
    leaseSeconds: 300,
    timeoutSeconds: options.timeoutSeconds ?? 30,
    retryBaseSeconds: 1,
    movesMoney: options.movesMoney ?? false,
    async dueScopes() {
      return options.due ? options.due() : [{ jobId: id, scope: 'fleet', period: 'p1', reason: { kind: 'manual', requestedBy: 'test' } }]
    },
    async run(ctx) {
      calls.push(ctx.attempt)
      return options.run(ctx.attempt)
    },
  }
  return { job, calls }
}

function makeScheduler(clock: FixedClock, log: Logger, overrides: Partial<{
  runs: InMemoryRunStore
  locks: InMemoryLockBackend
  deadLetters: InMemoryDeadLetterQueue
  freeze: InMemoryFreezeGate
  workerId: string
}> = {}) {
  const runs = overrides.runs ?? new InMemoryRunStore()
  const locks = overrides.locks ?? new InMemoryLockBackend(clock)
  const deadLetters = overrides.deadLetters ?? new InMemoryDeadLetterQueue()
  const freeze = overrides.freeze ?? new InMemoryFreezeGate()
  const scheduler = new Scheduler({
    clock,
    runs,
    locks,
    deadLetters,
    freeze,
    log,
    workerId: overrides.workerId ?? 'worker-1',
  })
  return { scheduler, runs, locks, deadLetters, freeze }
}

describe('idempotency', () => {
  it('runs a (job, scope, period) exactly once no matter how many ticks', async () => {
    const { log, clock } = makeLogger()
    const { job, calls } = testJob({ run: async () => ({ ok: true, code: 'done' }) })
    const { scheduler } = makeScheduler(clock, log)
    scheduler.register(job)

    await scheduler.tick()
    clock.advance(1)
    const second = await scheduler.tick()

    expect(calls).toHaveLength(1)
    expect(second.results[0]?.disposition).toBe('skipped_already_done')
  })

  it('runs again once the period changes', async () => {
    const { log, clock } = makeLogger()
    let period = 'p1'
    const { job, calls } = testJob({
      run: async () => ({ ok: true, code: 'done' }),
      due: () => [{ jobId: 'recon.structural', scope: 'fleet', period, reason: { kind: 'manual', requestedBy: 't' } }],
    })
    const { scheduler } = makeScheduler(clock, log)
    scheduler.register(job)

    await scheduler.tick()
    period = 'p2'
    await scheduler.tick()

    expect(calls).toHaveLength(2)
  })

  it('a completed run is never reopened, even after a lease would have expired', async () => {
    const { log, clock } = makeLogger()
    const { job, calls } = testJob({ run: async () => ({ ok: true, code: 'done' }) })
    const { scheduler } = makeScheduler(clock, log)
    scheduler.register(job)

    await scheduler.tick()
    clock.advance(100_000)
    await scheduler.tick()

    expect(calls).toHaveLength(1)
  })
})

describe('singleton locking', () => {
  it('only one of two workers runs the same scope', async () => {
    const { log, clock } = makeLogger()
    const locks = new InMemoryLockBackend(clock)
    const runs = new InMemoryRunStore()

    const first = testJob({ run: async () => ({ ok: true, code: 'a' }) })
    const second = testJob({ run: async () => ({ ok: true, code: 'b' }) })

    const a = makeScheduler(clock, log, { locks, runs, workerId: 'w1' })
    const b = makeScheduler(clock, log, { locks, runs, workerId: 'w2' })
    a.scheduler.register(first.job)
    b.scheduler.register(second.job)

    const [ra, rb] = await Promise.all([a.scheduler.tick(), b.scheduler.tick()])
    const dispositions = [ra.results[0]?.disposition, rb.results[0]?.disposition].sort()

    expect(first.calls.length + second.calls.length).toBe(1)
    // The loser is stopped by whichever gate it reached first.
    expect(dispositions).toContain('completed')
  })

  it('releases the lock after a run so the next period is not starved', async () => {
    const { log, clock } = makeLogger()
    const locks = new InMemoryLockBackend(clock)
    const { job } = testJob({ run: async () => ({ ok: true, code: 'done' }) })
    const { scheduler } = makeScheduler(clock, log, { locks })
    scheduler.register(job)

    await scheduler.tick()
    expect(locks.heldCount()).toBe(0)
  })

  it('releases the lock even when the job throws', async () => {
    const { log, clock } = makeLogger()
    const locks = new InMemoryLockBackend(clock)
    const { job } = testJob({
      run: async () => {
        throw new Error('boom')
      },
    })
    const { scheduler } = makeScheduler(clock, log, { locks })
    scheduler.register(job)

    await scheduler.tick()
    expect(locks.heldCount()).toBe(0)
  })
})

describe('failure handling', () => {
  it('retries up to maxAttempts, then dead-letters with context', async () => {
    const { log, clock } = makeLogger()
    let period = 0
    const { job, calls } = testJob({
      maxAttempts: 3,
      run: async () => ({ ok: false, code: 'vendor_unreachable' }),
      due: () => [
        { jobId: 'recon.structural', scope: 'fleet', period: 'stable', reason: { kind: 'manual', requestedBy: 't' } },
      ],
    })
    const { scheduler, deadLetters } = makeScheduler(clock, log)
    scheduler.register(job)

    for (let i = 0; i < 5; i += 1) {
      period += 1
      await scheduler.tick()
      clock.advance(10)
    }

    expect(calls).toEqual([1, 2, 3])
    const parked = await deadLetters.list()
    expect(parked).toHaveLength(1)
    expect(parked[0]?.errorCode).toBe('vendor_unreachable')
    expect(parked[0]?.attempts).toBe(3)
    expect(parked[0]?.jobId).toBe('recon.structural')
    expect(period).toBe(5)
  })

  it('treats a thrown error and a handled ok:false the same way', async () => {
    const { log, clock } = makeLogger()
    const { job } = testJob({
      maxAttempts: 1,
      run: async () => {
        throw new TypeError('bad shape')
      },
    })
    const { scheduler, deadLetters } = makeScheduler(clock, log)
    scheduler.register(job)

    const report = await scheduler.tick()
    expect(report.results[0]?.disposition).toBe('dead_lettered')
    expect((await deadLetters.list())[0]?.errorCode).toBe('type_error')
  })

  it('a dead-lettered run is not retried on a later tick', async () => {
    const { log, clock } = makeLogger()
    const { job, calls } = testJob({
      maxAttempts: 1,
      run: async () => ({ ok: false, code: 'nope' }),
    })
    const { scheduler } = makeScheduler(clock, log)
    scheduler.register(job)

    await scheduler.tick()
    clock.advance(1000)
    await scheduler.tick()

    expect(calls).toHaveLength(1)
  })
})

describe('fail closed', () => {
  it('refuses to run when the run store is unreachable', async () => {
    const { log, clock } = makeLogger()
    const runs = new InMemoryRunStore()
    const { job, calls } = testJob({ run: async () => ({ ok: true, code: 'done' }) })
    const { scheduler } = makeScheduler(clock, log, { runs })
    scheduler.register(job)

    runs.unavailable = true
    const report = await scheduler.tick()

    expect(calls).toHaveLength(0)
    expect(report.results[0]?.disposition).toBe('refused_backend_unavailable')
  })

  it('refuses to run when the lock backend is unreachable', async () => {
    const { log, clock } = makeLogger()
    const locks = new InMemoryLockBackend(clock)
    const { job, calls } = testJob({ run: async () => ({ ok: true, code: 'done' }) })
    const { scheduler } = makeScheduler(clock, log, { locks })
    scheduler.register(job)

    locks.unavailable = true
    const report = await scheduler.tick()

    expect(calls).toHaveLength(0)
    expect(report.results[0]?.disposition).toBe('refused_backend_unavailable')
  })

  it('a job whose dueScopes throws contributes nothing rather than everything', async () => {
    const { log, clock, sink } = makeLogger()
    const { job, calls } = testJob({
      run: async () => ({ ok: true, code: 'done' }),
      due: () => {
        throw new Error('measurement unavailable')
      },
    })
    const { scheduler } = makeScheduler(clock, log)
    scheduler.register(job)

    const report = await scheduler.tick()
    expect(calls).toHaveLength(0)
    expect(report.results).toHaveLength(0)
    expect(sink.events()).toContain('scheduler.due_scopes_failed')
  })

  it('times out a job that never returns, and does not leave the lock held', async () => {
    const { log, clock } = makeLogger()
    const locks = new InMemoryLockBackend(clock)
    const { job } = testJob({
      maxAttempts: 1,
      timeoutSeconds: 0.01,
      run: () => new Promise<JobOutcome>(() => {}),
    })
    const { scheduler, deadLetters } = makeScheduler(clock, log, { locks })
    scheduler.register(job)

    const report = await scheduler.tick()
    expect(report.results[0]?.disposition).toBe('dead_lettered')
    expect((await deadLetters.list())[0]?.errorCode).toBe('timeout')
    expect(locks.heldCount()).toBe(0)
  })
})

describe('the authorization freeze', () => {
  it('blocks a money-moving job', async () => {
    const { log, clock } = makeLogger()
    const freeze = new InMemoryFreezeGate()
    const { job, calls } = testJob({
      id: 'escrow.sweep',
      movesMoney: true,
      run: async () => ({ ok: true, code: 'swept' }),
      due: () => [{ jobId: 'escrow.sweep', scope: 'fleet', period: 'p1', reason: { kind: 'manual', requestedBy: 't' } }],
    })
    const { scheduler } = makeScheduler(clock, log, { freeze })
    scheduler.register(job)

    freeze.freezeGlobal()
    const report = await scheduler.tick()

    expect(calls).toHaveLength(0)
    expect(report.results[0]?.disposition).toBe('skipped_frozen')
  })

  it('does NOT block reconciliation, or the freeze could never be lifted', async () => {
    const { log, clock } = makeLogger()
    const freeze = new InMemoryFreezeGate()
    const { job, calls } = testJob({ movesMoney: false, run: async () => ({ ok: true, code: 'clean' }) })
    const { scheduler } = makeScheduler(clock, log, { freeze })
    scheduler.register(job)

    freeze.freezeGlobal()
    await scheduler.tick()

    expect(calls).toHaveLength(1)
  })

  it('a per-vault freeze does not stop other vaults', async () => {
    const { log, clock } = makeLogger()
    const freeze = new InMemoryFreezeGate()
    const scopes = ['0xaaa', '0xbbb']
    const { job, calls } = testJob({
      id: 'escrow.sweep',
      movesMoney: true,
      run: async () => ({ ok: true, code: 'swept' }),
      due: () =>
        scopes.map((scope) => ({
          jobId: 'escrow.sweep' as JobId,
          scope,
          period: 'p1',
          reason: { kind: 'manual' as const, requestedBy: 't' },
        })),
    })
    const { scheduler } = makeScheduler(clock, log, { freeze })
    scheduler.register(job)

    freeze.freezeScope('0xaaa')
    const report = await scheduler.tick()

    expect(calls).toHaveLength(1)
    expect(report.results.map((r) => r.disposition).sort()).toEqual(['completed', 'skipped_frozen'])
  })
})

describe('events', () => {
  it('delivers an emitted event on the following tick, not the current one', async () => {
    const { log, clock } = makeLogger()
    const seen: string[] = []

    const emitter: JobDefinition = {
      id: 'escrow.sweep',
      description: 'emits',
      triggers: [{ kind: 'interval', everySeconds: 60 }],
      maxAttempts: 1,
      leaseSeconds: 120,
      timeoutSeconds: 10,
      retryBaseSeconds: 1,
      movesMoney: false,
      async dueScopes({ nowUnix }) {
        return [
          {
            jobId: 'escrow.sweep',
            scope: 'fleet',
            period: `p${nowUnix}`,
            reason: { kind: 'manual', requestedBy: 't' },
          },
        ]
      },
      async run(ctx) {
        ctx.emit({ name: 'sweep_completed', scope: 'fleet' })
        return { ok: true, code: 'emitted' }
      },
    }

    const listener: JobDefinition = {
      id: 'escrow.settle',
      description: 'listens',
      triggers: [{ kind: 'event', event: 'sweep_completed' }],
      maxAttempts: 1,
      leaseSeconds: 120,
      timeoutSeconds: 10,
      retryBaseSeconds: 1,
      movesMoney: false,
      async dueScopes({ events, nowUnix }) {
        for (const event of events) seen.push(event.name)
        return events.length === 0
          ? []
          : [
              {
                jobId: 'escrow.settle',
                scope: 'fleet',
                period: `p${nowUnix}`,
                reason: { kind: 'event', event: 'sweep_completed' },
              },
            ]
      },
      async run() {
        return { ok: true, code: 'settled' }
      },
    }

    const { scheduler } = makeScheduler(clock, log)
    scheduler.registerAll([emitter, listener])

    await scheduler.tick()
    expect(seen).toEqual([])

    clock.advance(120)
    await scheduler.tick()
    expect(seen).toEqual(['sweep_completed'])
  })
})

describe('helpers', () => {
  it('errorCode produces a stable snake-case code and never the remote message', () => {
    expect(errorCode(new JobTimeout('escrow.sweep', 5))).toBe('timeout')
    expect(errorCode(new TypeError('secret detail'))).toBe('type_error')
    expect(errorCode(new Error('secret detail'))).toBe('error')
    expect(errorCode('a string')).toBe('non_error_thrown')
  })

  it('withTimeout resolves through when the promise wins', async () => {
    await expect(withTimeout(Promise.resolve(7), 5, 'x')).resolves.toBe(7)
  })

  it('withTimeout rejects with JobTimeout when it does not', async () => {
    await expect(withTimeout(new Promise(() => {}), 0.01, 'x')).rejects.toBeInstanceOf(JobTimeout)
  })

  it('refuses to register the same job twice', () => {
    const { log, clock } = makeLogger()
    const { scheduler } = makeScheduler(clock, log)
    const { job } = testJob({ run: async () => ({ ok: true, code: 'x' }) })
    scheduler.register(job)
    expect(() => scheduler.register(job)).toThrow(/duplicate job id/)
  })

  it('the loop sleeps until the earliest due coin, clamped to [1s, tick]', () => {
    expect(sleepSecondsUntilDue(30, undefined, START)).toBe(30)
    expect(sleepSecondsUntilDue(30, START + 3, START)).toBe(3)
    expect(sleepSecondsUntilDue(30, START - 100, START)).toBe(1)
    expect(sleepSecondsUntilDue(30, START + 3_600, START)).toBe(30)
  })
})
