/**
 * Evasion-resistant text folding.
 *
 * Token metadata is attacker-authored and the attacker knows a lexicon exists.
 * The four evasions that actually appear in the wild are unicode homoglyphs
 * (Cyrillic "а" for Latin "a"), leetspeak, zero-width and bidi splitting, and
 * separator injection ("s.l.u.r"). All four are defeated the same way: fold
 * everything to a dense lowercase Latin skeleton and match terms folded by the
 * SAME function, so the term list never has to enumerate variants.
 *
 * Every fold keeps a map back to the original code-unit offsets, because a flag
 * without a citable span is not reviewable by a human at the paid-media gate.
 */

/** Result of a fold: the skeleton plus, per output char, its source offset. */
export interface FoldedText {
  text: string
  /** map[i] is the index in the ORIGINAL string that produced text[i]. */
  map: number[]
}

export interface FoldOptions {
  /** Fold digits and symbols onto the letters they imitate. */
  leet?: boolean
  /** Drop everything that is not a letter (or digit, when kept). */
  squeeze?: boolean
  /** Collapse runs of the same character to one. Defeats "sluuuur". */
  collapseRepeats?: boolean
  /** Only meaningful with squeeze. Numeric codes need digits preserved. */
  keepDigits?: boolean
}

const COMBINING = /\p{M}/u
const LETTER = /[a-z]/
const DIGIT = /[0-9]/

/**
 * Format controls, zero-width characters, bidi overrides, variation selectors
 * and tag characters. All of these render as nothing and all of them have been
 * used to split a blocked term into two unblocked halves.
 */
function isInvisible(cp: string): boolean {
  const code = cp.codePointAt(0)
  if (code === undefined) return true
  if (code <= 0x08) return true
  if (code >= 0x0b && code <= 0x1f) return true
  if (code >= 0x7f && code <= 0x9f) return true
  if (code === 0x00ad) return true // soft hyphen
  if (code === 0x034f) return true // combining grapheme joiner
  if (code === 0x061c) return true // arabic letter mark
  if (code === 0x180e) return true // mongolian vowel separator
  if (code >= 0x200b && code <= 0x200f) return true // ZWSP, ZWNJ, ZWJ, LRM, RLM
  if (code >= 0x202a && code <= 0x202e) return true // bidi embedding/override
  if (code >= 0x2060 && code <= 0x2064) return true // word joiner, invisible ops
  if (code >= 0x2066 && code <= 0x206f) return true // bidi isolates, deprecated
  if (code >= 0xfe00 && code <= 0xfe0f) return true // variation selectors
  if (code === 0xfeff) return true // BOM / ZWNBSP
  if (code >= 0xfff9 && code <= 0xfffb) return true // interlinear annotation
  if (code >= 0xe0000 && code <= 0xe007f) return true // tag characters
  if (code >= 0xe0100 && code <= 0xe01ef) return true // variation selectors sup.
  return false
}

/**
 * Homoglyph folding for scripts that render as Latin. NFKD already handles
 * fullwidth, mathematical alphanumerics, circled letters, ligatures and
 * diacritics; this table covers the cross-script lookalikes it does not.
 */
const CONFUSABLES = new Map<string, string>(
  Object.entries({
    // Cyrillic
    а: 'a', б: 'b', в: 'b', г: 'r', д: 'd', е: 'e', ж: 'x', з: '3', и: 'u',
    й: 'u', к: 'k', л: 'n', м: 'm', н: 'h', о: 'o', п: 'n', р: 'p', с: 'c',
    т: 't', у: 'y', ф: 'o', х: 'x', ц: 'u', ч: 'y', ш: 'w', щ: 'w', ъ: 'b',
    ы: 'b', ь: 'b', э: 'e', ю: 'io', я: 'r', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd',
    ԛ: 'q', ԝ: 'w', ғ: 'f', ҫ: 'c', ү: 'y', ҳ: 'x', ө: 'o', ӏ: 'l',
    // Greek
    α: 'a', β: 'b', γ: 'y', δ: 'd', ε: 'e', ζ: 'z', η: 'n', θ: 'o', ι: 'i',
    κ: 'k', λ: 'l', μ: 'u', ν: 'v', ξ: 'e', ο: 'o', π: 'n', ρ: 'p', σ: 'o',
    ς: 'c', τ: 't', υ: 'u', φ: 'o', χ: 'x', ψ: 'y', ω: 'w',
    // Latin extended and phonetic lookalikes NFKD leaves alone
    ı: 'i', ł: 'l', ø: 'o', đ: 'd', ð: 'd', þ: 'p', ŋ: 'n', ſ: 's', ɑ: 'a',
    ɐ: 'a', ɓ: 'b', ƈ: 'c', ɗ: 'd', ɘ: 'e', ɛ: 'e', ɡ: 'g', ɢ: 'g',
    ɥ: 'h', ɦ: 'h', ɩ: 'i', ɪ: 'i', ʝ: 'j', ĸ: 'k', ʟ: 'l', ɱ: 'm', ɴ: 'n',
    ɵ: 'o', ᴏ: 'o', ᴀ: 'a', ᴃ: 'b', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ᴊ: 'j', ᴋ: 'k',
    ᴍ: 'm', ᴘ: 'p', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ʏ: 'y', ᴢ: 'z',
    ʀ: 'r', ʁ: 'r', ʃ: 's', ʈ: 't', ʉ: 'u', ʌ: 'v', ʍ: 'w', ʎ: 'y', ʐ: 'z',
    æ: 'ae', œ: 'oe', ß: 'ss',
    // Armenian, Georgian, Cherokee lookalikes
    օ: 'o', ց: 'g', տ: 'un', ք: 'p', ո: 'n', Ꭺ: 'a', Ꮯ: 'c', Ꭼ: 'e', Ꮋ: 'h',
    Ꮶ: 'k', Ꮮ: 'l', Ꮇ: 'm', Ꮎ: 'o', Ꮲ: 'p', Ꮪ: 's', Ꭲ: 'i', Ꮤ: 'w', Ꮍ: 'y',
    // Full-width symbols NFKD maps, plus the few it does not
    '＠': '@', '．': '.', '｡': '.',
  }),
)

