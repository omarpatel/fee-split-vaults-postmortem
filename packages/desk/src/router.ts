/**
 * The desk router: one message in, at most one reply out.
 *
 * Order is fixed and every stage is allowed to stop the message:
 *
 *   1. Moderate. Scam removal and raid control run before anything else, so a
 *      drainer link is gone whether or not the desk understood the sentence.
 *   2. Admit to the airlock corpus. Counts only, capped deterministically.
 *   3. Slash command -> T0 table lookup. No model, ever, on this path.
 *   4. Language gate. A message the desk would answer is refused, in English,
 *      when it is not English. Deterministic; the model never reads it.
 *   5. Anti-snipe ticket -> the deterministic explainer, at every tier.
 *   6. T1+ only: the grounded model path, under a call budget.
 *
 * The desk answers from the FactSheet. It does not read the room and then act
 * on what it read: the only thing that crosses to the planning plane is the
 * Digest, and the desk plane holds no spending, signing, or publishing tool to
 * act with in the first place.
 */

import type { Address } from '@fee-split-vaults/core'
import type { TierId } from '../../../config/protocol.js'
import { renderOutbound, type DeskAnswer, type OutboundOptions } from './answer.js'
import { explainAntiSnipe, looksLikeAntiSnipeTicket } from './antisnipe.js'
import { DeskCorpusAssembler } from './airlock/inbound.js'
import type { FactSheet } from './factsheet/builder.js'
import type { FieldAnswerContext } from './field-answer.js'
import { classifyLanguage } from './language.js'
import type { InboundMessage } from './message.js'
import { executeModeration, type ModerationEngine, type ModerationVerdict } from './moderation/engine.js'
import { InMemoryEscalationQueue } from './moderation/escalation.js'
import { classifyRefusal } from './refusal/classifier.js'
import {
  fingerprint,
  makeRefusalRef,
  scrubExcerpt,
  type RefusalLog,
} from './refusal/log.js'
import { noVerifiedAnswerBody, refusalBody, refusalCodeBody } from './refusal/templates.js'
import { handleT0Command, parseCommand } from './t0/commands.js'
import type { HaikuDesk, DeskAttempt } from './t1/desk.js'
import { detectLanguage } from './text/normalize.js'
import type { TelegramClient } from './telegram/client.js'

export interface DeskBudget {
  /** Hard ceiling on model calls per coin per day. T1 COGS is ~$13/coin/day. */
  maxModelCallsPerDay: number
  /** Per-author hourly ceiling, so one person cannot drain the day's budget. */
  maxModelCallsPerAuthorPerHour: number
  /** Refusals from one author within an hour before a human is told. */
  refusalProbeThreshold: number
}

export const DEFAULT_DESK_BUDGET: DeskBudget = {
  maxModelCallsPerDay: 400,
  maxModelCallsPerAuthorPerHour: 6,
  refusalProbeThreshold: 8,
}

export type DeskAction =
  | 'moderated'
  | 'command'
  | 'antisnipe'
  | 'model'
  | 'refused'
  | 'unavailable'
  | 'budget_exhausted'
  | 'ignored'

export interface DeskOutcome {
  action: DeskAction
  answer?: DeskAnswer
  /** Exactly what went on the wire, disclosure included. */
  sentText?: string
  moderation?: ModerationVerdict
  attempt?: DeskAttempt
  modelCalled: boolean
}

export interface DeskRouterOptions {
  vault: Address
  tier: TierId
  client: TelegramClient
  /** The cached sheet. Never refreshed from a message handler. */
  sheetSource: () => FactSheet | undefined
  moderation: ModerationEngine
  escalations: InMemoryEscalationQueue
  refusalLog: RefusalLog
  corpus: DeskCorpusAssembler
  outbound: OutboundOptions
  botUsername?: string
  /** Required to answer natural language. Absent means T0 behaviour. */
  desk?: HaikuDesk
  budget?: Partial<DeskBudget>
  clock?: () => number
}

