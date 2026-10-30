import { describe, expect, it } from 'vitest'
import { AirlockViolation } from '../airlock.js'
import { NARRATIVE_LIMITS, validateNarrativeProfile } from '../narrative.js'

const HASH = 'a'.repeat(64)

function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    tagline: 'a frog that refuses to be serious',
    themes: ['how_to_buy', 'sentiment_positive'],
    tone: 'playful',
    palette: { primary: '#22aa55', secondary: '#112233' },
    approvedAtUnix: 1_788_652_800,
    approvedBy: 'ops.alice',
    sourceHashes: [HASH],
    ...overrides,
  }
}

function rejects(raw: unknown, field?: string): void {
  let caught: unknown
  try {
    validateNarrativeProfile(raw)
  } catch (error: unknown) {
    caught = error
  }
  expect(caught).toBeInstanceOf(AirlockViolation)
  if (field !== undefined) expect((caught as AirlockViolation).field).toBe(field)
}

describe('validateNarrativeProfile', () => {
  it('accepts a clean profile and normalises what it keeps', () => {
    const out = validateNarrativeProfile(
      profile({ tagline: '  a frog\u200b that   refuses  ', themes: ['how_to_buy', 'how_to_buy'], sourceHashes: [HASH, HASH] }),
    )
    expect(out.tagline).toBe('a frog that refuses')
    expect(out.themes).toEqual(['how_to_buy'])
    expect(out.sourceHashes).toEqual([HASH])
  })

  it('refuses a tagline that names a destination, however it is spelled', () => {
    for (const tagline of [
      'claim yours at vnx-claim.top',
      'dm @vnx_support for help',
      'write vnx_support_desk on telegram',
      'send 0.5 ETH to join the frog pond',
      'see https://example.org',
      'the frog lives at 0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
      'frogs [.] com',
      'frogs dot com is the place',
      'f\u200br\u200bo\u200bg\u200bs.top is the place',
      'a frog worth 1000 pond coins',
    ]) {
      rejects(profile({ tagline }), 'narrative.tagline')
    }
  })

  it('refuses an empty or over-long tagline', () => {
    rejects(profile({ tagline: '   ' }), 'narrative.tagline')
    rejects(profile({ tagline: 'x'.repeat(NARRATIVE_LIMITS.maxTaglineChars + 1) }), 'narrative.tagline')
  })

  it('refuses an unknown key anywhere in the shape', () => {
    rejects(profile({ website: 'frogs.example' }), 'narrative.website')
    rejects(profile({ palette: { primary: '#22aa55', secondary: '#112233', url: 'x' } }), 'narrative.palette')
  })

  it('refuses themes outside the closed vocabulary or over the cap', () => {
    rejects(profile({ themes: ['moon'] }), 'narrative.themes')
    rejects(profile({ themes: 'how_to_buy' }), 'narrative.themes')
    rejects(
      profile({
        themes: ['how_to_buy', 'sentiment_positive', 'sentiment_negative', 'scam_report', 'impersonator_report', 'raid_or_spam'],
      }),
      'narrative.themes',
    )
  })

  it('refuses a tone outside the closed vocabulary', () => {
    rejects(profile({ tone: 'aggressive' }), 'narrative.tone')
    rejects(profile({ tone: 'Playful' }), 'narrative.tone')
  })

  it('refuses a palette that is not two lowercase #rrggbb colours', () => {
    rejects(profile({ palette: { primary: '#22AA55', secondary: '#112233' } }), 'narrative.palette.primary')
    rejects(profile({ palette: { primary: '#22aa55', secondary: 'blue' } }), 'narrative.palette.secondary')
    rejects(profile({ palette: { primary: '#22aa55' } }), 'narrative.palette.secondary')
    rejects(profile({ palette: ['#22aa55', '#112233'] }), 'narrative.palette')
  })

  it('refuses a profile without a real approval', () => {
    rejects(profile({ approvedAtUnix: 0 }), 'narrative.approvedAtUnix')
    rejects(profile({ approvedAtUnix: 1.5 }), 'narrative.approvedAtUnix')
    rejects(profile({ approvedBy: '' }), 'narrative.approvedBy')
    rejects(profile({ approvedBy: 'alice@example.org' }), 'narrative.approvedBy')
  })

  it('refuses source hashes that are not sha256 hex or exceed the cap', () => {
    rejects(profile({ sourceHashes: ['not-a-hash'] }), 'narrative.sourceHashes')
    rejects(profile({ sourceHashes: [HASH.toUpperCase()] }), 'narrative.sourceHashes')
    rejects(
      profile({ sourceHashes: Array.from({ length: NARRATIVE_LIMITS.maxSourceHashes + 1 }, (_, i) => String(i).padStart(64, '0')) }),
      'narrative.sourceHashes',
    )
  })

  it('refuses anything that is not version 1 or not an object', () => {
    rejects(profile({ version: 2 }), 'narrative.version')
    rejects(null, 'narrative')
    rejects([profile()], 'narrative')
  })
})
