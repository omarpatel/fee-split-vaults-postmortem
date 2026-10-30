/**
 * Text normalisation used by the refusal classifier and by moderation.
 *
 * The refusal classifier is a fail-closed OUTPUT classifier, not a prompt
 * instruction, so its resistance to rephrasing is a property of THIS file:
 * every evasion an attacker reaches for first - zero-width joiners, Cyrillic
 * homoglyphs, leetspeak, letter spacing, character repetition - is collapsed
 * here before a single pattern is evaluated.
 *
 * Four views are produced rather than one because folding is lossy in opposite
 * directions. Homoglyph folding maps Cyrillic to Latin, which destroys genuine
 * Russian text; leet folding maps digits to letters, which destroys "100x".
 * Patterns therefore declare the view they match against.
 */

/**
 * Invisible characters are removed by code-point test rather than by a regex
 * character class: the class would itself contain unprintable characters, and a
 * single mangled byte in this file silently reopens every zero-width evasion.
 */
function stripInvisible(input: string): string {
  let out = ""
  for (const ch of input) {
    const cp = ch.codePointAt(0)!
    if (cp < 0x20 && cp !== 0x0a && cp !== 0x09) continue
    if (cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) continue
    if (cp === 0xad || cp === 0x61c || cp === 0x180e || cp === 0xfeff) continue
    if (cp >= 0x200b && cp <= 0x200f) continue
    if (cp >= 0x202a && cp <= 0x202e) continue
    if (cp >= 0x2060 && cp <= 0x2064) continue
    if (cp >= 0x2066 && cp <= 0x206f) continue
    if (cp >= 0xe0000 && cp <= 0xe007f) continue
    out += ch
  }
  return out
}

/** Combining marks, stripped after NFKD so accents fold away. */
function stripCombining(input: string): string {
  let out = ""
  for (const ch of input) {
    const cp = ch.codePointAt(0)!
    if (cp >= 0x0300 && cp <= 0x036f) continue
    if (cp >= 0x1ab0 && cp <= 0x1aff) continue
    if (cp >= 0x1dc0 && cp <= 0x1dff) continue
    if (cp >= 0x20d0 && cp <= 0x20ff) continue
    if (cp >= 0xfe20 && cp <= 0xfe2f) continue
    out += ch
  }
  return out
}

/**
 * Script-confusable characters mapped to their Latin lookalike. Deliberately
 * one-directional and lossy: only ever applied to the `folded` view.
 */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  // Cyrillic
  'а': 'a', 'б': 'b', 'в': 'b', 'г': 'r', 'ԁ': 'd', 'е': 'e',
  'ѐ': 'e', 'ё': 'e', 'з': '3', 'и': 'u', 'і': 'i', 'ї': 'i',
  'й': 'u', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'п': 'n',
  'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'ф': 'o', 'х': 'x',
  'ѕ': 's', 'ј': 'j', 'ԛ': 'q', 'ѡ': 'w', 'ѵ': 'v', 'һ': 'h',
  // Greek
  'α': 'a', 'β': 'b', 'γ': 'y', 'δ': 'd', 'ε': 'e', 'ζ': 'z',
  'η': 'n', 'θ': 'o', 'ι': 'i', 'κ': 'k', 'λ': 'l', 'μ': 'm',
  'ν': 'v', 'ξ': 'e', 'ο': 'o', 'π': 'n', 'ρ': 'p', 'σ': 's',
  'ς': 's', 'τ': 't', 'υ': 'u', 'φ': 'o', 'χ': 'x', 'ψ': 'y',
  'ω': 'w',
  // Latin extended and symbol lookalikes
  'ı': 'i', 'ǀ': 'l', 'ɩ': 'i', 'ɑ': 'a', 'ɡ': 'g', 'ʀ': 'r',
  'ʟ': 'l', 'ø': 'o', 'œ': 'oe', 'æ': 'ae', 'ß': 'ss', 'ð': 'd',
  'þ': 'p', 'ł': 'l', 'đ': 'd', 'ħ': 'h', 'ƶ': 'z',
  '‐': '-', '‑': '-', '–': '-', '—': '-', '․': '.', '。': '.',
}

/** Applied only to the `deleet` view, where digits are expected to be letters. */
const LEET: Readonly<Record<string, string>> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
  $: 's', '@': 'a', '!': 'i', '|': 'l', '+': 't', '¢': 'c', '€': 'e', '£': 'l',
}

