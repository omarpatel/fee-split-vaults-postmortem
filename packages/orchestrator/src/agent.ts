/**
 * THE TEAM, NAMED.
 *
 * The product claim is that every member coin has its own agent team working
 * for it. That team already exists - it is the six stages of CoinTicker.tick()
 * - but until now it had no name anyone outside this repository could read, so
 * there was no way to SHOW a dev what is working for their coin or, more
 * importantly, what is deliberately not.
 *
 * This file is that naming, and nothing more. It introduces no new behaviour:
 * every activation rule below is the SAME condition the tick already evaluates,
 * quoted from the phase that owns it, so a role that reads "active" here is a
 * role that would actually run on the next tick. If a rule in coin.ts changes
 * and this file does not, the roles spec fails.
 *
 * THE REFUSALS ARE THE PRODUCT. `mayNot` is not a disclaimer. A dev choosing a
 * disclosed operator is buying the fact that the thing reading their holders'
 * messages holds no tools, that the thing that can spend cannot read, and that
 * a dormant role says why it is dormant instead of disappearing. So `mayNot` is
 * a first-class field with the same weight as `may`, and a dormant role is
 * rendered rather than hidden.
 */

import type { ScreeningVerdict, VaultState } from '@fee-split-vaults/core'
import type { DegradeLevel } from '@fee-split-vaults/runtime'
import { TIERS } from '../../../config/protocol.js'
import type { TierId } from '../../../config/protocol.js'
import type { TickPhase } from './errors.js'

export const AGENT_ROLE_IDS = [
  'indexer',
  'reader',
  'planner',
  'desk',
  'broker',
  'publisher',
] as const

export type AgentRoleId = (typeof AGENT_ROLE_IDS)[number]

export interface AgentRole {
  id: AgentRoleId
  /** What a dev would call this member of the team. */
  title: string
  /** One line. What it is for. */
  mission: string
  /** The tick phases this role owns. Ties the name to the code that runs. */
  phases: readonly TickPhase[]
  /** True when this role consumes attacker-authored text. */
  readsUntrustedInput: boolean
  may: readonly string[]
  /** The structural refusals. Never a preference, never prompt-enforced. */
  mayNot: readonly string[]
}

/**
 * The six. Ordered as the tick runs them, because the order is the argument:
 * the two roles that read untrusted input (reader, desk) sit between a role
 * that cannot read one (indexer) and the roles that can spend or speak
 * (broker, publisher), and nothing carries a raw string across that boundary.
 */
