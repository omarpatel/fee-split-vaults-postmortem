/**
 * The agent page's arithmetic and vocabulary, kept out of the components.
 *
 * Everything here is pure and runs in a Node test runner, for the same reason
 * the fee split does: these are the functions that decide whether the page says
 * "the team spent 8% of its budget" or "we cannot tell", and that decision is
 * not something to discover by looking at a screenshot.
 *
 * THE RULE THIS MODULE EXISTS TO HOLD: a missing input renders as an EXPLICIT
 * UNKNOWN, never as zero. A budget with no ceiling is not a budget at 0% used.
 */

import { formatMicroUsd, type MicroUsd } from './money.js'
import type {
  AgentRun,
  AgentRunDigest,
  AgentRunProposal,
  AgentRoleView,
  DegradeLevel,
  ModelProvenance,
} from '../api/model.js'

// ---------------------------------------------------------------------------
// Spend against the cap
// ---------------------------------------------------------------------------

export interface SpendAgainstCap {
  /** Tenths of a percent, integer, so the bar width needs no float. */
  permille: number
  /** Clamped to 100% for the bar; `permille` keeps the true figure. */
  barPercent: number
  overCap: boolean
  spent: string
  cap: string
}

/**
 * How much of today's model budget this coin has used.
 *
 * Returns null when there is no cap to measure against. A page that rendered a
 * capless coin as "0% of $0.00" would be describing a coin that cannot spend as
 * a coin that has not spent, and those are opposite facts.
 */
export function spendAgainstCap(spent: MicroUsd, cap: MicroUsd): SpendAgainstCap | null {
  if (cap <= 0n) return null
  const permille = Number((spent * 1_000n) / cap)
  return {
    permille,
    barPercent: Math.min(100, permille / 10),
    overCap: spent > cap,
    spent: formatMicroUsd(spent),
    cap: formatMicroUsd(cap),
  }
}

/** "0.4%" from tenths of a percent, without a float division in the caller. */
export function formatPermille(permille: number): string {
  const whole = Math.trunc(permille / 10)
  const tenth = Math.abs(permille % 10)
  return tenth === 0 ? `${whole}%` : `${whole}.${tenth}%`
}

// ---------------------------------------------------------------------------
// The degrade ladder
// ---------------------------------------------------------------------------

export interface DegradeStep {
  level: DegradeLevel
  label: string
  meaning: string
  tone: 'good' | 'neutral' | 'warn' | 'bad'
}

/**
 * Degrade, never overspend.
 *
 * Named as a ladder rather than a status because the point a dev needs to take
 * from it is that the bottom rung is deterministic operation, not an outage.
 */
export const DEGRADE_LADDER: readonly DegradeStep[] = [
  {
    level: 'full',
    label: 'Full',
    meaning: 'Within budget. Every role runs on its normal model, in real time.',
    tone: 'good',
  },
  {
    level: 'batch',
    label: 'Batched',
    meaning:
      'Past 60% of the day. Work that can wait is routed through the Batch API at half price; urgent work is not.',
    tone: 'neutral',
  },
  {
    level: 'downgrade',
    label: 'Downgraded',
    meaning:
      'Past 85% of the day. The planner drops to the cheap model. The reader was already on it.',
    tone: 'warn',
  },
  {
    level: 'suspend',
    label: 'Suspended',
    meaning:
      "The day's model budget is spent. The team runs deterministically until the next UTC day rather than running this coin at a loss.",
    tone: 'bad',
  },
]

export function degradeStep(level: DegradeLevel): DegradeStep {
  const found = DEGRADE_LADDER.find((step) => step.level === level)
  if (found === undefined) throw new Error(`unknown degrade level ${level}`)
  return found
}

// ---------------------------------------------------------------------------
// Model provenance
// ---------------------------------------------------------------------------

export interface ProvenanceNotice {
  banner: boolean
  title: string
  body: string
}

/**
 * What to say about whose output this is.
 *
 * `banner` is true for anything that is not a confirmed live client, including
 * 'unknown'. Presenting a stand-in's output as a model's is the single worst
 * thing this page could do, and "we are not sure" is not a reason to say
 * nothing - it is the thing to say.
 */
export function provenanceNotice(
  provenance: ModelProvenance,
  detail: string,
): ProvenanceNotice {
  switch (provenance) {
    case 'live':
      return {
        banner: false,
        title: 'Live model client',
        body: detail,
      }
    case 'fake':
      return {
        banner: true,
        title: 'This is not a model. It is a scripted stand-in.',
        body:
          `${detail} Every digest, proposal and refusal below was produced by a fixed script, ` +
          'not by a model. Nothing on this page is evidence of what a model would do.',
      }
    case 'unknown':
      return {
        banner: true,
        title: 'We cannot confirm which client produced this',
        body:
          `${detail} Until a call resolves against a real credential, treat everything below as ` +
          'unattributed. This page will not guess.',
      }
  }
}

// ---------------------------------------------------------------------------
// The airlock, as counters
// ---------------------------------------------------------------------------

