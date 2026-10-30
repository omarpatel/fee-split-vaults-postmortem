/**
 * The language gate. The desk answers in English only, and it says so rather
 * than guessing at a language it cannot verify a template for.
 *
 * Detection is DETERMINISTIC - no model is consulted. A model asked "is this
 * English?" is a model reading attacker-controlled text, and the gate runs
 * before every other reader of the message. The rule is two cheap signals:
 *
 *   1. Unicode script buckets. Letters are counted per script on the
 *      NFKC-normalised, invisible-stripped view, so a fullwidth "ｗｈａｔ"
 *      counts as Latin and a zero-width joiner cannot hide a script. A message
 *      whose letters are one third or more non-Latin is not English.
 *   2. A stopword ratio for Latin text. Folded words are checked against a
 *      small English list and a small list of function words distinctive to
 *      the Latin-script languages a token chat actually sees. Foreign evidence
 *      outweighing English evidence is a refusal; a tie or no evidence at all
 *      passes, because the gate is a courtesy, not a control.
 *
 * Things that are not language pass through untouched: slash commands,
 * addresses, tickers, links, emoji, and anything under three words. Those are
 * the messages a holder sends most, and none of them has a language to refuse.
 *
 * The gate never makes the desk say MORE. Everything after it - the refusal
 * classifier, grounding, disclosure - still runs on whatever passes.
 */

import { ADDRESS_LIKE_SOURCE } from '@fee-split-vaults/core'
import { normalize } from './text/normalize.js'

export type LanguageVerdict = 'english' | 'agnostic' | 'unsupported'

export type LanguageReason =
  /** Slash command; the command table decides what it means. */
  | 'command'
  /** No letters at all: an address, a ticker, a link, emoji, a number. */
  | 'symbols'
  /** Fewer than three words, so no ratio is meaningful. */
  | 'short'
  /** Latin words carried more English evidence than foreign, or no evidence. */
  | 'latin_english'
  /** Latin words carried more foreign evidence than English. */
  | 'latin_foreign'
  /** A third or more of the letters are in a non-Latin script. */
  | 'script'
  /** Some non-Latin letters and no clear English around them. */
  | 'mixed_script'

export type ScriptBucket =
  | 'latin'
  | 'cyrillic'
  | 'greek'
  | 'arabic'
  | 'hebrew'
  | 'han'
  | 'kana'
  | 'hangul'
  | 'devanagari'
  | 'bengali'
  | 'thai'
  | 'armenian'
  | 'georgian'
  | 'other'

export interface LanguageDecision {
  verdict: LanguageVerdict
  reason: LanguageReason
  /** The most frequent script among the letters; absent when there are none. */
  script?: ScriptBucket
  /** Latin words compared against the stopword lists. */
  words: number
  english: number
  foreign: number
}

const SCRIPT_TESTS: ReadonlyArray<readonly [RegExp, ScriptBucket]> = [
  [/\p{Script=Latin}/u, 'latin'],
  [/\p{Script=Cyrillic}/u, 'cyrillic'],
  [/\p{Script=Greek}/u, 'greek'],
  [/\p{Script=Arabic}/u, 'arabic'],
  [/\p{Script=Hebrew}/u, 'hebrew'],
  [/\p{Script=Han}/u, 'han'],
  [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, 'kana'],
  [/\p{Script=Hangul}/u, 'hangul'],
  [/\p{Script=Devanagari}/u, 'devanagari'],
  [/\p{Script=Bengali}/u, 'bengali'],
  [/\p{Script=Thai}/u, 'thai'],
  [/\p{Script=Armenian}/u, 'armenian'],
  [/\p{Script=Georgian}/u, 'georgian'],
]

const LETTER = /\p{L}/u

function scriptOf(ch: string): ScriptBucket {
  for (const [re, bucket] of SCRIPT_TESTS) if (re.test(ch)) return bucket
  return 'other'
}

/** Not language: stripped before anything is counted. */
const NOT_LANGUAGE = [
  /https?:\/\/\S+/g,
  /\b[a-z0-9-]+\.(?:com|io|xyz|app|org|net|fi|me|co|gg|link)\b\S*/g,
  new RegExp(ADDRESS_LIKE_SOURCE, 'gu'),
  /@[a-z0-9_]{1,64}/g,
  /\$[a-z][a-z0-9]{0,15}\b/g,
]

