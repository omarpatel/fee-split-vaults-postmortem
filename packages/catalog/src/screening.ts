/**
 * Loaders for the screening seed data under data/screening/.
 *
 * This package OWNS THE DATA AND ITS VALIDATION. It does not own the screening
 * decision - packages/screening does - and nothing here returns a verdict. The
 * split matters: a screening stage that also decided what its own list said
 * would have no independent check on either.
 *
 * WHY THE SLUR LIST IS HASHED. A slur lexicon checked into a repository in
 * plaintext is an evasion guide with a table of contents. Hashing the terms
 * keeps the check working - a normalised token either hashes into the set or it
 * does not - while making the file useless to someone shopping for a spelling
 * the filter misses. Hate PHRASES whose only reading is the hateful one are a
 * different case and stay in plaintext, because they need substring matching
 * and publishing them teaches an attacker nothing they did not already know.
 *
 * WHY THERE IS NO SEEDED DRAINER-DOMAIN LIST. Naming real hosts as malicious
 * from memory would be unverifiable and defamatory, and a list written once is
 * stale within days. What ships is the structural half - the half that does not
 * rot - plus the ingest points for an operator feed, and a status flag that
 * fails closed until that feed is loaded.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CatalogError } from './errors.js'
import { sha256Hex } from './hash.js'
import { dataPaths } from './paths.js'

function fail(code: string, message: string): never {
  throw new CatalogError('screening_data', code, message)
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('not_an_object', `${where} is not an object`)
  }
  return value as Record<string, unknown>
}

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) fail('missing_file', `${path} does not exist`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail('malformed_json', `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function requireString(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value.length === 0) {
    fail('missing_string', `${where}.${key} must be a non-empty string`)
  }
  return value
}

function requireInt(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    fail('missing_int', `${where}.${key} must be an integer`)
  }
  return value
}

function requireArray(source: Record<string, unknown>, key: string, where: string): unknown[] {
  const value = source[key]
  if (!Array.isArray(value)) fail('missing_array', `${where}.${key} must be an array`)
  return value
}

function requireBoolean(source: Record<string, unknown>, key: string, where: string): boolean {
  const value = source[key]
  if (typeof value !== 'boolean') fail('missing_boolean', `${where}.${key} must be a boolean`)
  return value
}

function requireStringArray(source: Record<string, unknown>, key: string, where: string): string[] {
  return requireArray(source, key, where).map((item, index) => {
    if (typeof item !== 'string' || item.length === 0) {
      fail('bad_string_item', `${where}.${key}[${index}] must be a non-empty string`)
    }
    return item
  })
}

// ---------------------------------------------------------------------------
// Term normalisation. The contract between this file and any consumer.
// ---------------------------------------------------------------------------

/**
 * The normalisation a hashed term commits to. Published as a constant so
 * packages/screening can reproduce it byte for byte; a hash set is worthless if
 * the two sides disagree about what they are hashing.
 *
 * NFKD, lowercase, diacritics stripped, everything outside [a-z0-9] collapsed
 * to single spaces, trimmed. Deliberately NOT leet-folded: leet folding belongs
 * in the scanner, which tries several folded views against this one canonical
 * form, rather than in the stored hash, which must be unambiguous.
 */
export const TERM_NORMALIZATION = 'nfkd-lower-strip-diacritics-alnum-space@v1'

export function normalizeTerm(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** sha256 of the normalised term. The only thing the hashed list stores. */
export function hashTerm(raw: string): string {
  const normalized = normalizeTerm(raw)
  if (normalized.length === 0) {
    fail('empty_term', 'a term that normalises to nothing cannot be hashed')
  }
  return sha256Hex(`${TERM_NORMALIZATION}|${normalized}`)
}

interface Token {
  text: string
  start: number
  end: number
}

function tokenize(raw: string): Token[] {
  const tokens: Token[] = []
  const pattern = /[A-Za-z0-9À-ɏ]+/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw)) !== null) {
    const text = normalizeTerm(match[0])
    if (text.length === 0) continue
    tokens.push({ text, start: match.index, end: match.index + match[0].length })
  }
  return tokens
}

