/**
 * SHOWING A COIN ITS OWN TEAM.
 *
 * Three read-only routes back this file. They exist because the product's
 * central claim - that a coin has a team working for it and every action is
 * receipted - was until now only true inside the process. A dev could read what
 * was BOUGHT on the receipts ledger and could not read what was DECIDED, what
 * was refused, or which of the six roles was even awake.
 *
 * THREE RULES THIS MODULE HOLDS.
 *
 *   1. NO BIGINT CROSSES THE WIRE AS A NUMBER. Inference cost is carried in
 *      integer MICRO-USD as a decimal string. Cents is the wrong unit here: a
 *      Haiku reader call costs a fraction of a cent and a day is hundreds of
 *      them, so rounding at the boundary would show most of a day's work as
 *      $0.00 and understate the running total.
 *
 *   2. EVERY MODEL-AUTHORED STRING IS SCRUBBED ON THE WAY OUT. A gist, a
 *      purchase rationale, an escalation note and a phase refusal detail can
 *      all carry text that started life in a stranger's message. They go
 *      through the same safeEcho() the onboarding routes use.
 *
 *   3. A FAKED DEPENDENCY IS STATED, NEVER OMITTED. Every response carries
 *      `fakedDependencies` and every run carries `modelProvenance`. An empty
 *      list is a claim that everything is real, so nothing may be dropped from
 *      it to make a page look tidier.
 */

import type { Address } from '@fee-split-vaults/core'
import type {
  AgentRole,
  AgentRoleStatus,
  AgentRunPage,
  AgentRunProposalView,
  AgentRunRecord,
  AgentRunStore,
  AgentSnapshot,
} from '@fee-split-vaults/orchestrator'

import { safeEcho } from './echo.js'
import { HttpError } from './http/router.js'

/**
 * What a composition root must supply for these routes to answer.
 *
 * `snapshot` resolving to undefined means NO SUCH VAULT. It must throw - not
 * return undefined - when the fleet cannot be reached, because "we hold no
 * ticker for this coin" and "we could not tell" are different answers and only
 * one of them is a 404.
 */
export interface AgentPort {
  snapshot(vault: Address): Promise<AgentSnapshot | undefined>
  runs: AgentRunStore
}

/**
 * The port a deployment gets when nothing has wired a fleet to it.
 *
 * It refuses with a 503 and says what is missing. The alternative - answering
 * with an empty team, a zero spend and a null tick - would render as a coin
 * whose agents are idle, which is a different and much worse claim than "this
 * process cannot see the fleet".
 */
export function unwiredAgentPort(detail: string): AgentPort {
  const refuse = (): Promise<never> =>
    Promise.reject(new HttpError(503, 'agent_not_wired', detail))
  return {
    snapshot: refuse,
    runs: {
      record: refuse,
      list: refuse,
      latest: refuse,
    },
  }
}

// ---------------------------------------------------------------------------
// Wire projection
// ---------------------------------------------------------------------------

function roleBody(role: AgentRole): Record<string, unknown> {
  return {
    id: role.id,
    title: role.title,
    mission: role.mission,
    phases: [...role.phases],
    readsUntrustedInput: role.readsUntrustedInput,
    may: [...role.may],
    mayNot: [...role.mayNot],
  }
}

function roleStatusBody(status: AgentRoleStatus): Record<string, unknown> {
  return {
    ...roleBody(status.role),
    activity: status.activity,
    ...(status.dormantCode === undefined ? {} : { dormantCode: status.dormantCode }),
    ...(status.dormantReason === undefined ? {} : { dormantReason: status.dormantReason }),
  }
}

/** GET /coins/:vault/agent */
export function agentBody(snapshot: AgentSnapshot): Record<string, unknown> {
  return {
    coinRef: snapshot.coinRef,
    vault: snapshot.vault,
    tier: snapshot.tier,
    vaultState: snapshot.vaultState,
    halted: snapshot.halted,
    screeningVerdict: snapshot.screeningVerdict ?? null,
    paidMediaPermitted: snapshot.paidMediaPermitted,
    lastTickAtUnix: snapshot.lastTickAtUnix,
    nextDueUnix: snapshot.nextDueUnix,
    freeze: snapshot.freeze,
    model: {
      readerModel: snapshot.model.readerModel,
      plannerModel: snapshot.model.plannerModel,
      // 'fake' is never rendered as an absence. See the header note.
      provenance: snapshot.model.provenance,
      detail: snapshot.model.detail,
      viaBatch: snapshot.model.viaBatch,
    },
    spend: {
      todayMicroUsd: snapshot.spend.todayMicroUsd.toString(),
      dailyCapMicroUsd: snapshot.spend.dailyCapMicroUsd.toString(),
      tierCogsPerDayMicroUsd: snapshot.spend.tierCogsPerDayMicroUsd.toString(),
      callsToday: snapshot.spend.callsToday,
      degradeLevel: snapshot.spend.degradeLevel,
      dayKey: snapshot.spend.dayKey,
    },
    roles: snapshot.roles.map(roleStatusBody),
    fakedDependencies: [...snapshot.fakedDependencies],
    atUnix: snapshot.atUnix,
  }
}

/** GET /coins/:vault/agent/roles */
export function agentRolesBody(snapshot: AgentSnapshot): Record<string, unknown> {
  return {
    vault: snapshot.vault,
    tier: snapshot.tier,
    roles: snapshot.roles.map(roleStatusBody),
    fakedDependencies: [...snapshot.fakedDependencies],
    atUnix: snapshot.atUnix,
  }
}

