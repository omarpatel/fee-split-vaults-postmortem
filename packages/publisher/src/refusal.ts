import { REFUSAL_CLASSES, type RefusalClass } from '../../../config/protocol.js'
import { normalizeVisibleText } from './text.js'

/**
 * OUTBOUND REFUSAL CLASSIFIER.
 *
 * Phase 0 promoted this from a prompt instruction to a fail-closed output
 * classifier: the Anthropic Finance High-Risk clause attaches a
 * qualified-professional-review requirement to advice and recommendations, and
 * an autonomous desk cannot satisfy it. So the desk answers operational facts
 * only - what the contract address is, what the fee is, when a listing went
 * live - and never emits advice, recommendation, or future-value language.
 *
 * It runs on OUTBOUND text, not inbound. Inbound is the airlock's problem and a
 * question containing "wen moon" is not itself a violation; answering it is.
 *
 * Every rule is a regex over normalized text. No model call: a classifier that
 * can be talked out of its verdict is not a control.
 */

export interface RefusalRule {
  id: string
  class: RefusalClass
  pattern: RegExp
}

export interface RefusalMatch {
  class: RefusalClass
  ruleId: string
  excerpt: string
}

export interface RefusalScan {
  refused: boolean
  matches: RefusalMatch[]
  classes: RefusalClass[]
  /** Set when the scan refused for a reason other than a content match. */
  reason?: string
}

/**
 * Operational phrasings that would otherwise trip a rule. Replaced with a
 * placeholder before matching, so "how to buy" reads as operational while
 * "buy now" still reads as advice.
 */
const NEUTRALIZERS: readonly RegExp[] = [
  /\bhow\s+(?:do\s+i\s+|to\s+|can\s+i\s+)?buy\b/gi,
  /\bwhere\s+(?:do\s+i\s+|to\s+|can\s+i\s+)?buy\b/gi,
  /\bbuy\s*\/\s*sell\s+tax\b/gi,
  /\b(?:buy|sell)(?:ing)?\s+tax\b/gi,
  /\bbuy[-\s]?back(?:s)?\b/gi,
  /\bbuyer(?:s)?\b/gi,
  /\bbuy\s+button\b/gi,
  /\bunique\s+buy(?:s|ers)?\b/gi,
]

const PLACEHOLDER = '§'

function neutralize(text: string): string {
  let out = text
  for (const pattern of NEUTRALIZERS) {
    out = out.replace(pattern, (match) => PLACEHOLDER.repeat(Math.max(1, match.length)))
  }
  return out
}