// ---------------------------------------------------------------------------
// Hashed lexicon
// ---------------------------------------------------------------------------

export type HashedLexiconCategory = 'slur' | 'hate'

export interface HashedLexiconEntry {
  id: string
  category: HashedLexiconCategory
  termHash: string
  /** Words in the normalised term. Bounds the n-gram window the scanner needs. */
  tokenCount: number
}

export interface PlaintextPhrase {
  term: string
  category: HashedLexiconCategory
  note?: string
}

export interface HashedLexiconFile {
  schemaVersion: 1
  algorithm: 'sha256'
  normalization: string
  /**
   * 'unconfigured' means no operator slur list has been loaded. A deployment in
   * that state must raise `lexicon_unconfigured` and refuse paid media, exactly
   * as packages/screening already specifies. Missing list, no clearance.
   */
  status: 'unconfigured' | 'configured'
  revision: string
  publishedAtUnix: number
  entries: HashedLexiconEntry[]
  plaintextPhrases: PlaintextPhrase[]
  note?: string
}

export interface HashedLexiconHit {
  entryId: string
  category: HashedLexiconCategory
  /** Offsets into the ORIGINAL text. The matched term is never returned. */
  startOffset: number
  endOffset: number
}

export function parseHashedLexicon(raw: unknown, where: string): HashedLexiconFile {
  const file = asObject(raw, where)
  if (requireInt(file, 'schemaVersion', where) !== 1) {
    fail('unsupported_schema_version', `${where} declares an unsupported schemaVersion`)
  }
  if (requireString(file, 'algorithm', where) !== 'sha256') {
    fail('unsupported_algorithm', `${where} must use sha256`)
  }
  const normalization = requireString(file, 'normalization', where)
  if (normalization !== TERM_NORMALIZATION) {
    fail(
      'normalization_mismatch',
      `${where} was built under "${normalization}" but this build normalises as "${TERM_NORMALIZATION}"; ` +
        `the hashes would never match and every term would silently miss`,
    )
  }
  const status = requireString(file, 'status', where)
  if (status !== 'unconfigured' && status !== 'configured') {
    fail('bad_status', `${where}.status must be "unconfigured" or "configured"`)
  }

  const entries: HashedLexiconEntry[] = []
  const seenIds = new Set<string>()
  const seenHashes = new Set<string>()
  for (const [index, item] of requireArray(file, 'entries', where).entries()) {
    const entryWhere = `${where}.entries[${index}]`
    const source = asObject(item, entryWhere)
    const id = requireString(source, 'id', entryWhere)
    if (seenIds.has(id)) fail('duplicate_entry_id', `${entryWhere} duplicates id "${id}"`)
    seenIds.add(id)
    const category = requireString(source, 'category', entryWhere)
    if (category !== 'slur' && category !== 'hate') {
      fail('bad_category', `${entryWhere}.category must be "slur" or "hate"`)
    }
    const termHash = requireString(source, 'termHash', entryWhere)
    if (!/^[0-9a-f]{64}$/.test(termHash)) {
      fail('bad_term_hash', `${entryWhere}.termHash is not a sha256 digest`)
    }
    if (seenHashes.has(termHash)) {
      fail('duplicate_term_hash', `${entryWhere} duplicates a term already in the list`)
    }
    seenHashes.add(termHash)
    const tokenCount = requireInt(source, 'tokenCount', entryWhere)
    if (tokenCount < 1 || tokenCount > 8) {
      fail('bad_token_count', `${entryWhere}.tokenCount must be between 1 and 8`)
    }
    // A plaintext term here would defeat the entire point of the file.
    if ('term' in source) {
      fail(
        'plaintext_term_in_hashed_list',
        `${entryWhere} carries a plaintext "term"; the hashed list must never hold the string it hashes`,
      )
    }
    entries.push({ id, category, termHash, tokenCount })
  }

  const plaintextPhrases: PlaintextPhrase[] = []
  for (const [index, item] of requireArray(file, 'plaintextPhrases', where).entries()) {
    const phraseWhere = `${where}.plaintextPhrases[${index}]`
    const source = asObject(item, phraseWhere)
    const category = requireString(source, 'category', phraseWhere)
    if (category !== 'hate') {
      fail(
        'plaintext_slur',
        `${phraseWhere} is category "${category}"; only "hate" phrases may be published in plaintext, ` +
          `and a slur never may`,
      )
    }
    const phrase: PlaintextPhrase = { term: requireString(source, 'term', phraseWhere), category }
    if (typeof source.note === 'string') phrase.note = source.note
    plaintextPhrases.push(phrase)
  }

  const out: HashedLexiconFile = {
    schemaVersion: 1,
    algorithm: 'sha256',
    normalization,
    status,
    revision: requireString(file, 'revision', where),
    publishedAtUnix: requireInt(file, 'publishedAtUnix', where),
    entries,
    plaintextPhrases,
  }
  if (typeof file.note === 'string') out.note = file.note

  if (status === 'configured' && entries.length === 0) {
    fail('configured_but_empty', `${where} claims to be configured but holds no terms`)
  }
  return out
}

