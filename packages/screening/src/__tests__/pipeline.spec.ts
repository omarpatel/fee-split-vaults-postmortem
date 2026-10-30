import { describe, expect, it } from 'vitest'
import { ScreeningFailClosed } from '../flags.js'
import {
  InMemoryDeclineList,
  declineRecordFor,
  serializeDeclineList,
} from '../declineList.js'
import {
  DEFAULT_SCREENING_CONFIG,
  InMemoryScreeningHistory,
  assertFreshScreening,
  assertOperationsPermitted,
  assertPaidMediaPermitted,
  isFresh,
} from '../pipeline.js'
import { LoadedSdnSource, SAMPLE_SDN_ENTRIES, SampleSdnSource, SdnScreener } from '../ofac.js'
import { Lexicon, DEFAULT_LEXICON_SOURCE } from '../lexicon.js'
import { toScreeningResult } from '../types.js'
import { NOW, metadata, testEngine, testSdn } from './fixtures.js'

describe('verdicts', () => {
  it('clears an ordinary subject', async () => {
    const report = await testEngine().screen(metadata())
    expect(report.verdict).toBe('CLEAR')
    expect(report.flags).toEqual([])
    expect(report.paidMediaPermitted).toBe(true)
    expect(report.stagesRun).toEqual(['lexicon', 'trademark', 'adjudication'])
  })

  it('restricts a trademark, which still permits organic operations', async () => {
    const report = await testEngine().screen(metadata({ name: 'Disney Dog' }))
    expect(report.verdict).toBe('RESTRICTED')
    expect(report.paidMediaPermitted).toBe(false)
    expect(() => assertOperationsPermitted(report, NOW)).not.toThrow()
    expect(() => assertPaidMediaPermitted(report, NOW)).toThrow(ScreeningFailClosed)
  })

  it('blocks a claim of official status on a third-party mark', async () => {
    const report = await testEngine().screen(
      metadata({ name: 'Official Disney Coin', description: 'the verified project' }),
    )
    expect(report.flags.map((f) => f.code)).toContain('impersonation_claim')
    expect(report.verdict).toBe('BLOCKED')
    expect(() => assertOperationsPermitted(report, NOW)).toThrow(/BLOCKED/)
  })

  it('blocks a coin named for a sanctioned entity', async () => {
    const report = await testEngine().screen(
      metadata({ name: 'Tornado Cash Tribute', symbol: 'TORN' }),
    )
    expect(report.flags.map((f) => f.code)).toContain('ofac_sdn_name_match')
    expect(report.verdict).toBe('BLOCKED')
  })

  it('blocks tragedy exploitation', async () => {
    const report = await testEngine().screen(
      metadata({ name: 'Quake Relief', description: 'for the earthquake victims, 100x' }),
    )
    expect(report.flags.map((f) => f.code)).toContain('tragedy_exploitation')
    expect(report.verdict).toBe('BLOCKED')
  })

  it('blocks a sexual term paired with a reference to a minor, whatever the framing', async () => {
    const report = await testEngine().screen(
      metadata({ name: 'Sexy Schoolgirl Parody Coin', description: 'just a joke' }),
    )
    const codes = report.flags.map((f) => f.code)
    expect(codes).toContain('sexual_minor_context')
    expect(report.verdict).toBe('BLOCKED')
  })
})

describe('fail closed on configuration', () => {
  it('cannot clear a coin when no slur list is loaded', async () => {
    const engine = testEngine({ lexicon: new Lexicon([DEFAULT_LEXICON_SOURCE]) })
    const report = await engine.screen(metadata())
    expect(report.flags.map((f) => f.code)).toContain('lexicon_unconfigured')
    expect(report.verdict).toBe('RESTRICTED')
  })

  it('cannot clear a coin on the non-authoritative sample SDN list', async () => {
    const engine = testEngine({ sdn: new SdnScreener(new SampleSdnSource(NOW)) })
    const report = await engine.screen(metadata())
    expect(report.flags.map((f) => f.code)).toContain('lexicon_unconfigured')
  })

  it('cannot clear a coin on a stale SDN list', async () => {
    const engine = testEngine({
      sdn: new SdnScreener(new LoadedSdnSource(SAMPLE_SDN_ENTRIES, NOW - 30 * 24 * 60 * 60)),
    })
    const report = await engine.screen(metadata())
    expect(report.flags.map((f) => f.code)).toContain('sanctions_list_stale')
    expect(report.verdict).toBe('RESTRICTED')
  })

  it('cannot clear a coin with no adjudicator wired', async () => {
    const engine = testEngine({ adjudicator: undefined })
    const report = await engine.screen(metadata())
    expect(report.flags.map((f) => f.code)).toContain('adjudication_unavailable')
    expect(report.verdict).toBe('RESTRICTED')
  })

  it('turns an internal failure into a block, not a pass', async () => {
    const broken = {
      scan(): never {
        throw new Error('lexicon corrupt')
      },
      scanNumericCodes(): never {
        throw new Error('lexicon corrupt')
      },
      has(): boolean {
        return true
      },
    } as unknown as Lexicon
    const report = await testEngine({ lexicon: broken }).screen(metadata())
    expect(report.flags.map((f) => f.code)).toEqual(['internal_fail_closed'])
    expect(report.verdict).toBe('BLOCKED')
  })
})

