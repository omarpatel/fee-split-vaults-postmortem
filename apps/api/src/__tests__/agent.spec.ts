/**
 * The three agent routes, exercised through the router.
 *
 * What these check is the honesty discipline rather than the happy path: that a
 * faked model client is named in every response that carries its output, that a
 * dormant role says why, that a phase refusal survives to the wire with its
 * machine code, that model-authored text is scrubbed on the way out, and that
 * an unwired fleet REFUSES instead of rendering a coin whose team looks idle.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LEXICON_SOURCE,
  FakeChainDiligenceProbe,
  FakeIdentityProvider,
  Lexicon,
  SampleSdnSource,
  ScreeningEngine,
  SdnScreener,
} from '@fee-split-vaults/screening'
import { Ledger, InMemoryLedgerStore } from '@fee-split-vaults/ledger'
import {
  InMemoryAgentRunStore,
  InMemoryReceiptStore,
  buildAgentSnapshot,
  microUsdFromFloat,
  type AgentRunRecord,
  type AgentSnapshot,
  type PinnedUsdPrice,
} from '@fee-split-vaults/orchestrator'
import type { Address, Asset } from '@fee-split-vaults/core'

import { unwiredAgentPort, type AgentPort } from '../agent.js'
import { keccakHex, utf8 } from '../crypto/address.js'
import { buildRouter } from '../routes.js'
import { withV1 } from './v1-harness.js'
import { InMemoryKybAttestationStore } from '../diligence/kyb.js'
import { InMemoryOnboardingStore, Onboarding, type RecipientReader } from '../onboarding.js'
import { FakeVaultDeployer, type FactoryDescriptor } from '../deploy.js'
import { serialize } from '../http/json.js'
import type { RefusalRecord } from '../report.js'
import type { Eip712Domain } from '../eip712.js'

const NOW = 1_788_652_800
const VAULT = '0xaaaa000000000000000000000000000000000001' as Address
const FACTORY: FactoryDescriptor = {
  factory: '0xfac70000000000000000000000000000000000f1',
  deployer: '0xdeb10000000000000000000000000000000000d2',
  vaultInitCodeHash: keccakHex(utf8('CoinVault init code')),
  chainId: 4663,
}
const DOMAIN: Eip712Domain = { chainId: 4663, verifyingContract: FACTORY.factory }
const RECIPIENTS: RecipientReader = {
  creatorFeeRecipient: () => Promise.reject(new Error('not wired')),
  launchedAtUnix: () => Promise.resolve(NOW - 86_400),
  launchTerms: () => Promise.resolve({ buybackEnabled: false, creatorTaxBps: 0 }),
}

/** A meter with a fixed day, so the cap arithmetic is exact rather than clock-dependent. */
function meter(spentUsd: number, budgetUsd: number, calls: number) {
  return {
    budgetUsd,
    spentUsd: () => spentUsd,
    spend: () => ({ dayKey: '2026-09-09', usd: spentUsd, calls }),
    level: () => (spentUsd / budgetUsd >= 1 ? ('suspend' as const) : ('full' as const)),
  }
}

function snapshotFor(overrides: Partial<Parameters<typeof buildAgentSnapshot>[0]> = {}): AgentSnapshot {
  return buildAgentSnapshot({
    coinRef: 'coin_alpha',
    vault: VAULT,
    tier: 'T2',
    vaultState: 'ACTIVE',
    halted: false,
    screeningVerdict: 'CLEAR',
    paidMediaPermitted: true,
    operatedAccountCount: 2,
    meter: meter(1.4, 18, 12),
    model: {
      readerModel: 'claude-haiku-4-5',
      plannerModel: 'claude-sonnet-5',
      provenance: 'fake',
      detail: 'no credential resolved; running on FakeModelClient',
      viaBatch: false,
    },
    lastRun: { atUnix: NOW - 600, nextDueUnix: NOW + 1_200 },
    fakedDependencies: ['model client', 'telegram transport'],
    nowUnix: NOW,
    ...overrides,
  })
}