/**
 * Membership testing over hashed terms.
 *
 * Matching is n-gram exact rather than substring: a hash cannot be matched
 * partially. That is a real limitation and it is why this list is one input to
 * stage 1 rather than the whole of it - the plaintext phrase list and the
 * numeric-code scan in packages/screening cover the cases a hash set cannot.
 */
export class HashedLexicon {
  readonly #byHash = new Map<string, HashedLexiconEntry>()
  readonly #maxTokenCount: number
  readonly revision: string
  readonly status: 'unconfigured' | 'configured'

  constructor(file: HashedLexiconFile) {
    let max = 1
    for (const entry of file.entries) {
      this.#byHash.set(entry.termHash, entry)
      if (entry.tokenCount > max) max = entry.tokenCount
    }
    this.#maxTokenCount = max
    this.revision = file.revision
    this.status = file.status
  }

  /** Fail closed: an unconfigured list forbids paid media, it does not clear. */
  get isConfigured(): boolean {
    return this.status === 'configured'
  }

  get size(): number {
    return this.#byHash.size
  }

  hasHash(termHash: string): boolean {
    return this.#byHash.has(termHash)
  }

  hasTerm(term: string): boolean {
    return this.#byHash.has(hashTerm(term))
  }

  /** Every hit, by offset. The matched string is deliberately never returned. */
  scan(raw: string): HashedLexiconHit[] {
    const tokens = tokenize(raw)
    const hits: HashedLexiconHit[] = []
    for (let start = 0; start < tokens.length; start += 1) {
      for (let span = 1; span <= this.#maxTokenCount && start + span <= tokens.length; span += 1) {
        const window = tokens.slice(start, start + span)
        const first = window[0]
        const last = window[window.length - 1]
        if (first === undefined || last === undefined) continue
        const entry = this.#byHash.get(hashTerm(window.map((t) => t.text).join(' ')))
        if (entry === undefined) continue
        hits.push({
          entryId: entry.id,
          category: entry.category,
          startOffset: first.start,
          endOffset: last.end,
        })
      }
    }
    return hits
  }
}

// ---------------------------------------------------------------------------
// Trademark and public-figure list
// ---------------------------------------------------------------------------

export type MarkCategory = 'trademark' | 'public_figure'

/** Shaped so it can be handed straight to screening's `parseLexiconJson`. */
export interface MarkEntry {
  term: string
  category: MarkCategory
  requireBoundary?: boolean
  note?: string
}

