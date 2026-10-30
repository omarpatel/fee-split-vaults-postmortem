import { describe, expect, it } from 'vitest'

import { TIERS, TIER_ORDER, type TierId } from '../../protocol.js'
import { ApiError } from '../client.js'
import { DecodeError, decodeAgentRun, decodeCoinAgent } from '../decode.js'
import { FixtureApiClient } from '../fixtures/client.js'
import { AGENT_ROLE_IDS } from '../model.js'
import type * as M from '../model.js'
import type * as W from '../wire.js'

/**
 * The agent team, through the API boundary.
 *
 * Two things are being defended here. The first is that the OFFLINE demo tells
 * the truth: every figure it shows is derived from the runs underneath it, and
 * it never claims a model produced anything. The second is that the DECODER
 * fails loudly on a body it does not understand, rather than rendering a
 * half-understood team as a working one.
 */

const NOW = 1_780_000_000
const WINDOW_SECONDS = 30 * 60

function client(): FixtureApiClient {
  return new FixtureApiClient({ now: () => NOW })
}

async function agentsByTier(): Promise<Map<TierId, M.CoinAgent>> {
  const api = client()
  const byTier = new Map<TierId, M.CoinAgent>()
  for (const summary of await api.listCoins()) {
    const agent = await api.getCoinAgent(summary.vault)
    if (!byTier.has(agent.tier)) byTier.set(agent.tier, agent)
  }
  return byTier
}

describe('the fixture backend renders a team for every tier', () => {
  it('has an agent for every coin, and a coin at every tier', async () => {
    const byTier = await agentsByTier()
    for (const tier of TIER_ORDER) {
      expect(byTier.has(tier), `no fixture coin at ${tier}`).toBe(true)
    }
  })

  it('lists all six roles for every coin, dormant ones included', async () => {
    const api = client()
    for (const summary of await api.listCoins()) {
      const agent = await api.getCoinAgent(summary.vault)
      expect(agent.roles.map((role) => role.id)).toEqual([...AGENT_ROLE_IDS])
    }
  })

  it('states a code AND a sentence on every dormant role, never a bare absence', async () => {
    const api = client()
    for (const summary of await api.listCoins()) {
      const agent = await api.getCoinAgent(summary.vault)
      for (const role of agent.roles) {
        if (role.activity !== 'dormant') continue
        expect(role.dormantCode, `${agent.tier} ${role.id}`).toBeTruthy()
        expect((role.dormantReason ?? '').length, `${agent.tier} ${role.id}`).toBeGreaterThan(20)
      }
    }
  })

  it('gives every role a "may not" list, because the refusals are the product', async () => {
    const api = client()
    const coins = await api.listCoins()
    const roles = await api.getAgentRoles(coins[0]!.vault)
    for (const role of roles) {
      expect(role.may.length, role.id).toBeGreaterThan(0)
      expect(role.mayNot.length, role.id).toBeGreaterThan(0)
    }
  })

  it('never claims a model produced any of it', async () => {
    const api = client()
    for (const summary of await api.listCoins()) {
      const agent = await api.getCoinAgent(summary.vault)
      // The single assertion in this file that is about honesty rather than
      // arithmetic. A demo that badged itself 'live' would be teaching exactly
      // the wrong thing about the one claim this product cannot get wrong.
      expect(agent.model.provenance).toBe('fake')
      expect(agent.fakedDependencies.length).toBeGreaterThan(0)

      const page = await api.listAgentRuns(summary.vault)
      for (const run of page.runs) expect(run.modelProvenance).toBe('fake')
      expect(page.fakedDependencies).toEqual(agent.fakedDependencies)
    }
  })
})

