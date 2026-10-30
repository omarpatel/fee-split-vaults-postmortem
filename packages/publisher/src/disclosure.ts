import { DISCLOSURE } from '../../../config/protocol.js'
import { containsToken, normalizeVisibleText, truncateToBudget, type Measure } from './text.js'
import type { Rejection } from './types.js'

/**
 * DISCLOSURE IS CODE-OWNED.
 *
 * FTC Endorsement Guides and Securities Act 17(b) both require the disclosure to
 * be IN the communication. EU AI Act Art. 50 and CA SB 1001 require the machine
 * operator to be identified in it. A receipts ledger on a separate page cures
 * neither, so the canonical block below is appended to the VISIBLE BODY of every
 * emission and is never sourced from a model.
 *
 * Two rules follow and are enforced here rather than in a prompt:
 *   1. Any disclosure-shaped string the model authored is STRIPPED, then the
 *      canonical block is re-added. A model-authored tag is unverifiable and, in
 *      the worst case, attacker-controlled.
 *   2. Truncation eats the BODY. The disclosure is reserved out of the channel
 *      budget before the body is measured, so it can never be the part that is
 *      cut off.
 */

export const DISCLOSURE_SEPARATOR = '\n\n'
const FIELD_SEPARATOR = ' · '

export interface DisclosureSpec {
  operatorName: string
  receiptUrl: string
  /** Adds the paid-promotion tag. Set by the rule engine, never by a model. */
  paidPromotion: boolean
}

/** The canonical block. The only disclosure string this system ever publishes. */
export function renderDisclosure(spec: DisclosureSpec): string {
  const fields = [
    `${DISCLOSURE.aiOperationTag} by ${spec.operatorName}`,
    `receipts: ${spec.receiptUrl}`,
  ]
  if (spec.paidPromotion) fields.unshift(DISCLOSURE.paidPromotionTag)
  return fields.join(FIELD_SEPARATOR)
}

/**
 * The substrings that must still be present when the post is re-fetched.
 *
 * Read-back checks tokens rather than the whole rendered block: platforms
 * linkify, re-wrap and re-encode text, and a whole-string comparison would
 * false-positive on that while a token check still catches a removed tag.
 */
export function disclosureTokens(spec: DisclosureSpec): string[] {
  const tokens = [DISCLOSURE.aiOperationTag, spec.operatorName, spec.receiptUrl]
  if (spec.paidPromotion) tokens.unshift(DISCLOSURE.paidPromotionTag)
  return tokens
}

/**
 * Disclosure-shaped strings a model might author. Deliberately over-broad: a
 * false strip costs a few words of copy, a missed strip publishes an
 * unverifiable claim about who is speaking and who paid for it.
 */
const AUTHORED_DISCLOSURE_PATTERNS: readonly RegExp[] = [
  /#(?:ad|ads|advert|advertisement|advertising|sponsored|sponsor|paid|paidpromo(?:tion)?|promo(?:tion)?|promoted|partner(?:ed|ship)?|collab|aioperated|aigenerated|bot)\b/gi,
  /\bpaid[ -]?(?:promotion|partnership|post|placement|content|advertisement|ad)\b/gi,
  /\bsponsored\s+(?:by|post|content|tweet|message|thread)\b/gi,
  /\bthis\s+(?:is|post\s+is|message\s+is|thread\s+is)\s+(?:an?\s+)?(?:ad|advert(?:isement)?|paid\s+\w+|sponsored\s+\w+)\b/gi,
  /\bai[ -]?(?:operated|generated|written|managed|run|powered|assisted)\b/gi,
  /\b(?:operated|written|managed|run|posted|published)\s+by\s+(?:an?\s+)?(?:ai|bot|agent|automation|automated\s+\w+)\b/gi,
  /\b(?:automated|bot)[ -]?(?:account|post|message|agent)\b/gi,
  // Stop at the sentence end, not the line end: a single-line post would
  // otherwise lose everything after the word "disclosure".
  /\bdisclosure\s*:[^.\n]*\.?/gi,
  /\bdisclaimer\s*:[^.\n]*\.?/gi,
  /\breceipts?\s*(?:link|page|ledger)?\s*[:@-]\s*\S+/gi,
  /\bnot\s+financial\s+advice\b/gi,
  /\b(?:nfa|dyor)\b/gi,
]