export const AGENT_ROLES: Readonly<Record<AgentRoleId, AgentRole>> = Object.freeze({
  indexer: Object.freeze({
    id: 'indexer',
    title: 'Indexer',
    mission: "Reads the chain and attributes this coin's credited creator fees to its own vault.",
    phases: ['ingest', 'accrual', 'measure'] as const,
    readsUntrustedInput: false,
    may: Object.freeze([
      'Scan forward from a cursor for credits to this vault, and never re-scan history.',
      "Record accruals and chain movements in this coin's ledger.",
      'Measure QF as a trailing 7-day median of daily credits, in USD, at a pinned price.',
    ]),
    mayNot: Object.freeze([
      'Read a holder message. It never touches the message plane at all.',
      'Report a measurement of zero when the posting store could not be read. No read means no measurement.',
      'Hold a key, move money, or publish anything.',
    ]),
  }),
  reader: Object.freeze({
    id: 'reader',
    title: 'Reader',
    mission:
      "Reads what holders actually said in a closed 30-minute window and turns it into counts.",
    phases: ['cognition'] as const,
    readsUntrustedInput: true,
    may: Object.freeze([
      'Read every admitted message in the window, at full fidelity.',
      'Emit counts against a closed topic vocabulary, closed-enum signals, and short scrubbed gists.',
    ]),
    mayNot: Object.freeze([
      'Hold a tool. READER_TOOLS is asserted empty at construction; a non-empty list refuses to start the process.',
      'Emit an address, a URL, a handle, or a digit that could encode an amount. Every gist is scrubbed by trusted code.',
      'Restate which coin it read, rewrite the message counts, or backdate a window. Trusted code supplies those fields.',
      'Be woken by a message. The schedule is fixed; there is no wake-on-mention path.',
    ]),
  }),
  planner: Object.freeze({
    id: 'planner',
    title: 'Planner',
    mission: 'Decides what to propose, having seen counts and scrubbed gists and nothing else.',
    phases: ['cognition'] as const,
    readsUntrustedInput: false,
    may: Object.freeze([
      'Read one validated Digest: counters, closed-enum signals, and at most eight scrubbed gists.',
      'Call the closed set of proposal tools: post, purchase, escalate, or do nothing.',
    ]),
    mayNot: Object.freeze([
      'Read a raw message. It never sees one, at any tier, under any load.',
      'Name a destination. A link is an allowlisted id; the URL is resolved after the model is out of the loop.',
      'Set a price or an amount. It sees SKU ids and cost bands, never a price.',
      'Execute its own proposal. A tool_use block is a record; there is no loop to hijack.',
    ]),
  }),
  desk: Object.freeze({
    id: 'desk',
    title: 'Desk',
    mission: 'Answers holder questions about operational facts, and refuses six classes of question.',
    phases: ['desk'] as const,
    readsUntrustedInput: true,
    may: Object.freeze([
      'Answer a question about how the vault works, what was bought, and where the receipts are.',
      'Write a placeholder such as {{CONTRACT_ADDRESS}}, which trusted code substitutes from its own records.',
    ]),
    mayNot: Object.freeze([
      'Predict a price, advise a buy or a sell, imply a future value, compare investment merit, or comment on a holder’s finances.',
      'Have that refusal talked around. It is a fail-closed output classifier, not a prompt instruction: the answer is discarded and replaced.',
      'Write an address or a URL itself. An answer containing one the facts did not supply is discarded.',
    ]),
  }),
  broker: Object.freeze({
    id: 'broker',
    title: 'Broker',
    mission: 'Buys third-party media at cost, against machine-checkable delivery predicates.',
    phases: ['spend'] as const,
    readsUntrustedInput: false,
    may: Object.freeze([
      'Buy a catalog SKU from an allowlisted vendor at pass-through cost, with zero markup.',
      'Withhold payment when a delivery predicate fails at re-check.',
    ]),
    mayNot: Object.freeze([
      "Commit beyond this coin's own banked, escrowed budget. No credit line, no forward financing.",
      "Spend another coin's budget. Cross-coin subsidy is unrepresentable, not merely forbidden.",
      'Disburse above the human-approval threshold without a human.',
      'Read a holder message, or take a payee from one.',
    ]),
  }),
  publisher: Object.freeze({
    id: 'publisher',
    title: 'Publisher',
    mission: "Emits posts on this coin's own accounts, with the disclosure injected by trusted code.",
    phases: ['publish'] as const,
    readsUntrustedInput: false,
    may: Object.freeze([
      'Post to an account bound to this coin, one ticker per account.',
      'Re-fetch a published post and delete it when the disclosure is not present.',
    ]),
    mayNot: Object.freeze([
      'Author its own disclosure. The tags are injected by trusted code and never written by a model.',
      'Promote another member coin, or promote this coin to another member’s holders.',
      'Operate a covert or undisclosed account. There are none, and adding one is a legal boundary, not a setting.',
      'Construct a link. Destinations resolve from allowlisted ids after the model is out of the loop.',
    ]),
  }),
})

/**
 * Everything the activation rules read.
 *
 * Deliberately the same facts coin.ts computes in its guard phase, under the
 * same names, so the two can be compared by eye.
 */