describe('a deterministic tier is shown as deterministic, not as broken', () => {
  it('names the tier as the reason the model roles are asleep at T0', async () => {
    const agent = (await agentsByTier()).get('T0')!
    expect(TIERS.T0.usesModel).toBe(false)

    for (const id of ['reader', 'planner', 'desk'] as const) {
      const role = agent.roles.find((candidate) => candidate.id === id)!
      expect(role.activity).toBe('dormant')
      expect(role.dormantCode).toBe('tier_has_no_model')
      expect(role.dormantReason).toContain('deterministic by design')
    }

    const broker = agent.roles.find((role) => role.id === 'broker')!
    expect(broker.dormantCode).toBe('tier_has_no_paid_media')

    // The indexer runs at every tier: a coin we may not speak for is still a
    // coin whose fees have to be accounted for correctly.
    expect(agent.roles.find((role) => role.id === 'indexer')?.activity).toBe('active')
  })

  it('gives a T0 coin runs that record the refusal rather than no runs at all', async () => {
    const api = client()
    const agent = (await agentsByTier()).get('T0')!
    const page = await api.listAgentRuns(agent.vault)

    expect(page.runs.length).toBeGreaterThan(0)
    for (const run of page.runs) {
      expect(run.ranCognition).toBe(false)
      expect(run.digest).toBeNull()
      expect(run.skipped).toBe('tier_has_no_model')
      expect(run.cost.microUsd).toBe(0n)
      expect(run.refusals.map((refusal) => refusal.code)).toContain('tier_has_no_model')
    }
  })

  it('spends nothing and makes no call at a tier with no model in the loop', async () => {
    const agent = (await agentsByTier()).get('T0')!
    expect(agent.spend.todayMicroUsd).toBe(0n)
    expect(agent.spend.callsToday).toBe(0)
    expect(agent.spend.degradeLevel).toBe('full')

    // The governor still derives a ceiling from the tier's COGS, so the figure
    // on the wire is a small non-zero number rather than zero. It is NOT a
    // budget this coin may spend, and the page suppresses it on the tier fact
    // rather than on the figure - asserted in the page's own render test.
    expect(agent.spend.dailyCapMicroUsd).toBeGreaterThan(0n)
    expect(TIERS.T0.usesModel).toBe(false)
  })
})

describe('the figures agree with the history underneath them', () => {
  it("derives today's spend and call count from the runs, not from a drawn number", async () => {
    const api = client()
    const dayKey = (unix: number) => new Date(unix * 1_000).toISOString().slice(0, 10)

    for (const summary of await api.listCoins()) {
      const agent = await api.getCoinAgent(summary.vault)
      // Every run, not just the first page: a total that only matched page one
      // would be a coincidence.
      const runs: M.AgentRun[] = []
      let cursor: string | null = null
      do {
        const page: M.AgentRunPage = await api.listAgentRuns(summary.vault, cursor)
        runs.push(...page.runs)
        cursor = page.nextCursor
      } while (cursor !== null)

      const today = runs.filter((run) => dayKey(run.atUnix) === agent.spend.dayKey)
      const spent = today.reduce((sum, run) => sum + run.cost.microUsd, 0n)
      const calls = today.reduce((sum, run) => sum + (run.ranCognition ? 2 : 0), 0)

      expect(spent, `${agent.tier} spend`).toBe(agent.spend.todayMicroUsd)
      expect(calls, `${agent.tier} calls`).toBe(agent.spend.callsToday)
    }
  })

  it('never reports a coin over its own daily model cap', async () => {
    const api = client()
    for (const summary of await api.listCoins()) {
      const agent = await api.getCoinAgent(summary.vault)
      if (agent.spend.dailyCapMicroUsd === 0n) {
        expect(agent.spend.todayMicroUsd).toBe(0n)
        continue
      }
      expect(agent.spend.todayMicroUsd).toBeLessThanOrEqual(agent.spend.dailyCapMicroUsd)
    }
  })

  it('runs on the fixed 30-minute schedule, newest first, with no wake-on-mention gap', async () => {
    const api = client()
    for (const summary of await api.listCoins()) {
      const { runs } = await api.listAgentRuns(summary.vault)
      for (const [i, run] of runs.entries()) {
        if (i === 0) continue
        expect(runs[i - 1]!.atUnix - run.atUnix).toBe(WINDOW_SECONDS)
      }
      // nextDueUnix is one window on from the run that set it, always.
      for (const run of runs) expect(run.nextDueUnix - run.atUnix).toBe(WINDOW_SECONDS)
    }
  })

  it('reports the last tick from the newest run and never as now or zero', async () => {
    const api = client()
    for (const summary of await api.listCoins()) {
      const agent = await api.getCoinAgent(summary.vault)
      const { runs } = await api.listAgentRuns(summary.vault)
      expect(agent.lastTickAtUnix).toBe(runs[0]!.atUnix)
      expect(agent.nextDueUnix).toBe(runs[0]!.nextDueUnix)
    }
  })

  it('includes at least one window that ran nothing and cost nothing', async () => {
    // Most windows do nothing. A demo of eight busy windows in a row would
    // misdescribe the product as badly as a demo of none.
    const api = client()
    const agent = (await agentsByTier()).get('T2')!
    const { runs } = await api.listAgentRuns(agent.vault)
    const quiet = runs.filter((run) => !run.ranCognition)
    expect(quiet.length).toBeGreaterThan(0)
    for (const run of quiet) expect(run.cost.microUsd).toBe(0n)
  })
})

