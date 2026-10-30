/**
 * The agent team, for the fixture backend.
 *
 * Same rule as the rest of this directory: DERIVED, not drawn. The model cap
 * comes from the tier's own cogsPerDay, the day's spend is the sum of the runs
 * that fall inside the day, the call count is counted from the runs, and which
 * roles are awake is computed from the coin's tier, state and screening rather
 * than asserted. If the demo shows a team the real pipeline could not produce,
 * that is a bug in this file.
 *
 * ONE THING IS ASSERTED AND IT IS THE IMPORTANT ONE: `provenance` is always
 * 'fake' here, because it always is. Everything this file produces came from a
 * script, and the page carries an unmissable banner saying so. A fixture that
 * dressed itself up as a live desk would be teaching exactly the wrong thing
 * about the one claim this product cannot afford to get wrong.
 */

import { TIERS, type TierId } from '../../protocol.js'
import type * as M from '../model.js'

const MINUTE = 60
const HOUR = 60 * MINUTE

/**
 * The cognition window, in minutes. Mirrors CORPUS_LIMITS.windowMinutes in
 * packages/core: a fixed schedule with no wake-on-mention path, so the runs
 * below land on a regular cadence rather than on message arrival.
 */
const WINDOW_MINUTES = 30

/**
 * Share of a tier's daily COGS available to inference.
 *
 * Mirrors CostGovernor's default `modelShareOfCogs`. It lives in
 * packages/runtime, which this app deliberately cannot import - config/protocol
 * is its only crossing - so the real figure arrives on the wire and this is the
 * fixture's own copy of the same assumption.
 */
const MODEL_SHARE_OF_COGS = 0.6

/**
 * The published model ids. Owned by packages/runtime/src/model/ids.ts; the
 * server sends them on the wire and this mirrors them for the offline demo.
 */
const MODEL = {
  haiku45: 'claude-haiku-4-5',
  sonnet5: 'claude-sonnet-5',
} as const

/** Reader is always the cheap model; the planner moves with the tier. */
function plannerModelFor(tier: TierId): string {
  return tier === 'T1' ? MODEL.haiku45 : MODEL.sonnet5
}

/** Deterministic small integer from a label, so the demo is stable per coin. */
function jitter(label: string, span: number): number {
  let hash = 2_166_136_261
  for (let i = 0; i < label.length; i += 1) {
    hash ^= label.charCodeAt(i)
    hash = Math.imul(hash, 16_777_619) >>> 0
  }
  return hash % span
}

/** The UTC day a timestamp belongs to. The governor's own day boundary. */
function dayKey(unix: number): string {
  return new Date(unix * 1_000).toISOString().slice(0, 10)
}