export interface AirlockView {
  /** Messages the reader read at full fidelity. */
  readerSaw: number
  /** Messages the deterministic caps dropped before the reader saw them. */
  droppedByCaps: number
  distinctAuthors: number
  /** Closed-enum counters the planner received. */
  counterCount: number
  signalCount: number
  /** Scrubbed fragments. The only text that crossed, and it is redacted. */
  gistCount: number
  /** Gists the reader wrote that trusted code refused to pass. */
  gistsRejected: number
  readerRefusals: number
  /** Characters of free text the planner received, across every gist. */
  gistChars: number
}

export function airlockView(digest: AgentRunDigest): AirlockView {
  return {
    readerSaw: digest.admittedMessageCount,
    droppedByCaps: digest.droppedMessageCount,
    distinctAuthors: digest.distinctAuthorCount,
    counterCount: digest.topicCounts.reduce((sum, entry) => sum + entry.count, 0),
    signalCount: digest.signals.length,
    gistCount: digest.gists.length,
    gistsRejected: digest.rejectedGistCount,
    readerRefusals: digest.readerRefusals,
    gistChars: digest.gists.reduce((sum, gist) => sum + gist.length, 0),
  }
}

// ---------------------------------------------------------------------------
// One tick, summarised
// ---------------------------------------------------------------------------

/** The tick phases, in the order the tick runs them. */
export const TICK_PHASES = [
  'guard',
  'ingest',
  'accrual',
  'measure',
  'tier',
  'cognition',
  'spend',
  'publish',
  'receipts',
] as const

export type TickPhase = (typeof TICK_PHASES)[number]

/**
 * Refusals grouped by phase, in tick order, INCLUDING phases that refused
 * nothing when they are the ones a reader is looking for.
 *
 * A phase with no refusals is dropped rather than shown as an empty row: the
 * list is the answer to "what stopped", and padding it with silence makes the
 * two entries that matter harder to find.
 */
export function refusalsByPhase(run: AgentRun): Array<{ phase: string; codes: AgentRun['refusals'] }> {
  const grouped = new Map<string, AgentRun['refusals']>()
  for (const refusal of run.refusals) {
    grouped.set(refusal.phase, [...(grouped.get(refusal.phase) ?? []), refusal])
  }
  const ordered: Array<{ phase: string; codes: AgentRun['refusals'] }> = []
  for (const phase of TICK_PHASES) {
    const codes = grouped.get(phase)
    if (codes !== undefined) ordered.push({ phase, codes })
    grouped.delete(phase)
  }
  // Anything the client does not recognise still gets shown, at the end. A
  // phase this build has not heard of is not a phase to hide.
  for (const [phase, codes] of grouped) ordered.push({ phase, codes })
  return ordered
}

export interface RunSummary {
  proposed: number
  suppressed: number
  refused: number
  violations: number
  published: number
  publishRejected: number
  spendApproved: number
  spendRefused: number
  cost: string
  /** True when the team ran and deliberately did nothing. Not the same as idle. */
  deliberatelyQuiet: boolean
}

export function runSummary(run: AgentRun): RunSummary {
  const actionable = run.proposals.filter((proposal) => proposal.kind !== 'no_action')
  return {
    proposed: run.proposals.length,
    suppressed: run.suppressed.length,
    refused: run.refusals.length,
    violations: run.violations.length,
    published: run.publishes.filter((attempt) => attempt.published).length,
    publishRejected: run.publishes.filter((attempt) => !attempt.published).length,
    spendApproved: run.spends.filter((spend) => spend.approved).length,
    spendRefused: run.spends.filter((spend) => !spend.approved).length,
    cost: formatMicroUsd(run.cost.microUsd),
    deliberatelyQuiet: run.ranCognition && actionable.length === 0,
  }
}

/** A short label for a proposal, with no model-authored copy in it. */
export function proposalLabel(proposal: AgentRunProposal): string {
  switch (proposal.kind) {
    case 'post':
      return `post to ${proposal.channel} · ${proposal.intent} · ${proposal.topic}`
    case 'purchase':
      return `buy ${proposal.skuId} ×${String(proposal.quantity)}`
    case 'escalation':
      return `escalate to a human · ${proposal.reason}`
    case 'no_action':
      return 'no action'
  }
}

/**
 * Why a window produced no model call at all.
 *
 * Every one of these is a correct outcome rather than a failure, and the copy
 * says so: an empty window costing nothing is the entire point of a fixed
 * schedule with no wake-on-mention path.
 */
export function describeSkip(skipped: string): string {
  switch (skipped) {
    case 'empty_window':
      return 'Nobody said anything in this window, so no model was called and it cost nothing.'
    case 'tier_has_no_model':
      return 'This tier is deterministic by design. No model is in the loop, at any volume.'
    case 'budget_suspended':
      return "The day's model budget is spent. The team degraded to deterministic operation."
    case 'budget_insufficient':
      return 'The next call was estimated to exceed the remaining day, so it was not made.'
    default:
      return skipped
  }
}

/** Roles that read a stranger's text, named for the airlock panel. */
export function untrustedReaders(roles: readonly AgentRoleView[]): AgentRoleView[] {
  return roles.filter((role) => role.readsUntrustedInput)
}