describe('the airlock holds in the fixture data too', () => {
  it('lets no address, URL, handle or amount across in a gist', async () => {
    const api = client()
    for (const summary of await api.listCoins()) {
      const { runs } = await api.listAgentRuns(summary.vault)
      for (const run of runs) {
        for (const gist of run.digest?.gists ?? []) {
          expect(gist, 'address-shaped').not.toMatch(/0x[0-9a-fA-F]{6,}/)
          expect(gist, 'link-shaped').not.toMatch(/https?:\/\/|\w+\.(com|io|xyz|net)\b/i)
          expect(gist, 'handle-shaped').not.toMatch(/@\w+/)
          expect(gist, 'amount-shaped').not.toMatch(/\d/)
        }
      }
    }
  })

  it('reports a flood as messages the caps dropped, not as messages read', async () => {
    const api = client()
    const agent = (await agentsByTier()).get('T3')!
    const { runs } = await api.listAgentRuns(agent.vault)
    const flooded = runs.find((run) => (run.digest?.droppedMessageCount ?? 0) > 100)

    expect(flooded, 'no flooded window in the demo data').toBeDefined()
    expect(flooded!.digest!.admittedMessageCount).toBeLessThan(
      flooded!.digest!.droppedMessageCount,
    )
    expect(flooded!.digest!.signals).toContain('mention_spike')
  })

  it('records a frozen purchase as suppressed rather than deleting it', async () => {
    const api = client()
    const found: Array<{ reason: string }> = []
    for (const summary of await api.listCoins()) {
      const { runs } = await api.listAgentRuns(summary.vault)
      for (const run of runs) {
        for (const entry of run.suppressed) {
          found.push({ reason: entry.reason })
          // The suppressed proposal is still there in full, so a reader can see
          // WHAT was stopped and not merely that something was.
          expect(entry.proposal.kind).toBe('purchase')
          expect(entry.reason.length).toBeGreaterThan(10)
          expect(run.proposals).not.toContainEqual(entry.proposal)
        }
      }
    }
    expect(found.length, 'no suppression anywhere in the demo data').toBeGreaterThan(0)
  })

  it('shows both a coin frozen right now and a coin that is not', async () => {
    // A demo where every coin is frozen would misdescribe the freeze as normal;
    // one where none is would leave the whole mechanism invisible.
    const api = client()
    const freezes = new Set<string>()
    for (const summary of await api.listCoins()) {
      const agent = await api.getCoinAgent(summary.vault)
      if (TIERS[agent.tier].usesModel) freezes.add(agent.freeze)
    }
    expect(freezes.has('none')).toBe(true)
    expect(freezes.has('purchases')).toBe(true)
  })
})

