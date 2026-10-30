import { AirlockViolation, assertNoDestination } from '@fee-split-vaults/core'
import { MODEL } from '../model/ids.js'
import type { ModelClient, ModelRequest, ModelUsage } from '../model/client.js'
import { sanitizeUntrusted } from '../corpus/sanitize.js'
import { DESK_SYSTEM_PROMPT } from './prompts.js'
import { REFUSAL_TEXT, classifyRefusal } from './refusal.js'
import type { RefusalClass } from '../protocol.js'

/**
 * The T1 desk.
 *
 * Same plane as the reader: it consumes a stranger's question and holds no
 * tools. The two things that make it safe to reply at all:
 *
 *   1. A fail-closed output classifier. The model's answer is discarded and
 *      replaced with fixed refusal text whenever a refusal class fires, so an
 *      asker who talks the model into an opinion still does not receive one.
 *   2. Placeholder substitution. The model never writes an address, a URL, or a
 *      handle; it writes a token like {{CONTRACT_ADDRESS}} and trusted code
 *      substitutes the value from its own records. A model that hallucinates an
 *      address produces a rejected answer, not a drained holder.
 */

export const DESK_MAX_TOKENS = 384
export const MAX_QUESTION_CHARS = 400
export const MAX_ANSWER_CHARS = 600

/** The closed set of values trusted code will substitute. */
export type DeskPlaceholder =
  | 'CONTRACT_ADDRESS'
  | 'TICKER'
  | 'CHAIN'
  | 'OFFICIAL_SITE'
  | 'OFFICIAL_TELEGRAM'
  | 'SUPPORT_CONTACT'

export type DeskFacts = Partial<Record<DeskPlaceholder, string>>

export interface DeskAnswer {
  text: string
  refused: boolean
  refusalClasses: RefusalClass[]
  /** Placeholders the model used that trusted code had no value for. */
  unresolvedPlaceholders: DeskPlaceholder[]
  usage: ModelUsage
}

export class Desk {
  constructor(private readonly model: ModelClient) {}

  buildRequest(question: string, facts: DeskFacts, userIdHash: string): ModelRequest {
    const cleaned = sanitizeUntrusted(question, MAX_QUESTION_CHARS)
    if (cleaned.length === 0) throw new Error('desk: empty question')
    const available = (Object.keys(facts) as DeskPlaceholder[]).filter(
      (k) => (facts[k] ?? '').length > 0,
    )
    return {
      model: MODEL.haiku45,
      system: [{ text: DESK_SYSTEM_PROMPT, cacheBreakpoint: true }],
      userText: [
        'Placeholders you may write, exactly as shown:',
        available.length > 0
          ? available.map((k) => `  {{${k}}}`).join('\n')
          : '  (none available - do not write any placeholder)',
        '',
        '<<<UNTRUSTED_QUESTION',
        cleaned,
        'UNTRUSTED_QUESTION',
      ].join('\n'),
      maxTokens: DESK_MAX_TOKENS,
      userIdHash,
      // No tools. No effort (Haiku 4.5 rejects output_config). No thinking.
    }
  }

  async answer(question: string, facts: DeskFacts, userIdHash: string): Promise<DeskAnswer> {
    const request = this.buildRequest(question, facts, userIdHash)
    if (request.tools !== undefined) throw new AirlockViolation('desk request carries tools', 'tools')

    const response = await this.model.complete(request)
    const raw = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()

    const verdict = classifyRefusal(question, raw)
    if (verdict.refuse || raw.length === 0) {
      return {
        text: REFUSAL_TEXT,
        refused: true,
        refusalClasses: verdict.classes,
        unresolvedPlaceholders: [],
        usage: response.usage,
      }
    }

    const rendered = renderDeskAnswer(raw, facts)
    return {
      text: rendered.text,
      refused: false,
      refusalClasses: [],
      unresolvedPlaceholders: rendered.unresolved,
      usage: response.usage,
    }
  }
}

const PLACEHOLDER_PATTERN = /\{\{([A-Z_]{1,40})\}\}/gu

export interface RenderedDeskAnswer {
  text: string
  unresolved: DeskPlaceholder[]
}

/**
 * Substitute placeholders, then assert the result carries nothing the model
 * could have authored. An address that appears in the output without having come
 * from `facts` means the model wrote one, and that answer is discarded.
 */
export function renderDeskAnswer(answer: string, facts: DeskFacts): RenderedDeskAnswer {
  const body = sanitizeUntrusted(answer, MAX_ANSWER_CHARS)

  // Check BEFORE substitution: after substitution the trusted values legitimately
  // contain addresses and URLs, so this is the only moment the assertion is
  // meaningful. The placeholders themselves are masked out first - they are a
  // closed vocabulary matched by PLACEHOLDER_PATTERN, and `{{CONTRACT_ADDRESS}}`
  // is an underscored identifier that the (correct) contact-handle rule would
  // otherwise read as a handle. Masking a closed set is not a hole; excusing an
  // arbitrary underscored token would be.
  assertNoDestination(body.replace(PLACEHOLDER_PATTERN, ' '), 'deskAnswer')

  const unresolved: DeskPlaceholder[] = []
  const text = body.replace(PLACEHOLDER_PATTERN, (_match, name: string) => {
    const key = name as DeskPlaceholder
    const value = facts[key]
    if (value === undefined || value.length === 0) {
      if (!unresolved.includes(key)) unresolved.push(key)
      return '[not available here]'
    }
    return value
  })

  return { text, unresolved }
}
