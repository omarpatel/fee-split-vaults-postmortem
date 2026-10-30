/**
 * The team, and the record of what it did.
 *
 * The load-bearing assertion in this file is the one that runs a REAL tick and
 * then checks that `evaluateAgentRoles` agrees with it. The role table is a
 * naming of conditions that already exist in coin.ts, so its only real failure
 * mode is drift: a rule changes in the tick and the page keeps saying the old
 * thing. Comparing a projected run's refusal codes against the dormancy codes
 * for the same inputs is what catches that.
 */
import { describe, expect, it } from 'vitest'

import {
  AGENT_ROLE_IDS,
  AGENT_ROLES,
  AgentRunQueryError,
  InMemoryAgentRunStore,
  buildAgentSnapshot,
  evaluateAgentRoles,
  microUsdFromFloat,
  projectAgentRun,
  type AgentRunRecord,
  type RoleActivationInput,
} from '../index.js'
import { NOW, QUIET, VAULT, makeHarness, makeScreening } from './harness.js'

const HEALTHY: RoleActivationInput = {
  tier: 'T2',
  vaultState: 'ACTIVE',
  halted: false,
  screeningVerdict: 'CLEAR',
  paidMediaPermitted: true,
  operatedAccountCount: 2,
  degradeLevel: 'full',
  freeze: 'none',
}

function codes(input: RoleActivationInput): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const status of evaluateAgentRoles(input)) {
    out[status.role.id] = status.activity === 'active' ? undefined : status.dormantCode
  }
  return out
}

