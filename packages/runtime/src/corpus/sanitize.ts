import { createHash } from 'node:crypto'
import { stripInvisible } from '@fee-split-vaults/core'

/**
 * Deterministic, trusted-code normalisation applied to every untrusted string
 * before it is hashed, counted, or rendered into a corpus.
 *
 * This is not the airlock. The airlock is that the reader has no tools. This is
 * the layer that stops a smuggled payload from being invisible to a human
 * auditing the same corpus the model saw, and stops two visually identical
 * messages from evading the dedupe cap by differing in a zero-width character.
 */

/**
 * Reduce an untrusted fragment to visible, normalised text.
 *
 * NFKC first: it folds the compatibility forms (fullwidth Latin, mathematical
 * alphanumerics, small-form variants) that an attacker uses to write a payload
 * the dedupe hash and any lexical rule will not recognise. Then the invisible
 * and format characters go.
 *
 * The character class lives in @fee-split-vaults/core, not here. It used to live in
 * this file AND, in a different and weaker form, in the publisher's outbound
 * normaliser - which meant the normaliser guarding what HUMANS read was the laxer
 * of the two, and an address split by U+0085 or U+202F walked past the publisher's
 * address wall while the same trick was caught on the way in. One class, imported
 * by both, is the only arrangement in which that cannot happen again.
 */
export function sanitizeUntrusted(raw: string, maxChars: number): string {
  if (maxChars <= 0) throw new Error('maxChars must be positive')
  let out = stripInvisible(stripInvisible(raw).normalize('NFKC'))
  out = out.replace(/\s+/gu, ' ').trim()
  if (out.length > maxChars) out = out.slice(0, maxChars)
  return out
}

/**
 * Aggressive normalisation used ONLY as the dedupe key. Lossy on purpose: two
 * messages that differ only in case, punctuation, or repeated characters are the
 * same message for flood-control purposes.
 */
export function dedupeKey(raw: string): string {
  const folded = sanitizeUntrusted(raw, 4_096)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/(\p{L})\1{2,}/gu, '$1$1')
    .replace(/\s+/gu, ' ')
    .trim()
  return contentHash(folded)
}

export function contentHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Conservative offline token estimate. Deliberately over-estimates so that the
 * hard ceiling in CORPUS_LIMITS binds before the real tokenizer does; an exact
 * count would need a network call, and a network call in the assembler would
 * reintroduce the per-message cost that the caps exist to remove.
 *
 * PRICED ON BYTES, NOT CHARACTERS. This used to be `ceil(text.length / 3) + 2` -
 * a pure function of UTF-16 code units with no reference to how they encode. That
 * over-estimates for ASCII English (~3.5-4 bytes per token) and under-estimates
 * badly for everything else: a BMP CJK or Tibetan character is ONE UTF-16 unit
 * and THREE UTF-8 bytes, and rare-script bytes get almost no BPE merging. Two
 * floods priced identically at 7,987 tokens measured 23,538 and 68,538 UTF-8
 * bytes, so the "hard ceiling" was a ceiling only for Latin text and a mention
 * flood in a rare script bought several times the inference the caps were sized
 * for. Bytes are what the tokenizer reads and what the bill is denominated in.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3) + 2
}

export function estimateTokensAcross(parts: readonly string[]): number {
  let total = 0
  for (const p of parts) total += estimateTokens(p)
  return total
}
