/**
 * Stage 1 lexicon: deterministic, pure, no network, sub-millisecond.
 *
 * WHY THE SLUR LIST IS NOT IN THIS REPOSITORY. A slur and hate lexicon is an
 * operational artefact, not source code: it is jurisdiction-specific, it churns
 * weekly, and checking it into a public repository publishes an evasion guide.
 * It is loaded through `LexiconSource` from operator-controlled storage. The
 * in-repo default carries the categories that are safe to publish (ideological
 * phrases, tragedy, sexual, trademark, public figure) and NO raw slurs, and a
 * deployment with no slur source configured raises `lexicon_unconfigured`,
 * which forbids paid media until it is configured. Missing list, no clearance.
 */

import {
  DENSE_FOLD,
  fold,
  foldTerm,
  hasWordBoundary,
  spanWasSplit,
  NUMERIC_FOLD,
} from './normalize.js'
import { TermMatcher, type TermSpec } from './matcher.js'

export const LEXICON_CATEGORIES = [
  'hate',
  'slur',
  'tragedy',
  'sexual_explicit',
  'sexual_suggestive',
  'minor_reference',
  'violence',
  'trademark',
  'public_figure',
  'official_claim',
] as const

export type LexiconCategory = (typeof LEXICON_CATEGORIES)[number]

export interface LexiconEntry {
  term: string
  category: LexiconCategory
  /**
   * Force the word-boundary rule on a term long enough to skip it. Set on terms
   * that live inside their own negation: "official" inside "unofficial",
   * "authorized" inside "unauthorized".
   */
  requireBoundary?: boolean
  /** Operator note. Never rendered into public output. */
  note?: string
}

export interface LexiconSource {
  entries(): readonly LexiconEntry[]
  /** Provenance for the audit trail. */
  revision(): string
}

export interface CategoryHit {
  category: LexiconCategory
  term: string
  /** Offsets into the ORIGINAL text, for a citable excerpt. */
  startOffset: number
  endOffset: number
}

/**
 * Terms shorter than this must sit on a word boundary in the original text, or
 * they fire inside innocent words ("nike" inside "unikernel"). A term that was
 * split by the author ("n.i.k.e") keeps its hit regardless: deliberate
 * splitting is itself evidence.
 */
const SHORT_TERM_LENGTH = 6

/**
 * The publishable half of the lexicon. Ideological phrases rather than slurs,
 * so the file is safe to read; the slur list arrives via LexiconSource.
 */
