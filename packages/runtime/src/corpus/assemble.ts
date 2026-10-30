import { CORPUS_LIMITS } from '@fee-split-vaults/core'
import { dedupeKey, estimateTokens, sanitizeUntrusted } from './sanitize.js'
import type { CorpusWindow } from './window.js'

/**
 * Deterministic corpus assembly. Trusted code. No model runs here.
 *
 * THE PROPERTY THIS FILE EXISTS TO PROVIDE: inference cost is a function of the
 * caps, not of the input. 500,000 messages and 500 messages that both saturate
 * the caps render to byte-identical corpora of identical token count, so a
 * mention flood cannot burn a coin's inference budget and cannot lengthen the
 * attacker's window of influence over the reader.
 *
 * Ordering is by (postedAtUnix, contentHash), so the output does not depend on
 * the order the ingest happened to deliver messages in. Two replays of the same
 * window produce the same corpus and therefore the same cache key.
 */

/** Where an untrusted string entered the system. Set by trusted ingest. */
export type MessageOrigin = 'telegram' | 'x_mention' | 'token_metadata' | 'vendor_response'

const ORIGIN_TAG: Record<MessageOrigin, string> = {
  telegram: 'tg',
  x_mention: 'x',
  token_metadata: 'meta',
  vendor_response: 'vend',
}

export interface RawMessage {
  /** Source-assigned id. Untrusted; used only for tie-breaking and audit. */
  sourceId: string
  /** Untrusted author identifier. Never rendered; only counted and pseudonymised. */
  authorId: string
  /** Untrusted body. */
  text: string
  postedAtUnix: number
  origin: MessageOrigin
  /**
   * Bound by trusted ingest at the moment of collection, never parsed out of the
   * message. The assembler refuses a message whose binding does not match the
   * window's coin, which is the structural block on cross-coin context bleed.
   */
  boundCoinRef: string
}

export interface AssembleOptions {
  maxMessagesPerAuthor?: number
  maxMessagesPerWindow?: number
  maxTokensPerWindow?: number
  /**
   * Per-message character cap. Without it a single 40,000 character message
   * consumes the whole window and no other voice is heard.
   */
  maxCharsPerMessage?: number
}

export interface CorpusCaps {
  byDuplicate: number
  byAuthor: number
  byWindowCap: number
  byTokenCeiling: number
  byEmptyAfterSanitising: number
}

export interface AssembledCorpus {
  window: CorpusWindow
  coinRef: string
  /** One rendered line per admitted message, in deterministic order. */
  lines: string[]
  renderedText: string
  admittedMessageCount: number
  /** Everything the caps refused. A flood surfaces here as a number, nowhere else. */
  droppedMessageCount: number
  distinctAuthorCount: number
  estimatedTokens: number
  contentHashes: string[]
  caps: CorpusCaps
}

interface Candidate {
  key: string
  sanitised: string
  authorId: string
  origin: MessageOrigin
  postedAtUnix: number
  sourceId: string
}

export class CorpusBindingError extends Error {
  constructor(sourceId: string, expected: string, actual: string) {
    super(`message ${sourceId} is bound to ${actual}, not to ${expected}`)
    this.name = 'CorpusBindingError'
  }
}

