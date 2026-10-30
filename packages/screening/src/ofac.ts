/**
 * OFAC SDN name matching.
 *
 * Sanctions screening is the one stage-1 check with a hard legal consequence
 * for a false negative, and it fails closed twice over: a list older than the
 * policy window raises `sanctions_list_stale`, and the sample list shipped in
 * this repository is not authoritative - a deployment that has not loaded the
 * real SDN file cannot issue a CLEAR verdict.
 *
 * Matching is token-based with a one-edit tolerance rather than substring,
 * because SDN entries are names: substring matching on "Hydra" would flag every
 * mythology coin, and exact matching misses "Lazaruss" and "Garantexx".
 */

import { wordTokens } from './normalize.js'

export type SdnEntryType = 'individual' | 'entity' | 'vessel' | 'digital_currency'

export interface SdnEntry {
  /** OFAC unique id. */
  uid: string
  name: string
  aliases?: string[]
  program?: string
  type: SdnEntryType
}

export interface SdnSource {
  entries(): readonly SdnEntry[]
  /** When OFAC published the loaded file. Drives the staleness gate. */
  publishedAtUnix(): number
  /**
   * False for any list that is not the official SDN download. The sample list
   * in this file sets this false and can therefore never produce a CLEAR.
   */
  authoritative(): boolean
}

export interface SdnMatch {
  uid: string
  matchedName: string
  program?: string
  /** 'full' means every distinctive token matched. */
  strength: 'full' | 'partial'
  /** The subject tokens that matched, for the audit trail. */
  matchedTokens: string[]
}

/**
 * A small, publicly documented sample used for tests and local development.
 * These are OFAC-designated virtual-currency entities; the list is illustrative
 * and is NOT a substitute for the official SDN file.
 */
export const SAMPLE_SDN_ENTRIES: readonly SdnEntry[] = [
  { uid: 'sample-1', name: 'TORNADO CASH', program: 'CYBER2', type: 'digital_currency' },
  { uid: 'sample-2', name: 'BLENDER IO', aliases: ['BLENDER.IO'], program: 'DPRK3', type: 'digital_currency' },
  { uid: 'sample-3', name: 'SINBAD IO', aliases: ['SINBAD.IO'], program: 'DPRK3', type: 'digital_currency' },
  { uid: 'sample-4', name: 'LAZARUS GROUP', aliases: ['HIDDEN COBRA'], program: 'DPRK', type: 'entity' },
  { uid: 'sample-5', name: 'GARANTEX EUROPE OU', aliases: ['GARANTEX'], program: 'CYBER2', type: 'entity' },
  { uid: 'sample-6', name: 'HYDRA MARKET', aliases: ['HYDRA MARKETPLACE'], program: 'CYBER2', type: 'entity' },
  { uid: 'sample-7', name: 'SUEX OTC', aliases: ['SUEX'], program: 'CYBER2', type: 'entity' },
  { uid: 'sample-8', name: 'CHATEX', program: 'CYBER2', type: 'entity' },
]

export class SampleSdnSource implements SdnSource {
  constructor(private readonly publishedAt: number) {}
  entries(): readonly SdnEntry[] {
    return SAMPLE_SDN_ENTRIES
  }
  publishedAtUnix(): number {
    return this.publishedAt
  }
  authoritative(): boolean {
    return false
  }
}

/** Wraps a parsed official SDN download. */
export class LoadedSdnSource implements SdnSource {
  constructor(
    private readonly items: readonly SdnEntry[],
    private readonly publishedAt: number,
  ) {}
  entries(): readonly SdnEntry[] {
    return this.items
  }
  publishedAtUnix(): number {
    return this.publishedAt
  }
  authoritative(): boolean {
    return true
  }
}

/** Tokens too common to carry a match on their own. */
const NAME_STOPWORDS = new Set([
  'the', 'of', 'and', 'co', 'ltd', 'llc', 'inc', 'group', 'company', 'limited',
  'ou', 'oy', 'ab', 'sa', 'gmbh', 'bv', 'nv', 'plc', 'corp', 'trading', 'market',
  'io', 'com', 'net', 'org', 'cash', 'coin', 'token', 'exchange', 'services',
  'service', 'holding', 'holdings', 'international', 'global', 'capital',
])

/** Bounded Damerau-Levenshtein: true when distance is at most 1. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true
  const lenA = a.length
  const lenB = b.length
  if (Math.abs(lenA - lenB) > 1) return false

  if (lenA === lenB) {
    let diff = -1
    for (let i = 0; i < lenA; i += 1) {
      if (a[i] !== b[i]) {
        if (diff >= 0) {
          // One transposition of adjacent characters is still one edit.
          return diff === i - 1 && a[diff] === b[i] && a[i] === b[diff] && a.slice(i + 1) === b.slice(i + 1)
        }
        diff = i
      }
    }
    return true
  }

  const shorter = lenA < lenB ? a : b
  const longer = lenA < lenB ? b : a
  let i = 0
  let j = 0
  let skipped = false
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i += 1
      j += 1
      continue
    }
    if (skipped) return false
    skipped = true
    j += 1
  }
  return true
}

export interface SdnPolicy {
  /** Refuse to clear on a list older than this. */
  maxListAgeSeconds: number
  /** Tokens at least this long may carry a partial match. */
  distinctiveTokenLength: number
  /** Tokens at least this long tolerate one edit. */
  fuzzyTokenLength: number
}

