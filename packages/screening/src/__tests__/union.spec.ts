import { describe, expect, it } from 'vitest'
import {
  ScreeningFailClosed,
  assertMonotonic,
  makeFlag,
  mergeFlags,
  verdictFor,
} from '../flags.js'
import { FakeAdjudicator } from '../stage3.js'
import { PaidMediaReviewQueue } from '../stage4.js'
import { CLEAN_ADJUDICATION, NOW, metadata, testEngine } from './fixtures.js'

describe('union of flags', () => {
  it('stage 3 returning clean cannot clear a stage 1 hit', async () => {
    const engine = testEngine({
      adjudicator: FakeAdjudicator.returning(CLEAN_ADJUDICATION),
    })

    const report = await engine.screen(metadata({ name: 'ZORBLAT', symbol: 'ZORB' }))

    expect(report.flags.map((f) => f.code)).toContain('slur_lexicon')
    expect(report.verdict).toBe('BLOCKED')
    expect(report.paidMediaPermitted).toBe(false)
  })

  it('does not even spend a model call once a block is recorded', async () => {
    const adjudicator = FakeAdjudicator.returning(CLEAN_ADJUDICATION)
    const engine = testEngine({ adjudicator })

    const report = await engine.screen(metadata({ name: 'ZORBLAT' }))

    expect(adjudicator.seen).toHaveLength(0)
    expect(report.stagesRun).not.toContain('adjudication')
  })

  it('a clean stage 3 still cannot lift a RESTRICTED stage 1 hit', async () => {
    const adjudicator = FakeAdjudicator.returning(CLEAN_ADJUDICATION)
    const engine = testEngine({ adjudicator })

    const report = await engine.screen(
      metadata({ name: 'Nintendo Fan Coin', description: 'unofficial tribute' }),
    )

    expect(adjudicator.seen).toHaveLength(1)
    expect(report.flags.map((f) => f.code)).toContain('trademark_match')
    expect(report.verdict).toBe('RESTRICTED')
    expect(report.paidMediaPermitted).toBe(false)
  })

  it('stage 3 may only add - a violation label on a clean subject blocks', async () => {
    const engine = testEngine({
      adjudicator: FakeAdjudicator.returning({
        labels: ['deceptive_fraud'],
        confidence: 'high',
      }),
    })

    const report = await engine.screen(metadata({ description: 'guaranteed 100x, audited' }))

    expect(report.flags.map((f) => f.code)).toContain('adjudication_deceptive')
    expect(report.verdict).toBe('BLOCKED')
  })
})

describe('mergeFlags and assertMonotonic', () => {
  const slur = makeFlag('slur_lexicon', NOW, { evidence: 'x' })
  const trademark = makeFlag('trademark_match', NOW)

  it('never drops a prior flag', () => {
    expect(mergeFlags([slur], [trademark])).toHaveLength(2)
    expect(mergeFlags([slur], []).map((f) => f.code)).toEqual(['slur_lexicon'])
  })

  it('deduplicates identical flags', () => {
    expect(mergeFlags([slur], [slur])).toHaveLength(1)
  })

  it('throws when a stage drops a prior flag', () => {
    expect(() => assertMonotonic([slur, trademark], [trademark])).toThrow(ScreeningFailClosed)
  })

  it('throws when a stage softens a prior flag', () => {
    const softened = { ...slur, severity: 'note' as const }
    expect(() => assertMonotonic([slur], [softened])).toThrow(/softened/)
  })

  it('folds severities to the worst verdict', () => {
    expect(verdictFor([])).toBe('CLEAR')
    expect(verdictFor([trademark])).toBe('RESTRICTED')
    expect(verdictFor([trademark, slur])).toBe('BLOCKED')
  })
})

describe('a human cannot clear a machine block', () => {
  it('refuses to enqueue a BLOCKED subject at all', async () => {
    const engine = testEngine()
    const report = await engine.screen(metadata({ name: 'ZORBLAT' }))
    const queue = new PaidMediaReviewQueue()

    expect(() =>
      queue.enqueue({
        id: 'item-1',
        vault: '0xvault',
        token: report.subject.token,
        creativeHash: 'abc',
        submittedAtUnix: NOW,
        report,
      }),
    ).toThrow(ScreeningFailClosed)
  })

  it('refuses an approval on any block-severity flag', async () => {
    const engine = testEngine()
    const clean = await engine.screen(metadata())
    const queue = new PaidMediaReviewQueue()
    queue.enqueue({
      id: 'item-2',
      vault: '0xvault',
      token: clean.subject.token,
      creativeHash: 'abc',
      submittedAtUnix: NOW,
      report: { ...clean, flags: [...clean.flags, makeFlag('human_blocked', NOW)] },
    })

    expect(() =>
      queue.decide('item-2', { reviewerId: 'r1', decision: 'approve', decidedAtUnix: NOW }),
    ).toThrow(/cannot approve/)
  })

  it('records a rejection as an added flag, never as a removal', async () => {
    const engine = testEngine()
    const report = await engine.screen(metadata({ name: 'Nintendo Fan Coin' }))
    const queue = new PaidMediaReviewQueue()
    queue.enqueue({
      id: 'item-3',
      vault: '0xvault',
      token: report.subject.token,
      creativeHash: 'abc',
      submittedAtUnix: NOW,
      report,
    })

    const updated = queue.decide('item-3', {
      reviewerId: 'r1',
      decision: 'reject',
      decidedAtUnix: NOW + 10,
    })

    expect(updated.flags.map((f) => f.code)).toContain('trademark_match')
    expect(updated.flags.map((f) => f.code)).toContain('human_rejected_paid_media')
    expect(updated.stagesRun).toContain('human')
    expect(updated.verdict).toBe('RESTRICTED')
  })
})
