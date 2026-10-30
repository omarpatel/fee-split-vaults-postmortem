/**
 * THE REFUSAL CLASSIFIER.
 *
 * Phase 0 promoted refusal from a prompt instruction to a fail-closed OUTPUT
 * classifier. The reason is the Anthropic usage policy's Finance High-Risk
 * clause: advice and recommendations carry a qualified-professional-review
 * requirement, and an autonomous desk answering a public chat cannot satisfy
 * it. So the desk answers operational facts and nothing else.
 *
 * WHY THIS IS AN OUTPUT CLASSIFIER. A prompt rule is a request to a model. This
 * is a gate the model's words have to pass through. Even a completely
 * jailbroken model - one that has been convinced it is a licensed advisor by
 * some clever framing - produces a string, and the string is classified before
 * anyone sees it. The jailbreak has to survive the classifier, not the prompt.
 *
 * WHY REPHRASING DOES NOT HELP. Matching runs over the normalised views from
 * ../text/normalize.js, which collapse zero-width joiners, homoglyphs,
 * leetspeak, letter spacing and character repetition before any pattern is
 * evaluated, in every supported language. Then the input side and the output
 * side are BOTH classified and the results are unioned: rephrasing the question
 * so it slips past the input rules still leaves an answer that has to pass the
 * output rules, and an answer that gives advice looks like advice.
 *
 * FAIL CLOSED. Every path that cannot decide refuses. An empty candidate, an
 * unparseable model reply, a classifier that throws - all refusals.
 *
 * Adding a rule is routine. REMOVING one, or narrowing a view, is a security
 * change: it widens what the desk is willing to say about money.
 */

import { REFUSAL_CLASSES, type RefusalClass } from '../../../../config/protocol.js'
import { foldPattern, normalize, type NormalizedText } from '../text/normalize.js'

export type ClassifierSide = 'input' | 'output'

type View = 'lower' | 'folded' | 'deleet' | 'squeezed'

interface SingleRule {
  id: string
  cls: RefusalClass
  view: View
  pattern: RegExp
  sides?: readonly ClassifierSide[]
}

interface ConjunctionRule {
  id: string
  cls: RefusalClass
  view: View
  /** Every pattern must match somewhere in the view. */
  all: RegExp[]
  sides?: readonly ClassifierSide[]
}

export interface RefusalMatch {
  cls: RefusalClass
  ruleId: string
  /** Short, normalised, already-scrubbed context for the audit log. */
  excerpt: string
}

export interface RefusalDecision {
  refused: boolean
  classes: RefusalClass[]
  matches: RefusalMatch[]
  side: ClassifierSide
}

/**
 * Single-pattern rules.
 *
 * `squeezed` strips every non-alphanumeric, so those patterns are contiguous
 * and immune to "s h o u l d  i  b u y". `lower` keeps the original script and
 * digits, so multilingual and amount-bearing patterns live there.
 */
