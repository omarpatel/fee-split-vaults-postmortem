/**
 * THE PER-TICK RECORD.
 *
 * A CoinTickResult is a live object full of things that must never leave the
 * process: a Digest carrying model-authored gists, proposal bodies, broker
 * decisions holding disbursement internals. This module projects it into a flat
 * record that is safe to keep and safe to serve, and the projection is where
 * the decisions about what may be shown get made once instead of at every
 * rendering site.
 *
 * WHAT THE PROJECTION DELIBERATELY DROPS.
 *
 *   Post bodies. A post body is model-authored copy destined for a channel; the
 *   published artifact belongs on the receipts ledger with its permalink, not
 *   in an operational run log. Only its length survives, because "the planner
 *   wrote 180 characters" is an audit fact and the characters are not.
 *
 *   Disbursement and pull internals. The run record says a purchase was
 *   proposed and what the gate decided. What moved and to whom is the ledger's
 *   job, and duplicating it here would create a second, unreconciled account of
 *   the same money.
 *
 * WHAT IT DELIBERATELY KEEPS. Every refusal, every suppression, and every
 * violation, each with its machine code. A run in which the team did nothing is
 * the most informative run there is, and a log that only recorded successes
 * would make the fail-closed design invisible - which is the same as not having
 * it, from the outside.
 *
 * FREE TEXT IN THIS RECORD IS STILL UNTRUSTED. Gists, rationales and escalation
 * notes came out of a model that read attacker-authored input. They are scrubbed
 * on the way in here, and the HTTP boundary scrubs them again on the way out.
 */

import { scrubGist } from '@fee-split-vaults/core'
import type { Address, Digest, SignalCode, TopicCode } from '@fee-split-vaults/core'
import type { DegradeLevel, ModelUsage, Proposal, ProposalViolation } from '@fee-split-vaults/runtime'
import type { TierId } from '../../../config/protocol.js'

import { microUsdFromFloat, type MicroUsd } from './agent.js'
import type { CoinTickResult, PhaseRefusal } from './coin.js'

/** The counts the reader produced, and nothing the reader wrote freely. */
export interface AgentRunDigestView {
  windowId: string
  windowStartUnix: number
  windowEndUnix: number
  /** Messages the reader actually saw, after deterministic capping. */
  admittedMessageCount: number
  /** Messages the caps dropped. A flood shows up here as a number. */
  droppedMessageCount: number
  distinctAuthorCount: number
  /** Closed vocabulary, in the vocabulary's own order. */
  topicCounts: Array<{ code: TopicCode; count: number }>
  signals: SignalCode[]
  /** Scrubbed on the way in. This is the ONLY text that crossed the airlock. */
  gists: string[]
  /** Gists the reader produced that trusted code dropped at the boundary. */
  rejectedGistCount: number
  readerRefusals: number
}

export type AgentRunProposalView =
  | { kind: 'post'; channel: string; intent: string; topic: string; linkRefCount: number; bodyChars: number }
  | { kind: 'purchase'; skuId: string; quantity: number; rationale: string }
  | { kind: 'escalation'; reason: string; note: string }
  | { kind: 'no_action'; reason: string }

export interface AgentRunSuppression {
  proposal: AgentRunProposalView
  reason: string
}

export interface AgentRunSpendView {
  /**
   * Absent when the gate refused before a disbursement existed AND the run
   * could not be paired with its proposal. An empty string would read as a SKU.
   */
  skuId?: string
  status: string
  approved: boolean
  /** First failing gate. Gates are ordered and the first failure wins. */
  failedGate?: string
  requiresHumanApproval: boolean
  /** Machine code. Stable across releases; safe to alert on. */
  code: string
  detail: string
}

export interface AgentRunPublishView {
  channel: string
  intent: string
  published: boolean
  rejectedReason?: string
}

export interface AgentRunCostView {
  microUsd: MicroUsd
  usage: ModelUsage
  degradeLevel: DegradeLevel
}

export interface AgentRunRecord {
  /** `${vault}:${atUnix}`. Deterministic, so a replay does not duplicate. */
  id: string
  coinRef: string
  vault: Address
  atUnix: number
  tier: TierId
  ranChainPoll: boolean
  ranCognition: boolean
  nextDueUnix: number
  /** Absent when this tick ran no cognition window at all. */
  digest?: AgentRunDigestView
  /** Why the window produced no model call, when it produced none. */
  skipped?: string
  freeze?: { level: 'purchases' | 'all'; reason: string }
  proposals: AgentRunProposalView[]
  suppressed: AgentRunSuppression[]
  /** Tool calls the planner made that trusted code rejected outright. */
  violations: ProposalViolation[]
  refusals: PhaseRefusal[]
  spends: AgentRunSpendView[]
  publishes: AgentRunPublishView[]
  cost: AgentRunCostView

