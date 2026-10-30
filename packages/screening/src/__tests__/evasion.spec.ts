import { describe, expect, it } from 'vitest'
import { Lexicon } from '../lexicon.js'
import { fold, DENSE_FOLD } from '../normalize.js'
import { FAKE_SLUR_SOURCE, testLexicon } from './fixtures.js'

const lexicon = new Lexicon([FAKE_SLUR_SOURCE])

function slurHits(text: string): number {
  return lexicon.scan(text).filter((h) => h.category === 'slur').length
}

describe('unicode homoglyph evasion', () => {
  it('folds Cyrillic lookalikes onto Latin', () => {
    // о U+043E, а U+0430, е U+0435 - visually identical, different code points.
    expect(slurHits('buy зоrblаt now')).toBe(0) // з is not z
    expect(slurHits('zоrblаt')).toBe(1)
    expect(slurHits('Ѕorblat')).toBe(0) // Ѕ folds to s, not z
  })

  it('folds Greek lookalikes', () => {
    expect(slurHits('zοrblαt')).toBe(1)
  })

  it('folds small-capital and phonetic lookalikes', () => {
    expect(slurHits('zᴏrblᴀt')).toBe(1)
  })

  it('folds fullwidth and mathematical alphanumerics via NFKD', () => {
    expect(slurHits('ｚｏｒｂｌａｔ')).toBe(1)
    expect(slurHits('\u{1D433}\u{1D428}\u{1D42B}\u{1D41B}\u{1D425}\u{1D41A}\u{1D42D}')).toBe(1)
  })

  it('strips combining diacritics', () => {
    expect(slurHits('zörblät')).toBe(1)
    expect(slurHits('źôr̃b̄l̅ăt')).toBe(1)
  })
})

describe('leetspeak evasion', () => {
  it('folds digit and symbol substitutions', () => {
    expect(slurHits('z0rbl4t')).toBe(1)
    expect(slurHits('z0r8l@t')).toBe(1)
    expect(slurHits('Z0R8L4T')).toBe(1)
    expect(slurHits('gr1nt0k')).toBe(1)
  })

  it('folds symbol substitutions that are not digits', () => {
    expect(slurHits('z0rbl@t')).toBe(1)
    expect(slurHits('$corblat')).toBe(0)
  })
})

describe('zero-width and bidi splitting', () => {
  it('drops zero-width characters before matching', () => {
    const zwsp = 'z​o​r​b​l​a​t'
    const zwnj = 'z‌o‌r‌b‌l‌a‌t'
    const zwj = 'z‍o‍r‍b‍l‍a‍t'
    expect(slurHits(zwsp)).toBe(1)
    expect(slurHits(zwnj)).toBe(1)
    expect(slurHits(zwj)).toBe(1)
  })

  it('drops bidi overrides, word joiners, soft hyphens and variation selectors', () => {
    expect(slurHits('z‮o‭r‬blat')).toBe(1)
    expect(slurHits('z⁠o⁠rblat')).toBe(1)
    expect(slurHits('z­o­r­b­l­a­t')).toBe(1)
    expect(slurHits('z️o️rblat')).toBe(1)
    expect(slurHits('z﻿orblat')).toBe(1)
  })
})

describe('separator and repetition evasion', () => {
  it('matches through injected punctuation and spacing', () => {
    expect(slurHits('z.o.r.b.l.a.t')).toBe(1)
    expect(slurHits('z-o-r-b-l-a-t')).toBe(1)
    expect(slurHits('z o r b l a t')).toBe(1)
    expect(slurHits('z_o_r_b_l_a_t')).toBe(1)
  })

  it('collapses repeated characters', () => {
    expect(slurHits('zzzooorrrblaaat')).toBe(1)
    expect(slurHits('zorrrrrrblat')).toBe(1)
  })

  it('matches a combined homoglyph + leet + zero-width payload', () => {
    // Cyrillic о, leet 4 for a, zero-width joiners, doubled letters, mixed case.
    const payload = 'Z‍оRR8​l4‍t'
    expect(slurHits(payload)).toBe(1)
  })
})

describe('precision', () => {
  it('does not fire on a near miss', () => {
    expect(slurHits('zorbla')).toBe(0)
    expect(slurHits('orblat')).toBe(0)
  })

  it('requires a word boundary for short terms', () => {
    const full = testLexicon()
    expect(full.scan('unikernel architecture').some((h) => h.term === 'nike')).toBe(false)
    expect(full.scan('NIKE tribute coin').some((h) => h.term === 'nike')).toBe(true)
  })

  it('still fires on a short term the author deliberately split', () => {
    const full = testLexicon()
    expect(full.scan('buyn.i.k.enow').some((h) => h.term === 'nike')).toBe(true)
  })
})

describe('numeric hate codes', () => {
  const full = testLexicon()

  it('flags an uncorroborated 1488', () => {
    expect(full.scanNumericCodes('token 1488 edition').map((c) => c.digits)).toContain('1488')
  })

  it('does not treat a digit run containing 14 as a code', () => {
    const codes = full.scanNumericCodes('founded in 2014 by a team')
    expect(codes.filter((c) => c.digits === '14' || c.digits === '1488')).toHaveLength(0)
  })

  it('marks 88 as needing corroboration rather than firing alone', () => {
    const codes = full.scanNumericCodes('lucky 88 coin')
    expect(codes.every((c) => c.requiresCorroboration)).toBe(true)
  })

  it('is not defeated by leet folding, because the numeric view keeps digits', () => {
    const view = fold('1488', DENSE_FOLD).text
    expect(view).not.toContain('1488')
    expect(full.scanNumericCodes('1488').map((c) => c.digits)).toContain('1488')
  })
})