export const DEFAULT_SDN_POLICY: SdnPolicy = {
  maxListAgeSeconds: 7 * 24 * 60 * 60,
  distinctiveTokenLength: 6,
  fuzzyTokenLength: 5,
}

export type SdnListStatus = 'ok' | 'stale' | 'not_authoritative'

/**
 * Single-character deletions of a token, plus the token itself. Two strings are
 * within edit distance 1 exactly when these sets intersect, which is what makes
 * the inverted index below sound: a candidate can never be missed, only
 * proposed and then rejected by `withinOneEdit`.
 */
function deletionKeys(token: string): string[] {
  const keys = [token]
  for (let i = 0; i < token.length; i += 1) {
    keys.push(token.slice(0, i) + token.slice(i + 1))
  }
  return keys
}

export class SdnScreener {
  private readonly names: Array<{ entry: SdnEntry; display: string; tokens: string[] }>
  /**
   * token (or single-deletion variant) -> candidate name indices. The real SDN
   * file is ~17k entries and rather more names once aliases are expanded;
   * scanning all of them per subject would put stage 1 into the tens of
   * milliseconds and destroy the property that makes it the always-on stage.
   */
  private readonly index: Map<string, number[]>

  constructor(
    private readonly source: SdnSource,
    private readonly policy: SdnPolicy = DEFAULT_SDN_POLICY,
  ) {
    this.names = []
    this.index = new Map()

    for (const entry of source.entries()) {
      for (const display of [entry.name, ...(entry.aliases ?? [])]) {
        const tokens = wordTokens(display).filter((t) => t.length > 1)
        if (tokens.length === 0) continue
        const nameIndex = this.names.length
        this.names.push({ entry, display, tokens })

        for (const token of tokens) {
          const keys =
            token.length >= this.policy.fuzzyTokenLength ? deletionKeys(token) : [token]
          for (const key of keys) {
            const bucket = this.index.get(key)
            if (bucket === undefined) this.index.set(key, [nameIndex])
            else if (bucket[bucket.length - 1] !== nameIndex) bucket.push(nameIndex)
          }
        }
      }
    }
  }

  /** Staleness and provenance, evaluated before any matching. */
  listStatus(nowUnix: number): SdnListStatus {
    if (!this.source.authoritative()) return 'not_authoritative'
    if (nowUnix - this.source.publishedAtUnix() > this.policy.maxListAgeSeconds) return 'stale'
    return 'ok'
  }

  match(raw: string): SdnMatch[] {
    const subjectTokens = wordTokens(raw)
    if (subjectTokens.length === 0) return []
    const exact = new Set(subjectTokens)
    const matches = new Map<string, SdnMatch>()

    for (const candidate of this.candidates(subjectTokens)) {
      const matched: string[] = []
      let allMatched = true

      for (const token of candidate.tokens) {
        const hit = this.findToken(token, subjectTokens, exact)
        if (hit === undefined) {
          allMatched = false
          continue
        }
        matched.push(hit)
      }

      if (matched.length === 0) continue

      const distinctive = matched.filter(
        (t) => t.length >= this.policy.distinctiveTokenLength && !NAME_STOPWORDS.has(t),
      )
      const strength: 'full' | 'partial' =
        allMatched && distinctive.length > 0 ? 'full' : 'partial'
      if (strength === 'partial' && distinctive.length === 0) continue

      const existing = matches.get(candidate.entry.uid)
      if (existing !== undefined && existing.strength === 'full') continue

      const match: SdnMatch = {
        uid: candidate.entry.uid,
        matchedName: candidate.display,
        strength,
        matchedTokens: matched,
      }
      if (candidate.entry.program !== undefined) match.program = candidate.entry.program
      matches.set(candidate.entry.uid, match)
    }

    return [...matches.values()]
  }

  /** Names sharing at least one token (or near-token) with the subject. */
  private candidates(
    subjectTokens: readonly string[],
  ): Array<{ entry: SdnEntry; display: string; tokens: string[] }> {
    const seen = new Set<number>()
    for (const token of subjectTokens) {
      if (token.length <= 1) continue
      const keys =
        token.length >= this.policy.fuzzyTokenLength ? deletionKeys(token) : [token]
      for (const key of keys) {
        for (const nameIndex of this.index.get(key) ?? []) seen.add(nameIndex)
      }
    }
    const out: Array<{ entry: SdnEntry; display: string; tokens: string[] }> = []
    for (const nameIndex of seen) {
      const candidate = this.names[nameIndex]
      if (candidate !== undefined) out.push(candidate)
    }
    return out
  }

  private findToken(
    token: string,
    subjectTokens: readonly string[],
    exact: ReadonlySet<string>,
  ): string | undefined {
    if (exact.has(token)) return token
    if (token.length < this.policy.fuzzyTokenLength) return undefined
    for (const subject of subjectTokens) {
      if (subject.length < this.policy.fuzzyTokenLength) continue
      if (withinOneEdit(token, subject)) return subject
    }
    return undefined
  }
}
