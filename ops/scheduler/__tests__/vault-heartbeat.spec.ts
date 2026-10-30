/**
 * The dead-man heartbeat, through the real scheduler against the fakes.
 *
 * The property that matters: a heartbeat goes out ONLY once operator silence
 * has reached a quarter of DEAD_MAN, and never as a reflex on every tick. A
 * busy vault is never touched; a quiet one is touched about four times per
 * dead-man window, which is what keeps emergencyDevRelease unreachable.
 */

import { describe, expect, it } from 'vitest'
import { MemoryLogSink, StructuredLogger } from '../../lib/logging.js'
import { TERMS } from '../../lib/protocol.js'
import { DAY, FixedClock, HOUR } from '../../lib/time.js'
import { HEARTBEAT } from '../config.js'
import { InMemoryDeadLetterQueue } from '../deadletter.js'
import { makeFakePorts } from '../fakes.js'
import { InMemoryRunStore } from '../idempotency.js'
import { HEARTBEAT_AFTER_SECONDS, heartbeatDue, vaultHeartbeatJob } from '../jobs/vault-heartbeat.js'
import { InMemoryLockBackend } from '../lock.js'
import { InMemoryFreezeGate, Scheduler } from '../scheduler.js'

const VAULT = '0x1111111111111111111111111111111111111111'
const START = Math.floor(Date.UTC(2026, 8, 7, 12, 0, 0) / 1000)

function harness() {
  const clock = new FixedClock(START)
  const sink = new MemoryLogSink()
  const log = new StructuredLogger({ sink: sink.sink, nowUnix: () => clock.nowUnix(), minLevel: 'debug' })
  const ports = makeFakePorts(clock)
  const scheduler = new Scheduler({
    clock,
    runs: new InMemoryRunStore(),
    locks: new InMemoryLockBackend(clock),
    deadLetters: new InMemoryDeadLetterQueue(),
    freeze: new InMemoryFreezeGate(),
    log,
    workerId: 'test',
  }).registerAll([vaultHeartbeatJob(ports)])
  ports.vaults.add({
    address: VAULT,
    token: '0x2222222222222222222222222222222222222222',
    state: 'ACTIVE',
    tier: 'T1',
    budgetBps: 0,
    operatorBps: 1000,
    buybackEnabled: false,
    creatorTaxBps: 0,
    devPayout: '0x4444444444444444444444444444444444444444',
  })
  return { clock, ports, scheduler }
}

describe('vault.heartbeat', () => {
  it('fires at a quarter of the dead-man window, derived from TERMS rather than written down', () => {
    expect(HEARTBEAT_AFTER_SECONDS).toBe((TERMS.deadManDays * DAY) / HEARTBEAT.silenceFractionOfDeadMan)
    expect(heartbeatDue(START, START - HEARTBEAT_AFTER_SECONDS + 1)).toBe(false)
    expect(heartbeatDue(START, START - HEARTBEAT_AFTER_SECONDS)).toBe(true)
  })

  it('leaves a vault the operator has touched alone, and heartbeats one that has gone quiet', async () => {
    const { clock, ports, scheduler } = harness()
    ports.heartbeat.set(VAULT, START - DAY)

    await scheduler.tick()
    expect(ports.heartbeat.sent).toHaveLength(0)

    // Silence accumulates on the vault's own clock; the job reads it there.
    clock.advance(HEARTBEAT_AFTER_SECONDS)
    await scheduler.tick()
    expect(ports.heartbeat.sent).toHaveLength(1)
    expect(ports.heartbeat.sent[0]?.vault).toBe(VAULT)

    // The heartbeat reset the clock: the next evaluation sends nothing.
    clock.advance(HEARTBEAT.evaluateEverySeconds + HOUR)
    await scheduler.tick()
    expect(ports.heartbeat.sent).toHaveLength(1)
  })

  it('does not evaluate more often than the interval', async () => {
    const { clock, ports, scheduler } = harness()
    ports.heartbeat.set(VAULT, START - 2 * HEARTBEAT_AFTER_SECONDS)
    await scheduler.tick()
    expect(ports.heartbeat.sent).toHaveLength(1)
    ports.heartbeat.set(VAULT, START - 2 * HEARTBEAT_AFTER_SECONDS)
    clock.advance(HOUR)
    await scheduler.tick()
    expect(ports.heartbeat.sent).toHaveLength(1)
  })
})