export interface MarkListFile {
  schemaVersion: 1
  revision: string
  publishedAtUnix: number
  entries: MarkEntry[]
  note?: string
}

export function parseMarkList(raw: unknown, where: string): MarkListFile {
  const file = asObject(raw, where)
  if (requireInt(file, 'schemaVersion', where) !== 1) {
    fail('unsupported_schema_version', `${where} declares an unsupported schemaVersion`)
  }

  const entries: MarkEntry[] = []
  const seen = new Set<string>()
  for (const [index, item] of requireArray(file, 'entries', where).entries()) {
    const entryWhere = `${where}.entries[${index}]`
    const source = asObject(item, entryWhere)
    const term = requireString(source, 'term', entryWhere)
    const normalized = normalizeTerm(term)
    if (normalized.length === 0) {
      fail('empty_term', `${entryWhere}.term normalises to nothing`)
    }
    const category = requireString(source, 'category', entryWhere)
    // The file is confined to marks. A hate or slur term smuggled in here would
    // inherit RESTRICTED handling instead of BLOCKED.
    if (category !== 'trademark' && category !== 'public_figure') {
      fail(
        'bad_category',
        `${entryWhere}.category must be "trademark" or "public_figure"; this file carries marks only`,
      )
    }
    const key = `${category}:${normalized}`
    if (seen.has(key)) fail('duplicate_mark', `${entryWhere} duplicates "${term}"`)
    seen.add(key)

    const entry: MarkEntry = { term, category }
    // Short marks fire inside innocent words. The flag is required rather than
    // inferred so the decision is visible in the data.
    if (source.requireBoundary === true) entry.requireBoundary = true
    else if (normalized.replace(/ /g, '').length < 6 && source.requireBoundary !== false) {
      fail(
        'short_mark_without_boundary_decision',
        `${entryWhere} is short enough to match inside other words; set requireBoundary explicitly`,
      )
    }
    if (typeof source.note === 'string') entry.note = source.note
    entries.push(entry)
  }

  if (entries.length === 0) fail('empty_mark_list', `${where} lists no marks`)

  const out: MarkListFile = {
    schemaVersion: 1,
    revision: requireString(file, 'revision', where),
    publishedAtUnix: requireInt(file, 'publishedAtUnix', where),
    entries,
  }
  if (typeof file.note === 'string') out.note = file.note
  return out
}

// ---------------------------------------------------------------------------
// Drainer domains
// ---------------------------------------------------------------------------

export interface DrainerFeed {
  id: string
  uri: string
  /** How the feed is published, so the ingest script knows how to parse it. */
  format: 'hostlist_text' | 'json_array' | 'json_object'
  cadence: string
  note?: string
}

export interface DrainerHostEntry {
  host: string
  addedAtUnix: number
  sourceFeedId: string
  note?: string
}

export interface DrainerDomainFile {
  schemaVersion: 1
  /** 'unconfigured' until an operator feed has been ingested. Fails closed. */
  status: 'unconfigured' | 'configured'
  revision: string
  publishedAtUnix: number
  /** The durable half: shape-based rules that do not go stale. */
  structural: {
    blockPunycodeHosts: boolean
    blockRawIpHosts: boolean
    blockShorteners: boolean
    maxLookalikeEditDistance: number
    funnelPathTokens: string[]
  }
  /** Hosts whose entire purpose is hiding a destination. Not an accusation. */
  shorteners: string[]
  feeds: DrainerFeed[]
  /** Populated by the ingest script, never by hand. Empty on a fresh checkout. */
  operatorEntries: DrainerHostEntry[]
  note?: string
}

const FEED_FORMATS = ['hostlist_text', 'json_array', 'json_object'] as const