export interface RoleActivationInput {
  tier: TierId
  vaultState: VaultState
  /** An indexer halt on this token. Any halt stops spend authority. */
  halted: boolean
  /** undefined means no screening on file, which is not the same as a pass. */
  screeningVerdict: ScreeningVerdict | undefined
  /** The tier decision's own answer, already ANDed with the screening verdict. */
  paidMediaPermitted: boolean
  /** Channels this coin actually has an account on. */
  operatedAccountCount: number
  degradeLevel: DegradeLevel
  /** The divergence detector's standing freeze, if any. */
  freeze: 'none' | 'purchases' | 'all'
}

export type RoleActivity = 'active' | 'dormant'

export interface AgentRoleStatus {
  role: AgentRole
  activity: RoleActivity
  /**
   * Machine code for why a dormant role is dormant. Stable, alertable, and the
   * same vocabulary the tick's own refusals use.
   */
  dormantCode?: string
  /** One sentence a non-engineer can act on. Never "unavailable". */
  dormantReason?: string
}

interface Dormancy {
  code: string
  reason: string
}

/**
 * Is this coin permitted to operate at all?
 *
 * Quoted from coin.ts: operations permission is a SCREENING fact, not a tier
 * fact, so a tick that could not measure QF must not silence the desk.
 */
function operationsPermitted(input: RoleActivationInput): boolean {
  return input.screeningVerdict !== 'BLOCKED'
}

function spendAuthorityActive(input: RoleActivationInput): boolean {
  return input.vaultState === 'ACTIVE' && !input.halted && operationsPermitted(input)
}

/** The first reason that applies, in the order the tick would hit it. */
function dormancyFor(id: AgentRoleId, input: RoleActivationInput): Dormancy | undefined {
  const usesModel = TIERS[input.tier].usesModel

  if (input.vaultState === 'TERMINATED') {
    return {
      code: 'engagement_ended',
      reason:
        'The dev ended the engagement. Nothing runs for this coin, and 100% of fees pass through to them.',
    }
  }

  switch (id) {
    case 'indexer':
      // The indexer runs at every tier and under every screening verdict: a
      // coin we may not speak for is still a coin whose fees must be accounted
      // for correctly, and a BLOCKED coin is never charged either way.
      return undefined

    case 'reader':
    case 'planner':
    case 'desk': {
      if (!usesModel) {
        return {
          code: 'tier_has_no_model',
          reason: `${input.tier} (${TIERS[input.tier].name}) is deterministic by design. No model is in the loop at this tier, at any volume.`,
        }
      }
      if (!operationsPermitted(input)) {
        return {
          code: 'operations_not_permitted',
          reason: 'Screening returned BLOCKED. Every operation stops, and this coin is not charged.',
        }
      }
      if (input.degradeLevel === 'suspend') {
        return {
          code: 'budget_suspended',
          reason:
            "This coin's daily model budget is spent. The team degrades to deterministic operation rather than running at a loss; it resumes at the next UTC day.",
        }
      }
      if (id === 'planner' && input.freeze === 'all') {
        return {
          code: 'divergence_freeze_all',
          reason:
            'The divergence detector froze proposals: the topic mix moved further than an organic window moves. The planner is not called at all while a freeze stands.',
        }
      }
      return undefined
    }

    case 'broker': {
      if (!TIERS[input.tier].paidMedia) {
        return {
          code: 'tier_has_no_paid_media',
          reason: `${input.tier} (${TIERS[input.tier].name}) buys no third-party media. Its budget slice would not fund the cheapest deliverable, so the tier does not offer one.`,
        }
      }
      if (!spendAuthorityActive(input)) {
        return {
          code: input.halted ? 'indexer_halt' : 'spend_authority_inactive',
          reason: input.halted
            ? 'The indexer halted on this token. A halt stops all spend until a human clears it.'
            : `The vault is ${input.vaultState}, not ACTIVE. Spend authority exists only while charging does.`,
        }
      }
      if (!input.paidMediaPermitted) {
        return {
          code: 'paid_media_not_permitted',
          reason:
            input.screeningVerdict === undefined
              ? 'No screening result is on file. Absence of a screening is not a pass, so no paid media may be bought.'
              : `Screening returned ${input.screeningVerdict}. Organic operations continue; no paid media until a human adjudicates.`,
        }
      }
      if (input.freeze === 'purchases' || input.freeze === 'all') {
        return {
          code: 'divergence_freeze_purchases',
          reason:
            'The divergence detector froze purchases for this window. Proposals to spend are recorded and suppressed rather than executed.',
        }
      }
      return undefined
    }

    case 'publisher': {
      if (!operationsPermitted(input)) {
        return {
          code: 'operations_not_permitted',
          reason: 'Screening returned BLOCKED. Nothing is published for this coin.',
        }
      }
      if (input.operatedAccountCount === 0) {
        return {
          code: 'no_operated_accounts',
          reason:
            'No account is bound to this coin. A channel we hold no account on is a channel we cannot speak on; posts for it are refused, not redirected.',
        }
      }
      return undefined
    }
  }
}