describe('paging the run history', () => {
  it('pages forward and stops, without ever restarting at page one', async () => {
    const api = client()
    const vault = (await agentsByTier()).get('T3')!.vault

    const first = await api.listAgentRuns(vault)
    expect(first.nextCursor).not.toBeNull()

    const second = await api.listAgentRuns(vault, first.nextCursor)
    expect(second.runs[0]?.id).not.toBe(first.runs[0]?.id)
    expect(second.nextCursor).toBeNull()

    const ids = [...first.runs, ...second.runs].map((run) => run.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('refuses a cursor it did not issue rather than silently serving page one', async () => {
    const api = client()
    const vault = (await agentsByTier()).get('T3')!.vault
    await expect(api.listAgentRuns(vault, 'not-a-cursor')).rejects.toBeInstanceOf(ApiError)
  })
})

// ---------------------------------------------------------------------------
// The decoder
// ---------------------------------------------------------------------------

function roleWire(id: string): W.AgentRoleWire {
  return {
    id,
    title: 'Role',
    mission: 'does a thing',
    phases: ['cognition'],
    readsUntrustedInput: false,
    may: ['a'],
    mayNot: ['b'],
    activity: 'active',
  }
}

function agentWire(overrides: Partial<W.CoinAgentWire> = {}): W.CoinAgentWire {
  return {
    coinRef: 'coin_x',
    vault: '0x1111111111111111111111111111111111111111',
    tier: 'T2',
    vaultState: 'ACTIVE',
    halted: false,
    screeningVerdict: 'CLEAR',
    paidMediaPermitted: true,
    lastTickAtUnix: NOW - 600,
    nextDueUnix: NOW + 1_200,
    freeze: 'none',
    model: {
      readerModel: 'claude-haiku-4-5',
      plannerModel: 'claude-sonnet-5',
      provenance: 'live',
      detail: 'resolved',
      viaBatch: false,
    },
    spend: {
      todayMicroUsd: '431000',
      dailyCapMicroUsd: '4680000',
      tierCogsPerDayMicroUsd: '7800000',
      callsToday: 12,
      degradeLevel: 'full',
      dayKey: '2026-05-01',
    },
    roles: [...AGENT_ROLE_IDS].map(roleWire),
    fakedDependencies: [],
    atUnix: NOW,
    ...overrides,
  }
}

describe('decoding the agent wire', () => {
  it('carries micro-USD across as an integer, never as a JSON number', () => {
    const agent = decodeCoinAgent(agentWire())
    expect(agent.spend.todayMicroUsd).toBe(431_000n)
    expect(agent.spend.dailyCapMicroUsd).toBe(4_680_000n)
    expect(typeof agent.spend.todayMicroUsd).toBe('bigint')
  })

  it('refuses a team that arrived short a member rather than rendering a smaller team', () => {
    const short = agentWire({ roles: ['indexer', 'reader'].map(roleWire) })
    expect(() => decodeCoinAgent(short)).toThrow(DecodeError)
  })

  it('refuses a role id it does not know rather than rendering a blank card', () => {
    const rogue = agentWire({ roles: [...AGENT_ROLE_IDS, 'ghostwriter'].map(roleWire) })
    expect(() => decodeCoinAgent(rogue)).toThrow(DecodeError)
  })

  it('refuses an unknown degrade level rather than reading it as "full"', () => {
    // The failure this guards is specific: a suspended team rendered as a
    // working one, because a fallback treated an unrecognised value as normal.
    const wire = agentWire()
    const melted = { ...wire, spend: { ...wire.spend, degradeLevel: 'melted' } }
    expect(() => decodeCoinAgent(melted)).toThrow(DecodeError)
  })

  it('keeps a null screening verdict null, because absence is not a pass', () => {
    expect(decodeCoinAgent(agentWire({ screeningVerdict: null })).screeningVerdict).toBeNull()
  })

  it('keeps a never-ticked coin null rather than turning it into zero', () => {
    const agent = decodeCoinAgent(agentWire({ lastTickAtUnix: null, nextDueUnix: null }))
    expect(agent.lastTickAtUnix).toBeNull()
    expect(agent.nextDueUnix).toBeNull()
  })

  it('decodes a run with no digest as a run that read nothing, not as a broken run', () => {
    const run = decodeAgentRun({
      id: '0xv:1',
      coinRef: 'coin_x',
      vault: '0x1111111111111111111111111111111111111111',
      atUnix: NOW,
      tier: 'T0',
      ranChainPoll: true,
      ranCognition: false,
      nextDueUnix: NOW + 1_800,
      skipped: 'tier_has_no_model',
      digest: null,
      proposals: [],
      suppressed: [],
      violations: [],
      refusals: [{ phase: 'cognition', code: 'tier_has_no_model', detail: 'T0 is deterministic' }],
      spends: [],
      publishes: [],
      cost: {
        microUsd: '0',
        degradeLevel: 'full',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      },
      modelProvenance: 'fake',
    })
    expect(run.digest).toBeNull()
    expect(run.skipped).toBe('tier_has_no_model')
    expect(run.cost.microUsd).toBe(0n)
    expect(run.refusals).toHaveLength(1)
  })
})
