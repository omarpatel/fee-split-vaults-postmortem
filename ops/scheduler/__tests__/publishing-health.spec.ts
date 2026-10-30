/**
 * Publishing account health end to end: the job through the real scheduler
 * against the fakes (one scope per account, a verdict per interval,
 * `unreachable` retried rather than recorded), the Postgres adapter listing
 * the bound X accounts and appending rows the publisher's own store reads,
 * and the collector turning the newest non-ok row per account into the
 * `publishing_channel_suspended` signal with the onset as its timestamp.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pgLedgerDriver, PgVaultRepository } from '@fee-split-vaults/adapters'
import { SqlLedgerStore } from '@fee-split-vaults/ledger'
import { InMemoryChannelHealthStore, type ChannelHealthProbe } from '@fee-split-vaults/publisher'
import { MemoryLogSink, StructuredLogger } from '../../lib/logging.js'
import { FixedClock, HOUR } from '../../lib/time.js'
import { publishingChannelSuspended } from '../../monitoring/alerts.js'
import { PgSignalCollector } from '../../monitoring/collect.js'
import { PUBLISHING_HEALTH } from '../config.js'
import { PgVaultDirectory } from '../adapters/directory.js'
import { PgPublishingHealth } from '../adapters/publishing-health.js'
import { openMigratedDb, type MigratedDb } from '../adapters/__tests__/pglite.js'
import { InMemoryDeadLetterQueue } from '../deadletter.js'
import { FakeEscrowReader, makeFakePorts } from '../fakes.js'
import { InMemoryRunStore } from '../idempotency.js'
import { healthScope, publishingHealthJob } from '../jobs/publishing-health.js'
import { InMemoryLockBackend } from '../lock.js'
import { InMemoryFreezeGate, Scheduler } from '../scheduler.js'

const START = Math.floor(Date.UTC(2026, 8, 7, 12, 0, 0) / 1000)
const VAULT = '0x1111111111111111111111111111111111111111'
const OTHER_VAULT = '0x3333333333333333333333333333333333333333'
const OP = { channel: 'x_operator' as const, accountId: '100200300', vault: VAULT }
const DEV = { channel: 'x_client_delegated' as const, accountId: '400500600', vault: OTHER_VAULT }

function harness() {
  const clock = new FixedClock(START)
  const sink = new MemoryLogSink()
  const log = new StructuredLogger({ sink: sink.sink, nowUnix: () => clock.nowUnix(), minLevel: 'debug' })
  const ports = makeFakePorts(clock)
  const deadLetters = new InMemoryDeadLetterQueue()
  const scheduler = new Scheduler({
    clock,
    runs: new InMemoryRunStore(),
    locks: new InMemoryLockBackend(clock),
    deadLetters,
    freeze: new InMemoryFreezeGate(),
    log,
    workerId: 'test',
  }).registerAll([publishingHealthJob(ports)])
  return { clock, ports, scheduler, deadLetters }
}

describe('publishing.health job', () => {
  it('probes every bound X account once per interval and appends each verdict', async () => {
    const { clock, ports, scheduler } = harness()
    ports.publishingHealth.bind(OP, 'ok').bind(DEV, 'suspended')

    await scheduler.tick()
    expect(ports.publishingHealth.probed.map((p) => p.accountId).sort()).toEqual([OP.accountId, DEV.accountId])
    expect(await ports.publishingHealth.store.get('x_operator', OP.accountId)).toMatchObject({ status: 'ok', observedAtUnix: START })
    expect(await ports.publishingHealth.store.get('x_client_delegated', DEV.accountId)).toMatchObject({ status: 'suspended' })

    // Not a reflex: an hour later nothing is re-probed; after the interval everything is.
    clock.advance(HOUR)
    await scheduler.tick()
    expect(ports.publishingHealth.probed).toHaveLength(2)
    clock.advance(PUBLISHING_HEALTH.probeEverySeconds)
    await scheduler.tick()
    expect(ports.publishingHealth.probed).toHaveLength(4)
    expect(ports.publishingHealth.store.history('x_operator', OP.accountId)).toHaveLength(2)
  })

  it('does not record unreachable: the run fails and is retried, and the last verdict stands', async () => {
    const { clock, ports, scheduler, deadLetters } = harness()
    ports.publishingHealth.bind(OP, 'ok')
    await scheduler.tick()
    ports.publishingHealth.setStanding(OP.accountId, 'unreachable')
    clock.advance(PUBLISHING_HEALTH.probeEverySeconds)
    const report = await scheduler.tick()
    expect(report.results.map((r) => r.disposition)).toEqual(['retry_scheduled'])
    expect(ports.publishingHealth.store.history('x_operator', OP.accountId)).toEqual([
      expect.objectContaining({ status: 'ok', observedAtUnix: START }),
    ])
    expect(await deadLetters.openCount()).toBe(0)
  })

  it('reports an account unbound between scheduling and running as done, not as a failure', async () => {
    const { ports } = harness()
    const job = publishingHealthJob(ports)
    const outcome = await job.run({
      jobId: 'publishing.health',
      scope: healthScope(OP),
      period: 'p',
      runKey: 'k',
      nowUnix: START,
      attempt: 1,
      reason: { kind: 'manual', requestedBy: 'test' },
      log: new StructuredLogger({ sink: new MemoryLogSink().sink, nowUnix: () => START, minLevel: 'debug' }),
      emit: () => undefined,
    })
    expect(outcome).toEqual({ ok: true, code: 'account_unbound', facts: { scope: 'x_operator:100200300' } })
    expect(ports.publishingHealth.probed).toHaveLength(0)
  })
})

describe('PgPublishingHealth and the collector', () => {
  let db: MigratedDb
  const clock = { nowUnix: () => START }

  beforeEach(async () => {
    db = await openMigratedDb(START)
    await db.driver.execute(
      `INSERT INTO publisher_account_binding (channel, account_id, coin_ref, vault, token, ticker, delegated) VALUES
         ('x_operator', '100200300', 'vnx', $1, '0x2222222222222222222222222222222222222222', 'VNX', FALSE),
         ('x_client_delegated', '400500600', 'other', $2, '0x4444444444444444444444444444444444444444', 'OTHER', TRUE),
         ('telegram', '-100123', 'vnx', $1, '0x2222222222222222222222222222222222222222', 'VNX', FALSE)`,
      [VAULT, OTHER_VAULT],
    )
  })

  afterEach(async () => {
    await db.db.close()
  })

  function collector(): PgSignalCollector {
    return new PgSignalCollector({
      driver: db.driver,
      ledgerStore: new SqlLedgerStore(pgLedgerDriver(db.driver)),
      vaults: new PgVaultDirectory(new PgVaultRepository(db.driver)),
      halts: { halts: async () => [] },
      escrow: new FakeEscrowReader(),
    })
  }

  it('lists only the X bindings, probes through the transport, and records rows the publisher store reads back', async () => {
    const answers = new Map<string, ChannelHealthProbe>([
      ['100200300', { status: 'ok', observedAtUnix: START, detail: '200 users/me' }],
    ])
    const store = new InMemoryChannelHealthStore()
    const health = new PgPublishingHealth({
      driver: db.driver,
      transport: {
        async probeAccount(accountId) {
          const answer = answers.get(accountId)
          if (answer === undefined) throw new Error('ECONNRESET')
          return answer
        },
      },
      store,
      clock,
    })
    expect(await health.listAccounts()).toEqual([DEV, OP])
    expect(await health.probe(OP)).toEqual({ status: 'ok', observedAtUnix: START, detail: '200 users/me' })
    expect(await health.probe(DEV)).toMatchObject({ status: 'unreachable', observedAtUnix: START })
    await health.record({ ...OP, status: 'ok', observedAtUnix: START, detail: '200 users/me' })
    expect(await store.get('x_operator', OP.accountId)).toMatchObject({ status: 'ok' })
  })

  it('surfaces the newest non-ok row per account with the onset of the run, and the catalog pages on it', async () => {
    const insert = (channel: string, accountId: string, status: string, at: number) =>
      db.driver.execute(
        `INSERT INTO publisher_account_health (channel, account_id, status, observed_at_unix, detail) VALUES ($1, $2, $3, $4, $5)`,
        [channel, accountId, status, at, `${status}`],
      )
    // The operator account: ok, then suspended twice. Onset is the first suspended row.
    await insert('x_operator', OP.accountId, 'ok', START - 18 * HOUR)
    await insert('x_operator', OP.accountId, 'suspended', START - 12 * HOUR)
    await insert('x_operator', OP.accountId, 'suspended', START - 6 * HOUR)
    // The dev account: locked, then reinstated. Newest is ok, so nothing fires.
    await insert('x_client_delegated', DEV.accountId, 'locked', START - 12 * HOUR)
    await insert('x_client_delegated', DEV.accountId, 'ok', START - 6 * HOUR)

    const signals = await collector().collect(START)
    expect(signals.publishing.suspendedChannels).toEqual([
      { channel: 'x_operator', accountRef: OP.accountId, detectedAtUnix: START - 12 * HOUR, affectedVaults: 1 },
    ])

    const firing = publishingChannelSuspended.evaluate(signals)
    expect(firing).toHaveLength(1)
    expect(firing[0]).toMatchObject({ severity: 'page', scope: OP.accountId, autoAction: 'halt_publishing' })
  })

  it('reports nothing while every newest row is ok', async () => {
    await db.driver.execute(
      `INSERT INTO publisher_account_health (channel, account_id, status, observed_at_unix, detail) VALUES ('x_operator', '100200300', 'ok', $1, '200')`,
      [START],
    )
    expect((await collector().collect(START)).publishing.suspendedChannels).toEqual([])
  })
})