  /**
   * Whether the model output in this run came from a real client.
   *
   * Recorded PER RUN rather than read from current configuration, because a
   * process that later gains a credential must not retroactively relabel the
   * scripted runs it already served.
   */
  modelProvenance: 'live' | 'fake' | 'unknown'
}

const ZERO_USAGE: ModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
}

function projectDigest(digest: Digest, rejectedGistCount: number): AgentRunDigestView {
  return {
    windowId: digest.windowId,
    windowStartUnix: digest.windowStartUnix,
    windowEndUnix: digest.windowEndUnix,
    admittedMessageCount: digest.admittedMessageCount,
    droppedMessageCount: digest.droppedMessageCount,
    distinctAuthorCount: digest.distinctAuthorCount,
    topicCounts: (Object.entries(digest.topicCounts) as Array<[TopicCode, number | undefined]>)
      .filter((entry): entry is [TopicCode, number] => entry[1] !== undefined && entry[1] > 0)
      .map(([code, count]) => ({ code, count })),
    signals: [...digest.signals],
    // Scrubbed a second time. validateDigest already scrubbed these; re-running
    // it is cheap and means a record written by a future caller that skipped
    // validation is still safe to serve.
    gists: digest.gists.map((gist) => scrubGist(gist)),
    rejectedGistCount,
    readerRefusals: digest.readerRefusals,
  }
}

function projectProposal(proposal: Proposal): AgentRunProposalView {
  switch (proposal.kind) {
    case 'post':
      return {
        kind: 'post',
        channel: proposal.channel,
        intent: proposal.intent,
        topic: proposal.topic,
        linkRefCount: proposal.linkRefs.length,
        // The body itself does not enter the record. See the header note.
        bodyChars: proposal.body.length,
      }
    case 'purchase':
      return {
        kind: 'purchase',
        skuId: proposal.skuId,
        quantity: proposal.quantity,
        rationale: scrubGist(proposal.rationale),
      }
    case 'escalation':
      return { kind: 'escalation', reason: proposal.reason, note: scrubGist(proposal.note) }
    case 'no_action':
      return { kind: 'no_action', reason: scrubGist(proposal.reason) }
  }
}

export interface ProjectAgentRunOptions {
  tier: TierId
  modelProvenance: 'live' | 'fake' | 'unknown'
  /** Gists the reader emitted that were dropped on the boundary, if known. */
  rejectedGistCount?: number
}

/**
 * One tick in, one record out. Pure: it reads the result and nothing else, so a
 * disputed run can be re-projected from an archived CoinTickResult.
 */
