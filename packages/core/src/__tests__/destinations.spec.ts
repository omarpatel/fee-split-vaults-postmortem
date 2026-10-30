/**
 * THE SHARED DESTINATION MODULE, pinned on the properties that made four
 * separate copies of these rules dangerous.
 *
 * The rules themselves are exercised against a corpus in airlock.spec.ts. What
 * is asserted here is the STRUCTURE: that there is one class, that it is a
 * superset of everything any plane used to strip on its own, that folding is
 * order-correct around NFKC, and that the address comparison folds the same
 * spellings the matcher does - because fixing a matcher while leaving the
 * comparison case-sensitive would only move the bypass one line down.
 */

import { describe, expect, it } from 'vitest'
import {
  addressLikeTokens,
  carriesDestination,
  containsHostLike,
  foldForDetection,
  foldSpaces,
  handleTokens,
  namingServiceTokens,
  normalizeAddressToken,
  stripInvisible,
} from '../destinations.js'

const cp = (n: number): string => String.fromCodePoint(n)

/**
 * Every character any normaliser in this repository ever removed, plus the ones
 * that were missing from one of them and were demonstrated to work.
 */
const MUST_BE_STRIPPED: ReadonlyArray<readonly [string, number]> = [
  ['NUL', 0x0000],
  ['BEL', 0x0007],
  ['DEL', 0x007f],
  ['NEL (C1) - absent from the outbound class', 0x0085],
  ['C1 U+0090 - absent from the outbound class', 0x0090],
  ['SOFT HYPHEN', 0x00ad],
  ['COMBINING GRAPHEME JOINER', 0x034f],
  ['ARABIC LETTER MARK', 0x061c],
  ['HANGUL CHOSEONG FILLER', 0x115f],
  ['KHMER VOWEL INHERENT AQ', 0x17b4],
  ['MONGOLIAN FREE VARIATION SELECTOR', 0x180b],
  ['ZERO WIDTH SPACE', 0x200b],
  ['ZERO WIDTH NON-JOINER', 0x200c],
  ['LEFT-TO-RIGHT MARK', 0x200e],
  ['LINE SEPARATOR - absent from both classes', 0x2028],
  ['PARAGRAPH SEPARATOR - absent from both classes', 0x2029],
  ['LEFT-TO-RIGHT EMBEDDING', 0x202a],
  ['RIGHT-TO-LEFT OVERRIDE', 0x202e],
  ['NARROW NO-BREAK SPACE - absent from both classes', 0x202f],
  ['WORD JOINER', 0x2060],
  ['LEFT-TO-RIGHT ISOLATE', 0x2066],
  ['HANGUL FILLER', 0x3164],
  ['VARIATION SELECTOR-1', 0xfe00],
  ['BOM / ZWNBSP', 0xfeff],
  ['HALFWIDTH HANGUL FILLER', 0xffa0],
  ['INTERLINEAR ANNOTATION ANCHOR', 0xfff9],
  ['TAG LATIN SMALL LETTER A', 0xe0061],
]

/** Real spaces. Folded to U+0020 so legitimate copy is not silently joined. */
const MUST_BE_FOLDED: ReadonlyArray<readonly [string, number]> = [
  ['NO-BREAK SPACE', 0x00a0],
  ['OGHAM SPACE MARK', 0x1680],
  ['EN QUAD', 0x2000],
  ['THIN SPACE', 0x2009],
  ['MEDIUM MATHEMATICAL SPACE', 0x205f],
  ['IDEOGRAPHIC SPACE', 0x3000],
]

describe('one invisible-character class, and it is a superset', () => {
  for (const [name, code] of MUST_BE_STRIPPED) {
    it(`strips ${name}`, () => {
      expect(stripInvisible(`a${cp(code)}b`)).toBe('ab')
    })
  }

  for (const [name, code] of MUST_BE_FOLDED) {
    it(`folds ${name} to a plain space rather than deleting it`, () => {
      expect(foldSpaces(`a${cp(code)}b`)).toBe('a b')
      expect(stripInvisible(`a${cp(code)}b`)).toBe(`a${cp(code)}b`)
    })
  }

  it('leaves ordinary text alone', () => {
    const text = 'Holders asked about the pinned message — the desk replied.'
    expect(foldForDetection(text)).toBe(text)
  })
})

describe('folding is order-correct around NFKC', () => {
  it('catches U+202F, which NFKC folds to a space before a later strip sees it', () => {
    const split = `0x1a2B${cp(0x202f)}3c4D5e6F7a8B9c0D1e2F3a4B5c6D7e8F9a0B`
    expect(addressLikeTokens(split)).toHaveLength(1)
  })

  it('still catches a fullwidth payload, which needs NFKC to be seen at all', () => {
    expect(addressLikeTokens('０ｘＤＥＡＤＢＥＥＦＤＥＡＤ')).toHaveLength(1)
  })

  it('catches a payload that needs BOTH: fullwidth, split by U+202F', () => {
    expect(addressLikeTokens(`０ｘＤＥＡＤ${cp(0x202f)}ＢＥＥＦＤＥＡＤ`)).toHaveLength(1)
  })
})