function runFor(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: `${VAULT}:${String(NOW - 600)}`,
    coinRef: 'coin_alpha',
    vault: VAULT,
    atUnix: NOW - 600,
    tier: 'T2',
    ranChainPoll: true,
    ranCognition: true,
    nextDueUnix: NOW + 1_200,
    digest: {
      windowId: 'coin_alpha:1788651600',
      windowStartUnix: NOW - 1_800,
      windowEndUnix: NOW,
      admittedMessageCount: 84,
      droppedMessageCount: 19,
      distinctAuthorCount: 31,
      topicCounts: [
        { code: 'price_question', count: 22 },
        { code: 'scam_report', count: 4 },
      ],
      signals: ['mention_spike'],
      gists: ['holders asking when the next listing lands'],
      rejectedGistCount: 1,
      readerRefusals: 2,
    },
    proposals: [
      { kind: 'post', channel: 'telegram', intent: 'answer', topic: 'how_to_buy', linkRefCount: 1, bodyChars: 180 },
    ],
    suppressed: [
      {
        proposal: { kind: 'purchase', skuId: 'dex_boost_500', quantity: 1, rationale: 'mention spike' },
        reason: 'divergence: price_question share moved 4.2 sigma with a correlated mention spike',
      },
    ],
    violations: [{ toolName: 'propose_post', field: 'linkRefs', message: 'unknown link id' }],
    refusals: [{ phase: 'spend', code: 'paid_media_not_permitted', detail: 'tier or screening denies paid media' }],
    spends: [],
    publishes: [{ channel: 'telegram', intent: 'answer', published: true }],
    cost: {
      microUsd: microUsdFromFloat(0.0431),
      usage: { inputTokens: 5_100, outputTokens: 380, cacheCreationInputTokens: 0, cacheReadInputTokens: 4_096 },
      degradeLevel: 'full',
    },
    modelProvenance: 'fake',
    ...overrides,
  }
}

async function wiredPort(
  runs: AgentRunRecord[],
  snapshot: AgentSnapshot = snapshotFor(),
): Promise<AgentPort> {
  const store = new InMemoryAgentRunStore()
  for (const run of [...runs].reverse()) await store.record(run)
  return {
    snapshot: (vault: Address) =>
      Promise.resolve(vault === VAULT ? snapshot : undefined),
    runs: store,
  }
}

function makeRouter(agent: AgentPort): ReturnType<typeof buildRouter> {
  const ledgerStore = new InMemoryLedgerStore()
  return buildRouter(withV1({ onboarding: new Onboarding({
    factory: FACTORY,
    domain: DOMAIN,
    deployer: new FakeVaultDeployer(FACTORY, () => NOW),
    recipients: RECIPIENTS,
    store: new InMemoryOnboardingStore(),
    now: () => NOW,
  }),
  screening: new ScreeningEngine({
    lexicon: new Lexicon([DEFAULT_LEXICON_SOURCE]),
    sdn: new SdnScreener(new SampleSdnSource(NOW)),
    clock: () => NOW,
  }),
  diligence: { probe: new FakeChainDiligenceProbe(), identity: new FakeIdentityProvider() },
  factory: FACTORY,
  domain: DOMAIN,
  ledger: new Ledger(ledgerStore, { now: () => NOW }),
  ledgerStore,
  receipts: new InMemoryReceiptStore(),
  reporting: {
    assetFor: (): Promise<Asset | undefined> => Promise.resolve(undefined),
    priceFor: (): Promise<PinnedUsdPrice | undefined> => Promise.resolve(undefined),
    refusalsFor: (): Promise<RefusalRecord[]> => Promise.resolve([]),
    tierFor: (): Promise<string> => Promise.resolve('T0'),
    paidMediaPermitted: (): Promise<boolean> => Promise.resolve(false),
  },
  agent,
  kyb: new InMemoryKybAttestationStore(),
  screeningMaxAgeSeconds: 7 * 86_400,
  now: () => NOW, }))
}

async function get(agent: AgentPort, path: string, query: Record<string, string> = {}) {
  const response = await makeRouter(agent).handle({
    method: 'GET',
    path,
    query,
    body: undefined,
    headers: {},
  })
  // Round-tripped through the real serialiser: a bigint that reached the body
  // would throw here, which is the property json.ts exists to hold.
  return { status: response.status, body: JSON.parse(serialize(response.body)) as never }
}