export function parseDrainerDomainFile(raw: unknown, where: string): DrainerDomainFile {
  const file = asObject(raw, where)
  if (requireInt(file, 'schemaVersion', where) !== 1) {
    fail('unsupported_schema_version', `${where} declares an unsupported schemaVersion`)
  }
  const status = requireString(file, 'status', where)
  if (status !== 'unconfigured' && status !== 'configured') {
    fail('bad_status', `${where}.status must be "unconfigured" or "configured"`)
  }

  const structuralWhere = `${where}.structural`
  const structuralSource = asObject(file.structural, structuralWhere)
  const maxLookalikeEditDistance = requireInt(
    structuralSource,
    'maxLookalikeEditDistance',
    structuralWhere,
  )
  if (maxLookalikeEditDistance < 1 || maxLookalikeEditDistance > 4) {
    fail(
      'bad_edit_distance',
      `${structuralWhere}.maxLookalikeEditDistance must be between 1 and 4; beyond that every host looks like every other`,
    )
  }
  const structural = {
    blockPunycodeHosts: requireBoolean(structuralSource, 'blockPunycodeHosts', structuralWhere),
    blockRawIpHosts: requireBoolean(structuralSource, 'blockRawIpHosts', structuralWhere),
    blockShorteners: requireBoolean(structuralSource, 'blockShorteners', structuralWhere),
    maxLookalikeEditDistance,
    funnelPathTokens: requireStringArray(structuralSource, 'funnelPathTokens', structuralWhere),
  }
  if (structural.funnelPathTokens.length === 0) {
    fail('no_funnel_tokens', `${structuralWhere}.funnelPathTokens is empty`)
  }

  const hostPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
  const shorteners = requireStringArray(file, 'shorteners', where).map((host, index) => {
    if (!hostPattern.test(host)) {
      fail('bad_host', `${where}.shorteners[${index}] ("${host}") is not a lowercase hostname`)
    }
    return host
  })

  const feeds: DrainerFeed[] = []
  const feedIds = new Set<string>()
  for (const [index, item] of requireArray(file, 'feeds', where).entries()) {
    const feedWhere = `${where}.feeds[${index}]`
    const source = asObject(item, feedWhere)
    const id = requireString(source, 'id', feedWhere)
    if (feedIds.has(id)) fail('duplicate_feed', `${feedWhere} duplicates feed id "${id}"`)
    feedIds.add(id)
    const format = requireString(source, 'format', feedWhere)
    if (!(FEED_FORMATS as readonly string[]).includes(format)) {
      fail('bad_feed_format', `${feedWhere}.format must be one of ${FEED_FORMATS.join(', ')}`)
    }
    const feed: DrainerFeed = {
      id,
      uri: requireString(source, 'uri', feedWhere),
      format: format as DrainerFeed['format'],
      cadence: requireString(source, 'cadence', feedWhere),
    }
    if (typeof source.note === 'string') feed.note = source.note
    feeds.push(feed)
  }
  if (feeds.length === 0) {
    fail(
      'no_feeds',
      `${where} names no ingest feed. A structural-only link policy is weaker than the operator thinks it is; ` +
        `name the feed even if it has not been loaded yet.`,
    )
  }

  const operatorEntries: DrainerHostEntry[] = []
  const seenHosts = new Set<string>()
  for (const [index, item] of requireArray(file, 'operatorEntries', where).entries()) {
    const entryWhere = `${where}.operatorEntries[${index}]`
    const source = asObject(item, entryWhere)
    const host = requireString(source, 'host', entryWhere).toLowerCase()
    if (!hostPattern.test(host)) {
      fail('bad_host', `${entryWhere}.host ("${host}") is not a lowercase hostname`)
    }
    if (seenHosts.has(host)) fail('duplicate_host', `${entryWhere} duplicates "${host}"`)
    seenHosts.add(host)
    const sourceFeedId = requireString(source, 'sourceFeedId', entryWhere)
    // Provenance is mandatory: an accusation with no source is one this
    // operator made up, and this list is consulted before removing a link.
    if (!feedIds.has(sourceFeedId)) {
      fail(
        'unknown_feed',
        `${entryWhere}.sourceFeedId "${sourceFeedId}" names no declared feed; every blocked host must cite its source`,
      )
    }
    const entry: DrainerHostEntry = {
      host,
      addedAtUnix: requireInt(source, 'addedAtUnix', entryWhere),
      sourceFeedId,
    }
    if (typeof source.note === 'string') entry.note = source.note
    operatorEntries.push(entry)
  }

  if (status === 'configured' && operatorEntries.length === 0) {
    fail('configured_but_empty', `${where} claims to be configured but has ingested no hosts`)
  }

  const out: DrainerDomainFile = {
    schemaVersion: 1,
    status,
    revision: requireString(file, 'revision', where),
    publishedAtUnix: requireInt(file, 'publishedAtUnix', where),
    structural,
    shorteners,
    feeds,
    operatorEntries,
  }
  if (typeof file.note === 'string') out.note = file.note
  return out
}

