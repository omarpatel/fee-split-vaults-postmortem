/**
 * RED TEAM: the token ceiling is encoding-blind.
 *
 * sanitize.ts claims estimateTokens is a "Conservative offline token estimate.
 * Deliberately over-estimates so that the hard ceiling in CORPUS_LIMITS binds
 * before the real tokenizer does."
 *
 * It is `ceil(text.length / 3) + 2` - a function of UTF-16 code units, with no
 * reference to how those units encode. That over-estimates for ASCII English
 * (~3.5-4 bytes per token) and under-estimates badly for anything else: a BMP
 * CJK or Tibetan character is one UTF-16 unit and three UTF-8 bytes, and a
 * rare-script byte sequence gets almost no BPE merging.
 *
 * Consequence: two corpora the assembler prices identically at ~8,000 tokens
 * differ ~3x in bytes, so the "hard ceiling" is a ceiling only for Latin text.
 * The bound asserted below - four UTF-8 bytes per token - is the most generous
 * average any byte-level BPE could plausibly achieve; real tokenization of this
 * input is nearer one to two bytes per token.
 */

import { describe, expect, it } from 'vitest'
import { CORPUS_LIMITS } from '@fee-split-vaults/core'
import { assembleCorpus } from '../corpus/assemble.js'
import { estimateTokens } from '../corpus/sanitize.js'
import { testWindow } from './helpers.js'

/** U+0F40 TIBETAN LETTER KA. Not folded by NFKC, three UTF-8 bytes. */
const RARE = 'ཀ'

function flood(fill: string, perMessage: number, count: number) {
  const window = testWindow()
  const messages = []
  for (let i = 0; i < count; i += 1) {
    messages.push({
      sourceId: `s${String(i)}`,
      authorId: `a${String(i)}`,
      text: fill.repeat(perMessage) + ' ' + String(i),
      postedAtUnix: window.startUnix + (i % 1_700),
      origin: 'telegram' as const,
      boundCoinRef: window.coinRef,
    })
  }
  return assembleCorpus(window, messages)
}

const utf8 = (s: string): number => Buffer.byteLength(s, 'utf8')

/**
 * NOTE ON THIS FIRST TEST, which was rewritten rather than fixed.
 *
 * As originally written it asserted, in order:
 *
 *     expect(estimateTokens(ascii)).toBe(estimateTokens(rare))   // the DEFECT
 *     expect(utf8(rare)).toBeLessThanOrEqual(utf8(ascii) * 1.1)  // impossible
 *
 * The first line pins the bug in place - equal prices for unequal encodings is
 * exactly what the finding says is wrong - and the second asserts that 300
 * Tibetan characters occupy no more than 330 UTF-8 bytes, which is a claim about
 * UTF-8 rather than about this repository and is false for every possible
 * implementation. No change to estimateTokens could have made both pass.
 *
 * What follows asserts the property the finding actually argues for, and it is
 * STRICTLY STRONGER than what was there: the estimate must track bytes, so a
 * corpus that costs three times as much to tokenize must be priced three times
 * as high. It fails against the old character-based estimator.
 */
describe('RED TEAM: the corpus token ceiling only binds for ASCII', () => {
  it('estimateTokens prices bytes, not UTF-16 code units', () => {
    const ascii = 'a'.repeat(300)
    const rare = RARE.repeat(300)

    // Three UTF-8 bytes per character against one, so three times the price.
    expect(utf8(rare)).toBe(utf8(ascii) * 3)
    expect(estimateTokens(rare)).toBeGreaterThanOrEqual(estimateTokens(ascii) * 2.5)

    // And the estimate stays conservative for the Latin case it was tuned for:
    // never fewer tokens than one per four bytes, which is the most generous
    // average any byte-level BPE could plausibly achieve.
    for (const sample of [ascii, rare, '😀'.repeat(100)]) {
      expect(estimateTokens(sample)).toBeGreaterThanOrEqual(utf8(sample) / 4)
    }
  })

  it('admits a corpus whose real token count is multiples of the ceiling', () => {
    const ascii = flood('x', 300, 3_000)
    const rare = flood(RARE, 300, 3_000)

    expect(ascii.estimatedTokens).toBeLessThanOrEqual(CORPUS_LIMITS.maxTokensPerWindow)
    expect(rare.estimatedTokens).toBeLessThanOrEqual(CORPUS_LIMITS.maxTokensPerWindow)

    // Four UTF-8 bytes per token is a generous upper bound for any byte-level
    // BPE. FAILS TODAY at roughly 68,500 bytes against a 32,000 byte allowance.
    expect(utf8(rare.renderedText)).toBeLessThanOrEqual(CORPUS_LIMITS.maxTokensPerWindow * 4)
  })
})
