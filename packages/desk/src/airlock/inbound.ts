/**
 * The desk's side of the airlock.
 *
 * Every inbound message goes through here, and only two things ever come out:
 *
 *   1. A deterministic topic code, used by the desk itself. No model reads the
 *      corpus to produce it, so at T0 nothing model-shaped touches user text.
 *   2. A validated Digest, which is the ONLY structure that crosses to the
 *      planning plane in packages/planner. Counts, closed-enum codes, and
 *      scrubbed gists - no address, amount, payee, URL, handle, or instruction
 *      field exists on it to carry anything else.
 *
 * The desk itself never reads a Digest and never proposes spend. It answers
 * from the FactSheet. That separation is the point: the component that reads the
 * room is not the component that can act on the room.
 *
 * Caps are applied by THIS deterministic code before any model sees anything, so
 * 500,000 messages and 500 messages cost the same. There is no wake-on-mention
 * path; windows close on a clock.
 */

import { createHash } from 'node:crypto'
import {
  CORPUS_LIMITS,
  scrubGist,
  validateDigest,
  type Digest,
  type SignalCode,
  type TopicCode,
} from '@fee-split-vaults/core'
import type { InboundMessage } from '../message.js'
import { foldPattern, normalize } from '../text/normalize.js'

/**
 * The desk's permitted tool surface, mirroring READER_TOOLS.
 *
 * The desk holds no keys and no spending, posting, or signing tools. Its only
 * effects are chat administration and a reply, both scoped to the one chat it
 * moderates. If this array is ever non-empty, the two-plane argument is gone.
 */
export const DESK_SPEND_TOOLS: readonly never[] = [] as const

/** Names that must never appear on anything the desk plane can call. */
const FORBIDDEN_CAPABILITY = /(spend|purchase|buy|transfer|withdraw|claim|approve|sign|disburse|payout|swap)/i

export class DeskAuthorityViolation extends Error {
  constructor(name: string) {
    super(`desk: "${name}" is an authority-bearing capability and cannot exist on the desk plane`)
    this.name = 'DeskAuthorityViolation'
  }
}

/** Fail closed on a capability that should never have reached this plane. */
export function assertDeskHoldsNoAuthority(surface: readonly string[]): void {
  for (const name of surface) {
    if (FORBIDDEN_CAPABILITY.test(name)) throw new DeskAuthorityViolation(name)
  }
}

// ---------------------------------------------------------------------------
// Deterministic topic classification
// ---------------------------------------------------------------------------

interface TopicRule {
  topic: TopicCode
  pattern: RegExp
  view: 'squeezed' | 'lower'
}

const RAW_TOPIC_RULES: readonly TopicRule[] = [
  { topic: 'contract_address_request', view: 'squeezed', pattern: /(whatstheca|wheresca|contractaddress|tokenaddress|whatistheca|caplease|dropthe?ca)/ },
  { topic: 'how_to_buy', view: 'squeezed', pattern: /(howdoi?buy|howtobuy|wheredoi?buy|wheretobuy|howcani?buy|howdoiget|whichdex|howtoswap)/ },
  { topic: 'price_question', view: 'squeezed', pattern: /(price|marketcap|mcap|chart|dexscreener|howmuchisit)/ },
  { topic: 'liquidity_question', view: 'squeezed', pattern: /(liquidity|lppool|lplocked|lpburn|poolsize|slippage)/ },
  { topic: 'roadmap_question', view: 'squeezed', pattern: /(roadmap|whatsnext|upcoming|milestone|listing|cexlisting|partnership)/ },
  { topic: 'team_question', view: 'squeezed', pattern: /(whoistheteam|whosthedev|isthedevdoxxed|doxxed|whoisbehind|teaminfo)/ },
  { topic: 'scam_report', view: 'squeezed', pattern: /(scam|phishing|drainer|fakelink|stolemytokens|gotdrained)/ },
  { topic: 'impersonator_report', view: 'squeezed', pattern: /(impersonat|fakeadmin|fakemod|pretendingtobe|copyingtheadmin)/ },
  { topic: 'technical_support', view: 'squeezed', pattern: /(transactionfailed|txfailed|stucktransaction|cantswap|approvalfailed|walletissue|gaserror|reverted)/ },
  { topic: 'raid_or_spam', view: 'squeezed', pattern: /(joinmygroup|freeairdrop|followme|checkmychannel|pumpgroup)/ },
]