describe('the six roles', () => {
  it('are exactly six, in the order the tick runs them', () => {
    expect(AGENT_ROLE_IDS).toEqual(['indexer', 'reader', 'planner', 'desk', 'broker', 'publisher'])
    expect(evaluateAgentRoles(HEALTHY)).toHaveLength(6)
  })

  it('every role states what it may NOT do; the refusals are the product surface', () => {
    for (const id of AGENT_ROLE_IDS) {
      expect(AGENT_ROLES[id].mayNot.length, `${id} has no stated refusals`).toBeGreaterThan(0)
      expect(AGENT_ROLES[id].may.length, `${id} has no stated permissions`).toBeGreaterThan(0)
      expect(AGENT_ROLES[id].phases.length, `${id} owns no tick phase`).toBeGreaterThan(0)
    }
  })

  it('names exactly the two roles that read untrusted input', () => {
    const reading = AGENT_ROLE_IDS.filter((id) => AGENT_ROLES[id].readsUntrustedInput)
    // The security argument in docs/ARCHITECTURE.md §5 in one line: the roles
    // that read a stranger's text are disjoint from the roles that can act.
    expect(reading).toEqual(['reader', 'desk'])
    for (const id of reading) {
      expect(AGENT_ROLES[id].phases).not.toContain('spend')
      expect(AGENT_ROLES[id].phases).not.toContain('publish')
    }
  })

  it('is all awake on a healthy T2 coin', () => {
    expect(codes(HEALTHY)).toEqual({
      indexer: undefined,
      reader: undefined,
      planner: undefined,
      desk: undefined,
      broker: undefined,
      publisher: undefined,
    })
  })

  it('sleeps the model roles at T0 and says the tier is the reason', () => {
    const at0 = codes({ ...HEALTHY, tier: 'T0', paidMediaPermitted: false })
    expect(at0.reader).toBe('tier_has_no_model')
    expect(at0.planner).toBe('tier_has_no_model')
    expect(at0.desk).toBe('tier_has_no_model')
    expect(at0.broker).toBe('tier_has_no_paid_media')
    // The indexer never sleeps for a tier: fees still have to be accounted for.
    expect(at0.indexer).toBeUndefined()
    expect(at0.publisher).toBeUndefined()
  })

  it('separates "no screening on file" from "screening said no"', () => {
    const missing = evaluateAgentRoles({
      ...HEALTHY,
      screeningVerdict: undefined,
      paidMediaPermitted: false,
    })
    const broker = missing.find((role) => role.role.id === 'broker')
    expect(broker?.dormantCode).toBe('paid_media_not_permitted')
    expect(broker?.dormantReason).toContain('Absence of a screening is not a pass')

    const restricted = evaluateAgentRoles({
      ...HEALTHY,
      screeningVerdict: 'RESTRICTED',
      paidMediaPermitted: false,
    })
    expect(
      restricted.find((role) => role.role.id === 'broker')?.dormantReason,
    ).toContain('RESTRICTED')
    // RESTRICTED stops paid media and NOTHING else. Organic operations continue.
    expect(restricted.find((role) => role.role.id === 'desk')?.activity).toBe('active')
    expect(restricted.find((role) => role.role.id === 'publisher')?.activity).toBe('active')
  })

  it('a BLOCKED verdict stops every role that speaks or spends', () => {
    const blocked = codes({
      ...HEALTHY,
      screeningVerdict: 'BLOCKED',
      paidMediaPermitted: false,
    })
    expect(blocked.reader).toBe('operations_not_permitted')
    expect(blocked.planner).toBe('operations_not_permitted')
    expect(blocked.desk).toBe('operations_not_permitted')
    expect(blocked.publisher).toBe('operations_not_permitted')
    expect(blocked.broker).toBe('spend_authority_inactive')
    expect(blocked.indexer).toBeUndefined()
  })

  it('reports a halt as a halt rather than as an inactive vault', () => {
    expect(codes({ ...HEALTHY, halted: true }).broker).toBe('indexer_halt')
    expect(codes({ ...HEALTHY, vaultState: 'PENDING' }).broker).toBe('spend_authority_inactive')
  })

  it('a spent daily model budget degrades rather than failing', () => {
    const suspended = codes({ ...HEALTHY, degradeLevel: 'suspend' })
    expect(suspended.reader).toBe('budget_suspended')
    expect(suspended.planner).toBe('budget_suspended')
    // Spending and publishing do not depend on the model budget.
    expect(suspended.broker).toBeUndefined()
    expect(suspended.publisher).toBeUndefined()
  })

  it('a full freeze silences the planner; a purchase freeze silences only the broker', () => {
    expect(codes({ ...HEALTHY, freeze: 'all' }).planner).toBe('divergence_freeze_all')
    const purchases = codes({ ...HEALTHY, freeze: 'purchases' })
    expect(purchases.planner).toBeUndefined()
    expect(purchases.broker).toBe('divergence_freeze_purchases')
  })

  it('has no account to speak on, and says so instead of posting elsewhere', () => {
    expect(codes({ ...HEALTHY, operatedAccountCount: 0 }).publisher).toBe('no_operated_accounts')
  })

  it('reports an ended engagement once, for every role', () => {
    const ended = evaluateAgentRoles({ ...HEALTHY, vaultState: 'TERMINATED' })
    expect(ended.every((role) => role.dormantCode === 'engagement_ended')).toBe(true)
  })
})

/**
 * These are the drift tests, and they are the reason this file exists.
 *
 * The role table restates conditions that live in coin.ts. Restating a
 * condition is how a page ends up confidently describing a rule the code
 * stopped following, so each case here runs a REAL tick, reads the cognition
 * refusal the tick itself recorded, and asserts the table produces the same
 * machine code for the same inputs.
 *
 * `binding: null` holds the tier where the test put it: without a binding the
 * measure phase refuses, the tier phase holds, and the tick is exercising the
 * cognition gate rather than a tier change.
 */
