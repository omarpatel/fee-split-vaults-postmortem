import { normalizeVisibleText } from './text.js'

/**
 * PROMOTIONAL vs OPERATIONAL - A RULE ENGINE, NOT A MODEL CALL.
 *
 * The classification decides whether the paid-promotion tag is attached. A model
 * asked "is this promotional?" can be argued out of the answer by the same text
 * it is judging, and its verdict is unauditable after the fact. These rules are
 * fixed, ordered, and every hit is recorded with the post.
 *
 * The default is PROMOTIONAL. Over-disclosing an operational notice costs a few
 * characters; under-disclosing a promotion is an FTC and 17(b) problem. A
 * caller-declared `isPromotional: true` is honoured, a declared `false` is not
 * trusted to override a rule hit.
 */

export type ContentClass = 'promotional' | 'operational'

export interface ClassificationInput {
  body: string
  links?: readonly string[]
  /** PublishRequest.isPromotional. Can only escalate, never downgrade. */
  declaredPromotional?: boolean
  hasImages?: boolean
}

export interface ClassificationRule {
  id: string
  verdict: ContentClass
  test: (input: { text: string; ctx: ClassificationInput }) => boolean
}

const PROMOTIONAL_RULES: readonly ClassificationRule[] = [
  {
    id: 'promo.declared',
    verdict: 'promotional',
    test: ({ ctx }) => ctx.declaredPromotional === true,
  },
  {
    id: 'promo.creative_asset',
    verdict: 'promotional',
    test: ({ ctx }) => (ctx.hasImages ?? false) === true,
  },
  {
    id: 'promo.call_to_action',
    verdict: 'promotional',
    test: ({ text }) =>
      /\b(?:join|follow|retweet|rt\b|like\s+and|share\s+this|tag\s+a\s+friend|check\s+(?:us|it)\s+out|come\s+see|swipe|click|sign\s+up|trade\s+now)\b/i.test(
        text,
      ),
  },
  {
    id: 'promo.campaign_language',
    verdict: 'promotional',
    test: ({ text }) =>
      /\b(?:giveaway|contest|raffle|airdrop|whitelist|competition|campaign|partnership|partnered|collab(?:oration)?|ama|space(?:s)?\s+with|sponsored\s+space)\b/i.test(
        text,
      ),
  },
  {
    id: 'promo.placement',
    verdict: 'promotional',
    test: ({ text }) =>
      /\b(?:trending|boosted|featured|now\s+listed|listing\s+live|front\s+page|banner|billboard|spotlight)\b/i.test(
        text,
      ),
  },
  {
    id: 'promo.hype_register',
    verdict: 'promotional',
    test: ({ text }) =>
      /\b(?:gem|degen|bullish|pumping|explosive|unstoppable|legendary|epic|insane)\b/i.test(
        text,
      ),
  },
  {
    id: 'promo.emoji_hype',
    verdict: 'promotional',
    test: ({ text }) => /[\u{1F680}\u{1F525}\u{1F4C8}\u{1F48E}\u{1F911}]/u.test(text),
  },
]

const OPERATIONAL_RULES: readonly ClassificationRule[] = [
  {
    id: 'ops.contract_fact',
    verdict: 'operational',
    test: ({ text }) => /\b(?:contract\s+address|token\s+address|the\s+address\s+is|ca\s*[:=])/i.test(text),
  },
  {
    id: 'ops.how_to_buy_answer',
    verdict: 'operational',
    test: ({ text }) => /\b(?:how|where)\s+(?:do\s+i\s+|to\s+|can\s+i\s+)?buy\b/i.test(text),
  },
  {
    id: 'ops.incident',
    verdict: 'operational',
    test: ({ text }) =>
      /\b(?:we\s+are\s+aware|known\s+issue|degraded|outage|downtime|maintenance|resolved|status\s+update|postmortem)\b/i.test(
        text,
      ),
  },
  {
    id: 'ops.safety_notice',
    verdict: 'operational',
    test: ({ text }) =>
      /\b(?:scam|phishing|impersonat(?:or|ion)|fake\s+(?:account|token|link)|do\s+not\s+click|beware)\b/i.test(text),
  },
  {
    id: 'ops.moderation',
    verdict: 'operational',
    test: ({ text }) => /\b(?:banned|muted|removed\s+a\s+post|moderation|rules\s+reminder|slow\s+mode)\b/i.test(text),
  },
  {
    id: 'ops.reporting',
    verdict: 'operational',
    test: ({ text }) =>
      /\b(?:weekly\s+report|receipts?\s+(?:for|are)|reconcil(?:ed|iation)|invoice|spend\s+summary|what\s+we\s+did\s+not\s+do)\b/i.test(
        text,
      ),
  },
  {
    id: 'ops.fee_mechanics',
    verdict: 'operational',
    test: ({ text }) =>
      /\b(?:creator\s+fee|fee\s+recipient|buy[-\s]?back|vest(?:ing)?|liquidity\s+lock|pool\s+fee|anti[-\s]?snipe)\b/i.test(
        text,
      ),
  },
]

export interface Classification {
  contentClass: ContentClass
  isPromotional: boolean
  /** Rule ids that fired, in evaluation order. Stored with the post record. */
  matched: string[]
  /** True when nothing matched and the fail-closed default decided it. */
  defaultedToPromotional: boolean
}

export function classifyContent(input: ClassificationInput): Classification {
  const text = normalizeVisibleText(input.body)
  const ctx = { text, ctx: input }

  const promo = PROMOTIONAL_RULES.filter((rule) => rule.test(ctx)).map((rule) => rule.id)
  if (promo.length > 0) {
    return {
      contentClass: 'promotional',
      isPromotional: true,
      matched: promo,
      defaultedToPromotional: false,
    }
  }

  const ops = OPERATIONAL_RULES.filter((rule) => rule.test(ctx)).map((rule) => rule.id)
  if (ops.length > 0) {
    return {
      contentClass: 'operational',
      isPromotional: false,
      matched: ops,
      defaultedToPromotional: false,
    }
  }

  return {
    contentClass: 'promotional',
    isPromotional: true,
    matched: [],
    defaultedToPromotional: true,
  }
}
