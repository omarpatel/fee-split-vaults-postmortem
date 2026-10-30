/**
 * T1: the natural-language desk.
 *
 * The pipeline, in order, and every step can only make the answer safer:
 *
 *   question -> input refusal screen -> fresh facts only -> model -> parse
 *            -> citation resolution -> grounding check -> output refusal screen
 *            -> disclosure injection
 *
 * The model sits in the middle with no tools, no raw numbers, and no access to
 * a field the desk has not verified. Everything before it decides what it may
 * see; everything after it decides whether what it wrote may be sent. A
 * jailbreak that fully owns the model still has to produce text that passes two
 * code gates it cannot reach.
 *
 * Every failure - a timeout, a malformed reply, an ungrounded figure, a
 * refusal-class match - lands on the same honest fallback: I have not verified
 * that, here is how to check it yourself.
 */

import type { DeskAnswer } from '../answer.js'
import { usableFacts, type FactSheet } from '../factsheet/builder.js'
import { FACT_LABELS } from '../factsheet/fields.js'
import { formatDuration } from '../factsheet/render.js'
import type { FieldAnswerContext } from '../field-answer.js'
import { screenExchange, type ExchangeScreen } from '../refusal/classifier.js'
import { noVerifiedAnswerBody, refusalBody } from '../refusal/templates.js'
import { groundAnswer, type GroundingResult } from './grounding.js'
import type { DeskModel, DeskModelRequest, GroundingFact } from './model.js'

export type DeskFailure =
  | 'refused'
  | 'no_facts'
  | 'model_error'
  | 'model_timeout'
  | 'cannot_answer'
  | 'ungrounded'

export interface DeskAttempt {
  answer: DeskAnswer
  screen: ExchangeScreen
  grounding?: GroundingResult
  modelCalled: boolean
  failure?: DeskFailure
  /** The raw model text, for the audit log only. Never sent anywhere. */
  candidate?: string
}

export interface HaikuDeskOptions {
  model: DeskModel
  /** Inbound questions are truncated to bound cost. */
  maxQuestionChars?: number
  timeoutMs?: number
  /** Hosts the answer may link to, beyond the explorer. */
  allowedHosts?: string[]
  /** Injected for tests; defaults to a real timer race. */
  now?: () => number
}

/** Strip control characters and cap length before anything reads the question. */
export function sanitizeQuestion(raw: string, maxChars: number): string {
  let out = ''
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp < 0x20 && cp !== 0x0a && cp !== 0x09) continue
    if (cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) continue
    out += ch
    if (out.length >= maxChars) break
  }
  return out.replace(/\s+/g, ' ').trim()
}

export function buildGroundingFacts(sheet: FactSheet, nowUnix: number): GroundingFact[] {
  return usableFacts(sheet, nowUnix).map((fact) => ({
    field: fact.field,
    label: FACT_LABELS[fact.field],
    display: fact.display,
    sourceNote: `${fact.provenance.source}, read ${formatDuration(
      Math.max(0, nowUnix - fact.provenance.observedAtUnix),
    )} ago`,
  }))
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('desk model timed out')), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class HaikuDesk {
  private readonly maxQuestionChars: number
  private readonly timeoutMs: number

  constructor(private readonly options: HaikuDeskOptions) {
    this.maxQuestionChars = options.maxQuestionChars ?? 512
    this.timeoutMs = options.timeoutMs ?? 8_000
  }

  private refusal(ctx: FieldAnswerContext, screen: ExchangeScreen, ref: string): DeskAttempt {
    return {
      answer: {
        kind: 'refusal',
        body: refusalBody(ctx.language, ref),
        citations: [],
        language: ctx.language,
        refusalClasses: screen.classes,
        modelAuthored: false,
      },
      screen,
      modelCalled: false,
      failure: 'refused',
    }
  }

  private noAnswer(ctx: FieldAnswerContext, failure: DeskFailure, screen: ExchangeScreen): DeskAttempt {
    return {
      answer: {
        kind: 'unknown_field',
        body: noVerifiedAnswerBody(ctx.language),
        citations: [],
        language: ctx.language,
        modelAuthored: false,
      },
      screen,
      modelCalled: failure !== 'no_facts',
      failure,
    }
  }

  /**
   * Answer one question. `refusalRef` is supplied by the caller so the same id
   * appears in the reply and in the refusal log.
   */
  async answer(question: string, ctx: FieldAnswerContext, refusalRef: string): Promise<DeskAttempt> {
    const clean = sanitizeQuestion(question, this.maxQuestionChars)

    // Input side first: an advice question is not worth a model call.
    const inputScreen = screenExchange(clean, '')
    if (inputScreen.refused) return this.refusal(ctx, inputScreen, refusalRef)

    const facts = buildGroundingFacts(ctx.sheet, ctx.nowUnix)
    if (facts.length === 0) {
      return this.noAnswer(ctx, 'no_facts', inputScreen)
    }

    const request: DeskModelRequest = {
      question: clean,
      language: ctx.language,
      facts,
      tokenSymbol: ctx.sheet.facts.token_symbol?.display,
    }

    let reply
    try {
      reply = await withTimeout(this.options.model.answer(request), this.timeoutMs)
    } catch (error) {
      const failure: DeskFailure =
        error instanceof Error && error.message.includes('timed out') ? 'model_timeout' : 'model_error'
      return this.noAnswer(ctx, failure, inputScreen)
    }

    if (reply.cannotAnswer || reply.answer.trim().length === 0) {
      return this.noAnswer(ctx, 'cannot_answer', inputScreen)
    }

    // Output side. Screened before grounding so an advice-shaped answer is
    // recorded as a refusal rather than as a grounding failure.
    const screen = screenExchange(clean, reply.answer)
    if (screen.refused) {
      const refused = this.refusal(ctx, screen, refusalRef)
      return { ...refused, modelCalled: true, candidate: reply.answer }
    }

    const grounding = groundAnswer(reply.answer, {
      sheet: ctx.sheet,
      nowUnix: ctx.nowUnix,
      citedFields: reply.citedFields,
      allowedHosts: this.options.allowedHosts,
    })

    if (!grounding.ok) {
      return {
        ...this.noAnswer(ctx, 'ungrounded', screen),
        grounding,
        candidate: reply.answer,
      }
    }

    return {
      answer: {
        kind: 'fact',
        body: reply.answer,
        citations: grounding.citations,
        language: ctx.language,
        modelAuthored: true,
      },
      screen,
      grounding,
      modelCalled: true,
      candidate: reply.answer,
    }
  }
}