export const DEFAULT_LEXICON: readonly LexiconEntry[] = [
  // Hate: phrases whose only reading is the hateful one.
  { term: 'heil hitler', category: 'hate' },
  { term: 'sieg heil', category: 'hate' },
  { term: 'white power', category: 'hate' },
  { term: 'racial holy war', category: 'hate' },
  { term: 'blood and soil', category: 'hate' },
  { term: 'gas the', category: 'hate' },
  { term: 'kill all the', category: 'hate' },
  { term: 'final solution for', category: 'hate' },
  { term: 'master race', category: 'hate' },

  // Tragedy exploitation: a coin named for someone else's worst day.
  { term: 'school shooting', category: 'tragedy' },
  { term: 'mass shooting', category: 'tragedy' },
  { term: 'terror attack', category: 'tragedy' },
  { term: 'death toll', category: 'tragedy' },
  { term: 'plane crash', category: 'tragedy' },
  { term: 'earthquake victims', category: 'tragedy' },
  { term: 'hurricane victims', category: 'tragedy' },
  { term: 'tsunami victims', category: 'tragedy' },
  { term: 'war victims', category: 'tragedy' },
  { term: 'memorial fund', category: 'tragedy' },
  { term: 'rest in peace', category: 'tragedy' },
  { term: 'died today', category: 'tragedy' },
  { term: 'genocide', category: 'tragedy' },

  // Sexual content.
  { term: 'porn', category: 'sexual_explicit' },
  { term: 'hardcore xxx', category: 'sexual_explicit' },
  { term: 'onlyfans', category: 'sexual_explicit' },
  { term: 'sex tape', category: 'sexual_explicit' },
  { term: 'escort service', category: 'sexual_explicit' },
  { term: 'hentai', category: 'sexual_explicit' },
  { term: 'nudes', category: 'sexual_explicit' },
  { term: 'sexy', category: 'sexual_suggestive' },
  { term: 'lingerie', category: 'sexual_suggestive' },
  { term: 'strip club', category: 'sexual_suggestive' },

  // Minor references. Never a flag alone - only in combination, see stage1.
  { term: 'underage', category: 'minor_reference' },
  { term: 'preteen', category: 'minor_reference' },
  { term: 'schoolgirl', category: 'minor_reference' },
  { term: 'jailbait', category: 'minor_reference' },
  { term: 'loli', category: 'minor_reference' },
  { term: 'shota', category: 'minor_reference' },
  { term: 'toddler', category: 'minor_reference' },
  { term: 'kindergarten', category: 'minor_reference' },
  { term: 'middle school', category: 'minor_reference' },

  // Violence and self-harm.
  { term: 'kill yourself', category: 'violence' },
  { term: 'kys', category: 'violence' },
  { term: 'shoot up the', category: 'violence' },
  { term: 'bomb the', category: 'violence' },
  { term: 'assassinate', category: 'violence' },
  { term: 'behead', category: 'violence' },

  // Trademarks. RESTRICTED, not blocked: parody and nominative use exist, but
  // never on paid media without a human.
  { term: 'disney', category: 'trademark' },
  { term: 'pokemon', category: 'trademark' },
  { term: 'nintendo', category: 'trademark' },
  { term: 'coca cola', category: 'trademark' },
  { term: 'mcdonalds', category: 'trademark' },
  { term: 'ferrari', category: 'trademark' },
  { term: 'louis vuitton', category: 'trademark' },
  { term: 'star wars', category: 'trademark' },
  { term: 'harry potter', category: 'trademark' },
  { term: 'netflix', category: 'trademark' },
  { term: 'marvel', category: 'trademark' },
  { term: 'binance', category: 'trademark' },
  { term: 'coinbase', category: 'trademark' },
  { term: 'openai', category: 'trademark' },
  { term: 'chatgpt', category: 'trademark' },
  { term: 'anthropic', category: 'trademark' },
  { term: 'nike', category: 'trademark' },

  // Public figures.
  { term: 'elon musk', category: 'public_figure' },
  { term: 'donald trump', category: 'public_figure' },
  { term: 'joe biden', category: 'public_figure' },
  { term: 'vladimir putin', category: 'public_figure' },
  { term: 'taylor swift', category: 'public_figure' },
  { term: 'warren buffett', category: 'public_figure' },
  { term: 'barack obama', category: 'public_figure' },
  { term: 'kanye west', category: 'public_figure' },
  { term: 'lionel messi', category: 'public_figure' },
  { term: 'cristiano ronaldo', category: 'public_figure' },
  { term: 'mrbeast', category: 'public_figure' },

  // Claims of authority. Alone these are noise; with a mark they are the
  // difference between parody and impersonation.
  { term: 'official', category: 'official_claim', requireBoundary: true },
  { term: 'verified', category: 'official_claim', requireBoundary: true },
  { term: 'licensed by', category: 'official_claim' },
  { term: 'endorsed by', category: 'official_claim' },
  { term: 'partnered with', category: 'official_claim' },
  { term: 'in partnership with', category: 'official_claim' },
  { term: 'authorized', category: 'official_claim', requireBoundary: true },
]

/**
 * Numeric hate codes. Matched on the digit-preserving view, so leet folding
 * cannot erase them and repeat collapsing cannot turn "88" into "8".
 *
 * `requiresCorroboration` codes are common enough as ordinary numbers that they
 * only count alongside another hate hit.
 */
export const NUMERIC_HATE_CODES: ReadonlyArray<{
  digits: string
  requiresCorroboration: boolean
}> = [
  { digits: '1488', requiresCorroboration: false },
  { digits: '8814', requiresCorroboration: false },
  { digits: '1352', requiresCorroboration: true },
  { digits: '88', requiresCorroboration: true },
  { digits: '14', requiresCorroboration: true },
]

export class StaticLexiconSource implements LexiconSource {
  constructor(
    private readonly items: readonly LexiconEntry[],
    private readonly rev: string,
  ) {}