export function projectAgentRun(
  result: CoinTickResult,
  options: ProjectAgentRunOptions,
): AgentRunRecord {
  const window = result.window
  const proposals = (window?.proposals ?? []).map(projectProposal)

  // coin.ts#runSpends iterates the purchase proposals in order and pushes one
  // outcome per proposal, so index i of one is index i of the other. That is
  // the only way to recover a SKU for a REFUSED spend: SpendDecision carries a
  // gate and a reason, never the thing it refused to buy.
  const purchases = proposals.filter(
    (proposal): proposal is Extract<AgentRunProposalView, { kind: 'purchase' }> =>
      proposal.kind === 'purchase',
  )

  const record: AgentRunRecord = {
    id: `${result.vault}:${String(result.atUnix)}`,
    coinRef: result.coinRef,
    vault: result.vault,
    atUnix: result.atUnix,
    tier: options.tier,
    ranChainPoll: result.ranChainPoll,
    ranCognition: result.ranCognition,
    nextDueUnix: result.nextDueUnix,
    proposals,
    suppressed: (window?.suppressed ?? []).map((entry) => ({
      proposal: projectProposal(entry.proposal),
      reason: entry.reason,
    })),
    violations: (window?.violations ?? []).map((violation) => ({ ...violation })),
    refusals: result.refusals.map((refusal) => ({ ...refusal })),
    spends: result.spends.map((spend, index) => {
      const skuId = spend.disbursement?.skuId ?? purchases[index]?.skuId
      return {
        ...(skuId === undefined ? {} : { skuId }),
        status: spend.status,
        approved: spend.decision.approved,
        ...(spend.decision.failedGate === undefined
          ? {}
          : { failedGate: spend.decision.failedGate }),
        requiresHumanApproval: spend.decision.requiresHumanApproval,
        code: spend.code,
        detail: spend.detail,
      }
    }),
    publishes: result.publishes.map((attempt) => ({
      channel: attempt.channel,
      intent: attempt.intent,
      published: attempt.result.published,
      ...(attempt.result.rejectedReason === undefined
        ? {}
        : { rejectedReason: attempt.result.rejectedReason }),
    })),
    cost: {
      microUsd: microUsdFromFloat(window?.costUsd ?? 0),
      usage: window?.usage ?? { ...ZERO_USAGE },
      degradeLevel: window?.degradeLevel ?? 'full',
    },
    modelProvenance: options.modelProvenance,
  }

  if (window?.digest !== undefined) {
    record.digest = projectDigest(window.digest, options.rejectedGistCount ?? 0)
  }
  if (window?.skipped !== undefined) record.skipped = window.skipped
  if (window?.verdict !== undefined && window.verdict.freeze !== 'none') {
    record.freeze = { level: window.verdict.freeze, reason: window.verdict.reason }
  }
  return record
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface AgentRunPage {
  runs: AgentRunRecord[]
  /** Opaque. Absent when this is the last page. */
  nextCursor?: string
}

export interface AgentRunQuery {
  limit?: number
  cursor?: string
}

/**
 * A port, not a class, for the reason ports.ts gives: nobody has built the SQL
 * one yet, and the read side must REFUSE rather than return an empty page when
 * it cannot reach its store. An empty list means "this coin has not ticked";
 * it must never also mean "we could not tell".
 */
export interface AgentRunStore {
  record(run: AgentRunRecord): Promise<void>
  list(vault: Address, query?: AgentRunQuery): Promise<AgentRunPage>
  latest(vault: Address): Promise<AgentRunRecord | undefined>
}

export const AGENT_RUN_PAGE_SIZE = 20
export const AGENT_RUN_MAX_PAGE_SIZE = 100

/**
 * In-memory runs, newest first, bounded per vault.
 *
 * The bound is per vault and not global on purpose: a fleet-wide ring buffer
 * would let one busy coin evict another coin's history, which is a cross-coin
 * effect in a system whose whole claim is that there are none.
 */
export class InMemoryAgentRunStore implements AgentRunStore {
  readonly #byVault = new Map<string, AgentRunRecord[]>()

  constructor(private readonly maxPerVault = 500) {}

  async record(run: AgentRunRecord): Promise<void> {
    const key = run.vault.toLowerCase()
    const held = this.#byVault.get(key) ?? []
    const existing = held.findIndex((candidate) => candidate.id === run.id)
    if (existing >= 0) held.splice(existing, 1)
    held.unshift(run)
    if (held.length > this.maxPerVault) held.length = this.maxPerVault
    this.#byVault.set(key, held)
  }

  async list(vault: Address, query: AgentRunQuery = {}): Promise<AgentRunPage> {
    const held = this.#byVault.get(vault.toLowerCase()) ?? []
    const limit = clampLimit(query.limit)
    const offset = parseCursor(query.cursor)
    const runs = held.slice(offset, offset + limit)
    const next = offset + limit < held.length ? String(offset + limit) : undefined
    return { runs, ...(next === undefined ? {} : { nextCursor: next }) }
  }

  async latest(vault: Address): Promise<AgentRunRecord | undefined> {
    return this.#byVault.get(vault.toLowerCase())?.[0]
  }
}

/**
 * A bad page request is a refusal, not a silent fallback.
 *
 * Serving page one for an unparsable cursor is how a paginated audit log
 * quietly repeats itself forever while the caller believes it is advancing.
 */
export class AgentRunQueryError extends Error {
  constructor(
    readonly code: 'bad_cursor' | 'bad_limit',
    message: string,
  ) {
    super(message)
    this.name = 'AgentRunQueryError'
  }
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return AGENT_RUN_PAGE_SIZE
  if (!Number.isInteger(limit) || limit < 1 || limit > AGENT_RUN_MAX_PAGE_SIZE) {
    throw new AgentRunQueryError(
      'bad_limit',
      `limit must be an integer in [1, ${String(AGENT_RUN_MAX_PAGE_SIZE)}]`,
    )
  }
  return limit
}

/** Refuses a malformed cursor rather than silently serving page one. */
export function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  if (!/^\d{1,9}$/.test(cursor)) {
    throw new AgentRunQueryError('bad_cursor', 'cursor is not a page offset this store issued')
  }
  return Number.parseInt(cursor, 10)
}
