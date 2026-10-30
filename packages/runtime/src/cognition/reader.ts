import {
  AirlockViolation,
  CORPUS_LIMITS,
  READER_TOOLS,
  SIGNAL_CODES,
  TOPIC_CODES,
  carriesDestination,
  scrubGist,
  validateDigest,
} from '@fee-split-vaults/core'
import type { Digest, SignalCode, TopicCode } from '@fee-split-vaults/core'
import { MODEL } from '../model/ids.js'
import type { ModelClient, ModelRequest, ModelUsage } from '../model/client.js'
import { assertNoDestinationOrAmount, assertExactKeys, parseStrictJsonObject } from './guards.js'
import { READER_SYSTEM_PROMPT } from './prompts.js'
import type { AssembledCorpus } from '../corpus/assemble.js'

/**
 * THE UNTRUSTED SIDE OF THE AIRLOCK.
 *
 * This call consumes attacker-authored text. It therefore holds nothing: no
 * tools, no keys, no network reach beyond the single Messages request, and no
 * ability to influence anything except the contents of a Digest whose schema has
 * no field capable of naming a destination or an amount.
 *
 * The reader does not author the whole Digest. It supplies four fields -
 * topicCounts, signals, gists, readerRefusals - and trusted code supplies the
 * rest from its own records. A compromised reader therefore cannot restate which
 * coin it was reading, cannot rewrite the message counts to hide a flood, and
 * cannot backdate a window.
 */

export const READER_MAX_TOKENS = 1_536
export const MAX_GISTS = 8

export interface ReaderOptions {
  maxTokens?: number
  maxGists?: number
}

export interface ReaderResult {
  digest: Digest
  usage: ModelUsage
  batched: boolean
  /** Gists the model produced that were dropped on the boundary. Audit signal. */
  rejectedGists: number
}

export class ReaderFailure extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(`reader: ${message}`)
    this.name = 'ReaderFailure'
  }
}

export class Reader {
  private readonly maxTokens: number
  private readonly maxGists: number

  constructor(
    private readonly model: ModelClient,
    options: ReaderOptions = {},
  ) {
    // If this ever fails, the two-plane argument no longer holds and the process
    // must not start. It is checked here, at construction, rather than at call
    // time, so a deployment with an open airlock cannot serve a single window.
    if (READER_TOOLS.length !== 0) {
      throw new AirlockViolation(
        'READER_TOOLS is non-empty; the reader would hold an expressive channel',
        'READER_TOOLS',
      )
    }
    this.maxTokens = options.maxTokens ?? READER_MAX_TOKENS
    this.maxGists = options.maxGists ?? MAX_GISTS
  }

  /**
   * Build the request. Exported behaviour, not a private detail: the adversarial
   * suite asserts that the object this returns has no `tools` key under any
   * input, including inputs that ask for one.
   */
  buildRequest(corpus: AssembledCorpus, userIdHash: string): ModelRequest {
    return {
      model: MODEL.haiku45,
      system: [{ text: READER_SYSTEM_PROMPT, cacheBreakpoint: true }],
      userText: renderCorpusTurn(corpus),
      maxTokens: this.maxTokens,
      userIdHash,
      traceId: corpus.window.windowId,
      // No `tools`, no `toolChoice`, no `effort` (Haiku 4.5 rejects it), no
      // thinking. Adding any of these is a security review.
    }
  }

  async read(corpus: AssembledCorpus, userIdHash: string): Promise<ReaderResult> {
    const request = this.buildRequest(corpus, userIdHash)
    if (request.tools !== undefined) {
      throw new AirlockViolation('reader request carries tools', 'tools')
    }

    const response = await this.model.complete(request)
    const text = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
    if (text.length === 0) throw new ReaderFailure('empty response')

    const emission = parseEmission(text, this.maxGists)

    const digest = validateDigest({
      // Trusted fields. The model contributes none of these.
      windowId: corpus.window.windowId,
      coinRef: corpus.coinRef,
      windowStartUnix: corpus.window.startUnix,
      windowEndUnix: corpus.window.endUnix,
      admittedMessageCount: corpus.admittedMessageCount,
      droppedMessageCount: corpus.droppedMessageCount,
      distinctAuthorCount: corpus.distinctAuthorCount,
      // Model-supplied fields, already narrowed to closed vocabularies.
      topicCounts: emission.topicCounts,
      signals: mergeSignals(emission.signals, deriveSignals(corpus, emission.topicCounts)),
      gists: emission.gists,
      readerRefusals: emission.readerRefusals,
    })

    return {
      digest,
      usage: response.usage,
      batched: response.batched,
      rejectedGists: emission.rejectedGists,
    }
  }
}

interface ReaderEmission {
  topicCounts: Partial<Record<TopicCode, number>>
  signals: SignalCode[]
  gists: string[]
  readerRefusals: number
  rejectedGists: number
}

const EMISSION_KEYS = ['topicCounts', 'signals', 'gists', 'readerRefusals'] as const

