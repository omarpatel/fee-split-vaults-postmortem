/**
 * The Postgres predicate queue, against a real Postgres.
 *
 * pglite runs 0013's DDL for real, so the primary key, the CHECK constraints
 * and the partial due index are what these tests exercise - a recording driver
 * would let a broken ON CONFLICT clause pass. The last group runs the actual
 * delivery.predicates job through the scheduler with the broker's registry
 * behind BrokerPredicateVerifier, which is the wiring production runs.
 */

import { PGlite, type Transaction } from '@electric-sql/pglite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeEvidenceSource, PredicateRegistry } from '@fee-split-vaults/broker'
import type { DeliveryPredicateSpec } from '@fee-split-vaults/core'
import { InMemoryReceiptStore, procurementReceipt, type PredicateSchedule } from '@fee-split-vaults/orchestrator'
import { MemoryLogSink, StructuredLogger } from '../../lib/logging.js'
import { DAY, FixedClock, HOUR } from '../../lib/time.js'
import type { SqlDriver, SqlRow, SqlValue } from '../../migrations/driver.js'
import { migrate, NoOpLock } from '../../migrations/runner.js'
import { InMemoryDeadLetterQueue } from '../deadletter.js'
import { makeFakePorts } from '../fakes.js'
import { InMemoryRunStore } from '../idempotency.js'
import { deliveryPredicatesJob } from '../jobs/delivery-predicates.js'
import { InMemoryLockBackend } from '../lock.js'
import { InMemoryFreezeGate, Scheduler } from '../scheduler.js'
import { PgPredicateQueue } from '../store/predicates.js'
import { BrokerPredicateVerifier } from '../verifier.js'

const MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url))

type Queryable = Pick<PGlite | Transaction, 'query' | 'exec'>

class PgliteDriver implements SqlDriver {
  constructor(
    private readonly db: Queryable,
    private readonly root: PGlite | undefined,
  ) {}

  async execute(sql: string, params: readonly SqlValue[] = []): Promise<{ rowsAffected: number }> {
    if (params.length === 0) {
      const results = await this.db.exec(sql)
      return { rowsAffected: results.reduce((n, r) => n + (r.affectedRows ?? 0), 0) }
    }
    const result = await this.db.query(sql, [...params])
    return { rowsAffected: result.affectedRows ?? 0 }
  }

  async query<T = SqlRow>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    const result = await this.db.query<T>(sql, [...params])
    return result.rows
  }

  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    if (this.root === undefined) return fn(this)
    return this.root.transaction((tx) => fn(new PgliteDriver(tx, undefined)))
  }
}

const VAULT = '0x1111111111111111111111111111111111111111'
const TOKEN = '0x2222222222222222222222222222222222222222'
const FUNDED = Math.floor(Date.UTC(2026, 8, 7, 12, 0, 0) / 1000)

const ETI_SPEC: DeliveryPredicateSpec = {
  kind: 'eti_listing',
  verifyAtOffsetsSeconds: [HOUR, DAY],
  params: { chain: '4663', pairSource: 'dexscreener', expectFieldPresent: 'info', minSocialsPresent: 1 },
}

function schedule(overrides: Partial<PredicateSchedule> = {}): PredicateSchedule {
  return {
    disbursementId: 'db_1',
    vault: VAULT,
    token: TOKEN,
    skuId: 'eti-a',
    vendorId: 'dexscreener',
    spec: ETI_SPEC,
    fundedAtUnix: FUNDED,
    costUsd: 300,
    ...overrides,
  }
}

let db: PGlite
let driver: SqlDriver
let clock: FixedClock
let queue: PgPredicateQueue

beforeEach(async () => {
  db = new PGlite()
  await db.waitReady
  driver = new PgliteDriver(db, db)
  await migrate({ driver, directory: MIGRATIONS, nowUnix: () => FUNDED, lock: new NoOpLock() })
  clock = new FixedClock(FUNDED)
  queue = new PgPredicateQueue(driver, clock)
})

afterEach(async () => {
  await db.close()
})

