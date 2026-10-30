/**
 * Outbound rendering.
 *
 * Disclosure is injected HERE, by code, on the way out. Any disclosure-shaped
 * string the model wrote is stripped first and the canonical one is appended, so
 * a model cannot weaken, translate, or omit it, and cannot double it either.
 *
 * Truncation eats the BODY. The disclosure is reserved out of the budget before
 * the body is measured, so the failure mode of a long answer is a shorter answer
 * rather than an undisclosed one.
 */

import { requireOperatorName } from '@fee-split-vaults/core'
import { DISCLOSURE, type RefusalClass } from '../../../config/protocol.js'
import type { Citation } from './factsheet/builder.js'
import type { RefusalCode } from './refusal/templates.js'
import type { LanguageCode } from './text/normalize.js'

export type DeskAnswerKind =
  | 'fact'
  | 'unknown_field'
  | 'refusal'
  | 'moderation'
  | 'help'
  | 'escalated'
  | 'unavailable'

export interface DeskAnswer {
  kind: DeskAnswerKind
  body: string
  /** Every figure in a 'fact' answer must be backed by one of these. */
  citations: Citation[]
  language: LanguageCode
  refusalClasses?: RefusalClass[]
  /** Set on a 'refusal' the classifier did not produce, e.g. the language gate. */
  refusalCode?: RefusalCode
  /** True when a model produced the body. Drives disclosure and audit. */
  modelAuthored: boolean
}

export class DeskConfigError extends Error {
  constructor(message: string) {
    super(`desk config: ${message}`)
    this.name = 'DeskConfigError'
  }
}

export interface OutboundOptions {
  /** Legal name of the operating entity. Never a model's idea of the name. */
  operatorName: string
  /** Set by a rule engine, never by the model. */
  promotional?: boolean
  /** Telegram's hard limit is 4096. */
  maxChars?: number
  /** Citations are appended for fact answers; suppress for terse channels. */
  includeCitations?: boolean
}

/**
 * Disclosure-shaped fragments a model might emit on its own. Stripped before
 * the canonical footer is appended, so the reader sees exactly one.
 */
const MODEL_AUTHORED_DISCLOSURE = [
  /\(?\s*#ad\s*\)?/gi,
  /\(?\s*#sponsored\s*\)?/gi,
  /\(?\s*ai[- ]operated\s*\)?/gi,
  /\(?\s*ai[- ]generated\s*\)?/gi,
  /\(?\s*(?:this is an?|i am an?)\s+(?:ai|bot|automated)\b[^.\n]*\.?/gi,
  /\(?\s*automated\s+(?:message|reply|response)\s*\)?/gi,
  /\(?\s*paid\s+promotion\s*\)?/gi,
  /\(?\s*not\s+financial\s+advice\s*\)?/gi,
  /\bnfa\b/gi,
  /\bdyor\b/gi,
]

export function stripModelDisclosure(body: string): string {
  let out = body
  for (const pattern of MODEL_AUTHORED_DISCLOSURE) out = out.replace(pattern, ' ')
  return out.replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n').trim()
}

/** The canonical footer. One shape, one place, never model-authored. */
export function disclosureFooter(options: OutboundOptions): string {
  // Single-sourced from @fee-split-vaults/core. This used to be
  // `options.operatorName === DISCLOSURE.operatorName`, which let 'TBD',
  // 'TODO' and 'CHANGEME' publish, and which would have refused the operator's
  // REAL name the moment config/protocol.ts was filled in. See
  // packages/core/src/disclosure.ts.
  const operatorName = requireOperatorName(
    options.operatorName,
    (message) => new DeskConfigError(`${message} Refusing to emit an undisclosed message (fail closed).`),
  )
  const tags: string[] = [DISCLOSURE.aiOperationTag]
  if (options.promotional) tags.unshift(DISCLOSURE.paidPromotionTag)
  return `${tags.join(' ')} - ${operatorName}`
}

export function renderCitations(citations: Citation[], limit = 3): string {
  if (citations.length === 0) return ''
  const lines: string[] = []
  for (const citation of citations.slice(0, limit)) {
    const block = citation.blockHash ? ` @ ${citation.blockHash.slice(0, 10)}` : ''
    const age = citation.ageSeconds < 60 ? `${citation.ageSeconds}s` : `${Math.floor(citation.ageSeconds / 60)}m`
    const link = citation.verifyUrl ? ` ${citation.verifyUrl}` : ''
    lines.push(`- ${citation.field}: ${citation.source}${block}, read ${age} ago.${link}`)
  }
  if (citations.length > limit) lines.push(`- (+${citations.length - limit} more)`)
  return 'Source:\n' + lines.join('\n')
}

/**
 * Assemble the wire message. Order is fixed: body, citations, disclosure.
 * The disclosure and the citation block are reserved out of the character
 * budget BEFORE the body is measured.
 */
export function renderOutbound(answer: DeskAnswer, options: OutboundOptions): string {
  const maxChars = options.maxChars ?? 4_096
  const footer = disclosureFooter(options)
  const includeCitations = options.includeCitations ?? answer.kind === 'fact'
  const citations = includeCitations ? renderCitations(answer.citations) : ''

  const body = answer.modelAuthored ? stripModelDisclosure(answer.body) : answer.body.trim()

  const reserved = footer.length + (citations.length > 0 ? citations.length + 2 : 0) + 2
  const budget = maxChars - reserved

  if (budget <= 0) {
    // Nothing can be said within the limit without dropping disclosure. Say the
    // disclosure and nothing else rather than the reverse.
    return footer.slice(0, maxChars)
  }

  const trimmedBody = body.length > budget ? body.slice(0, Math.max(0, budget - 1)).trimEnd() + '…' : body

  return [trimmedBody, citations, footer].filter((part) => part.length > 0).join('\n\n')
}

export function factAnswer(
  body: string,
  citations: Citation[],
  language: LanguageCode,
  modelAuthored = false,
): DeskAnswer {
  return { kind: 'fact', body, citations, language, modelAuthored }
}