  entries(): readonly LexiconEntry[] {
    return this.items
  }

  revision(): string {
    return this.rev
  }
}

export const DEFAULT_LEXICON_SOURCE: LexiconSource = new StaticLexiconSource(
  DEFAULT_LEXICON,
  'builtin-default',
)

/** Parse an operator-supplied list. Fail closed on any unknown category. */
export function parseLexiconJson(raw: unknown): LexiconEntry[] {
  if (!Array.isArray(raw)) throw new Error('lexicon: expected an array of entries')
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`lexicon: entry ${index} is not an object`)
    }
    const record = item as Record<string, unknown>
    const term = record.term
    const category = record.category
    if (typeof term !== 'string' || term.trim().length === 0) {
      throw new Error(`lexicon: entry ${index} has no term`)
    }
    if (
      typeof category !== 'string' ||
      !(LEXICON_CATEGORIES as readonly string[]).includes(category)
    ) {
      throw new Error(`lexicon: entry ${index} has unknown category "${String(category)}"`)
    }
    const entry: LexiconEntry = { term, category: category as LexiconCategory }
    if (record.requireBoundary === true) entry.requireBoundary = true
    if (typeof record.note === 'string') entry.note = record.note
    return entry
  })
}

export class Lexicon {
  private readonly matcher: TermMatcher
  private readonly byId: Map<string, LexiconEntry>
  readonly revisions: string[]
  readonly categoriesPresent: Set<LexiconCategory>

  constructor(sources: readonly LexiconSource[]) {
    const specs: TermSpec[] = []
    this.byId = new Map()
    this.revisions = []
    this.categoriesPresent = new Set()

    for (const source of sources) {
      this.revisions.push(source.revision())
      for (const entry of source.entries()) {
        const id = `${entry.category}:${entry.term}`
        if (this.byId.has(id)) continue
        this.byId.set(id, entry)
        this.categoriesPresent.add(entry.category)
        specs.push({ id, term: entry.term })
      }
    }

    this.matcher = TermMatcher.compile(specs, foldTerm)
  }

  get termCount(): number {
    return this.matcher.size
  }

  /** True when a category has at least one term loaded. */
  has(category: LexiconCategory): boolean {
    return this.categoriesPresent.has(category)
  }

  /**
   * Scan raw untrusted text. Pure: no I/O, no allocation beyond the hit list.
   */
  scan(raw: string): CategoryHit[] {
    const dense = fold(raw, DENSE_FOLD)
    const hits: CategoryHit[] = []

    for (const match of this.matcher.findAll(dense.text)) {
      const entry = this.byId.get(match.id)
      if (entry === undefined) continue
      const startOffset = dense.map[match.start]
      const lastOffset = dense.map[match.end - 1]
      if (startOffset === undefined || lastOffset === undefined) continue
      const endOffset = lastOffset + 1

      const folded = foldTerm(entry.term)
      const needsBoundary = entry.requireBoundary === true || folded.length < SHORT_TERM_LENGTH
      if (needsBoundary) {
        const boundary = hasWordBoundary(raw, startOffset, endOffset)
        if (!boundary && !spanWasSplit(raw, startOffset, endOffset)) continue
      }

      hits.push({ category: entry.category, term: entry.term, startOffset, endOffset })
    }

    return hits
  }

  /**
   * Numeric hate codes, on the digit-preserving view. Returns the codes found;
   * corroboration is applied by the caller, which knows the other hits.
   */
  scanNumericCodes(raw: string): Array<{ digits: string; requiresCorroboration: boolean }> {
    const view = fold(raw, NUMERIC_FOLD)
    const found: Array<{ digits: string; requiresCorroboration: boolean }> = []
    for (const code of NUMERIC_HATE_CODES) {
      let from = 0
      for (;;) {
        const at = view.text.indexOf(code.digits, from)
        if (at < 0) break
        from = at + 1
        const before = view.text[at - 1]
        const after = view.text[at + code.digits.length]
        const glued = (c: string | undefined): boolean => c !== undefined && /[0-9]/.test(c)
        if (glued(before) || glued(after)) continue
        found.push(code)
        break
      }
    }
    return found
  }
}
