/**
 * Test fixtures.
 *
 * The "slur" terms here are invented nonsense words. The evasion suite is
 * testing the FOLDING MECHANISM, not a particular word list, and the real slur
 * list is operator-supplied and deliberately absent from this repository.
 */

import { Lexicon, StaticLexiconSource, DEFAULT_LEXICON_SOURCE } from '../lexicon.js'
import { LoadedSdnSource, SAMPLE_SDN_ENTRIES, SdnScreener } from '../ofac.js'
import { ScreeningEngine, type ScreeningEngineDeps, type ScreeningConfig } from '../pipeline.js'
import { DEFAULT_SCREENING_CONFIG } from '../pipeline.js'
import { FakeAdjudicator } from '../stage3.js'
import type { SubjectMetadata } from '../types.js'

export const NOW = 1_757_000_000

export const FAKE_SLUR_SOURCE = new StaticLexiconSource(
  [
    { term: 'zorblat', category: 'slur' },
    { term: 'grintok', category: 'slur' },
  ],
  'test-slurs-v1',
)

export function testLexicon(): Lexicon {
  return new Lexicon([DEFAULT_LEXICON_SOURCE, FAKE_SLUR_SOURCE])
}

export function testSdn(publishedAtUnix = NOW): SdnScreener {
  return new SdnScreener(new LoadedSdnSource(SAMPLE_SDN_ENTRIES, publishedAtUnix))
}

export const CLEAN_ADJUDICATION = { labels: ['clean'], confidence: 'high' }

export function testEngine(overrides: Partial<ScreeningEngineDeps> = {}): ScreeningEngine {
  const config: ScreeningConfig = { ...DEFAULT_SCREENING_CONFIG, ...(overrides.config ?? {}) }
  return new ScreeningEngine({
    lexicon: testLexicon(),
    sdn: testSdn(),
    adjudicator: FakeAdjudicator.returning(CLEAN_ADJUDICATION),
    clock: () => NOW,
    ...overrides,
    config,
  })
}

export function metadata(partial: Partial<SubjectMetadata> = {}): SubjectMetadata {
  return {
    token: '0x00000000000000000000000000000000000000aa',
    name: 'Perfectly Ordinary Dog',
    symbol: 'WOOF',
    description: 'A dog coin for dog people.',
    metadataMutable: false,
    observedAtUnix: NOW,
    ...partial,
  }
}