describe('GET /coins/:vault/agent', () => {
  it('names every faked dependency and the model provenance', async () => {
    const { status, body } = await get(await wiredPort([runFor()]), `/coins/${VAULT}/agent`)
    expect(status).toBe(200)
    const agent = (body as { agent: Record<string, never> }).agent
    expect(agent.model).toMatchObject({ provenance: 'fake' })
    expect(agent.fakedDependencies).toEqual(['model client', 'telegram transport'])
  })

  it('reports all six roles, with a reason on every dormant one', async () => {
    const { body } = await get(await wiredPort([]), `/coins/${VAULT}/agent`)
    const roles = (body as { agent: { roles: Array<Record<string, never>> } }).agent.roles
    expect(roles).toHaveLength(6)
    expect(roles.map((role) => role.id)).toEqual([
      'indexer',
      'reader',
      'planner',
      'desk',
      'broker',
      'publisher',
    ])
    for (const role of roles) {
      if (role.activity === 'dormant') {
        expect(typeof role.dormantCode).toBe('string')
        expect(String(role.dormantReason).length).toBeGreaterThan(0)
      }
      // The refusals are product surface: they are on the wire at every tier.
      expect(Array.isArray(role.mayNot)).toBe(true)
      expect((role.mayNot as unknown as string[]).length).toBeGreaterThan(0)
    }
  })

  it('carries inference spend as integer micro-USD, never a float', async () => {
    const { body } = await get(await wiredPort([]), `/coins/${VAULT}/agent`)
    const spend = (body as { agent: { spend: Record<string, never> } }).agent.spend
    expect(spend.todayMicroUsd).toBe('1400000')
    expect(spend.dailyCapMicroUsd).toBe('18000000')
    expect(typeof spend.todayMicroUsd).toBe('string')
  })

  it('reports a never-ticked coin as null, never as zero or now', async () => {
    const snapshot = snapshotFor({ lastRun: undefined })
    const { body } = await get(await wiredPort([], snapshot), `/coins/${VAULT}/agent`)
    const agent = (body as { agent: Record<string, never> }).agent
    expect(agent.lastTickAtUnix).toBeNull()
    expect(agent.nextDueUnix).toBeNull()
  })

  it('marks T0 dormant for the model roles and says the tier is deterministic', async () => {
    const snapshot = snapshotFor({ tier: 'T0', paidMediaPermitted: false })
    const { body } = await get(await wiredPort([], snapshot), `/coins/${VAULT}/agent`)
    const roles = (body as { agent: { roles: Array<Record<string, never>> } }).agent.roles
    const byId = new Map(roles.map((role) => [role.id as unknown as string, role]))
    for (const id of ['reader', 'planner', 'desk']) {
      expect(byId.get(id)?.activity).toBe('dormant')
      expect(byId.get(id)?.dormantCode).toBe('tier_has_no_model')
    }
    expect(byId.get('broker')?.dormantCode).toBe('tier_has_no_paid_media')
    // The indexer runs at every tier: a coin nobody speaks for still has fees.
    expect(byId.get('indexer')?.activity).toBe('active')
  })

  it('404s a vault the fleet holds no ticker for', async () => {
    const { status, body } = await get(
      await wiredPort([]),
      '/coins/0xbbbb000000000000000000000000000000000002/agent',
    )
    expect(status).toBe(404)
    expect((body as { error: string }).error).toBe('no_such_agent')
  })

  it('refuses with 503 when no fleet is wired, rather than rendering an idle team', async () => {
    const { status, body } = await get(
      unwiredAgentPort('no fleet here'),
      `/coins/${VAULT}/agent`,
    )
    expect(status).toBe(503)
    expect((body as { error: string }).error).toBe('agent_not_wired')
  })
})