const RAW_SINGLE_RULES: readonly SingleRule[] = [
  // ---- price_prediction -------------------------------------------------
  { id: 'pp.squeeze.predict', cls: 'price_prediction', view: 'squeezed', pattern: /price(prediction|predict|forecast|target|projection)/ },
  { id: 'pp.squeeze.targetprice', cls: 'price_prediction', view: 'squeezed', pattern: /(target|predicted|projected|expected)price/ },
  { id: 'pp.squeeze.howhigh', cls: 'price_prediction', view: 'squeezed', pattern: /how(high|far|low)(will|can|could|might)/ },
  { id: 'pp.squeeze.willreach', cls: 'price_prediction', view: 'squeezed', pattern: /(will|would|could|gonna|goingto)(it|this|we|you)?(hit|reach|touch|get to|getto|breakto)/ },
  { id: 'pp.squeeze.whatwill', cls: 'price_prediction', view: 'squeezed', pattern: /whatwill(the)?(price|it|this|marketcap|mcap)/ },
  { id: 'pp.squeeze.worthby', cls: 'price_prediction', view: 'squeezed', pattern: /(howmuch|whatwill|whatis|whats).{0,14}worth/ },
  { id: 'pp.squeeze.whenhit', cls: 'price_prediction', view: 'squeezed', pattern: /when(willit|doesit|isit)?(hit|reach|touch)/ },
  { id: 'pp.lower.multilingual', cls: 'price_prediction', view: 'lower', pattern: /(prediccion de precio|precio objetivo|previsao de preco|previsão de preço|prevision du prix|prix cible|preisprognose|kursziel|прогноз цен|целевая цена|价格预测|目标价|価格予想|가격 ?예측|fiyat tahmini)/ },
  { id: 'pp.folded.eom', cls: 'price_prediction', view: 'folded', pattern: /\b(by|before|until)\s+(end of|eoy|q[1-4]|next (week|month|year)|\d{4})\b.{0,30}\b(price|worth|mcap|market cap|value)\b/ },

  // ---- buy_sell_advice --------------------------------------------------
  { id: 'bs.squeeze.shouldi', cls: 'buy_sell_advice', view: 'squeezed', pattern: /(should|shall|must|ought|oughtto)(nt|not)?(i|we|you|he|she|they)(buy|sell|hold|ape|invest|dump|exit|getin|getout|dca|bag|load|swap|stake)/ },
  { id: 'bs.squeeze.wouldyou', cls: 'buy_sell_advice', view: 'squeezed', pattern: /(would|will|do)you(buy|sell|hold|ape|invest|recommend|advise)/ },
  { id: 'bs.squeeze.goodinvest', cls: 'buy_sell_advice', view: 'squeezed', pattern: /(good|bad|safe|smart|solid|wise)(investment|buy|entry|play|bet)/ },
  { id: 'bs.squeeze.worth', cls: 'buy_sell_advice', view: 'squeezed', pattern: /worth(buying|selling|holding|investing|aping|it)/ },
  { id: 'bs.squeeze.timing', cls: 'buy_sell_advice', view: 'squeezed', pattern: /(good|best|right)timeto(buy|sell|enter|exit)/ },
  { id: 'bs.squeeze.entry', cls: 'buy_sell_advice', view: 'squeezed', pattern: /(entry|exit)(point|price|level)/ },
  { id: 'bs.squeeze.ornot', cls: 'buy_sell_advice', view: 'squeezed', pattern: /(buy|sell|hold|ape)or(not|dont|donot|wait|sell|buy|hold)/ },
  { id: 'bs.squeeze.opinion', cls: 'buy_sell_advice', view: 'squeezed', pattern: /(whatdoyouthink|whatsyouropinion|wdyt|yourthoughts|thoughtsonthis)/ },
  { id: 'bs.squeeze.advise', cls: 'buy_sell_advice', view: 'squeezed', pattern: /(giveme|anyone|any|investment|financial|trading|your|some)advice/ },
  { id: 'bs.squeeze.tellmeto', cls: 'buy_sell_advice', view: 'squeezed', pattern: /(tellme|justtellme|convinceme|helpmedecide).{0,12}(buy|sell|invest|ape)/ },
  { id: 'bs.squeeze.advisor', cls: 'buy_sell_advice', view: 'squeezed', pattern: /(financialadvisor|financialadviser|investmentadvisor|investmentadviser|actasafinancial|pretendyouarea?financial)/ },
  { id: 'bs.lower.multilingual', cls: 'buy_sell_advice', view: 'lower', pattern: /(deberia comprar|debería comprar|debo comprar|vale la pena comprar|devo comprar|vale a pena comprar|dois-je acheter|je devrais acheter|soll ich kaufen|lohnt sich der kauf|стоит ли покупать|стоит ли брать|покупать или нет|该买吗|该不该买|要买吗|買うべき|買ったほうが|사야 ?하나|사야 ?될까|almali miyim|alsam mi)/ },

  // ---- future_value_implication ----------------------------------------
  { id: 'fv.lower.multiplier', cls: 'future_value_implication', view: 'lower', pattern: /(?<!0)\b\d{1,6}\s?x\b/ },
  { id: 'fv.squeeze.moon', cls: 'future_value_implication', view: 'squeezed', pattern: /(tothemoon|moonshot|willmoon|gonnamoon|goingtomoon|moonsoon)/ },
  { id: 'fv.squeeze.pump', cls: 'future_value_implication', view: 'squeezed', pattern: /(will|gonna|goingto|abouttto|abouto)(pump|explode|skyrocket|rip|send|fly|rocket|soar|surge)/ },
  { id: 'fv.squeeze.guarantee', cls: 'future_value_implication', view: 'squeezed', pattern: /(guaranteed|riskfree|cantlose|cannotlose|surething|freemoney|easymoney|nobrainer)/ },
  { id: 'fv.squeeze.downside', cls: 'future_value_implication', view: 'squeezed', pattern: /(will|gonna|goingto|isit)(rug|crash|die|gotozero|zero|godown|collapse)/ },
  { id: 'fv.squeeze.rich', cls: 'future_value_implication', view: 'squeezed', pattern: /(makemerich|getrich|lifechangingmoney|generational?wealth|retireon|millionaire)/ },
  { id: 'fv.squeeze.gem', cls: 'future_value_implication', view: 'squeezed', pattern: /(hiddengem|undervalued|nextpepe|nextdoge|nextshib|nextbonk|next\w{0,8}killer)/ },
  { id: 'fv.lower.multilingual', cls: 'future_value_implication', view: 'lower', pattern: /(a la luna|vai bombar|va exploser|wird steigen|garantiert|улетит|взлетит|гарантированн|到月球|暴涨|必涨|爆上げ|급등)/ },

  // ---- user_financial_situation ----------------------------------------
  { id: 'uf.squeeze.savings', cls: 'user_financial_situation', view: 'squeezed', pattern: /(mylifesavings|lifesavings|myrent|rentmoney|mysalary|mymortgage|mypension|mystudentloan|myportfolio)/ },
  { id: 'uf.squeeze.borrowed', cls: 'user_financial_situation', view: 'squeezed', pattern: /(iborrowed|itookaloan|tookoutaloan|onmargin|usedleverage|mycreditcard)/ },
  { id: 'uf.squeeze.howmuch', cls: 'user_financial_situation', view: 'squeezed', pattern: /howmuchshouldi(invest|put|buy|spend|allocate)/ },
  // "allin" is deliberately absent: it folds to "alin", which appears inside
  // ordinary phrases like "all included". Short squeezed literals are the one
  // real over-blocking risk in this table.
  { id: 'uf.squeeze.afford', cls: 'user_financial_situation', view: 'squeezed', pattern: /(caniafford|allmymoney|everythingihave|mywholeportfolio|gonealin)/ },
  { id: 'uf.lower.multilingual', cls: 'user_financial_situation', view: 'lower', pattern: /(mis ahorros|minhas economias|mes economies|meine ersparnisse|мои сбережения|我的积蓄|全財産|전 ?재산)/ },

  // ---- wen_moon ---------------------------------------------------------
  { id: 'wm.squeeze.wenmoon', cls: 'wen_moon', view: 'squeezed', pattern: /(wen|when)(moon|lambo|lambro|rich|ath|mars|valhalla|pump|send|dump|x)/ },
  { id: 'wm.folded.barewen', cls: 'wen_moon', view: 'folded', pattern: /\bwen\b(?!\s*(listing|cex|dex|update|roadmap|website|audit|burn|unlock|snapshot))/ },
  { id: 'wm.lower.multilingual', cls: 'wen_moon', view: 'lower', pattern: /(cuando a la luna|quando lua|когда луна|什么时候上月球|いつムーン)/ },

  // ---- comparative_investment_merit ------------------------------------
  { id: 'ci.squeeze.better', cls: 'comparative_investment_merit', view: 'squeezed', pattern: /(better(than|investment|buy|bet|play)|saferbet|moreupside|morepotential|bestcointo(buy|hold))/ },
  { id: 'ci.squeeze.which', cls: 'comparative_investment_merit', view: 'squeezed', pattern: /(which|what)(coin|token|one|coinshould)(is|should|would|has)(better|best|i|more)/ },
  { id: 'ci.folded.vs', cls: 'comparative_investment_merit', view: 'folded', pattern: /\bvs\.?\b.{0,40}\b(better|worth|pick|safer|upside|choose)\b/ },
  { id: 'ci.lower.multilingual', cls: 'comparative_investment_merit', view: 'lower', pattern: /(mejor que|melhor que|mieux que|besser als|лучше чем|哪个更好|どっちがいい|어느 ?쪽이 ?더)/ },
]