/** Per-call overrides the scheduler holds, not the message. */
export interface DeskHandleOptions {
  /**
   * False forbids a model call for this message regardless of the router's own
   * budget: the tick loop caps model calls per window on top of the daily and
   * per-author budgets here, and a message past that cap is answered exactly
   * as one past the daily budget is.
   */
  allowModel?: boolean
}

export class DeskRouter {
  private readonly budget: DeskBudget
  private readonly clock: () => number
  private tier: TierId
  private modelCallsToday: { dayStartUnix: number; count: number }
  private readonly authorModelCalls = new Map<string, number[]>()

  constructor(private readonly options: DeskRouterOptions) {
    this.budget = { ...DEFAULT_DESK_BUDGET, ...options.budget }
    this.clock = options.clock ?? (() => Math.floor(Date.now() / 1000))
    this.tier = options.tier
    this.modelCallsToday = { dayStartUnix: this.dayStart(this.clock()), count: 0 }
  }

  /**
   * The tier is decided by the tick loop from the coin's measured QF and can
   * change between windows. The budget counters survive the change on purpose:
   * a tier change must not hand an author a fresh hourly allowance.
   */
  setTier(tier: TierId): void {
    this.tier = tier
  }

  private dayStart(nowUnix: number): number {
    return nowUnix - (nowUnix % 86_400)
  }

  private modelBudgetAvailable(authorId: string, nowUnix: number): boolean {
    const dayStart = this.dayStart(nowUnix)
    if (this.modelCallsToday.dayStartUnix !== dayStart) {
      this.modelCallsToday = { dayStartUnix: dayStart, count: 0 }
    }
    if (this.modelCallsToday.count >= this.budget.maxModelCallsPerDay) return false

    const calls = (this.authorModelCalls.get(authorId) ?? []).filter((t) => nowUnix - t < 3_600)
    this.authorModelCalls.set(authorId, calls)
    return calls.length < this.budget.maxModelCallsPerAuthorPerHour
  }

  private noteModelCall(authorId: string, nowUnix: number): void {
    this.modelCallsToday.count++
    const calls = this.authorModelCalls.get(authorId) ?? []
    calls.push(nowUnix)
    this.authorModelCalls.set(authorId, calls)
  }

  private context(sheet: FactSheet, message: InboundMessage, nowUnix: number): FieldAnswerContext {
    return { sheet, nowUnix, language: detectLanguage(message.text) }
  }

  private async send(message: InboundMessage, answer: DeskAnswer): Promise<string> {
    const text = renderOutbound(answer, this.options.outbound)
    await this.options.client.sendMessage(message.chatId, text, {
      replyToMessageId: message.messageId,
      disableLinkPreview: true,
    })
    return text
  }

  private logRefusal(
    message: InboundMessage,
    answer: DeskAnswer,
    ref: string,
    nowUnix: number,
    trippedOn: 'input' | 'output' | 'none',
    ruleIds: string[],
  ): void {
    this.options.refusalLog.record({
      ref,
      atUnix: nowUnix,
      vault: this.options.vault,
      channel: message.channel,
      chatId: message.chatId,
      authorId: message.authorId,
      trippedOn,
      classes: answer.refusalClasses ?? [],
      ruleIds,
      questionFingerprint: fingerprint(message.text),
      excerpt: scrubExcerpt(message.text),
      language: answer.language,
    })

    const recent = this.options.refusalLog.countSince(nowUnix - 3_600, message.authorId)
    if (recent >= this.budget.refusalProbeThreshold) {
      this.options.escalations.enqueue(
        {
          vault: this.options.vault,
          reason: 'refusal_probe',
          summary: `One account produced ${recent} refusals in an hour. That is a probe, not a customer.`,
          chatId: message.chatId,
          authorId: message.authorId,
        },
        nowUnix,
      )
    }
  }