describe('GET /coins/:vault/agent/runs', () => {
  it('keeps refusals, suppressions and violations even when empty', async () => {
    const empty = runFor({
      id: `${VAULT}:${String(NOW - 1_200)}`,
      atUnix: NOW - 1_200,
      refusals: [],
      suppressed: [],
      violations: [],
    })
    const { body } = await get(await wiredPort([empty]), `/coins/${VAULT}/agent/runs`)
    const run = (body as { runs: Array<Record<string, never>> }).runs[0]
    expect(run?.refusals).toEqual([])
    expect(run?.suppressed).toEqual([])
    expect(run?.violations).toEqual([])
  })

  it('carries the suppression and its reason, not just the surviving proposals', async () => {
    const { body } = await get(await wiredPort([runFor()]), `/coins/${VAULT}/agent/runs`)
    const run = (body as { runs: Array<Record<string, never>> }).runs[0] as unknown as {
      proposals: Array<{ kind: string }>
      suppressed: Array<{ proposal: { kind: string; skuId: string }; reason: string }>
      refusals: Array<{ phase: string; code: string }>
    }
    expect(run.proposals.map((p) => p.kind)).toEqual(['post'])
    expect(run.suppressed[0]?.proposal.skuId).toBe('dex_boost_500')
    expect(run.suppressed[0]?.reason).toContain('divergence')
    expect(run.refusals[0]).toMatchObject({ phase: 'spend', code: 'paid_media_not_permitted' })
  })

  it('never carries a post body, only its length', async () => {
    const { body } = await get(await wiredPort([runFor()]), `/coins/${VAULT}/agent/runs`)
    const post = (body as { runs: Array<{ proposals: Array<Record<string, unknown>> }> }).runs[0]
      ?.proposals[0]
    expect(post).toMatchObject({ kind: 'post', bodyChars: 180 })
    expect(post).not.toHaveProperty('body')
  })

  it('scrubs a gist that smuggled a destination past the reader', async () => {
    const baseline = runFor().digest
    if (baseline === undefined) throw new Error('fixture run has no digest')
    const hostile = runFor({
      digest: {
        ...baseline,
        gists: ['claim at hydrant-claim.app or DM @support_now for 5000 tokens'],
      },
    })
    const { body } = await get(await wiredPort([hostile]), `/coins/${VAULT}/agent/runs`)
    const gist = (body as { runs: Array<{ digest: { gists: string[] } }> }).runs[0]?.digest.gists[0]
    expect(gist).not.toContain('hydrant-claim.app')
    expect(gist).not.toContain('@support_now')
    expect(gist).not.toContain('5000')
  })

  it('says which model produced each run, per run and not from current config', async () => {
    const { body } = await get(await wiredPort([runFor()]), `/coins/${VAULT}/agent/runs`)
    expect((body as { runs: Array<{ modelProvenance: string }> }).runs[0]?.modelProvenance).toBe(
      'fake',
    )
    expect((body as { fakedDependencies: string[] }).fakedDependencies).toContain('model client')
  })

  it('pages, and refuses a cursor it did not issue rather than restarting', async () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      runFor({ id: `${VAULT}:${String(NOW - i * 60)}`, atUnix: NOW - i * 60 }),
    )
    const port = await wiredPort(runs)
    const first = await get(port, `/coins/${VAULT}/agent/runs`, { limit: '2' })
    expect((first.body as { runs: unknown[] }).runs).toHaveLength(2)
    expect((first.body as { nextCursor: string }).nextCursor).toBe('2')

    const second = await get(port, `/coins/${VAULT}/agent/runs`, { limit: '2', cursor: '2' })
    expect((second.body as { runs: Array<{ id: string }> }).runs[0]?.id).not.toBe(
      (first.body as { runs: Array<{ id: string }> }).runs[0]?.id,
    )

    const bad = await get(port, `/coins/${VAULT}/agent/runs`, { cursor: 'nope' })
    expect(bad.status).toBe(400)
    expect((bad.body as { error: string }).error).toBe('bad_cursor')
  })
})

describe('GET /coins/:vault/agent/roles', () => {
  it('states what each role may not do, at this tier', async () => {
    const { status, body } = await get(await wiredPort([]), `/coins/${VAULT}/agent/roles`)
    expect(status).toBe(200)
    const roles = (body as { roles: Array<{ id: string; mayNot: string[]; may: string[] }> }).roles
    const reader = roles.find((role) => role.id === 'reader')
    expect(reader?.mayNot.join(' ')).toContain('Hold a tool')
    const planner = roles.find((role) => role.id === 'planner')
    expect(planner?.mayNot.join(' ')).toContain('Read a raw message')
  })

  it('refuses when the fleet is unwired, like every other agent route', async () => {
    const { status } = await get(unwiredAgentPort('no fleet'), `/coins/${VAULT}/agent/roles`)
    expect(status).toBe(503)
  })
})