const MIN_WORDS = 3
/** Non-Latin letters at or above this share of all letters is a foreign script. */
const SCRIPT_SHARE = 1 / 3

function table(words: readonly string[]): Readonly<Record<string, true>> {
  const out: Record<string, true> = {}
  for (const word of words) out[word] = true
  return out
}

/**
 * English function words plus the English-morphology domain words a token chat
 * uses. Loanwords every language's chat shares ("token", "dev", "airdrop",
 * "bot") are NOT evidence of English and are left out, as is anything that is
 * also a common word elsewhere ("a", "no", "me", "was", "do", "ser", "real").
 */
const ENGLISH = table([
  'the', 'is', 'are', 'were', 'be', 'been', 'am', 'it', 'its', 'this', 'that', 'these', 'those',
  'there', 'here', 'what', 'when', 'where', 'why', 'how', 'who', 'which', 'can', 'could', 'will',
  'would', 'should', 'does', 'did', 'have', 'has', 'had', 'i', 'im', 'ive', 'my', 'you', 'your',
  'we', 'our', 'they', 'their', 'them', 'he', 'she', 'his', 'her', 'and', 'or', 'but', 'not',
  'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'about', 'into', 'out', 'up', 'down',
  'if', 'then', 'than', 'so', 'as', 'any', 'some', 'all', 'just', 'only', 'also', 'now', 'get',
  'got', 'dont', 'cant', 'wont', 'isnt', 'please', 'thanks', 'thank', 'hello', 'hi', 'hey', 'gm',
  'wen', 'yes', 'ok', 'much', 'many', 'more', 'still', 'again', 'yet', 'ever', 'supply', 'holders',
  'holder', 'liquidity', 'contract', 'address', 'fee', 'fees', 'tax', 'buy', 'sell', 'bought',
  'sold', 'price', 'wallet', 'locked', 'claim', 'trade', 'sniped', 'scammed', 'rugged', 'safe',
  'legit', 'verified',
])

/**
 * Function words distinctive to the Latin-script languages a token chat sees,
 * matched on the accent-stripped view ("qué" → "que"). Anything that is also
 * ordinary English ("ca", "ban", "ten", "come", "pot", "wat", "um") is absent.
 */
const FOREIGN = table([
  // es
  'que', 'como', 'donde', 'cuando', 'porque', 'para', 'esto', 'esta', 'este', 'puedo', 'quien',
  'el', 'la', 'lo', 'los', 'las', 'del', 'al', 'una', 'por', 'cual', 'cuanto', 'tiene', 'pero',
  'muy', 'mas', 'hola', 'gracias', 'precio', 'comprar', 'vender', 'contrato', 'aqui', 'es', 'en',
  'se', 'te', 'tu', 'si', 'y',
  // pt
  'onde', 'quando', 'isso', 'voce', 'posso', 'nao', 'uma', 'dos', 'das', 'tem', 'muito',
  'obrigado', 'preco', 'ola', 'esse', 'essa', 'qual', 'quanto', 'o', 'e', 'ou', 'sim', 'da',
  // fr
  'comment', 'quand', 'pourquoi', 'pour', 'cette', 'je', 'vous', 'est', 'les', 'des', 'une',
  'avec', 'dans', 'pas', 'quel', 'quelle', 'combien', 'bonjour', 'merci', 'prix', 'acheter',
  'contrat', 'ce', 'suis', 'nous', 'sur', 'le', 'et', 'oui',
  // de
  'wie', 'wo', 'wann', 'warum', 'diese', 'ich', 'nicht', 'ist', 'der', 'das', 'und', 'ein',
  'eine', 'kann', 'hallo', 'danke', 'preis', 'kaufen', 'verkaufen', 'vertrag', 'wird', 'sind',
  'haben', 'ihr', 'wir', 'ja', 'nein', 'auch', 'mit', 'von', 'zu', 'noch', 'schon', 'aber',
  'oder', 'auf', 'wenn', 'dass',
  // it
  'perche', 'questo', 'questa', 'sono', 'della', 'il', 'gli', 'ciao', 'grazie', 'prezzo',
  'comprare', 'contratto', 'puo', 'di',
  // tr
  'ne', 'nasil', 'nerede', 'nicin', 'icin', 'bu', 'ben', 'degil', 'var', 'mi', 'mu', 'fiyat',
  'nedir', 'merhaba', 'tesekkurler', 'alabilir', 'miyim', 'kontrat', 'sozlesme',
  // id / ms
  'apa', 'bagaimana', 'dimana', 'kapan', 'kenapa', 'untuk', 'ini', 'itu', 'saya', 'bisa',
  'tidak', 'harga', 'beli', 'jual', 'kontrak', 'terima', 'kasih', 'halo',
  // nl
  'waar', 'wanneer', 'waarom', 'voor', 'dit', 'ik', 'niet', 'het', 'een', 'kan', 'dank',
  'prijs', 'kopen',
  // pl
  'jak', 'gdzie', 'kiedy', 'dlaczego', 'dla', 'jest', 'nie', 'czy', 'moge', 'cena', 'kupic',
  'dzieki', 'czesc',
  // vi
  'gi', 'lam', 'sao', 'dau', 'khi', 'tai', 'nay', 'toi', 'khong', 'gia', 'mua', 'cam', 'chao',
  'dong',
  // tl
  'ano', 'paano', 'saan', 'kailan', 'bakit', 'ito', 'ako', 'hindi', 'presyo', 'bili', 'salamat',
  'kumusta', 'magkano',
  // ro
  'unde', 'cand', 'de', 'acest', 'aceasta', 'nu', 'pret', 'cumpara', 'multumesc', 'buna',
  // sw
  'nini', 'vipi', 'wapi', 'lini', 'kwa', 'hii', 'mimi', 'siwezi', 'bei', 'nunua', 'asante',
  'habari',
])