/** The six roles with their activity at this coin, right now. */
export function evaluateAgentRoles(input: RoleActivationInput): AgentRoleStatus[] {
  return AGENT_ROLE_IDS.map((id) => {
    const dormancy = dormancyFor(id, input)
    if (dormancy === undefined) return { role: AGENT_ROLES[id], activity: 'active' as const }
    return {
      role: AGENT_ROLES[id],
      activity: 'dormant' as const,
      dormantCode: dormancy.code,
      dormantReason: dormancy.reason,
    }
  })
}

// ---------------------------------------------------------------------------
// Model provenance
// ---------------------------------------------------------------------------

/**
 * WHOSE OUTPUT IS THIS?
 *
 * There is exactly one thing worse than a desk that cannot answer: a desk whose
 * scripted stand-in answer is presented as a model's. So the client in use is
 * carried as data all the way to the page, and 'fake' is never rendered as an
 * absence - it is rendered as a banner.
 *
 * 'unknown' is a real state and not a synonym for 'fake'. A credential can only
 * be confirmed by constructing the client and letting it resolve or throw; a
 * process that has not yet made a call cannot honestly claim either.
 */
export type ModelProvenance = 'live' | 'fake' | 'unknown'

export interface AgentModelView {
  /** The model the reader uses at this tier. Always the cheap one, by design. */
  readerModel: string
  /** The model the planner would use for the NEXT call, after any degrade. */
  plannerModel: string
  provenance: ModelProvenance
  /** Why the provenance is what it is. Shown verbatim; never omitted. */
  detail: string
  /** True while a degrade has the planner routed through the Batch API. */
  viaBatch: boolean
}

// ---------------------------------------------------------------------------
// Spend against the cap
// ---------------------------------------------------------------------------

/**
 * Inference spend is carried in MICRO-USD, not cents.
 *
 * A single Haiku reader call can cost well under one cent, and a per-coin
 * inference budget of $7.80/day is made of hundreds of them. Rounded to cents
 * at the boundary, most of a day's calls would each read as $0.00 and the
 * running total would drift below the truth - which on this product is the
 * failure mode the whole ledger exists to prevent. Integer micro-USD is exact
 * at the granularity the meter actually has.
 */
export type MicroUsd = bigint

export const MICRO_USD_PER_USD = 1_000_000n

/**
 * The one float-to-integer conversion in the inference-cost path.
 *
 * CostGovernor accumulates a JS number because token pricing is a rate, not an
 * amount. It is converted here, once, and everything downstream is integer.
 */
export function microUsdFromFloat(usd: number): MicroUsd {
  if (!Number.isFinite(usd)) {
    throw new TypeError(`inference cost is not finite: ${String(usd)}`)
  }
  return BigInt(Math.round(usd * 1_000_000))
}