/** Exact host or any subdomain of it. */
export function hostMatches(host: string, listed: string): boolean {
  const subject = host.toLowerCase()
  return subject === listed || subject.endsWith(`.${listed}`)
}

export class DrainerHostList {
  readonly #blocked: string[]
  readonly #shorteners: string[]
  readonly status: 'unconfigured' | 'configured'
  readonly structural: DrainerDomainFile['structural']

  constructor(file: DrainerDomainFile) {
    this.#blocked = file.operatorEntries.map((entry) => entry.host)
    this.#shorteners = [...file.shorteners]
    this.status = file.status
    this.structural = file.structural
  }

  /** The operator feed is loaded. Until it is, the link policy is structural only. */
  get isConfigured(): boolean {
    return this.status === 'configured'
  }

  /** Hosts the desk should treat as known-bad. Feeds LinkPolicyOptions.blockedHosts. */
  get blockedHosts(): string[] {
    return [...this.#blocked]
  }

  get shorteners(): string[] {
    return [...this.#shorteners]
  }

  isBlocked(host: string): boolean {
    return this.#blocked.some((listed) => hostMatches(host, listed))
  }

  isShortener(host: string): boolean {
    return this.#shorteners.some((listed) => hostMatches(host, listed))
  }
}

// ---------------------------------------------------------------------------
// Refresh policy
// ---------------------------------------------------------------------------

export interface RefreshRule {
  listId: string
  /** Human cadence, e.g. "daily 06:00 UTC". Read by operators, not by cron. */
  cadence: string
  /** The machine-enforced half. Older than this and the list is not a list. */
  maxAgeSeconds: number
  source: string
  /**
   * What happens when the list is older than maxAgeSeconds. Every one of these
   * is a refusal of some kind; none of them is "carry on".
   */
  onStale: 'block_paid_media' | 'block_all_screening' | 'block_link_posting' | 'refuse_clear'
  note?: string
}

export interface RefreshPolicyFile {
  schemaVersion: 1
  publishedAtUnix: number
  rules: RefreshRule[]
  note?: string
}

const STALE_ACTIONS = [
  'block_paid_media',
  'block_all_screening',
  'block_link_posting',
  'refuse_clear',
] as const

export function parseRefreshPolicy(raw: unknown, where: string): RefreshPolicyFile {
  const file = asObject(raw, where)
  if (requireInt(file, 'schemaVersion', where) !== 1) {
    fail('unsupported_schema_version', `${where} declares an unsupported schemaVersion`)
  }
  const rules: RefreshRule[] = []
  const seen = new Set<string>()
  for (const [index, item] of requireArray(file, 'rules', where).entries()) {
    const ruleWhere = `${where}.rules[${index}]`
    const source = asObject(item, ruleWhere)
    const listId = requireString(source, 'listId', ruleWhere)
    if (seen.has(listId)) fail('duplicate_rule', `${ruleWhere} duplicates listId "${listId}"`)
    seen.add(listId)
    const maxAgeSeconds = requireInt(source, 'maxAgeSeconds', ruleWhere)
    if (maxAgeSeconds <= 0) {
      fail('bad_max_age', `${ruleWhere}.maxAgeSeconds must be positive; a list with no expiry never gets refreshed`)
    }
    const onStale = requireString(source, 'onStale', ruleWhere)
    if (!(STALE_ACTIONS as readonly string[]).includes(onStale)) {
      fail('bad_on_stale', `${ruleWhere}.onStale must be one of ${STALE_ACTIONS.join(', ')}`)
    }
    const rule: RefreshRule = {
      listId,
      cadence: requireString(source, 'cadence', ruleWhere),
      maxAgeSeconds,
      source: requireString(source, 'source', ruleWhere),
      onStale: onStale as RefreshRule['onStale'],
    }
    if (typeof source.note === 'string') rule.note = source.note
    rules.push(rule)
  }
  if (rules.length === 0) fail('no_rules', `${where} declares no refresh rules`)

  const out: RefreshPolicyFile = {
    schemaVersion: 1,
    publishedAtUnix: requireInt(file, 'publishedAtUnix', where),
    rules,
  }
  if (typeof file.note === 'string') out.note = file.note
  return out
}

export class RefreshPolicy {
  readonly #rules = new Map<string, RefreshRule>()

  constructor(file: RefreshPolicyFile) {
    for (const rule of file.rules) this.#rules.set(rule.listId, rule)
  }

  /** Fail closed: a list with no declared refresh rule is not a governed list. */
  rule(listId: string): RefreshRule {
    const rule = this.#rules.get(listId)
    if (rule === undefined) {
      fail('no_refresh_rule', `list "${listId}" has no declared refresh rule and may not be used`)
    }
    return rule
  }

  get listIds(): string[] {
    return [...this.#rules.keys()]
  }

  isStale(listId: string, publishedAtUnix: number, nowUnix: number): boolean {
    return nowUnix - publishedAtUnix > this.rule(listId).maxAgeSeconds
  }
}

// ---------------------------------------------------------------------------
// Disk loading
// ---------------------------------------------------------------------------

export interface ScreeningSeed {
  hashedLexicon: HashedLexicon
  hashedLexiconFile: HashedLexiconFile
  marks: MarkListFile
  drainerHosts: DrainerHostList
  drainerFile: DrainerDomainFile
  refreshPolicy: RefreshPolicy
  refreshPolicyFile: RefreshPolicyFile
}

export function loadScreeningSeed(dataDir?: string): ScreeningSeed {
  const dir = dataPaths(dataDir).screeningDir
  const lexiconPath = join(dir, 'hate-lexicon.json')
  const marksPath = join(dir, 'marks.json')
  const drainerPath = join(dir, 'drainer-domains.json')
  const policyPath = join(dir, 'refresh-policy.json')

  const hashedLexiconFile = parseHashedLexicon(readJsonFile(lexiconPath), lexiconPath)
  const marks = parseMarkList(readJsonFile(marksPath), marksPath)
  const drainerFile = parseDrainerDomainFile(readJsonFile(drainerPath), drainerPath)
  const refreshPolicyFile = parseRefreshPolicy(readJsonFile(policyPath), policyPath)

  const policy = new RefreshPolicy(refreshPolicyFile)
  // Every shipped list must be governed by a refresh rule. A list nobody
  // promised to refresh is a list that will be years old when it matters.
  for (const listId of ['hate_lexicon', 'marks', 'drainer_domains', 'ofac_sdn']) {
    policy.rule(listId)
  }

  return {
    hashedLexicon: new HashedLexicon(hashedLexiconFile),
    hashedLexiconFile,
    marks,
    drainerHosts: new DrainerHostList(drainerFile),
    drainerFile,
    refreshPolicy: policy,
    refreshPolicyFile,
  }
}
