import { REFUSAL_CLASSES } from '../protocol.js'
import type { RefusalClass } from '../protocol.js'
import { sanitizeUntrusted } from '../corpus/sanitize.js'

/**
 * Fail-closed output classifier for the refusal classes.
 *
 * Phase 0 promoted these from a prompt instruction to a classifier because the
 * Finance High-Risk clause attaches a qualified-professional-review requirement
 * to advice and recommendations, and an autonomous desk cannot satisfy it. A
 * prompt line asking a model not to give investment advice is not a control; it
 * is a preference that fails silently under pressure from a persistent asker.
 *
 * The classifier runs on the QUESTION and on the ANSWER. Running it on the
 * answer is the part that matters: the model can be talked into an opinion it
 * was told not to hold, but it cannot emit the opinion past this.
 */

const RULES: Array<[RefusalClass, RegExp]> = [
  ['wen_moon', /\bwen\b[^.?!]{0,20}\b(?:moon|lambo|pump|listing)\b/iu],
  ['wen_moon', /\bto the moon\b/iu],
  ['price_prediction', /\bprice\s+(?:target|prediction|forecast|projection)\b/iu],
  ['price_prediction', /\b(?:will|would|could|should)\s+(?:it|this|the (?:price|token|coin))\b[^.?!]{0,30}\b(?:hit|reach|go|rise|climb|moon|pump|dump|drop|fall)\b/iu],
  ['price_prediction', /\bexpect(?:ed|ing)?\b[^.?!]{0,20}\bprice\b/iu],
  ['buy_sell_advice', /\bshould\s+(?:i|we|you)\b[^.?!]{0,30}\b(?:buy|sell|ape|hold|dump|exit|enter|invest)\b/iu],
  ['buy_sell_advice', /\b(?:good|bad|right|wrong)\s+(?:time\s+to\s+)?(?:buy|sell|entry|exit)\b/iu],
  ['buy_sell_advice', /\b(?:i|we)\s+recommend\b[^.?!]{0,20}\b(?:buy|sell|hold|invest)\b/iu],
  ['future_value_implication', /\b\d+\s*x\b/iu],
  ['future_value_implication', /\bguaranteed\b[^.?!]{0,20}\b(?:returns?|gains?|profit)\b/iu],
  ['future_value_implication', /\b(?:next|guaranteed|sure)\s+(?:100x|1000x|bitcoin|doge)\b/iu],
  ['user_financial_situation', /\bmy\s+(?:life\s+savings|rent|mortgage|salary|portfolio|bags)\b/iu],
  ['user_financial_situation', /\bi\s+(?:borrowed|took\s+a\s+loan|remortgaged|maxed\s+out)\b/iu],
  ['comparative_investment_merit', /\bbetter\s+(?:investment|buy|bet|play)\s+than\b/iu],
  ['comparative_investment_merit', /\bwhich\s+(?:one\s+)?(?:should\s+i|is\s+better)\b[^.?!]{0,30}\b(?:buy|invest|hold)\b/iu],
]

export interface RefusalVerdict {
  refuse: boolean
  classes: RefusalClass[]
  /** Where the hit was found. Both are checked; a hit in either refuses. */
  source: 'question' | 'answer' | 'both' | 'none'
}

function classesIn(text: string): RefusalClass[] {
  const normalised = sanitizeUntrusted(text, Math.max(text.length * 4, 1))
  const hits = new Set<RefusalClass>()
  for (const [cls, pattern] of RULES) {
    if (pattern.test(normalised)) hits.add(cls)
  }
  // Preserve the declared order so the reported class is stable.
  return REFUSAL_CLASSES.filter((c) => hits.has(c))
}

export function classifyRefusal(question: string, answer: string): RefusalVerdict {
  const inQuestion = classesIn(question)
  const inAnswer = classesIn(answer)
  const all = REFUSAL_CLASSES.filter((c) => inQuestion.includes(c) || inAnswer.includes(c))
  if (all.length === 0) return { refuse: false, classes: [], source: 'none' }
  const source =
    inQuestion.length > 0 && inAnswer.length > 0
      ? 'both'
      : inQuestion.length > 0
        ? 'question'
        : 'answer'
  return { refuse: true, classes: all, source }
}

/** The only thing the desk says when a refusal class fires. Fixed text, no model. */
export const REFUSAL_TEXT =
  'I am an operations desk and cannot discuss price, returns, or whether to buy or sell. ' +
  'I can help with how the token works, where published information lives, and reporting scams.'