export function assembleCorpus(
  window: CorpusWindow,
  messages: readonly RawMessage[],
  options: AssembleOptions = {},
): AssembledCorpus {
  const maxPerAuthor = options.maxMessagesPerAuthor ?? CORPUS_LIMITS.maxMessagesPerAuthor
  const maxPerWindow = options.maxMessagesPerWindow ?? CORPUS_LIMITS.maxMessagesPerWindow
  const maxTokens = options.maxTokensPerWindow ?? CORPUS_LIMITS.maxTokensPerWindow
  const maxChars = options.maxCharsPerMessage ?? 320

  const caps: CorpusCaps = {
    byDuplicate: 0,
    byAuthor: 0,
    byWindowCap: 0,
    byTokenCeiling: 0,
    byEmptyAfterSanitising: 0,
  }

  const deduped = new Map<string, Candidate>()
  let inWindow = 0

  for (const message of messages) {
    if (message.boundCoinRef !== window.coinRef) {
      throw new CorpusBindingError(message.sourceId, window.coinRef, message.boundCoinRef)
    }
    if (message.postedAtUnix < window.startUnix || message.postedAtUnix >= window.endUnix) continue
    inWindow += 1

    const sanitised = sanitizeUntrusted(message.text, maxChars)
    if (sanitised.length === 0) {
      caps.byEmptyAfterSanitising += 1
      continue
    }

    const key = dedupeKey(message.text)
    const existing = deduped.get(key)
    if (existing !== undefined) {
      caps.byDuplicate += 1
      // Keep the earliest occurrence so a replay is stable.
      if (
        message.postedAtUnix < existing.postedAtUnix ||
        (message.postedAtUnix === existing.postedAtUnix && message.sourceId < existing.sourceId)
      ) {
        deduped.set(key, toCandidate(message, key, sanitised))
      }
      continue
    }
    deduped.set(key, toCandidate(message, key, sanitised))
  }

  const ordered = [...deduped.values()].sort(compareCandidates)

  const perAuthor = new Map<string, number>()
  const authorIndex = new Map<string, number>()
  const lines: string[] = []
  const contentHashes: string[] = []
  let tokens = 0

  for (const candidate of ordered) {
    if (lines.length >= maxPerWindow) {
      caps.byWindowCap += 1
      continue
    }
    const used = perAuthor.get(candidate.authorId) ?? 0
    if (used >= maxPerAuthor) {
      caps.byAuthor += 1
      continue
    }

    // Tentative until the line is actually admitted, so a refused line never
    // consumes a pseudonym.
    const existingIndex = authorIndex.get(candidate.authorId)
    const index = existingIndex ?? authorIndex.size

    const line = renderLine(index, candidate.origin, candidate.sanitised)
    const lineTokens = estimateTokens(line)
    if (tokens + lineTokens > maxTokens) {
      caps.byTokenCeiling += 1
      continue
    }

    if (existingIndex === undefined) authorIndex.set(candidate.authorId, index)
    tokens += lineTokens
    perAuthor.set(candidate.authorId, used + 1)
    lines.push(line)
    contentHashes.push(candidate.key)
  }

  // Capped by construction: this is the breadth of what the reader actually saw,
  // not the breadth of the flood. The flood's size is carried by
  // droppedMessageCount, which is a number and cannot carry a payload.
  const distinctAuthors = authorIndex.size

  return {
    window,
    coinRef: window.coinRef,
    lines,
    renderedText: lines.join('\n'),
    admittedMessageCount: lines.length,
    droppedMessageCount: inWindow - lines.length,
    distinctAuthorCount: distinctAuthors,
    estimatedTokens: tokens,
    contentHashes,
    caps,
  }
}

function toCandidate(message: RawMessage, key: string, sanitised: string): Candidate {
  return {
    key,
    sanitised,
    authorId: message.authorId,
    origin: message.origin,
    postedAtUnix: message.postedAtUnix,
    sourceId: message.sourceId,
  }
}

function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.postedAtUnix !== b.postedAtUnix) return a.postedAtUnix - b.postedAtUnix
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

/**
 * Fixed-width author pseudonym, assigned per window in order of first admission
 * and never reused across windows. It gives the reader a breadth signal without
 * carrying an identity, and its fixed width is what makes two saturated windows
 * render to the same number of characters.
 */
function renderLine(authorIndex: number, origin: MessageOrigin, text: string): string {
  const pseudonym = `a${String(authorIndex).padStart(3, '0')}`
  return `${pseudonym}|${ORIGIN_TAG[origin]}| ${text}`
}
