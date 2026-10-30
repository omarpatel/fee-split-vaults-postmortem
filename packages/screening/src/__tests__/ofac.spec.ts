import { describe, expect, it } from 'vitest'
import {
  LoadedSdnSource,
  SAMPLE_SDN_ENTRIES,
  SampleSdnSource,
  SdnScreener,
  withinOneEdit,
  type SdnEntry,
} from '../ofac.js'
import { NOW } from './fixtures.js'

const screener = new SdnScreener(new LoadedSdnSource(SAMPLE_SDN_ENTRIES, NOW))

describe('withinOneEdit', () => {
  it('accepts identity, substitution, insertion, deletion and transposition', () => {
    expect(withinOneEdit('lazarus', 'lazarus')).toBe(true)
    expect(withinOneEdit('lazarus', 'lazarns')).toBe(true)
    expect(withinOneEdit('lazarus', 'lazaruss')).toBe(true)
    expect(withinOneEdit('lazarus', 'lazrus')).toBe(true)
    expect(withinOneEdit('lazarus', 'lazaurs')).toBe(true)
  })

  it('rejects two or more edits', () => {
    expect(withinOneEdit('lazarus', 'lazrns')).toBe(false)
    expect(withinOneEdit('lazarus', 'garantex')).toBe(false)
    expect(withinOneEdit('abc', 'cba')).toBe(false)
  })
})

describe('SDN name matching', () => {
  it('matches every token of a name as a full hit', () => {
    const matches = screener.match('Tornado Cash memorial coin')
    expect(matches).toHaveLength(1)
    expect(matches[0]?.strength).toBe('full')
    expect(matches[0]?.uid).toBe('sample-1')
  })

  it('matches a single-token entity name', () => {
    expect(screener.match('GARANTEX to the moon')[0]?.strength).toBe('full')
  })

  it('tolerates one edit on a distinctive token', () => {
    const matches = screener.match('LAZARUSS GROUP fan token')
    expect(matches[0]?.uid).toBe('sample-4')
    expect(matches[0]?.matchedTokens).toContain('lazaruss')
  })

  it('sees through homoglyph and leet obfuscation of a name', () => {
    // Cyrillic а and о inside "tornado", and fullwidth "cash".
    expect(screener.match('tоrnаdo ｃａｓｈ')[0]?.strength).toBe('full')
  })

  it('downgrades a distinctive-token-only hit to partial, not full', () => {
    const matches = screener.match('a coin about a tornado')
    expect(matches[0]?.strength).toBe('partial')
  })

  it('does not fire on a generic token alone', () => {
    expect(screener.match('cash money market group co')).toHaveLength(0)
    expect(screener.match('a perfectly ordinary dog coin')).toHaveLength(0)
  })

  it('reports a name once, at its strongest', () => {
    const matches = screener.match('tornado cash, tornado, tornado cash')
    expect(matches).toHaveLength(1)
    expect(matches[0]?.strength).toBe('full')
  })
})

describe('list provenance and freshness', () => {
  it('reports the sample list as non-authoritative', () => {
    expect(new SdnScreener(new SampleSdnSource(NOW)).listStatus(NOW)).toBe('not_authoritative')
  })

  it('reports a loaded list as ok while fresh and stale afterwards', () => {
    const loaded = new SdnScreener(new LoadedSdnSource(SAMPLE_SDN_ENTRIES, NOW))
    expect(loaded.listStatus(NOW)).toBe('ok')
    expect(loaded.listStatus(NOW + 8 * 24 * 60 * 60)).toBe('stale')
  })
})

describe('scale', () => {
  /**
   * The real SDN file is on the order of 17k entries before aliases. Stage 1 is
   * the always-on stage, so matching has to be indexed rather than a scan over
   * every name.
   */
  it('stays fast against a list the size of the real SDN file', () => {
    const entries: SdnEntry[] = []
    for (let i = 0; i < 20_000; i += 1) {
      entries.push({
        uid: `synthetic-${i}`,
        name: `SYNTHETIC ENTITY ${i} HOLDINGS ZQ${i}`,
        type: 'entity',
      })
    }
    entries.push({ uid: 'planted', name: 'QUIXOTIC PELICAN VENTURES', type: 'entity' })

    const big = new SdnScreener(new LoadedSdnSource(entries, NOW))
    const text = 'a perfectly ordinary dog coin with a long description '.repeat(20)

    const start = performance.now()
    for (let i = 0; i < 50; i += 1) big.match(text)
    const perCall = (performance.now() - start) / 50

    expect(perCall).toBeLessThan(5)
    expect(big.match('quixotic pelican ventures coin')[0]?.uid).toBe('planted')
  })
})