/** Leet substitutions. Applied only on views where digits are not load-bearing. */
const LEET = new Map<string, string>(
  Object.entries({
    '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't',
    '8': 'b', '9': 'g', '@': 'a', $: 's', '!': 'i', '|': 'l', '+': 't',
    '(': 'c', '<': 'c', '£': 'l', '€': 'e', '¥': 'y', '§': 's', '¢': 'c',
  }),
)

/**
 * Fold a string to a matching skeleton. Terms are folded with the same options
 * as the text they are matched against; that identity is the whole design.
 */
export function fold(raw: string, opts: FoldOptions = {}): FoldedText {
  const keepDigits = opts.keepDigits ?? true
  const chars: string[] = []
  const map: number[] = []
  let offset = 0

  for (const cp of raw) {
    const at = offset
    offset += cp.length
    if (isInvisible(cp)) continue

    for (const decomposed of cp.normalize('NFKD')) {
      if (COMBINING.test(decomposed)) continue
      const mapped = CONFUSABLES.get(decomposed) ?? decomposed
      let expanded = mapped.toLowerCase()
      if (opts.leet === true) {
        expanded = [...expanded].map((c) => LEET.get(c) ?? c).join('')
      }
      for (const out of expanded) {
        if (opts.squeeze === true) {
          const keep = LETTER.test(out) || (keepDigits && DIGIT.test(out))
          if (!keep) continue
        }
        if (opts.collapseRepeats === true && chars[chars.length - 1] === out) continue
        chars.push(out)
        map.push(at)
      }
    }
  }

  return { text: chars.join(''), map }
}

/**
 * The view the term automaton runs against: letters only, leet folded, repeats
 * collapsed, all separators gone. "s-l-u-r", "5LUR" and "ѕ l u r" all land here
 * as the same skeleton.
 */
export const DENSE_FOLD: FoldOptions = {
  leet: true,
  squeeze: true,
  collapseRepeats: true,
  keepDigits: false,
}

/**
 * The view numeric hate codes run against. Leet folding is off and repeats are
 * preserved, because "1488" must survive as digits and "88" must not collapse.
 */
export const NUMERIC_FOLD: FoldOptions = {
  leet: false,
  squeeze: true,
  collapseRepeats: false,
  keepDigits: true,
}

/**
 * The view name matching runs against: separators preserved so names can be
 * tokenised, but homoglyphs and diacritics folded away.
 */
export const WORD_FOLD: FoldOptions = {
  leet: false,
  squeeze: false,
  collapseRepeats: false,
  keepDigits: true,
}

export function foldDense(raw: string): FoldedText {
  return fold(raw, DENSE_FOLD)
}

export function foldTerm(term: string): string {
  return fold(term, DENSE_FOLD).text
}

/** Word tokens for name matching. Empty tokens are dropped. */
export function wordTokens(raw: string): string[] {
  return fold(raw, WORD_FOLD)
    .text.split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
}

/**
 * True when the original span is not glued to an alphanumeric neighbour.
 * Short terms require this, or "nike" fires inside "unikernel".
 */
export function hasWordBoundary(raw: string, startOffset: number, endOffset: number): boolean {
  const before = startOffset > 0 ? raw.slice(0, startOffset) : ''
  const after = raw.slice(endOffset)
  const beforeChar = [...fold(before, WORD_FOLD).text].pop() ?? ''
  const afterChar = [...fold(after, WORD_FOLD).text][0] ?? ''
  const glued = (c: string): boolean => c !== '' && /[a-z0-9]/.test(c)
  return !glued(beforeChar) && !glued(afterChar)
}

/**
 * True when the original span contains a separator the fold removed. Deliberate
 * splitting ("n.i.k.e") is itself evidence, so such a hit keeps its boundary
 * exemption.
 */
export function spanWasSplit(raw: string, startOffset: number, endOffset: number): boolean {
  return /[^\p{L}\p{N}]/u.test(raw.slice(startOffset, endOffset))
}

/** A bounded window of the ORIGINAL text around a match, for human review. */
export function excerpt(raw: string, startOffset: number, endOffset: number, pad = 32): string {
  const start = Math.max(0, startOffset - pad)
  const end = Math.min(raw.length, endOffset + pad)
  return raw.slice(start, end)
}