  /** No sheet means no verified anything. Say so and tell a human. */
  private async unavailable(message: InboundMessage, nowUnix: number): Promise<DeskOutcome> {
    const language = detectLanguage(message.text)
    const answer: DeskAnswer = {
      kind: 'unavailable',
      body: noVerifiedAnswerBody(language),
      citations: [],
      language,
      modelAuthored: false,
    }
    this.options.escalations.enqueue(
      {
        vault: this.options.vault,
        reason: 'factsheet_unavailable',
        summary: 'The desk has no usable FactSheet, so it is refusing to answer anything with a value in it.',
        chatId: message.chatId,
      },
      nowUnix,
    )
    return { action: 'unavailable', answer, sentText: await this.send(message, answer), modelCalled: false }
  }

  /**
   * Not English. The reply is the fixed English line and it goes through the
   * refusal log like any other refusal, under its code rather than a class.
   */
  private async languageUnsupported(
    message: InboundMessage,
    verdict: ModerationVerdict,
    nowUnix: number,
  ): Promise<DeskOutcome> {
    const ref = makeRefusalRef(this.options.vault, message.text, nowUnix)
    const answer: DeskAnswer = {
      kind: 'refusal',
      body: refusalCodeBody('language_unsupported', ref),
      citations: [],
      language: 'en',
      refusalCode: 'language_unsupported',
      modelAuthored: false,
    }
    this.logRefusal(message, answer, ref, nowUnix, 'input', ['language_unsupported'])
    return {
      action: 'refused',
      answer,
      sentText: await this.send(message, answer),
      moderation: verdict,
      modelCalled: false,
    }
  }

