import { createHash } from 'node:crypto'
import { foldSpaces, stripInvisible } from '@fee-split-vaults/core'

/**
 * Control, zero-width, bidi and variation characters are stripped before ANY
 * classification, truncation or allowlist check runs, and the class that says
 * WHICH characters those are now lives in @fee-split-vaults/core.
 *
 * Two attacks depend on them surviving: a right-to-left override that visually
 * reorders an appended disclosure into nonsense, and a zero-width space inside
 * an address ("0x1234<ZWSP>5678") that defeats a naive address matcher while
 * still copy-pasting as a working destination on most clients.
 *
 * WHY THE CLASS MOVED. The local copy handled U+200B - the character the comment
 * above names - and omitted the whole C1 block (so NEL U+0085 survived), U+2028,
 * U+2029 and U+202F. NFKC touches none of those and neither `[ \t]+` nor the
 * newline collapse reaches them, so the very same trick worked with any one of
 * them, against a plain lowercase `0x` address, and the post published. The
 * corpus sanitiser on the INBOUND side already covered the C1 block: the two
 * normalisers disagreed and the outbound one - the one guarding what humans read
 * - was the weaker. A single shared class is the only arrangement in which that
 * cannot recur; packages/core/src/__tests__/destinations.spec.ts pins it.
 *
 * Visible-but-exotic space separators (U+00A0, U+2000-U+200A, U+205F, U+3000)
 * are FOLDED to an ordinary space rather than deleted. They render as a gap, so
 * an address split by one is visibly broken rather than invisibly intact, and
 * deleting them would silently join words in legitimate copy.
 */

/**
 * NFKC folds full-width and mathematical-alphanumeric homoglyphs onto ASCII, so
 * a full-width "#ad" or "0x..." cannot dodge the tag stripper or the address
 * matcher. Applied to model output and to text read back from a platform; never
 * to anything used as a cryptographic preimage.
 */
export function normalizeVisibleText(raw: string): string {
  // The strip runs on both sides of NFKC: NFKC folds U+202F onto an ordinary
  // space, so a strip that only runs afterwards never sees it. See
  // foldForDetection in @fee-split-vaults/core, which this mirrors deliberately.
  return foldSpaces(stripInvisible(stripInvisible(raw).normalize('NFKC')))
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function codePoints(text: string): string[] {
  return Array.from(text)
}

export function codePointLength(text: string): number {
  return codePoints(text).length
}

/** How a channel counts a message. X weights every URL as a fixed 23 characters. */
export type Measure = (text: string) => number

export const countCodePoints: Measure = codePointLength

const TRAILING_URL_FRAGMENT = /\s*\bhttps?:\/\/\S*$/i
const TRAILING_PARTIAL_SCHEME = /\s*\bh(?:t(?:t(?:p(?:s(?::(?:\/\/?)?)?)?)?)?)?$/i

export interface TruncationOutcome {
  text: string
  truncated: boolean
}

/**
 * Shorten `text` until `measure(text + ellipsis) <= budget`.
 *
 * Cuts on code points, never UTF-16 units, and always removes a trailing URL
 * fragment: truncating "https://receipts.example.com/x" to "https://receipts.ex"
 * would publish a link to a domain we do not control.
 */
export function truncateToBudget(
  text: string,
  measure: Measure,
  budget: number,
  ellipsis = '…',
): TruncationOutcome {
  if (budget <= 0) return { text: '', truncated: text.length > 0 }
  if (measure(text) <= budget) return { text, truncated: false }
  if (measure(ellipsis) > budget) return { text: '', truncated: true }

  const cps = codePoints(text)
  const fits = (keep: number): boolean => measure(cps.slice(0, keep).join('') + ellipsis) <= budget

  let low = 0
  let high = cps.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (fits(mid)) low = mid
    else high = mid - 1
  }

  let kept = cps.slice(0, low).join('')
  const lastSpace = kept.lastIndexOf(' ')
  if (lastSpace > 0 && lastSpace >= Math.floor(kept.length * 0.6)) {
    kept = kept.slice(0, lastSpace)
  }
  kept = kept.replace(TRAILING_URL_FRAGMENT, '').replace(TRAILING_PARTIAL_SCHEME, '')
  kept = kept.replace(/[\s.,;:!?-]+$/u, '')

  // Every guard above only removes characters, so the measured budget still holds.
  const out = kept.length > 0 ? `${kept}${ellipsis}` : ''
  return { text: out, truncated: true }
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Case-insensitive containment on normalized text. Used for read-back proofs. */
export function containsToken(haystack: string, token: string): boolean {
  return normalizeVisibleText(haystack)
    .toLowerCase()
    .includes(normalizeVisibleText(token).toLowerCase())
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}