/**
 * Decide whether the desk may answer this text. The rule, in order:
 *   command → agnostic; no letters → agnostic; non-Latin share ≥ 1/3 →
 *   unsupported; under three Latin words → agnostic (unless mixed-script);
 *   foreign stopwords > English → unsupported; otherwise English.
 */
export function classifyLanguage(text: string): LanguageDecision {
  const { lower } = normalize(text)
  const empty = { words: 0, english: 0, foreign: 0 }

  if (lower.startsWith('/')) return { verdict: 'agnostic', reason: 'command', ...empty }

  let stripped = lower
  for (const re of NOT_LANGUAGE) stripped = stripped.replace(re, ' ')

  const buckets = new Map<ScriptBucket, number>()
  let letters = 0
  for (const ch of stripped) {
    if (!LETTER.test(ch)) continue
    letters++
    const bucket = scriptOf(ch)
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1)
  }
  if (letters === 0) return { verdict: 'agnostic', reason: 'symbols', ...empty }

  let script: ScriptBucket = 'other'
  let top = 0
  for (const [bucket, count] of buckets) {
    if (count > top) {
      top = count
      script = bucket
    }
  }
  const latin = buckets.get('latin') ?? 0
  const nonLatin = letters - latin
  if (nonLatin / letters >= SCRIPT_SHARE) {
    return { verdict: 'unsupported', reason: 'script', script, ...empty }
  }

  // Folded: accents stripped, homoglyphs mapped to Latin, so "qué" reads
  // "que" and a Cyrillic "о" in "shоuld" does not split the word.
  const words = normalize(stripped).folded.match(/[a-z]+/g) ?? []
  let english = 0
  let foreign = 0
  for (const word of words) {
    if (ENGLISH[word]) english++
    else if (FOREIGN[word]) foreign++
  }
  const tally = { script, words: words.length, english, foreign }

  if (nonLatin > 0) {
    // Mixed script: a stray homoglyph inside clear English passes; foreign
    // letters wrapped around no English at all is spam-shaped and does not.
    if (english >= 2 && english > foreign) return { verdict: 'english', reason: 'latin_english', ...tally }
    return { verdict: 'unsupported', reason: 'mixed_script', ...tally }
  }

  if (words.length < MIN_WORDS) return { verdict: 'agnostic', reason: 'short', ...tally }
  if (foreign > english) return { verdict: 'unsupported', reason: 'latin_foreign', ...tally }
  return { verdict: 'english', reason: 'latin_english', ...tally }
}