const TOPIC_RULES: readonly TopicRule[] = RAW_TOPIC_RULES.map((rule) =>
  rule.view === 'squeezed' ? { ...rule, pattern: foldPattern(rule.pattern) } : rule,
)

const POSITIVE = /(bullish|lfg|love this|great work|solid|nice|based|gm|holding|diamond)/
const NEGATIVE = /(rug|dead|dump|scam|slow|nothing happening|no volume|bad|lost|angry|terrible)/

/**
 * Classify a message into the closed topic vocabulary. Deterministic and
 * cheap - this is what keeps T0 free of a model entirely.
 */
export function classifyTopic(text: string): TopicCode {
  const normalized = normalize(text)
  for (const rule of TOPIC_RULES) {
    const haystack = rule.view === 'squeezed' ? normalized.squeezed : normalized.lower
    if (rule.pattern.test(haystack)) return rule.topic
  }
  if (POSITIVE.test(normalized.lower)) return 'sentiment_positive'
  if (NEGATIVE.test(normalized.lower)) return 'sentiment_negative'
  if (normalized.squeezed.length === 0) return 'off_topic'
  return 'sentiment_neutral'
}

// ---------------------------------------------------------------------------
// Corpus assembly
// ---------------------------------------------------------------------------

export interface CorpusLimits {
  maxTokensPerWindow: number
  maxMessagesPerAuthor: number
  maxMessagesPerWindow: number
  windowMinutes: number
  maxGistChars: number
}

export interface AdmitResult {
  admitted: boolean
  /** Why it was dropped. A flood shows up as a count, never as content. */
  reason?: 'author_cap' | 'window_cap' | 'token_cap' | 'duplicate' | 'empty'
  topic: TopicCode
}

/**
 * Builds one window's Digest. Not a general message store: it holds counts,
 * per-author tallies, and a small bounded set of candidate gists, and it drops
 * everything else on the floor as it goes.
 */
export class DeskCorpusAssembler {
  private readonly limits: CorpusLimits
  private topicCounts: Partial<Record<TopicCode, number>> = {}
  private authorCounts = new Map<string, number>()
  private seenHashes = new Set<string>()
  private admittedCount = 0
  private droppedCount = 0
  private approxTokens = 0
  private candidateGists: Array<{ topic: TopicCode; text: string }> = []
  private windowStartUnix: number
  private readerRefusals = 0

  constructor(
    private readonly coinRef: string,
    startUnix: number,
    limits?: Partial<CorpusLimits>,
  ) {
    this.limits = { ...CORPUS_LIMITS, ...limits }
    this.windowStartUnix = startUnix
  }

  get admitted(): number {
    return this.admittedCount
  }

  get dropped(): number {
    return this.droppedCount
  }

  /** Approximate token accounting. Deliberately pessimistic. */
  private tokensOf(text: string): number {
    return Math.ceil(text.length / 4)
  }