export const REFUSAL_RULES: Readonly<Record<RefusalClass, readonly RefusalRule[]>> = {
  price_prediction: [
    { id: 'pp.target', class: 'price_prediction', pattern: /\bprice\s+(?:target|prediction|forecast)\b/i },
    {
      id: 'pp.will_reach',
      class: 'price_prediction',
      pattern:
        /\b(?:will|gonna|going\s+to|should|could|expect(?:ed|ing)?|set\s+to)\s+(?:hit|reach|touch|break|top|climb|run|go)\b/i,
    },
    { id: 'pp.numeric_target', class: 'price_prediction', pattern: /\b(?:target|tp)\s*[:=]?\s*\$?\d/i },
    { id: 'pp.mcap_target', class: 'price_prediction', pattern: /\bmarket\s?cap\s+(?:target|will|to\s+\$?\d)/i },
    { id: 'pp.fair_value', class: 'price_prediction', pattern: /\bfair\s+value\b/i },
  ],
  buy_sell_advice: [
    {
      id: 'bs.imperative',
      class: 'buy_sell_advice',
      pattern: /(?:^|[.!?\n]\s*)(?:buy|sell|ape|accumulate|scoop|grab|long|short)\b/i,
    },
    {
      id: 'bs.cta',
      class: 'buy_sell_advice',
      pattern:
        /\b(?:buy|sell|ape|accumulate|scoop|grab|load\s+up|get\s+in|dca)\b[^.\n]{0,24}\b(?:now|today|here|early|before|dip|fast|quick|asap|in)\b/i,
    },
    { id: 'bs.fomo', class: 'buy_sell_advice', pattern: /\b(?:don'?t|do\s+not)\s+(?:miss|sleep|wait)\b/i },
    { id: 'bs.last_chance', class: 'buy_sell_advice', pattern: /\b(?:last\s+chance|not\s+too\s+late|final\s+call)\b/i },
    { id: 'bs.hold', class: 'buy_sell_advice', pattern: /\b(?:hodl|diamond\s+hands|paper\s+hands|keep\s+holding)\b/i },
    {
      id: 'bs.should',
      class: 'buy_sell_advice',
      pattern: /\b(?:should|shouldn'?t)\s+(?:you|i|we|they)\s+(?:buy|sell|hold)\b/i,
    },
  ],
  future_value_implication: [
    { id: 'fv.moon', class: 'future_value_implication', pattern: /\b(?:moon(?:ing|shot)?|lambo)\b/i },
    { id: 'fv.multiple', class: 'future_value_implication', pattern: /\b\d{1,4}\s?x\b/i },
    {
      id: 'fv.wealth',
      class: 'future_value_implication',
      pattern: /\b(?:gains|profits?|get\s+rich|life[-\s]changing|generational\s+wealth)\b/i,
    },
    { id: 'fv.guarantee', class: 'future_value_implication', pattern: /\bguarantee(?:d|s)?\b/i },
    {
      id: 'fv.valuation',
      class: 'future_value_implication',
      pattern: /\b(?:undervalued|underpriced|overvalued|still\s+cheap|bottom\s+is\s+in|floor\s+is)\b/i,
    },
    {
      id: 'fv.upside',
      class: 'future_value_implication',
      pattern: /\b(?:massive|huge|insane)\s+(?:upside|potential|run|move)\b/i,
    },
    { id: 'fv.next_big', class: 'future_value_implication', pattern: /\bnext\s+(?:big|major|100x|1000x)\b/i },
    { id: 'fv.still_early', class: 'future_value_implication', pattern: /\b(?:still\s+early|early\s+is\s+an\s+understatement)\b/i },
  ],
  user_financial_situation: [
    {
      id: 'ufs.your_money',
      class: 'user_financial_situation',
      pattern: /\byour\s+(?:portfolio|bag(?:s)?|position|money|savings|capital|investment|stack)\b/i,
    },
    { id: 'ufs.how_much', class: 'user_financial_situation', pattern: /\bhow\s+much\s+(?:should|can|do|would)\s+(?:i|you|we)\b/i },
    { id: 'ufs.allocate', class: 'user_financial_situation', pattern: /\b(?:invest|allocate|put)\s+(?:your|my)\b/i },
    { id: 'ufs.afford', class: 'user_financial_situation', pattern: /\bcan(?:'?t|not)?\s+afford\s+to\b/i },
  ],
  wen_moon: [
    { id: 'wm.wen', class: 'wen_moon', pattern: /\bwen\s+(?:moon|lambo|pump|listing|cex)\b/i },
    { id: 'wm.when', class: 'wen_moon', pattern: /\bwhen\s+(?:moon|lambo)\b/i },
    { id: 'wm.pump_soon', class: 'wen_moon', pattern: /\bpump(?:ing)?\s+(?:soon|any\s+(?:minute|day))\b/i },
  ],
  comparative_investment_merit: [
    {
      id: 'cim.better_than',
      class: 'comparative_investment_merit',
      pattern: /\b(?:better|worse|stronger|safer|smarter)\s+(?:investment|buy|play|bet|entry)\s+than\b/i,
    },
    {
      id: 'cim.outperform',
      class: 'comparative_investment_merit',
      pattern: /\b(?:outperform(?:s|ing)?|outpace(?:s|d)?|beat(?:s|ing)?)\s+\$?[A-Za-z]/i,
    },
    { id: 'cim.versus', class: 'comparative_investment_merit', pattern: /\b(?:vs\.?|versus|compared\s+to)\s+\$[A-Za-z]/i },
    {
      id: 'cim.superlative',
      class: 'comparative_investment_merit',
      pattern: /\b(?:best|top|number\s+one|#1)\s+(?:coin|token|play|investment|bet|opportunity)\b/i,
    },
  ],
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 24)
  const end = Math.min(text.length, index + length + 24)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
}

/**
 * Injectable form. `classes` is passed in so a drifted REFUSAL_CLASSES - a class
 * added to config with no matcher here - can be detected and refused rather than
 * silently unenforced.
 */
export function scanForRefusalsWith(
  text: string,
  rules: Readonly<Partial<Record<RefusalClass, readonly RefusalRule[]>>>,
  classes: readonly RefusalClass[],
): RefusalScan {
  const uncovered = classes.filter((cls) => (rules[cls]?.length ?? 0) === 0)
  if (uncovered.length > 0) {
    return {
      refused: true,
      matches: [],
      classes: [...uncovered],
      reason: `unmapped_refusal_class:${uncovered.join(',')}`,
    }
  }

  const normalized = normalizeVisibleText(text)
  const haystack = neutralize(normalized)
  const matches: RefusalMatch[] = []

  for (const cls of classes) {
    for (const rule of rules[cls] ?? []) {
      const found = rule.pattern.exec(haystack)
      if (found) {
        matches.push({
          class: cls,
          ruleId: rule.id,
          excerpt: excerptAround(normalized, found.index, found[0].length),
        })
      }
    }
  }

  return {
    refused: matches.length > 0,
    matches,
    classes: [...new Set(matches.map((m) => m.class))],
  }
}

export function scanForRefusals(text: string): RefusalScan {
  return scanForRefusalsWith(text, REFUSAL_RULES, REFUSAL_CLASSES)
}