export interface NormalizedText {
  /** Exactly as received. Never matched against; kept for the audit log. */
  original: string
  /** NFKC, invisibles stripped, lowercased, whitespace collapsed. Script-preserving. */
  lower: string
  /** `lower` + accents stripped + homoglyphs folded to Latin + runs collapsed to 2. */
  folded: string
  /** `folded` + leetspeak folded. Digits are gone; never match amounts here. */
  deleet: string
  /**
   * `deleet` with every non-alphanumeric removed AND every run of a repeated
   * character collapsed to one. Defeats l e t t e r  s p a c i n g and
   * "shooooould i buuuy" in the same step.
   *
   * Patterns matched against this view must be run through foldPattern(), so
   * that the pattern and the text are collapsed the same way.
   */
  squeezed: string
}

function mapChars(input: string, table: Readonly<Record<string, string>>): string {
  let out = ''
  for (const ch of input) out += table[ch] ?? ch
  return out
}

/** Collapse any run of 3+ identical characters to 2. "wennnn" -> "wenn". */
function collapseRuns(input: string): string {
  return input.replace(/(.)\1{2,}/gu, '$1$1')
}

/**
 * Collapse repeated literal characters in a pattern the same way the squeezed
 * view collapses them in text. Only runs of identical alphanumerics are
 * touched, so quantifiers, escapes and groups survive untouched.
 *
 * Without this, "should i selllll" normalises to "shouldisel" and a pattern
 * written as "shouldisell" silently stops matching - which is a refusal that
 * a stretched vowel can walk through.
 */
export function foldPattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source.replace(/([a-z0-9])\1+/g, '$1'), pattern.flags)
}

export function normalize(input: string): NormalizedText {
  const lower = stripInvisible(input.normalize('NFKC'))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

  const folded = collapseRuns(mapChars(stripCombining(lower.normalize('NFKD')), HOMOGLYPHS))
  const deleet = mapChars(folded, LEET)
  const squeezed = deleet.replace(/[^a-z0-9]+/g, '').replace(/([a-z0-9])\1+/g, '$1')

  return { original: input, lower, folded, deleet, squeezed }
}

/** Levenshtein distance, capped so a long pair cannot burn CPU. */
export function editDistance(a: string, b: string, cap = 8): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  const prev = new Array<number>(b.length + 1)
  const curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    let rowMin = curr[0]!
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost)
      rowMin = Math.min(rowMin, curr[j]!)
    }
    if (rowMin > cap) return cap + 1
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!
  }
  return prev[b.length]!
}

/** 0..1 similarity on the squeezed view. Used for impersonator detection. */
export function similarity(a: string, b: string): number {
  const na = normalize(a).squeezed
  const nb = normalize(b).squeezed
  if (na.length === 0 && nb.length === 0) return 1
  const longest = Math.max(na.length, nb.length)
  if (longest === 0) return 0
  const d = editDistance(na, nb, longest)
  return Math.max(0, 1 - d / longest)
}

export type LanguageCode = 'en' | 'es' | 'pt' | 'fr' | 'de' | 'ru' | 'tr' | 'zh' | 'ja' | 'ko'

const SCRIPT_TESTS: Array<[RegExp, LanguageCode]> = [
  [/[぀-ヿ]/, 'ja'],
  [/[가-힯ᄀ-ᇿ]/, 'ko'],
  [/[一-鿿]/, 'zh'],
  [/[Ѐ-ӿ]/, 'ru'],
]

/** Distinctive stopwords. Deterministic - no model is used to pick a language. */
const STOPWORDS: Array<[LanguageCode, readonly string[]]> = [
  ['es', ['que', 'como', 'donde', 'cuando', 'porque', 'para', 'esto', 'esta', 'puedo', 'quien']],
  ['pt', ['que', 'como', 'onde', 'quando', 'porque', 'para', 'isso', 'voce', 'posso', 'nao']],
  ['fr', ['que', 'comment', 'ou', 'quand', 'pourquoi', 'pour', 'cette', 'je', 'vous', 'est']],
  ['de', ['was', 'wie', 'wo', 'wann', 'warum', 'fur', 'diese', 'ich', 'nicht', 'ist']],
  ['tr', ['ne', 'nasil', 'nerede', 'nicin', 'icin', 'bu', 'ben', 'degil']],
  ['en', ['what', 'how', 'where', 'when', 'why', 'the', 'this', 'is', 'can', 'you']],
]

/**
 * Best-effort language detection for choosing a pre-translated, code-owned
 * template. It never affects WHETHER a refusal fires - only which fixed string
 * is emitted - so a wrong guess degrades wording, never safety.
 */
export function detectLanguage(text: string): LanguageCode {
  for (const [re, lang] of SCRIPT_TESTS) if (re.test(text)) return lang
  const { folded } = normalize(text)
  const words = new Set(folded.split(/[^a-z]+/).filter(Boolean))
  let best: LanguageCode = 'en'
  let bestScore = 0
  for (const [lang, list] of STOPWORDS) {
    let score = 0
    for (const w of list) if (words.has(w)) score++
    if (score > bestScore) {
      bestScore = score
      best = lang
    }
  }
  return best
}