  /**
   * `gistEligible` is false for anything moderation removed. Such a message
   * still becomes a count - the planner should know a scam wave happened - but
   * its words never enter the gist pool. A gist is scrubbed, so it could not
   * carry a destination anyway; keeping known-hostile text out of the planner's
   * context entirely is simply cheaper than relying on the scrubber twice.
   */
  admit(message: InboundMessage, forcedTopic?: TopicCode, gistEligible = true): AdmitResult {
    const topic = forcedTopic ?? classifyTopic(message.text)
    const normalized = normalize(message.text)

    if (normalized.squeezed.length === 0) {
      this.droppedCount++
      return { admitted: false, reason: 'empty', topic }
    }

    if (this.admittedCount >= this.limits.maxMessagesPerWindow) {
      this.droppedCount++
      this.topicCounts[topic] = (this.topicCounts[topic] ?? 0) + 1
      return { admitted: false, reason: 'window_cap', topic }
    }

    const authorCount = this.authorCounts.get(message.authorId) ?? 0
    if (authorCount >= this.limits.maxMessagesPerAuthor) {
      this.droppedCount++
      this.topicCounts[topic] = (this.topicCounts[topic] ?? 0) + 1
      return { admitted: false, reason: 'author_cap', topic }
    }

    const hash = createHash('sha256').update(normalized.squeezed).digest('hex').slice(0, 16)
    if (this.seenHashes.has(hash)) {
      this.droppedCount++
      this.topicCounts[topic] = (this.topicCounts[topic] ?? 0) + 1
      return { admitted: false, reason: 'duplicate', topic }
    }

    const tokens = this.tokensOf(message.text)
    if (this.approxTokens + tokens > this.limits.maxTokensPerWindow) {
      this.droppedCount++
      this.topicCounts[topic] = (this.topicCounts[topic] ?? 0) + 1
      return { admitted: false, reason: 'token_cap', topic }
    }

    this.seenHashes.add(hash)
    this.authorCounts.set(message.authorId, authorCount + 1)
    this.admittedCount++
    this.approxTokens += tokens
    this.topicCounts[topic] = (this.topicCounts[topic] ?? 0) + 1

    if (gistEligible && this.candidateGists.length < 40) {
      this.candidateGists.push({ topic, text: message.text })
    }

    return { admitted: true, topic }
  }

  /** Count a message the desk declined to summarise. Audit only. */
  noteRefusal(): void {
    this.readerRefusals++
  }

  private buildGists(): string[] {
    const perTopic = new Map<TopicCode, string>()
    for (const candidate of this.candidateGists) {
      if (perTopic.has(candidate.topic)) continue
      const scrubbed = scrubGist(candidate.text)
      if (scrubbed.length === 0) continue
      perTopic.set(candidate.topic, scrubbed)
    }
    return [...perTopic.values()].slice(0, 8)
  }

  private buildSignals(previousAdmitted: number): SignalCode[] {
    const signals: SignalCode[] = []
    const scam = this.topicCounts.scam_report ?? 0
    const impersonation = this.topicCounts.impersonator_report ?? 0
    const backlog = this.topicCounts.unanswered_backlog ?? 0
    const negative = this.topicCounts.sentiment_negative ?? 0
    const positive = this.topicCounts.sentiment_positive ?? 0

    if (scam >= 3) signals.push('scam_wave')
    if (impersonation >= 2) signals.push('impersonation_wave')
    if (backlog >= 5) signals.push('desk_backlog_growing')
    if (previousAdmitted > 0 && this.admittedCount >= previousAdmitted * 2 && this.admittedCount >= 20) {
      signals.push('mention_spike')
    }
    if (negative >= 5 && negative > positive * 2) signals.push('sentiment_shift_negative')
    if (positive >= 5 && positive > negative * 2) signals.push('sentiment_shift_positive')
    if (this.admittedCount === 0) signals.push('quiet')
    return signals
  }

  /**
   * Close the window and emit a Digest. The result is passed through
   * validateDigest() before it leaves: the assembler is trusted code, but the
   * boundary is checked anyway because that is what a boundary is for.
   */
  close(nowUnix: number, previousAdmitted = 0): Digest {
    const windowId = createHash('sha256')
      .update(`${this.coinRef}|${this.windowStartUnix}|${nowUnix}`)
      .digest('hex')
      .slice(0, 24)

    return validateDigest({
      windowId,
      coinRef: this.coinRef,
      windowStartUnix: this.windowStartUnix,
      windowEndUnix: nowUnix,
      admittedMessageCount: this.admittedCount,
      droppedMessageCount: this.droppedCount,
      distinctAuthorCount: this.authorCounts.size,
      topicCounts: this.topicCounts,
      signals: this.buildSignals(previousAdmitted),
      gists: this.buildGists(),
      readerRefusals: this.readerRefusals,
    })
  }

  /** Start a fresh window in place, keeping the coin binding. */
  reset(startUnix: number): void {
    this.topicCounts = {}
    this.authorCounts = new Map()
    this.seenHashes = new Set()
    this.admittedCount = 0
    this.droppedCount = 0
    this.approxTokens = 0
    this.candidateGists = []
    this.readerRefusals = 0
    this.windowStartUnix = startUnix
  }
}