describe('PgPredicateQueue: the orchestrator side', () => {
  it('expands one schedule into one due check per offset, carrying spec and baseline', async () => {
    await queue.enqueue(schedule({ baseline: { boosts: 4 } }))

    expect(await queue.listDue(FUNDED + HOUR - 1, 10)).toEqual([])
    const atHour = await queue.listDue(FUNDED + HOUR, 10)
    expect(atHour.map((c) => c.offsetSeconds)).toEqual([HOUR])
    expect(atHour[0]).toMatchObject({
      disbursementId: 'db_1',
      vault: VAULT,
      token: TOKEN,
      skuId: 'eti-a',
      vendorId: 'dexscreener',
      spec: ETI_SPEC,
      fundedAtUnix: FUNDED,
      dueAtUnix: FUNDED + HOUR,
      costUsd: 300,
      baseline: { boosts: 4 },
    })
    expect(await queue.listDue(FUNDED + DAY, 10)).toHaveLength(2)
  })

  it('is idempotent: a retried tick schedules nothing twice', async () => {
    await queue.enqueue(schedule())
    await queue.enqueue(schedule({ costUsd: 999 }))
    const due = await queue.listDue(FUNDED + DAY, 10)
    expect(due).toHaveLength(2)
    expect(due.every((c) => c.costUsd === 300)).toBe(true)
  })

  it('refuses a schedule with no offsets rather than enqueueing an unverifiable purchase', async () => {
    await expect(queue.enqueue(schedule({ spec: { ...ETI_SPEC, verifyAtOffsetsSeconds: [] } }))).rejects.toThrow(
      /no verification offsets/,
    )
  })

  it('omits baseline when none was captured, so the verifier sees exactly what was recorded', async () => {
    await queue.enqueue(schedule())
    const [check] = await queue.listDue(FUNDED + HOUR, 10)
    expect(check).toBeDefined()
    expect('baseline' in (check ?? {})).toBe(false)
  })
})

describe('PgPredicateQueue: the ops side', () => {
  it('a recorded result leaves the due queue and is not overwritten by a second record', async () => {
    await queue.enqueue(schedule())
    await queue.recordResult({
      disbursementId: 'db_1',
      offsetSeconds: HOUR,
      result: { checkedAtUnix: FUNDED + HOUR + 5, offsetSeconds: HOUR, passed: true, evidenceUri: 'memory://eti' },
    })
    await queue.recordResult({
      disbursementId: 'db_1',
      offsetSeconds: HOUR,
      result: { checkedAtUnix: FUNDED + HOUR + 60, offsetSeconds: HOUR, passed: false, note: 'late retry' },
    })

    expect((await queue.listDue(FUNDED + DAY, 10)).map((c) => c.offsetSeconds)).toEqual([DAY])
    expect(await queue.results('db_1')).toEqual([
      { checkedAtUnix: FUNDED + HOUR + 5, offsetSeconds: HOUR, passed: true, evidenceUri: 'memory://eti' },
    ])
  })

  it('lists oldest due first and honours the limit', async () => {
    await queue.enqueue(schedule({ disbursementId: 'db_late', fundedAtUnix: FUNDED + 10 }))
    await queue.enqueue(schedule({ disbursementId: 'db_early' }))
    const due = await queue.listDue(FUNDED + DAY + 10, 3)
    expect(due.map((c) => `${c.disbursementId}@${c.offsetSeconds}`)).toEqual([
      'db_early@3600',
      'db_late@3600',
      'db_early@86400',
    ])
  })

  it('withholding records the first reason only; penalties accumulate', async () => {
    await queue.withholdPayment({ disbursementId: 'db_1', vendorId: 'dexscreener', reason: 'first' })
    clock.advance(60)
    await queue.withholdPayment({ disbursementId: 'db_1', vendorId: 'dexscreener', reason: 'second' })
    await queue.penalizeVendor({ vendorId: 'dexscreener', reason: 'a' })
    await queue.penalizeVendor({ vendorId: 'dexscreener', reason: 'b' })

    expect(await queue.withheld('db_1')).toEqual({ vendorId: 'dexscreener', reason: 'first', withheldAtUnix: FUNDED })
    expect(await queue.penaltyCount('dexscreener')).toBe(2)
    expect(await queue.penaltyCount('other')).toBe(0)
  })

  it('refuses to hand the job a row whose spec this build cannot interpret', async () => {
    await queue.enqueue(schedule())
    await driver.execute(`UPDATE ops_predicate_check SET spec = '{"kind":"telepathy","verifyAtOffsetsSeconds":[1],"params":{}}'::jsonb`)
    await expect(queue.listDue(FUNDED + DAY, 10)).rejects.toThrow(/unknown kind/)
  })
})