/**
 * Conjunction rules. Each is a phrasing-independent structure rather than a
 * phrase, which is what catches novel wording in any language: an answer that
 * pairs a money amount with a future-tense claim IS a forecast, whatever words
 * it uses to get there.
 */
const RAW_CONJUNCTION_RULES: readonly ConjunctionRule[] = [
  {
    id: 'struct.amount_plus_future',
    cls: 'future_value_implication',
    view: 'lower',
    all: [
      /(\$\s?\d|\d[\d.,]*\s*(usd|dollars?|eth|weth|cents?|usdg))/,
      /\b(will|won't|wont|going to|gonna|expect|expects|expected|likely|projected|forecast|by end of|should reach|should hit)\b/,
    ],
  },
  {
    id: 'struct.advice_imperative',
    cls: 'buy_sell_advice',
    view: 'folded',
    all: [/\b(you|holders|everyone|anon|ser)\b/, /\b(should|ought to|need to|have to|must)\s+(buy|sell|hold|ape|invest|accumulate|dump|exit|swap)\b/],
    sides: ['output'],
  },
  {
    id: 'struct.recommendation',
    cls: 'buy_sell_advice',
    view: 'folded',
    all: [/\b(i recommend|id recommend|i would recommend|i suggest|i would suggest|my advice|i advise|recommendation)\b/],
    sides: ['output'],
  },
  {
    id: 'struct.hype_emoji_question',
    cls: 'wen_moon',
    view: 'lower',
    all: [/[\u{1F680}\u{1F311}-\u{1F31D}\u{1F48E}\u{1F64C}\u{1F4C8}]{2,}/u, /[?？]/],
  },
]

/**
 * Patterns aimed at the squeezed view are folded the same way the view is, so
 * a rule can be written in ordinary spelling and still match stretched text.
 */
const SINGLE_RULES: readonly SingleRule[] = RAW_SINGLE_RULES.map((rule) =>
  rule.view === 'squeezed' ? { ...rule, pattern: foldPattern(rule.pattern) } : rule,
)

const CONJUNCTION_RULES: readonly ConjunctionRule[] = RAW_CONJUNCTION_RULES.map((rule) =>
  rule.view === 'squeezed' ? { ...rule, all: rule.all.map(foldPattern) } : rule,
)

function viewOf(text: NormalizedText, view: View): string {
  switch (view) {
    case 'lower':
      return text.lower
    case 'folded':
      return text.folded
    case 'deleet':
      return text.deleet
    case 'squeezed':
      return text.squeezed
  }
}

function excerptAround(haystack: string, index: number, span = 32): string {
  const start = Math.max(0, index - span)
  return haystack.slice(start, Math.min(haystack.length, index + span))
}

function applies(sides: readonly ClassifierSide[] | undefined, side: ClassifierSide): boolean {
  return sides === undefined || sides.includes(side)
}

/**
 * Classify one string. Pure, total, and never throws: regex evaluation over
 * bounded input with no backtracking-heavy constructs.
 */
export function classifyRefusal(text: string, side: ClassifierSide): RefusalDecision {
  const matches: RefusalMatch[] = []
  if (typeof text !== 'string') {
    return { refused: true, classes: ['buy_sell_advice'], matches, side }
  }

  const normalized = normalize(text)

  for (const rule of SINGLE_RULES) {
    if (!applies(rule.sides, side)) continue
    const haystack = viewOf(normalized, rule.view)
    const found = rule.pattern.exec(haystack)
    if (found) {
      matches.push({
        cls: rule.cls,
        ruleId: rule.id,
        excerpt: excerptAround(haystack, found.index),
      })
    }
  }

  for (const rule of CONJUNCTION_RULES) {
    if (!applies(rule.sides, side)) continue
    const haystack = viewOf(normalized, rule.view)
    let firstIndex = -1
    let all = true
    for (const pattern of rule.all) {
      const found = pattern.exec(haystack)
      if (!found) {
        all = false
        break
      }
      if (firstIndex < 0) firstIndex = found.index
    }
    if (all) {
      matches.push({
        cls: rule.cls,
        ruleId: rule.id,
        excerpt: excerptAround(haystack, Math.max(0, firstIndex)),
      })
    }
  }

  const classes = [...new Set(matches.map((m) => m.cls))].sort(
    (a, b) => REFUSAL_CLASSES.indexOf(a) - REFUSAL_CLASSES.indexOf(b),
  )
  return { refused: classes.length > 0, classes, matches, side }
}

export interface ExchangeScreen {
  /** True when the desk must emit the fixed refusal instead of the answer. */
  refused: boolean
  classes: RefusalClass[]
  matches: RefusalMatch[]
  /** Which side tripped first. 'input' means the answer was never worth having. */
  trippedOn: ClassifierSide | 'none'
}

/**
 * Screen a whole exchange. The input side and the output side are unioned, and
 * anything unexpected refuses.
 *
 * The candidate answer is screened even when the model declined to answer, and
 * even when the answer was assembled by deterministic code: a template edited
 * six months from now gets the same treatment as a model's words.
 */
export function screenExchange(question: string, candidateAnswer: string): ExchangeScreen {
  try {
    const inbound = classifyRefusal(question, 'input')
    const outbound = classifyRefusal(candidateAnswer, 'output')
    const matches = [...inbound.matches, ...outbound.matches]
    const classes = [...new Set([...inbound.classes, ...outbound.classes])].sort(
      (a, b) => REFUSAL_CLASSES.indexOf(a) - REFUSAL_CLASSES.indexOf(b),
    )
    return {
      refused: classes.length > 0,
      classes,
      matches,
      trippedOn: inbound.refused ? 'input' : outbound.refused ? 'output' : 'none',
    }
  } catch {
    // A classifier that cannot run is a classifier that refuses.
    return {
      refused: true,
      classes: ['buy_sell_advice'],
      matches: [{ cls: 'buy_sell_advice', ruleId: 'fail.closed', excerpt: '' }],
      trippedOn: 'output',
    }
  }
}
