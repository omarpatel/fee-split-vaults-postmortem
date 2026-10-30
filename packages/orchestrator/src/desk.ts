/**
 * The desk phase: answer what holders asked in the window that just closed.
 *
 * Runs on the same fixed schedule as cognition and on the same opaque array.
 * There is no wake-on-message path: a question is answered at the next tick
 * after its window closes, never sooner, at every volume.
 *
 * WHAT THIS MODULE DOES NOT DO. It never reads a field of a message beyond the
 * binding and the origin, both stamped by trusted ingest. It never renders
 * disclosure - the publisher owns that, and a reply goes out through the same
 * `publish` call every planner post uses, with `replyTo` set so the publisher
 * treats it as an autonomous Telegram reply. It never calls a model: the desk
 * behind the port does, under the cap below, and reports whether it did.
 *
 * THE CAPS. Two, both per window, both enforced here by counting rather than
 * by trusting the desk:
 *
 *   - messages handed to the desk at all, so a flood costs the desk nothing
 *     past a fixed amount of deterministic work;
 *   - model calls, so a flood of well-formed questions cannot burn the coin's
 *     model budget inside one window. The figure is the desk's own daily
 *     budget (DEFAULT_DESK_BUDGET.maxModelCallsPerDay = 400) spread over the
 *     48 thirty-minute windows in a day, rounded down. Once spent, the desk is
 *     still asked - commands and the anti-snipe explainer are deterministic -
 *     but with `modelPermitted: false`.
 */

import type { Address, Channel, PublishResult } from '@fee-split-vaults/core'
import { CORPUS_LIMITS } from '@fee-split-vaults/core'
import type { RawMessage } from '@fee-split-vaults/runtime'
import type { Publisher } from '@fee-split-vaults/publisher'
import type { TierId } from '../../../config/protocol.js'

import { assertSameCoin } from './errors.js'
import type { DeskOutcome, DeskPort, DeskWindowRef, EscalationSink } from './ports.js'

const WINDOWS_PER_DAY = 86_400 / (CORPUS_LIMITS.windowMinutes * 60)
/** DEFAULT_DESK_BUDGET.maxModelCallsPerDay, restated here so this package does not import the desk. */
const DESK_MODEL_CALLS_PER_DAY = 400

export const DESK_WINDOW_LIMITS = {
  /** Messages the desk is asked about per window. Matches the corpus ceiling. */
  maxMessagesPerWindow: CORPUS_LIMITS.maxMessagesPerWindow,
  maxModelCallsPerWindow: Math.floor(DESK_MODEL_CALLS_PER_DAY / WINDOWS_PER_DAY),
} as const

/** The desk answers on this channel only. Everything else is corpus. */
const DESK_CHANNEL: Channel = 'telegram'

export interface DeskPhaseDeps {
  desk: DeskPort
  publisher: Publisher
  escalations: EscalationSink
}

export interface DeskPhaseInput {
  coinRef: string
  vault: Address
  token: Address
  tier: TierId
  /** The Telegram account this coin speaks from; also the chat the desk moderates. */
  accountId: string
  window: DeskWindowRef
  messages: readonly RawMessage[]
  nowUnix: number
  limits?: Partial<typeof DESK_WINDOW_LIMITS>
}

export interface DeskReplyAttempt {
  sourceId: string
  outcome: DeskOutcome['kind']
  result: PublishResult
}

export interface DeskPhaseResult {
  /** Telegram messages in the window, before any cap. */
  considered: number
  /** Handed to the desk. */
  handled: number
  /** Beyond the per-window message cap; never handed over. */
  skippedByCap: number
  modelCalls: number
  replies: DeskReplyAttempt[]
  refused: number
  moderated: number
  ignored: number
  escalationsRaised: number
  /** Per-message failures. Each is also a phase refusal on the tick. */
  refusals: Array<{ code: string; detail: string }>
}

export async function runDeskPhase(deps: DeskPhaseDeps, input: DeskPhaseInput): Promise<DeskPhaseResult> {
  const limits = { ...DESK_WINDOW_LIMITS, ...input.limits }
  const result: DeskPhaseResult = {
    considered: 0,
    handled: 0,
    skippedByCap: 0,
    modelCalls: 0,
    replies: [],
    refused: 0,
    moderated: 0,
    ignored: 0,
    escalationsRaised: 0,
    refusals: [],
  }

  for (const message of input.messages) {
    // The binding is the airlock's half of isolation; asserting it here is the
    // tick's half. A row for another coin reaching this loop is a bug in the
    // source, and it stops loudly rather than being quietly answered.
    assertSameCoin(input.coinRef, message.boundCoinRef, `desk message ${message.sourceId}`)
    if (message.origin !== DESK_CHANNEL) continue
    result.considered += 1

    if (result.handled >= limits.maxMessagesPerWindow) {
      result.skippedByCap += 1
      continue
    }
    result.handled += 1

    let outcome: DeskOutcome
    try {
      outcome = await deps.desk.answer({
        coinRef: input.coinRef,
        vault: input.vault,
        token: input.token,
        tier: input.tier,
        chatId: input.accountId,
        window: input.window,
        message,
        modelPermitted: result.modelCalls < limits.maxModelCallsPerWindow,
        nowUnix: input.nowUnix,
      })
    } catch (error) {
      result.refusals.push({
        code: codeOf(error),
        detail: `${message.sourceId}: ${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }

    if (outcome.modelCalled) result.modelCalls += 1

    for (const escalation of outcome.escalations) {
      await deps.escalations.raise({
        coinRef: input.coinRef,
        vault: input.vault,
        kind: 'desk_escalation',
        code: escalation.reason,
        detail: `[${escalation.priority}] ${escalation.summary}`,
        raisedAtUnix: input.nowUnix,
      })
      result.escalationsRaised += 1
    }

    switch (outcome.kind) {
      case 'ignore':
        result.ignored += 1
        continue
      case 'refused':
        result.refused += 1
        break
      case 'moderated':
        result.moderated += 1
        for (const failure of outcome.failed) {
          result.refusals.push({
            code: `moderation_${failure.code}`,
            detail: `${message.sourceId}: ${failure.action} could not be applied`,
          })
        }
        break
      case 'reply':
        break
    }

    const body = outcome.body
    if (body === undefined) continue

    const publish = await deps.publisher.publish({
      request: {
        vault: input.vault,
        channel: DESK_CHANNEL,
        body,
        isPromotional: false,
        links: [],
      },
      accountId: input.accountId,
      replyTo: { inReplyToId: message.sourceId },
      correlationId: `${input.window.windowId}:desk:${message.sourceId}`,
    })
    result.replies.push({ sourceId: message.sourceId, outcome: outcome.kind, result: publish })
    if (!publish.published) {
      result.refusals.push({
        code: 'reply_not_published',
        detail: `${message.sourceId}: ${publish.rejectedReason ?? 'unknown'}`,
      })
    }
  }

  if (result.skippedByCap > 0) {
    result.refusals.push({
      code: 'desk_window_cap',
      detail: `${String(result.skippedByCap)} messages beyond the per-window cap of ${String(limits.maxMessagesPerWindow)} were not handed to the desk`,
    })
  }

  return result
}

function codeOf(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return 'desk_failed'
}