  async handle(message: InboundMessage, handleOptions: DeskHandleOptions = {}): Promise<DeskOutcome> {
    const nowUnix = this.clock()

    // 1. Moderation, before anything else reads the text for meaning.
    const verdict = this.options.moderation.scan(message, nowUnix)
    if (verdict.actions.length > 0) {
      await executeModeration(this.options.client, message, verdict, {
        operatorWarning: async (text) => {
          await this.options.client.sendMessage(
            message.chatId,
            renderOutbound(
              {
                kind: 'moderation',
                body: text,
                citations: [],
                language: 'en',
                modelAuthored: false,
              },
              this.options.outbound,
            ),
            { replyToMessageId: message.messageId, disableLinkPreview: true },
          )
        },
      })
      for (const draft of verdict.escalations) this.options.escalations.enqueue(draft, nowUnix)
    }

    // 2. The airlock corpus gets counts either way; a removed message is still
    //    a data point about the window, and it is only ever a count.
    this.options.corpus.admit(message, verdict.topics[0], !verdict.removed)

    if (verdict.removed) {
      return { action: 'moderated', moderation: verdict, modelCalled: false }
    }

    const sheet = this.options.sheetSource()

    // 3. Slash commands. Deterministic, cached, no model.
    const command = parseCommand(message.text, this.options.botUsername)
    if (command) {
      if (!sheet) return this.unavailable(message, nowUnix)
      const answer = handleT0Command(command.command, this.context(sheet, message, nowUnix))
      return {
        action: 'command',
        answer,
        sentText: await this.send(message, answer),
        moderation: verdict,
        modelCalled: false,
      }
    }

    const addressed = message.mentionsBot === true || message.replyToBot === true
    const ticket = looksLikeAntiSnipeTicket(message.text)

    // 4. The language gate, on exactly the messages the desk would go on to
    //    answer. Unaddressed chatter is not judged, only counted (step 2).
    if ((addressed || ticket) && classifyLanguage(message.text).verdict === 'unsupported') {
      return this.languageUnsupported(message, verdict, nowUnix)
    }

    // 5. The anti-snipe ticket, answered deterministically at every tier. This
    //    is the single most common support ticket a Venue launch produces.
    if (ticket) {
      if (!sheet) return this.unavailable(message, nowUnix)
      const ctx = this.context(sheet, message, nowUnix)
      const answer = explainAntiSnipe(ctx)
      this.options.escalations.enqueue(
        {
          vault: this.options.vault,
          reason: 'antisnipe_ticket',
          summary: 'A holder reported losing value on a trade near launch. The desk sent the window explainer.',
          chatId: message.chatId,
          authorId: message.authorId,
        },
        nowUnix,
      )
      return {
        action: 'antisnipe',
        answer,
        sentText: await this.send(message, answer),
        moderation: verdict,
        modelCalled: false,
      }
    }

    // 6. T0 is a venue plus a janitor. It does not attempt natural language.
    if (this.tier === 'T0' || !this.options.desk) {
      if (!addressed) return { action: 'ignored', moderation: verdict, modelCalled: false }
      if (!sheet) return this.unavailable(message, nowUnix)
      const answer = handleT0Command('help', this.context(sheet, message, nowUnix))
      return {
        action: 'command',
        answer,
        sentText: await this.send(message, answer),
        moderation: verdict,
        modelCalled: false,
      }
    }

    if (!addressed) return { action: 'ignored', moderation: verdict, modelCalled: false }

    // A message that tried to give the desk instructions is answered by the
    // fixed template, never by the model.
    if (verdict.suppressModel) {
      if (!sheet) return this.unavailable(message, nowUnix)
      const language = detectLanguage(message.text)
      const answer: DeskAnswer = {
        kind: 'unknown_field',
        body: noVerifiedAnswerBody(language),
        citations: [],
        language,
        modelAuthored: false,
      }
      return {
        action: 'refused',
        answer,
        sentText: await this.send(message, answer),
        moderation: verdict,
        modelCalled: false,
      }
    }

    if (!sheet) return this.unavailable(message, nowUnix)

    // Cheap pre-screen so a refusal never costs a model call.
    const inbound = classifyRefusal(message.text, 'input')
    if (inbound.refused) {
      const ref = makeRefusalRef(this.options.vault, message.text, nowUnix)
      const answer: DeskAnswer = {
        kind: 'refusal',
        body: refusalBody(detectLanguage(message.text), ref),
        citations: [],
        language: detectLanguage(message.text),
        refusalClasses: inbound.classes,
        modelAuthored: false,
      }
      this.logRefusal(message, answer, ref, nowUnix, 'input', inbound.matches.map((m) => m.ruleId))
      return {
        action: 'refused',
        answer,
        sentText: await this.send(message, answer),
        moderation: verdict,
        modelCalled: false,
      }
    }

    if (handleOptions.allowModel === false || !this.modelBudgetAvailable(message.authorId, nowUnix)) {
      const answer = handleT0Command('help', this.context(sheet, message, nowUnix))
      return {
        action: 'budget_exhausted',
        answer,
        sentText: await this.send(message, answer),
        moderation: verdict,
        modelCalled: false,
      }
    }

    const ref = makeRefusalRef(this.options.vault, message.text, nowUnix)
    const ctx = this.context(sheet, message, nowUnix)
    const attempt = await this.options.desk.answer(message.text, ctx, ref)
    if (attempt.modelCalled) this.noteModelCall(message.authorId, nowUnix)

    if (attempt.answer.kind === 'refusal') {
      this.logRefusal(
        message,
        attempt.answer,
        ref,
        nowUnix,
        attempt.screen.trippedOn,
        attempt.screen.matches.map((m) => m.ruleId),
      )
      return {
        action: 'refused',
        answer: attempt.answer,
        sentText: await this.send(message, attempt.answer),
        moderation: verdict,
        attempt,
        modelCalled: attempt.modelCalled,
      }
    }

    return {
      action: 'model',
      answer: attempt.answer,
      sentText: await this.send(message, attempt.answer),
      moderation: verdict,
      attempt,
      modelCalled: attempt.modelCalled,
    }
  }
}