export interface AgentFixtureInput {
  key: string
  coinRef: string
  vault: string
  tier: TierId
  state: M.VaultState
  screening: { verdict: M.ScreeningVerdict; paidMediaPermitted: boolean; flags: string[] }
  accountCount: number
  /** Whether this coin has a SKU the broker would have proposed. */
  skuId: string | null
  /** Position in the seed list. Only ever used to alternate the flood window. */
  specIndex: number
  nowUnix: number
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

interface RoleSpec {
  id: M.AgentRoleId
  title: string
  mission: string
  phases: string[]
  readsUntrustedInput: boolean
  may: string[]
  mayNot: string[]
}

/**
 * The role table, mirroring packages/orchestrator/src/agent.ts.
 *
 * It is duplicated rather than imported for the reason the header of
 * src/protocol.ts gives: this app crosses out of its own tree exactly once, to
 * config/protocol.ts, and widening that to the orchestrator would pull the
 * whole server graph into a browser bundle. The server is the source of truth;
 * this is the offline copy, and api/__tests__/agent.spec.ts asserts the shape
 * the real one has to satisfy.
 */
const ROLES: readonly RoleSpec[] = [
  {
    id: 'indexer',
    title: 'Indexer',
    mission: "Reads the chain and attributes this coin's credited creator fees to its own vault.",
    phases: ['ingest', 'accrual', 'measure'],
    readsUntrustedInput: false,
    may: [
      'Scan forward from a cursor for credits to this vault, and never re-scan history.',
      "Record accruals and chain movements in this coin's ledger.",
      'Measure QF as a trailing 7-day median of daily credits, in USD, at a pinned price.',
    ],
    mayNot: [
      'Read a holder message. It never touches the message plane at all.',
      'Report a measurement of zero when the posting store could not be read. No read means no measurement.',
      'Hold a key, move money, or publish anything.',
    ],
  },
  {
    id: 'reader',
    title: 'Reader',
    mission: 'Reads what holders actually said in a closed 30-minute window and turns it into counts.',
    phases: ['cognition'],
    readsUntrustedInput: true,
    may: [
      'Read every admitted message in the window, at full fidelity.',
      'Emit counts against a closed topic vocabulary, closed-enum signals, and short scrubbed gists.',
    ],
    mayNot: [
      'Hold a tool. The tool list is asserted empty at construction; a non-empty one refuses to start the process.',
      'Emit an address, a URL, a handle, or a digit that could encode an amount. Every gist is scrubbed by trusted code.',
      'Restate which coin it read, rewrite the message counts, or backdate a window. Trusted code supplies those fields.',
      'Be woken by a message. The schedule is fixed; there is no wake-on-mention path.',
    ],
  },
  {
    id: 'planner',
    title: 'Planner',
    mission: 'Decides what to propose, having seen counts and scrubbed gists and nothing else.',
    phases: ['cognition'],
    readsUntrustedInput: false,
    may: [
      'Read one validated Digest: counters, closed-enum signals, and at most eight scrubbed gists.',
      'Call the closed set of proposal tools: post, purchase, escalate, or do nothing.',
    ],
    mayNot: [
      'Read a raw message. It never sees one, at any tier, under any load.',
      'Name a destination. A link is an allowlisted id; the URL is resolved after the model is out of the loop.',
      'Set a price or an amount. It sees SKU ids and cost bands, never a price.',
      'Execute its own proposal. A tool_use block is a record; there is no loop to hijack.',
    ],
  },
  {
    id: 'desk',
    title: 'Desk',
    mission: 'Answers holder questions about operational facts, and refuses six classes of question.',
    phases: ['cognition'],
    readsUntrustedInput: true,
    may: [
      'Answer a question about how the vault works, what was bought, and where the receipts are.',
      'Write a placeholder such as {{CONTRACT_ADDRESS}}, which trusted code substitutes from its own records.',
    ],
    mayNot: [
      'Predict a price, advise a buy or a sell, imply a future value, compare investment merit, or comment on a holder’s finances.',
      'Have that refusal talked around. It is a fail-closed output classifier, not a prompt instruction: the answer is discarded and replaced.',
      'Write an address or a URL itself. An answer containing one the facts did not supply is discarded.',
    ],
  },
  {
    id: 'broker',
    title: 'Broker',
    mission: 'Buys third-party media at cost, against machine-checkable delivery predicates.',
    phases: ['spend'],
    readsUntrustedInput: false,
    may: [
      'Buy a catalog SKU from an allowlisted vendor at pass-through cost, with zero markup.',
      'Withhold payment when a delivery predicate fails at re-check.',
    ],
    mayNot: [
      "Commit beyond this coin's own banked, escrowed budget. No credit line, no forward financing.",
      "Spend another coin's budget. Cross-coin subsidy is unrepresentable, not merely forbidden.",
      'Disburse above the human-approval threshold without a human.',
      'Read a holder message, or take a payee from one.',
    ],
  },
  {
    id: 'publisher',
    title: 'Publisher',
    mission: "Emits posts on this coin's own accounts, with the disclosure injected by trusted code.",
    phases: ['publish'],
    readsUntrustedInput: false,
    may: [
      'Post to an account bound to this coin, one ticker per account.',
      'Re-fetch a published post and delete it when the disclosure is not present.',
    ],
    mayNot: [
      'Author its own disclosure. The tags are injected by trusted code and never written by a model.',
      'Promote another member coin, or promote this coin to another member’s holders.',
      'Operate a covert or undisclosed account. There are none, and adding one is a legal boundary, not a setting.',
      'Construct a link. Destinations resolve from allowlisted ids after the model is out of the loop.',
    ],
  },
]

function dormancyFor(
  id: M.AgentRoleId,
  input: AgentFixtureInput,
  freeze: M.FreezeLevel,
): { code: string; reason: string } | undefined {
  const tier = TIERS[input.tier]
  const operationsPermitted = input.screening.verdict !== 'BLOCKED'
  const spendAuthority = input.state === 'ACTIVE' && operationsPermitted

  if (input.state === 'TERMINATED') {
    return {
      code: 'engagement_ended',
      reason:
        'The dev ended the engagement. Nothing runs for this coin, and 100% of fees pass through to them.',
    }
  }

  if (id === 'indexer') return undefined

  if (id === 'reader' || id === 'planner' || id === 'desk') {
    if (!tier.usesModel) {
      return {
        code: 'tier_has_no_model',
        reason: `${input.tier} (${tier.name}) is deterministic by design. No model is in the loop at this tier, at any volume.`,
      }
    }
    if (!operationsPermitted) {
      return {
        code: 'operations_not_permitted',
        reason: 'Screening returned BLOCKED. Every operation stops, and this coin is not charged.',
      }
    }
    if (id === 'planner' && freeze === 'all') {
      return {
        code: 'divergence_freeze_all',
        reason:
          'The divergence detector froze proposals: the topic mix moved further than an organic window moves. The planner is not called at all while a freeze stands.',
      }
    }
    return undefined
  }

  if (id === 'broker') {
    if (!tier.paidMedia) {
      return {
        code: 'tier_has_no_paid_media',
        reason: `${input.tier} (${tier.name}) buys no third-party media. Its budget slice would not fund the cheapest deliverable, so the tier does not offer one.`,
      }
    }
    if (!spendAuthority) {
      return {
        code: 'spend_authority_inactive',
        reason: `The vault is ${input.state}, not ACTIVE. Spend authority exists only while charging does.`,
      }
    }
    if (!input.screening.paidMediaPermitted) {
      return {
        code: 'paid_media_not_permitted',
        reason: `Screening returned ${input.screening.verdict}. Organic operations continue; no paid media until a human adjudicates.`,
      }
    }
    if (freeze !== 'none') {
      return {
        code: 'divergence_freeze_purchases',
        reason:
          'The divergence detector froze purchases for this window. Proposals to spend are recorded and suppressed rather than executed.',
      }
    }
    return undefined
  }

  if (!operationsPermitted) {
    return {
      code: 'operations_not_permitted',
      reason: 'Screening returned BLOCKED. Nothing is published for this coin.',
    }
  }
  if (input.accountCount === 0) {
    return {
      code: 'no_operated_accounts',
      reason:
        'No account is bound to this coin. A channel we hold no account on is a channel we cannot speak on; posts for it are refused, not redirected.',
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

const TOPICS = [
  'price_question',
  'how_to_buy',
  'sentiment_positive',
  'technical_support',
  'scam_report',
  'unanswered_backlog',
] as const

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
}

/**
 * Windows in which the planner reaches for the purchase tool.
 *
 * Window 0 is in the set deliberately: it is the one "This tick" renders, and
 * a demo where a suppression could only ever appear buried in history would
 * leave the panel that shows WHAT WAS STOPPED permanently empty - which is the
 * panel the disclosed-operator claim actually rests on.
 */
const PURCHASE_WINDOWS = new Set([0, 2, 6])

/** The one window in eight where nobody said anything. No call, no cost. */
const SILENT_WINDOW = 3

/**
 * Which window gets the mention flood, and so the divergence freeze.
 *
 * Alternated across the seed list rather than hashed from the coin key, so that
 * some coins show a live freeze on their latest tick and others show one only
 * in history. Every coin having been frozen just now would be as misleading as
 * no coin ever having been - and a hash does not guarantee either, which is how
 * the first attempt at this put every coin on the same window.
 */
function floodWindowFor(specIndex: number): number {
  return specIndex % 2 === 0 ? 0 : 2
}

/**
 * Eight windows, four hours, on the fixed 30-minute cadence.
 *
 * The variety is not decoration. Each coin gets at least one window that
 * produced nothing and cost nothing, because that is what most windows do, and
 * a demo showing eight busy windows in a row would misdescribe the product as
 * much as showing none.
 */
function buildRuns(input: AgentFixtureInput): M.AgentRun[] {
  const tier = TIERS[input.tier]
  const floodWindow = floodWindowFor(input.specIndex)
  const runs: M.AgentRun[] = []

  for (let i = 0; i < 8; i += 1) {
    const atUnix = input.nowUnix - i * WINDOW_MINUTES * MINUTE
    const seed = jitter(`${input.key}:${String(i)}`, 97)
    const ranChainPoll = i % 3 === 0
    const base = {
      id: `${input.vault}:${String(atUnix)}`,
      coinRef: input.coinRef,
      vault: input.vault,
      atUnix,
      tier: input.tier,
      ranChainPoll,
      nextDueUnix: atUnix + WINDOW_MINUTES * MINUTE,
      violations: [],
      spends: [],
      publishes: [],
      modelProvenance: 'fake' as const,
    }

    // T0 makes no model call, ever. The refusal is the whole record, and it is
    // a correct outcome rather than an error.
    if (!tier.usesModel) {
      runs.push({
        ...base,
        ranCognition: false,
        skipped: 'tier_has_no_model',
        digest: null,
        proposals: [],
        suppressed: [],
        refusals: [
          {
            phase: 'cognition',
            code: 'tier_has_no_model',
            detail: `${input.tier} is deterministic by design`,
          },
        ],
        cost: { microUsd: 0n, degradeLevel: 'full', usage: { ...ZERO_USAGE } },
      })
      continue
    }

    // One window in every eight is silent. No corpus, no call, no cost.
    if (i === SILENT_WINDOW) {
      runs.push({
        ...base,
        ranCognition: false,
        skipped: 'empty_window',
        digest: null,
        proposals: [],
        suppressed: [],
        refusals: [],
        cost: { microUsd: 0n, degradeLevel: 'full', usage: { ...ZERO_USAGE } },
      })
      continue
    }

    const admitted = 12 + seed
    const dropped = i === floodWindow ? 240 + seed : seed % 7
    const authors = Math.max(3, Math.round(admitted / 2))
    const topicCounts = TOPICS.slice(0, 3 + (seed % 3)).map((code, index) => ({
      code,
      count: Math.max(1, Math.round(admitted / (index + 2))),
    }))

    const digest: M.AgentRunDigest = {
      windowId: `${input.coinRef}:${String(atUnix - WINDOW_MINUTES * MINUTE)}`,
      windowStartUnix: atUnix - WINDOW_MINUTES * MINUTE,
      windowEndUnix: atUnix,
      admittedMessageCount: admitted,
      droppedMessageCount: dropped,
      distinctAuthorCount: authors,
      topicCounts,
      // A mention spike is reported on the window whose caps actually dropped
      // messages, so the two numbers on the page tell one consistent story.
      signals: dropped > 100 ? ['mention_spike', 'desk_backlog_growing'] : ['quiet'],
      gists: [
        'holders asking where to see what was bought this week',
        'someone reporting a lookalike account in the replies',
      ].slice(0, 1 + (seed % 2)),
      rejectedGistCount: seed % 3 === 0 ? 1 : 0,
      readerRefusals: seed % 4 === 0 ? 2 : 0,
    }

    // The freeze fires on the window that saw the mention spike, and it freezes
    // purchases only: the desk keeps answering while the buying stops.
    const frozen = dropped > 100 && input.skuId !== null
    const proposals: M.AgentRunProposal[] = []
    const suppressed: M.AgentRun['suppressed'] = []
    const refusals: M.AgentRunRefusal[] = []

    proposals.push({
      kind: 'post',
      channel: 'telegram',
      intent: 'answer',
      topic: topicCounts[0]?.code ?? 'how_to_buy',
      linkRefCount: 1,
      bodyChars: 140 + (seed % 90),
    })

    if (input.skuId !== null && PURCHASE_WINDOWS.has(i)) {
      const purchase: M.AgentRunProposal = {
        kind: 'purchase',
        skuId: input.skuId,
        quantity: 1,
        rationale: 'sustained interest in the last four windows',
      }
      if (frozen) {
        suppressed.push({
          proposal: purchase,
          reason:
            'divergence: the topic mix moved 4.1 sigma against its own baseline while mentions spiked',
        })
      } else if (!input.screening.paidMediaPermitted) {
        proposals.push(purchase)
        refusals.push({
          phase: 'spend',
          code: 'paid_media_not_permitted',
          detail: 'tier or screening denies paid media',
        })
      } else {
        proposals.push(purchase)
      }
    }

    if (digest.signals.includes('desk_backlog_growing')) {
      proposals.push({
        kind: 'escalation',
        reason: 'unanswered_backlog',
        note: 'questions arriving faster than the desk answers them; a human may want to look',
      })
    }

    const published = input.accountCount > 0 && input.screening.verdict !== 'BLOCKED'
    const publishes = proposals
      .filter((proposal): proposal is Extract<M.AgentRunProposal, { kind: 'post' }> =>
        proposal.kind === 'post',
      )
      .map((proposal) => ({
        channel: proposal.channel,
        intent: proposal.intent,
        published,
        ...(published ? {} : { rejectedReason: 'account_binding:no_account_for_channel' }),
      }))

    // Reader plus planner, on a real cache hit. The cost tracks the tokens.
    const readerCost = BigInt(1_100 + seed * 7)
    const plannerCost = BigInt(input.tier === 'T1' ? 900 + seed * 5 : 14_000 + seed * 60)

    runs.push({
      ...base,
      ranCognition: true,
      ...(frozen
        ? {
            freeze: {
              level: 'purchases' as const,
              reason:
                'divergence: the topic mix moved 4.1 sigma against its own baseline while mentions spiked',
            },
          }
        : {}),
      digest,
      proposals,
      suppressed,
      refusals,
      publishes,
      cost: {
        microUsd: readerCost + plannerCost,
        degradeLevel: 'full',
        usage: {
          inputTokens: 900 + admitted * 24,
          outputTokens: 260 + (seed % 120),
          cacheCreationInputTokens: i === 7 ? 2_400 : 0,
          cacheReadInputTokens: i === 7 ? 0 : 2_400,
        },
      },
    })
  }

  return runs
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface AgentFixture {
  agent: M.CoinAgent
  runs: M.AgentRun[]
}

export function buildAgentFixture(input: AgentFixtureInput): AgentFixture {
  const runs = buildRuns(input)
  const today = dayKey(input.nowUnix)
  const todayRuns = runs.filter((run) => dayKey(run.atUnix) === today)

  // DERIVED, both of them: the day's spend is the sum of the runs inside the
  // day, and the call count is counted from the runs that made calls. A figure
  // that did not agree with the history below it would be the one bug this
  // page could not survive.
  const todayMicroUsd = todayRuns.reduce((sum, run) => sum + run.cost.microUsd, 0n)
  const callsToday = todayRuns.reduce((sum, run) => sum + (run.ranCognition ? 2 : 0), 0)

  const tier = TIERS[input.tier]
  const dailyCapMicroUsd = BigInt(Math.round(tier.cogsPerDay * MODEL_SHARE_OF_COGS * 1_000_000))
  const utilisation = dailyCapMicroUsd > 0n ? Number(todayMicroUsd) / Number(dailyCapMicroUsd) : 0
  const degradeLevel: M.DegradeLevel =
    utilisation >= 1 ? 'suspend' : utilisation >= 0.85 ? 'downgrade' : utilisation >= 0.6 ? 'batch' : 'full'

  const latest = runs[0]
  const freeze: M.FreezeLevel = latest?.freeze?.level ?? 'none'

  const roles: M.AgentRoleView[] = ROLES.map((role) => {
    const dormancy = dormancyFor(role.id, input, freeze)
    return {
      ...role,
      phases: [...role.phases],
      may: [...role.may],
      mayNot: [...role.mayNot],
      activity: dormancy === undefined ? ('active' as const) : ('dormant' as const),
      ...(dormancy === undefined
        ? {}
        : { dormantCode: dormancy.code, dormantReason: dormancy.reason }),
    }
  })

  return {
    runs,
    agent: {
      coinRef: input.coinRef,
      vault: input.vault,
      tier: input.tier,
      vaultState: input.state,
      halted: false,
      screeningVerdict: input.screening.verdict,
      paidMediaPermitted: input.screening.paidMediaPermitted,
      lastTickAtUnix: latest?.atUnix ?? null,
      nextDueUnix: latest?.nextDueUnix ?? null,
      freeze,
      model: {
        readerModel: MODEL.haiku45,
        plannerModel: tier.usesModel ? plannerModelFor(input.tier) : MODEL.haiku45,
        // Always. See the header: this backend has no model behind it and says so.
        provenance: 'fake',
        detail:
          'This browser is running the in-memory fixture backend. No credential is resolved and no request leaves the page.',
        viaBatch: degradeLevel === 'batch' || degradeLevel === 'downgrade',
      },
      spend: {
        todayMicroUsd,
        dailyCapMicroUsd,
        tierCogsPerDayMicroUsd: BigInt(Math.round(tier.cogsPerDay * 1_000_000)),
        callsToday,
        degradeLevel,
        dayKey: today,
      },
      roles,
      fakedDependencies: [
        'model client (scripted, not a model)',
        'chain read model (in-memory postings)',
        'Telegram transport (sandbox, sends nothing)',
        'X transport (sandbox, sends nothing)',
      ],
      atUnix: input.nowUnix,
    },
  }
}

export { HOUR as AGENT_FIXTURE_HOUR, WINDOW_MINUTES as AGENT_WINDOW_MINUTES }