export interface StripOutcome {
  body: string
  /** Every fragment removed, for the audit log. */
  removed: string[]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Remove every model-authored disclosure claim, including any use of the
 * operator's own name. Run BEFORE the link allowlist: a fake "receipts:" line
 * pointing at an attacker domain should be deleted as a forged disclosure, and
 * only a link the model put in the body on its own merits should be judged by
 * the allowlist.
 */
export function stripAuthoredDisclosure(body: string, operatorName: string): StripOutcome {
  const removed: string[] = []
  const patterns: RegExp[] = [...AUTHORED_DISCLOSURE_PATTERNS]
  if (operatorName.length >= 3) {
    patterns.push(new RegExp(escapeRegExp(operatorName), 'gi'))
  }

  let out = body
  for (const pattern of patterns) {
    out = out.replace(pattern, (match) => {
      removed.push(match.trim())
      return ' '
    })
  }

  out = out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/^[\s·|—\-.,;:!?]+/u, '')
    .replace(/[\s·|—-]+$/u, '')
    .trim()

  return { body: normalizeVisibleText(out), removed }
}

export class DisclosureInvariantError extends Error {
  constructor(message: string) {
    super(`disclosure invariant: ${message}`)
    this.name = 'DisclosureInvariantError'
  }
}

export interface ComposeInput {
  /** Already normalized and already stripped of authored disclosure. */
  body: string
  spec: DisclosureSpec
  measure: Measure
  maxChars: number
}

export type ComposeOutcome =
  | { ok: true; text: string; disclosure: string; bodyTruncated: boolean }
  | { ok: false; rejection: Rejection }

/**
 * Compose body + canonical disclosure within a channel's character budget.
 *
 * The disclosure is measured first and its cost is removed from the budget, so
 * the body is the only thing truncation can reach. If the disclosure alone does
 * not fit the channel, we refuse to publish rather than publish undisclosed.
 */
export function composeDisclosedMessage(input: ComposeInput): ComposeOutcome {
  const disclosure = renderDisclosure(input.spec)
  const overhead = input.measure(DISCLOSURE_SEPARATOR + disclosure)

  if (input.measure(disclosure) > input.maxChars) {
    return {
      ok: false,
      rejection: {
        stage: 'disclosure_budget',
        reason: 'disclosure_exceeds_channel_limit',
        detail: `disclosure needs ${input.measure(disclosure)} of ${input.maxChars} characters`,
      },
    }
  }

  const budget = input.maxChars - overhead
  if (budget <= 0) {
    // The disclosure fits but nothing else does: publish disclosure-only rather
    // than publish a body without it.
    return { ok: true, text: disclosure, disclosure, bodyTruncated: input.body.length > 0 }
  }

  const { text: body, truncated } = truncateToBudget(input.body, input.measure, budget)
  const text = body.length > 0 ? `${body}${DISCLOSURE_SEPARATOR}${disclosure}` : disclosure

  for (const token of disclosureTokens(input.spec)) {
    if (!containsToken(text, token)) {
      throw new DisclosureInvariantError(`token "${token}" missing from composed message`)
    }
  }
  if (input.measure(text) > input.maxChars) {
    throw new DisclosureInvariantError(
      `composed message measures ${input.measure(text)} over limit ${input.maxChars}`,
    )
  }

  return { ok: true, text, disclosure, bodyTruncated: truncated }
}

/** Every required token still present in text fetched back from the platform. */
export function verifyDisclosurePresent(
  publishedText: string,
  spec: DisclosureSpec,
): { ok: boolean; missing: string[] } {
  const missing = disclosureTokens(spec).filter((token) => !containsToken(publishedText, token))
  return { ok: missing.length === 0, missing }
}

/** Receipt link for a vault. Built by code; never accepted from model output. */
export function receiptUrlFor(receiptsBaseUrl: string, vault: string): string {
  return `${receiptsBaseUrl.replace(/\/+$/, '')}/${vault}`
}