export interface AgentSpendView {
  /** Metered model spend for this coin today, UTC day. */
  todayMicroUsd: MicroUsd
  /** The governor's own daily ceiling for this coin. Never exceeded. */
  dailyCapMicroUsd: MicroUsd
  /** The tier's modelled all-in cost to serve, for context. Not a cap. */
  tierCogsPerDayMicroUsd: MicroUsd
  /** Model calls metered today. */
  callsToday: number
  degradeLevel: DegradeLevel
  /** The UTC day the two figures above belong to. */
  dayKey: string
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

export interface AgentSnapshot {
  coinRef: string
  vault: string
  tier: TierId
  vaultState: VaultState
  halted: boolean
  screeningVerdict: ScreeningVerdict | undefined
  paidMediaPermitted: boolean
  /** null when this coin has never ticked in this process. Never 0. */
  lastTickAtUnix: number | null
  /** null when nothing has scheduled a next tick yet. Never "now". */
  nextDueUnix: number | null
  freeze: 'none' | 'purchases' | 'all'
  model: AgentModelView
  spend: AgentSpendView
  roles: AgentRoleStatus[]
  /**
   * Dependencies running on a fake or unwired implementation, by name. EMPTY
   * MEANS EVERYTHING IS REAL, so nothing may be omitted from it to tidy a page.
   */
  fakedDependencies: string[]
  atUnix: number
}

/**
 * The slice of CostGovernor this snapshot reads.
 *
 * Structural rather than the class itself so a caller holding a persisted
 * day-spend row can answer without instantiating a governor - and so this
 * module cannot accidentally start spending through one.
 */
export interface DailySpendMeter {
  readonly budgetUsd: number
  spentUsd(nowUnix: number): number
  spend(nowUnix: number): { dayKey: string; usd: number; calls: number }
  level(nowUnix: number): DegradeLevel
}

export interface AgentSnapshotInput {
  coinRef: string
  vault: string
  tier: TierId
  vaultState: VaultState
  halted: boolean
  screeningVerdict: ScreeningVerdict | undefined
  paidMediaPermitted: boolean
  operatedAccountCount: number
  meter: DailySpendMeter
  model: AgentModelView
  /**
   * The most recent run, if this coin has ever ticked in this deployment.
   *
   * The standing divergence freeze is read from HERE rather than from the
   * detector, because the detector deliberately exposes no freeze getter: a
   * freeze is a property of a window that was evaluated, and reporting one that
   * no tick ever produced would be inventing a state.
   */
  lastRun?: { atUnix: number; nextDueUnix: number; freeze?: { level: 'purchases' | 'all' } }
  fakedDependencies: readonly string[]
  nowUnix: number
}

export function buildAgentSnapshot(input: AgentSnapshotInput): AgentSnapshot {
  const freeze = input.lastRun?.freeze?.level ?? 'none'
  const day = input.meter.spend(input.nowUnix)
  const activation: RoleActivationInput = {
    tier: input.tier,
    vaultState: input.vaultState,
    halted: input.halted,
    screeningVerdict: input.screeningVerdict,
    paidMediaPermitted: input.paidMediaPermitted,
    operatedAccountCount: input.operatedAccountCount,
    degradeLevel: input.meter.level(input.nowUnix),
    freeze,
  }

  return {
    coinRef: input.coinRef,
    vault: input.vault,
    tier: input.tier,
    vaultState: input.vaultState,
    halted: input.halted,
    screeningVerdict: input.screeningVerdict,
    paidMediaPermitted: input.paidMediaPermitted,
    // null, never 0 and never "now". A coin that has not ticked has not ticked,
    // and rendering the epoch or the current instant would both be a lie.
    lastTickAtUnix: input.lastRun?.atUnix ?? null,
    nextDueUnix: input.lastRun?.nextDueUnix ?? null,
    freeze,
    model: input.model,
    spend: {
      todayMicroUsd: microUsdFromFloat(input.meter.spentUsd(input.nowUnix)),
      dailyCapMicroUsd: microUsdFromFloat(input.meter.budgetUsd),
      tierCogsPerDayMicroUsd: microUsdFromFloat(TIERS[input.tier].cogsPerDay),
      callsToday: day.calls,
      degradeLevel: activation.degradeLevel,
      dayKey: day.dayKey,
    },
    roles: evaluateAgentRoles(activation),
    fakedDependencies: [...input.fakedDependencies],
    atUnix: input.nowUnix,
  }
}