describe('the role table against a real tick', () => {
  async function cognitionRefusal(options: Parameters<typeof makeHarness>[0]) {
    const result = await makeHarness(options).ticker.tick()
    return result.refusals.find((entry) => entry.phase === 'cognition')?.code
  }

  it('agrees with the tick that refused cognition at T0', async () => {
    const code = await cognitionRefusal({ vault: { tier: 'T0' }, binding: null })
    expect(code).toBe('tier_has_no_model')
    expect(codes({ ...HEALTHY, tier: 'T0' }).reader).toBe(code)
  })

  it('agrees with the tick that refused cognition under a BLOCKED screening', async () => {
    const code = await cognitionRefusal({
      vault: { tier: 'T1' },
      binding: null,
      screening: makeScreening({ verdict: 'BLOCKED' }),
    })
    expect(code).toBe('operations_not_permitted')
    expect(codes({ ...HEALTHY, screeningVerdict: 'BLOCKED' }).reader).toBe(code)
  })

  it('reports the tier gate before the screening gate, exactly as the tick does', async () => {
    // Both gates are shut. The tick names the tier, so the table must too:
    // telling a T0 dev their screening is the problem would send them to fix
    // the wrong thing.
    const code = await cognitionRefusal({
      vault: { tier: 'T0' },
      binding: null,
      screening: makeScreening({ verdict: 'BLOCKED' }),
    })
    expect(code).toBe('tier_has_no_model')
    expect(codes({ ...HEALTHY, tier: 'T0', screeningVerdict: 'BLOCKED' }).reader).toBe(code)
  })
})

describe('projecting a tick into a run record', () => {
  it('carries the digest counters, the proposals and every refusal', async () => {
    const harness = makeHarness({ plannerCalls: QUIET })
    const result = await harness.ticker.tick()
    const run = projectAgentRun(result, { tier: 'T1', modelProvenance: 'fake' })

    expect(run.vault).toBe(result.vault)
    expect(run.id).toBe(`${result.vault}:${String(result.atUnix)}`)
    expect(run.modelProvenance).toBe('fake')
    expect(run.ranCognition).toBe(result.ranCognition)
    expect(run.digest?.admittedMessageCount).toBe(result.window?.digest?.admittedMessageCount)
    expect(run.proposals.map((proposal) => proposal.kind)).toEqual(
      (result.window?.proposals ?? []).map((proposal) => proposal.kind),
    )
    expect(run.refusals).toEqual(result.refusals)
  })

  it('never carries a post body, only its length', () => {
    const run = projectAgentRun(
      {
        coinRef: 'coin_alpha',
        vault: VAULT,
        atUnix: NOW,
        ranChainPoll: false,
        ranCognition: true,
        spends: [],
        publishes: [],
        refusals: [],
        nextDueUnix: NOW + 60,
        window: {
          coinRef: 'coin_alpha',
          window: { windowId: 'w', coinRef: 'coin_alpha', startUnix: NOW - 1_800, endUnix: NOW },
          proposals: [
            {
              kind: 'post',
              channel: 'telegram',
              intent: 'answer_backlog',
              topic: 'how_to_buy',
              body: 'a body a holder would read',
              linkRefs: ['official_site'],
              imageRefs: [],
            },
          ],
          suppressed: [],
          violations: [],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          costUsd: 0,
          degradeLevel: 'full',
          notes: [],
        },
      },
      { tier: 'T1', modelProvenance: 'live' },
    )
    const post = run.proposals[0]
    expect(post).toEqual({
      kind: 'post',
      channel: 'telegram',
      intent: 'answer_backlog',
      topic: 'how_to_buy',
      linkRefCount: 1,
      bodyChars: 'a body a holder would read'.length,
    })
    expect(post).not.toHaveProperty('body')
  })
})