describe('addresses: the prefix is a convention, and its case is not a control', () => {
  const hex = '1a2B3c4D5e6F7a8B9c0D1e2F3a4B5c6D7e8F9a0B'

  it('matches all three spellings', () => {
    expect(addressLikeTokens(`0x${hex}`)).toHaveLength(1)
    expect(addressLikeTokens(`0X${hex}`)).toHaveLength(1)
    expect(addressLikeTokens(hex)).toHaveLength(1)
  })

  it('reports a prefixed address once, not twice', () => {
    expect(addressLikeTokens(`0x${hex}`)).toEqual([`0x${hex}`])
  })

  it('folds all three to the same allowlist key', () => {
    const keys = new Set([`0x${hex}`, `0X${hex}`, hex, `0x${hex.toUpperCase()}`].map(normalizeAddressToken))
    expect(keys.size).toBe(1)
  })

  it('matches a 64-character hash and a short prefixed fragment', () => {
    expect(addressLikeTokens('ab12'.repeat(16))).toHaveLength(1)
    expect(addressLikeTokens('0xdead')).toHaveLength(1)
  })

  it('does not fire on ordinary prose or short hex-ish words', () => {
    expect(addressLikeTokens('the deadbeef cafe added a fee')).toEqual([])
    expect(addressLikeTokens('version 1.2.3, build 42')).toEqual([])
  })
})

describe('hosts are detected by shape, not by a TLD list', () => {
  for (const tld of ['com', 'top', 'click', 'icu', 'cfd', 'sbs', 'cyou', 'win', 'vip', 'ru', 'bond']) {
    it(`sees a .${tld} host`, () => {
      expect(containsHostLike(`claim at vnx-claim.${tld} now`)).toBe(true)
    })
  }

  it('does not read a decimal, a version, or an abbreviation as a host', () => {
    for (const prose of [
      'the dial moved 3.5 points',
      'we are on v1.2.3 now',
      'e.g. the pinned message',
      'i.e. the desk',
      'that is 9 a.m. UTC',
      'U.S.A. only',
    ]) {
      expect(containsHostLike(prose)).toBe(false)
    }
  })
})

describe('naming-service names are destinations, not links', () => {
  for (const name of ['venuevault.eth', 'vnx-treasury.eth', 'venue.crypto', 'vault.sol', 'claim.bnb']) {
    it(`sees ${name}`, () => {
      expect(namingServiceTokens(`send it to ${name}`)).toHaveLength(1)
    })
  }

  it('does not read a version wildcard or a phone number as one', () => {
    expect(namingServiceTokens('node 22.x and release-1.x')).toEqual([])
    expect(namingServiceTokens('call 1.888.555.0100')).toEqual([])
  })

  /**
   * The host-shape rule happens to match these too, which is why this rule needs
   * its own test: the two are NOT interchangeable. A host is a candidate that
   * the ALLOWLIST then judges, so a host can be permitted. A naming-service name
   * is a payment destination and can never be permitted, and the publisher
   * refuses it with its own reason code before the link allowlist ever runs.
   */
  it('is a separate rule from the host rule, because it has no allowlist', () => {
    expect(namingServiceTokens('venuevault.eth')).toEqual(['venuevault.eth'])
    expect(namingServiceTokens('receipts.example.com')).toEqual([])
    expect(containsHostLike('receipts.example.com')).toBe(true)
  })
})

describe('contacts: the identifier, not the sigil', () => {
  it('sees @handle wherever it sits', () => {
    expect(handleTokens('dm @vnx_support_desk')).not.toHaveLength(0)
    expect(handleTokens('write me@vnx_support_desk')).not.toHaveLength(0)
    expect(handleTokens('dm (@drainer_bot) now')).not.toHaveLength(0)
  })

  it('sees the bare identifier with the sigil dropped', () => {
    expect(handleTokens('message vnx_support_desk on telegram')).not.toHaveLength(0)
  })

  it('does not fire on ordinary prose', () => {
    expect(handleTokens('several holders ask where to buy')).toEqual([])
  })
})

describe('carriesDestination separates destinations from amounts', () => {
  it('is true for anywhere money can go', () => {
    for (const bad of [
      'buy at 0X1a2B3c4D5e6F7a8B9c0D1e2F3a4B5c6D7e8F9a0B',
      'claim at vnx-claim.top',
      'send it to venuevault.eth',
      'message vnx_support_desk',
      'go to https://evil.example',
    ]) {
      expect(carriesDestination(bad)).toBe(true)
    }
  })

  it('is false for an amount, which is scrubbed rather than dropped', () => {
    expect(carriesDestination('several holders ask about a 12.5 ETH wallet')).toBe(false)
  })
})