function proposalBody(proposal: AgentRunProposalView, field: string): Record<string, unknown> {
  switch (proposal.kind) {
    case 'post':
      return {
        kind: 'post',
        channel: proposal.channel,
        intent: proposal.intent,
        topic: proposal.topic,
        linkRefCount: proposal.linkRefCount,
        // The body is not here. The published artifact and its permalink belong
        // on the receipts ledger; this log records that copy was written.
        bodyChars: proposal.bodyChars,
      }
    case 'purchase':
      return {
        kind: 'purchase',
        skuId: proposal.skuId,
        quantity: proposal.quantity,
        rationale: safeEcho(proposal.rationale, `${field}.rationale`),
      }
    case 'escalation':
      return {
        kind: 'escalation',
        reason: proposal.reason,
        note: safeEcho(proposal.note, `${field}.note`),
      }
    case 'no_action':
      return { kind: 'no_action', reason: safeEcho(proposal.reason, `${field}.reason`) }
  }
}

/**
 * One run, projected for the wire.
 *
 * Note what is NOT conditional on anything: refusals, suppressions and
 * violations are always present, even when empty, so a caller can tell "nothing
 * was refused" from "this build does not report refusals".
 */
export function agentRunBody(run: AgentRunRecord): Record<string, unknown> {
  const field = `run.${run.id}`
  return {
    id: run.id,
    coinRef: run.coinRef,
    vault: run.vault,
    atUnix: run.atUnix,
    tier: run.tier,
    ranChainPoll: run.ranChainPoll,
    ranCognition: run.ranCognition,
    nextDueUnix: run.nextDueUnix,
    ...(run.skipped === undefined ? {} : { skipped: run.skipped }),
    ...(run.freeze === undefined
      ? {}
      : { freeze: { level: run.freeze.level, reason: run.freeze.reason } }),
    digest:
      run.digest === undefined
        ? null
        : {
            windowId: run.digest.windowId,
            windowStartUnix: run.digest.windowStartUnix,
            windowEndUnix: run.digest.windowEndUnix,
            admittedMessageCount: run.digest.admittedMessageCount,
            droppedMessageCount: run.digest.droppedMessageCount,
            distinctAuthorCount: run.digest.distinctAuthorCount,
            topicCounts: run.digest.topicCounts.map((entry) => ({
              code: entry.code,
              count: entry.count,
            })),
            signals: [...run.digest.signals],
            gists: run.digest.gists.map((gist, i) => safeEcho(gist, `${field}.gists[${String(i)}]`)),
            rejectedGistCount: run.digest.rejectedGistCount,
            readerRefusals: run.digest.readerRefusals,
          },
    proposals: run.proposals.map((proposal, i) =>
      proposalBody(proposal, `${field}.proposals[${String(i)}]`),
    ),
    suppressed: run.suppressed.map((entry, i) => ({
      proposal: proposalBody(entry.proposal, `${field}.suppressed[${String(i)}]`),
      reason: entry.reason,
    })),
    violations: run.violations.map((violation, i) => ({
      toolName: violation.toolName,
      field: violation.field,
      // The airlock quotes the value it refused - a sku id, a link ref, a
      // signal code the model invented - so the message is model-authored too.
      message: safeEcho(violation.message, `${field}.violations[${String(i)}].message`),
    })),
    refusals: run.refusals.map((refusal, i) => ({
      phase: refusal.phase,
      code: refusal.code,
      // A refusal detail can quote an error that quoted a model that read a
      // stranger's message. Three hops is still untrusted.
      detail: safeEcho(refusal.detail, `${field}.refusals[${String(i)}].detail`),
    })),
    spends: run.spends.map((spend, i) => ({
      ...(spend.skuId === undefined ? {} : { skuId: spend.skuId }),
      status: spend.status,
      approved: spend.approved,
      ...(spend.failedGate === undefined ? {} : { failedGate: spend.failedGate }),
      requiresHumanApproval: spend.requiresHumanApproval,
      code: spend.code,
      detail: safeEcho(spend.detail, `${field}.spends[${String(i)}].detail`),
    })),
    publishes: run.publishes.map((attempt, i) => ({
      channel: attempt.channel,
      intent: attempt.intent,
      published: attempt.published,
      ...(attempt.rejectedReason === undefined
        ? {}
        : { rejectedReason: safeEcho(attempt.rejectedReason, `${field}.publishes[${String(i)}].rejectedReason`) }),
    })),
    cost: {
      microUsd: run.cost.microUsd.toString(),
      degradeLevel: run.cost.degradeLevel,
      usage: {
        inputTokens: run.cost.usage.inputTokens,
        outputTokens: run.cost.usage.outputTokens,
        cacheCreationInputTokens: run.cost.usage.cacheCreationInputTokens,
        cacheReadInputTokens: run.cost.usage.cacheReadInputTokens,
      },
    },
    modelProvenance: run.modelProvenance,
  }
}

/** GET /coins/:vault/agent/runs */
export function agentRunsBody(
  vault: Address,
  page: AgentRunPage,
  snapshot: AgentSnapshot,
  atUnix: number,
): Record<string, unknown> {
  return {
    vault,
    atUnix,
    runs: page.runs.map(agentRunBody),
    nextCursor: page.nextCursor ?? null,
    fakedDependencies: [...snapshot.fakedDependencies],
  }
}