describe('inference cost in micro-USD', () => {
  it('keeps a sub-cent call, which rounding to cents would erase', () => {
    // The whole reason this is not carried in cents: a reader call at $0.0043
    // is $0.00 to the nearest cent, and a day is hundreds of them.
    expect(microUsdFromFloat(0.0043)).toBe(4_300n)
    expect(microUsdFromFloat(0)).toBe(0n)
    expect(microUsdFromFloat(13.5)).toBe(13_500_000n)
  })

  it('refuses a non-finite cost rather than recording a zero', () => {
    expect(() => microUsdFromFloat(Number.NaN)).toThrow(TypeError)
    expect(() => microUsdFromFloat(Number.POSITIVE_INFINITY)).toThrow(TypeError)
  })

  it('reports a coin that has never ticked as null, not as zero', () => {
    const snapshot = buildAgentSnapshot({
      coinRef: 'coin_alpha',
      vault: VAULT,
      tier: 'T1',
      vaultState: 'ACTIVE',
      halted: false,
      screeningVerdict: 'CLEAR',
      paidMediaPermitted: true,
      operatedAccountCount: 1,
      meter: {
        budgetUsd: 7.8,
        spentUsd: () => 0,
        spend: () => ({ dayKey: '2026-09-09', usd: 0, calls: 0 }),
        level: () => 'full',
      },
      model: {
        readerModel: 'claude-haiku-4-5',
        plannerModel: 'claude-haiku-4-5',
        provenance: 'unknown',
        detail: 'no call has been made yet',
        viaBatch: false,
      },
      fakedDependencies: [],
      nowUnix: NOW,
    })
    expect(snapshot.lastTickAtUnix).toBeNull()
    expect(snapshot.nextDueUnix).toBeNull()
    expect(snapshot.spend.dailyCapMicroUsd).toBe(7_800_000n)
    // 'unknown' is not a synonym for 'fake'. A process that has made no call
    // cannot honestly claim either.
    expect(snapshot.model.provenance).toBe('unknown')
  })
})

describe('the run store', () => {
  const runAt = (vault: string, atUnix: number): AgentRunRecord => ({
    id: `${vault}:${String(atUnix)}`,
    coinRef: 'coin',
    vault,
    atUnix,
    tier: 'T1',
    ranChainPoll: false,
    ranCognition: false,
    nextDueUnix: atUnix + 60,
    proposals: [],
    suppressed: [],
    violations: [],
    refusals: [],
    spends: [],
    publishes: [],
    cost: {
      microUsd: 0n,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      degradeLevel: 'full',
    },
    modelProvenance: 'fake',
  })

  it('serves newest first and pages with a cursor it issued', async () => {
    const store = new InMemoryAgentRunStore()
    for (let i = 0; i < 5; i += 1) await store.record(runAt(VAULT, NOW + i * 60))

    const first = await store.list(VAULT, { limit: 2 })
    expect(first.runs.map((run) => run.atUnix)).toEqual([NOW + 240, NOW + 180])
    expect(first.nextCursor).toBe('2')

    const second = await store.list(VAULT, { limit: 2, cursor: first.nextCursor })
    expect(second.runs.map((run) => run.atUnix)).toEqual([NOW + 120, NOW + 60])
    expect((await store.latest(VAULT))?.atUnix).toBe(NOW + 240)
  })

  it('refuses a cursor it did not issue instead of serving page one', async () => {
    const store = new InMemoryAgentRunStore()
    await expect(store.list(VAULT, { cursor: 'nope' })).rejects.toBeInstanceOf(AgentRunQueryError)
    await expect(store.list(VAULT, { limit: 0 })).rejects.toBeInstanceOf(AgentRunQueryError)
    await expect(store.list(VAULT, { limit: 10_000 })).rejects.toBeInstanceOf(AgentRunQueryError)
  })

  it('bounds history per vault, so no coin can evict another coin', async () => {
    const other = '0x9999999999999999999999999999999999999999'
    const store = new InMemoryAgentRunStore(2)
    for (let i = 0; i < 5; i += 1) await store.record(runAt(VAULT, NOW + i * 60))
    await store.record(runAt(other, NOW))

    expect((await store.list(VAULT)).runs).toHaveLength(2)
    expect((await store.list(other)).runs).toHaveLength(1)
  })

  it('replacing a run by id does not duplicate it', async () => {
    const store = new InMemoryAgentRunStore()
    await store.record(runAt(VAULT, NOW))
    await store.record({ ...runAt(VAULT, NOW), ranCognition: true })
    const page = await store.list(VAULT)
    expect(page.runs).toHaveLength(1)
    expect(page.runs[0]?.ranCognition).toBe(true)
  })
})