describe('freshness', () => {
  it('expires, and an expired screening authorises nothing', async () => {
    const report = await testEngine().screen(metadata())
    const later = NOW + DEFAULT_SCREENING_CONFIG.screeningTtlSeconds + 1
    expect(isFresh(report, NOW)).toBe(true)
    expect(isFresh(report, later)).toBe(false)
    expect(() => assertFreshScreening(report, later)).toThrow(/expired/)
    expect(() => assertPaidMediaPermitted(report, later)).toThrow(/expired/)
  })

  it('ages mutable metadata out faster than immutable metadata', async () => {
    const engine = testEngine()
    const immutable = await engine.screen(metadata())
    const mutable = await engine.screen(metadata({ metadataMutable: true }))
    expect(mutable.expiresAtUnix).toBeLessThan(immutable.expiresAtUnix)
  })
})

describe('a block follows the token, not the metadata', () => {
  it('re-attaches previously_blocked after a rename', async () => {
    const history = new InMemoryScreeningHistory()
    const engine = testEngine({ history })

    const first = await engine.screen(metadata({ name: 'ZORBLAT COIN' }))
    expect(first.verdict).toBe('BLOCKED')

    const renamed = await engine.screen(metadata({ name: 'Friendly Puppy Coin' }))
    expect(renamed.flags.map((f) => f.code)).toContain('previously_blocked')
    expect(renamed.verdict).toBe('BLOCKED')
  })

  it('does not brand a token forever for a transient internal failure', async () => {
    const history = new InMemoryScreeningHistory()
    const broken = {
      scan(): never {
        throw new Error('rpc down')
      },
      scanNumericCodes(): never {
        throw new Error('rpc down')
      },
      has(): boolean {
        return true
      },
    } as unknown as Lexicon

    const failed = await testEngine({ history, lexicon: broken }).screen(metadata())
    expect(failed.verdict).toBe('BLOCKED')
    expect(history.everBlocked(failed.subject.token)).toBe(false)
  })
})

describe('the decline list', () => {
  it('records a coarse public code, keeps the dev whole, and quotes nothing', async () => {
    const report = await testEngine().screen(
      metadata({ name: 'ZORBLAT', description: 'zorblat forever' }),
    )
    const record = declineRecordFor(report)

    expect(record.verdict).toBe('BLOCKED')
    expect(record.code).toBe('hate_or_harassment')
    expect(record.devKeepsAllFees).toBe(true)
    expect(JSON.stringify(record).toLowerCase()).not.toContain('zorblat')
  })

  it('refuses to decline anything that is not BLOCKED', async () => {
    const report = await testEngine().screen(metadata())
    expect(() => declineRecordFor(report)).toThrow(ScreeningFailClosed)
  })

  it('names child safety over any other block code', async () => {
    const report = await testEngine().screen(metadata({ name: 'Sexy Schoolgirl ZORBLAT' }))
    expect(declineRecordFor(report).code).toBe('child_safety')
  })

  it('serialises stably and deduplicates by token and evidence', async () => {
    const list = new InMemoryDeclineList()
    const report = await testEngine().screen(metadata({ name: 'ZORBLAT' }))
    await list.publish(declineRecordFor(report))
    await list.publish(declineRecordFor(report))

    const records = await list.list()
    expect(records).toHaveLength(1)
    expect(serializeDeclineList(records)).toBe(serializeDeclineList(records))
    expect(await list.has(report.subject.token)).toBe(true)
  })
})

describe('the shared contract', () => {
  it('narrows to the cross-package ScreeningResult', async () => {
    const report = await testEngine({ sdn: testSdn() }).screen(metadata({ name: 'Disney Dog' }))
    const result = toScreeningResult(report)

    expect(result.token).toBe(report.subject.token)
    expect(result.verdict).toBe('RESTRICTED')
    expect(result.paidMediaPermitted).toBe(false)
    expect(result.flags).toContain('trademark_match')
    expect(new Set(result.flags).size).toBe(result.flags.length)
    expect(result.stagesRun).toContain('trademark')
  })
})