export function parseEmission(text: string, maxGists: number): ReaderEmission {
  const raw = parseStrictJsonObject(text)
  assertExactKeys(raw, EMISSION_KEYS, 'readerEmission')

  const topicCounts: Partial<Record<TopicCode, number>> = {}
  const rawTopics = raw.topicCounts
  if (typeof rawTopics !== 'object' || rawTopics === null || Array.isArray(rawTopics)) {
    throw new AirlockViolation('topicCounts must be an object', 'topicCounts')
  }
  for (const [key, value] of Object.entries(rawTopics as Record<string, unknown>)) {
    if (!(TOPIC_CODES as readonly string[]).includes(key)) {
      throw new AirlockViolation(`unknown topic code "${key}"`, 'topicCounts')
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new AirlockViolation(`topic "${key}" count is not a count`, 'topicCounts')
    }
    // FLOOR AND BOUND. Flooring alone left the counter unbounded, and an
    // unbounded counter is a covert channel: sixteen closed-enum codes at fifteen
    // significant digits each is ~240 decimal digits of attacker-chosen data, and
    // an EVM address needs 49. Deterministic capping means no window can ever
    // have admitted more than maxMessagesPerWindow messages, so a larger number
    // is not a count and is not treated as one. validateDigest reconciles again,
    // more tightly, against the count trusted code actually observed; this bound
    // exists so the violation is attributable to the READER.
    topicCounts[key as TopicCode] = Math.min(
      Math.floor(value),
      CORPUS_LIMITS.maxMessagesPerWindow,
    )
  }

  if (!Array.isArray(raw.signals)) {
    throw new AirlockViolation('signals must be an array', 'signals')
  }
  const signals: SignalCode[] = raw.signals.map((s: unknown) => {
    if (typeof s !== 'string' || !(SIGNAL_CODES as readonly string[]).includes(s)) {
      throw new AirlockViolation(`unknown signal code "${String(s)}"`, 'signals')
    }
    return s as SignalCode
  })

  if (!Array.isArray(raw.gists)) throw new AirlockViolation('gists must be an array', 'gists')
  const gists: string[] = []
  let rejectedGists = 0
  for (const candidate of raw.gists as unknown[]) {
    if (gists.length >= maxGists) {
      rejectedGists += 1
      continue
    }
    if (typeof candidate !== 'string') {
      rejectedGists += 1
      continue
    }
    // A gist that NAMED a destination is dropped, not laundered. Scrubbing it to
    // "[addr]" and keeping it would mean a reader that emitted an attacker's
    // contract address still got to choose the sentence around it, and it would
    // hide from the audit trail the one fact that matters: the reader tried. The
    // prompt already forbids addresses, links and handles in a gist, so a gist
    // carrying one is a reader that is not following its contract.
    if (carriesDestination(candidate)) {
      rejectedGists += 1
      continue
    }
    const scrubbed = scrubGist(candidate)
    if (scrubbed.length === 0) {
      rejectedGists += 1
      continue
    }
    // A gist that still carries a destination or an amount after scrubbing is
    // dropped rather than repaired. Repairing it would be guessing at intent.
    try {
      assertNoDestinationOrAmount(scrubbed, 'gists')
    } catch (error: unknown) {
      if (error instanceof AirlockViolation) {
        rejectedGists += 1
        continue
      }
      throw error
    }
    gists.push(scrubbed)
  }

  const refusals = raw.readerRefusals
  if (typeof refusals !== 'number' || !Number.isFinite(refusals) || refusals < 0) {
    throw new AirlockViolation('readerRefusals must be a non-negative number', 'readerRefusals')
  }

  return { topicCounts, signals, gists, readerRefusals: Math.floor(refusals), rejectedGists }
}

/**
 * Signals a model must not be the sole source of, because they are the ones a
 * planner acts on hardest and they are computable from trusted counters.
 */
export function deriveSignals(
  corpus: AssembledCorpus,
  topicCounts: Partial<Record<TopicCode, number>>,
): SignalCode[] {
  const out: SignalCode[] = []
  const total = corpus.admittedMessageCount + corpus.droppedMessageCount
  if (total === 0) out.push('quiet')
  if (corpus.droppedMessageCount > corpus.admittedMessageCount * 4) out.push('mention_spike')
  if ((topicCounts.unanswered_backlog ?? 0) > 0) out.push('desk_backlog_growing')
  return out
}

export function mergeSignals(a: readonly SignalCode[], b: readonly SignalCode[]): SignalCode[] {
  const seen = new Set<SignalCode>()
  const out: SignalCode[] = []
  for (const code of [...a, ...b]) {
    if (seen.has(code)) continue
    seen.add(code)
    out.push(code)
  }
  return out
}

/**
 * The user turn. The corpus is fenced and labelled as data. This is a courtesy
 * to the model, not a control: the control is that the model on the other side
 * of this string cannot do anything.
 */
export function renderCorpusTurn(corpus: AssembledCorpus): string {
  // Deliberately NOT included: how many messages the caps dropped. The reader
  // does not need the size of a flood to classify the text that survived it, and
  // leaving it out is what makes the rendered turn - and therefore the bill -
  // byte-identical for a 500 message window and a 500,000 message window that
  // both saturate the caps. Flood magnitude reaches the planner through
  // Digest.droppedMessageCount, which trusted code fills in.
  return [
    `window ${corpus.window.windowId}`,
    '',
    '<<<UNTRUSTED_COMMUNITY_TEXT',
    corpus.renderedText,
    'UNTRUSTED_COMMUNITY_TEXT',
    '',
    'Emit the JSON object now.',
  ].join('\n')
}