describe('delivery.predicates over the real queue and the broker registry', () => {
  function run(evidence: FakeEvidenceSource) {
    const sink = new MemoryLogSink()
    const log = new StructuredLogger({ sink: sink.sink, nowUnix: () => clock.nowUnix(), minLevel: 'debug' })
    const ports = makeFakePorts(clock)
    const receipts = new InMemoryReceiptStore()
    const wired = {
      ...ports,
      predicates: queue,
      predicateVerifier: new BrokerPredicateVerifier(new PredicateRegistry(evidence), clock),
      receipts,
    }
    const scheduler = new Scheduler({
      clock,
      runs: new InMemoryRunStore(),
      locks: new InMemoryLockBackend(clock),
      deadLetters: new InMemoryDeadLetterQueue(),
      freeze: new InMemoryFreezeGate(),
      log,
      workerId: 'test',
    }).register(deliveryPredicatesJob(wired))
    return { ports, receipts, scheduler }
  }

  const listed = () =>
    new FakeEvidenceSource({
      eti: { chain: '4663', pairSource: 'dexscreener', presentFields: ['info', 'boosts'], socialsPresent: 2 },
    })

  it('a passing check re-issues the withheld procurement receipt as delivered, citing the evidence', async () => {
    const { ports, receipts, scheduler } = run(listed())
    await queue.enqueue(schedule())
    await receipts.put(
      procurementReceipt({
        vault: VAULT,
        disbursement: {
          id: 'db_1',
          vault: VAULT,
          skuId: 'eti-a',
          vendorId: 'dexscreener',
          costUsd: 300,
          invoiceHash: '0x' + 'ab'.repeat(32),
          disbursedAtUnix: FUNDED,
          predicateResults: [],
        },
        delivered: false,
        description: 'ETI listing',
      }),
    )
    clock.advance(HOUR + 1)

    const report = await scheduler.tick()

    expect(report.results.map((r) => r.disposition)).toEqual(['completed'])
    const [result] = await queue.results('db_1')
    expect(result).toMatchObject({ offsetSeconds: HOUR, passed: true, checkedAtUnix: FUNDED + HOUR + 1 })
    expect(result?.evidenceUri).toBe('memory://eti')
    const published = await receipts.list(VAULT, { publishedOnly: true, nowUnix: clock.nowUnix() })
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ disbursementId: 'db_1', evidenceUri: 'memory://eti', publishAfterUnix: FUNDED })
    expect(await queue.withheld('db_1')).toBeUndefined()
    expect(ports.alerts.raised).toHaveLength(0)
  })

  it('a pass with no receipt to re-issue is a ticket, never a silent success', async () => {
    const { ports, scheduler } = run(listed())
    await queue.enqueue(schedule())
    clock.advance(HOUR + 1)

    const report = await scheduler.tick()

    expect(report.results[0]?.disposition).toBe('completed')
    expect(ports.alerts.byId('procurement_receipt_missing')).toHaveLength(1)
    expect(ports.alerts.byId('procurement_receipt_missing')[0]?.facts).toMatchObject({
      disbursement_id: 'db_1',
      code: 'procurement_receipt_missing',
    })
  })

  it('an offline evidence provider fails closed: withheld, penalised, ticketed', async () => {
    const { ports, scheduler } = run(new FakeEvidenceSource({ offline: true }))
    await queue.enqueue(schedule())
    clock.advance(HOUR + 1)

    await scheduler.tick()

    const [result] = await queue.results('db_1')
    expect(result?.passed).toBe(false)
    expect(await queue.withheld('db_1')).toMatchObject({ vendorId: 'dexscreener' })
    expect(await queue.penaltyCount('dexscreener')).toBe(1)
    expect(ports.alerts.byId('delivery_predicate_failed')).toHaveLength(1)
    // The T+1d check is still queued; a failure at T+1h does not cancel it.
    expect((await queue.listDue(FUNDED + DAY, 10)).map((c) => c.offsetSeconds)).toEqual([DAY])
  })

  it('a second tick re-checks nothing already recorded', async () => {
    const { scheduler } = run(listed())
    await queue.enqueue(schedule())
    clock.advance(HOUR + 1)
    await scheduler.tick()
    clock.advance(HOUR)
    const second = await scheduler.tick()

    expect(second.results.map((r) => r.disposition)).not.toContain('dead_lettered')
    expect(await queue.results('db_1')).toHaveLength(1)
  })
})
