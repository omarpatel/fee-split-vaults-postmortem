import { describe, expect, it } from 'vitest'
import { ScreeningFailClosed } from '../flags.js'
import {
  DEFAULT_THROUGHPUT_MODEL,
  PaidMediaReviewQueue,
  assertPaidMediaApproved,
  estimateDailyReviewHours,
  type PaidMediaReviewItem,
} from '../stage4.js'
import type { ScreeningReport } from '../types.js'
import { NOW, metadata, testEngine } from './fixtures.js'

async function itemFor(over: Partial<PaidMediaReviewItem> = {}): Promise<PaidMediaReviewItem> {
  const report = await testEngine().screen(metadata())
  return {
    id: 'item',
    vault: '0xvault',
    token: report.subject.token,
    creativeHash: 'creative-1',
    submittedAtUnix: NOW,
    report,
    ...over,
  }
}

describe('the review queue is one person-hour a day, because the fee gate filters first', () => {
  it('lands near an hour on the modelled book', () => {
    const hours = estimateDailyReviewHours()
    expect(hours).toBeGreaterThan(0.9)
    expect(hours).toBeLessThan(1.25)
  })

  it('matches the arithmetic in the module comment exactly', () => {
    // 40 clients x 1.5 items = 60 items; 10% flagged.
    // 54 x 45s + 6 x 240s = 2430 + 1440 = 3870s = 1.075h
    expect(estimateDailyReviewHours(DEFAULT_THROUGHPUT_MODEL)).toBeCloseTo(3870 / 3600, 6)
  })

  it('stays inside one shift even if the paid book quadruples', () => {
    expect(
      estimateDailyReviewHours({ ...DEFAULT_THROUGHPUT_MODEL, activePaidMediaClients: 160 }),
    ).toBeLessThan(8)
  })

  it('refuses a nonsensical flagged share rather than returning a number', () => {
    expect(() =>
      estimateDailyReviewHours({ ...DEFAULT_THROUGHPUT_MODEL, flaggedShare: 1.4 }),
    ).toThrow(ScreeningFailClosed)
  })
})

describe('PaidMediaReviewQueue', () => {
  it('serves flagged items before clean ones', async () => {
    const queue = new PaidMediaReviewQueue()
    const clean = await itemFor({ id: 'clean' })
    const flagged = await itemFor({ id: 'flagged' })
    flagged.report = await testEngine().screen(metadata({ name: 'Disney Dog' }))

    queue.enqueue(clean)
    queue.enqueue(flagged)

    expect(queue.pending()).toBe(2)
    expect(queue.claim('reviewer-1', NOW)?.id).toBe('flagged')
  })

  it('gates paid media on a recorded approval for this exact creative', async () => {
    const queue = new PaidMediaReviewQueue()
    const item = await itemFor()
    queue.enqueue(item)

    expect(() => assertPaidMediaApproved(item, NOW)).toThrow(/human approval/)

    queue.decide('item', { reviewerId: 'reviewer-1', decision: 'approve', decidedAtUnix: NOW })
    expect(() => assertPaidMediaApproved(item, NOW)).not.toThrow()
  })

  it('refuses to authorise spend on an expired screening', async () => {
    const queue = new PaidMediaReviewQueue()
    const item = await itemFor()
    queue.enqueue(item)
    queue.decide('item', { reviewerId: 'reviewer-1', decision: 'approve', decidedAtUnix: NOW })

    expect(() => assertPaidMediaApproved(item, item.report.expiresAtUnix + 1)).toThrow(/expired/)
  })

  it('returns an escalated item to the queue instead of deciding it', async () => {
    const queue = new PaidMediaReviewQueue()
    const item = await itemFor()
    queue.enqueue(item)
    queue.claim('reviewer-1', NOW)
    expect(queue.pending()).toBe(0)

    const updated = queue.decide('item', {
      reviewerId: 'reviewer-1',
      decision: 'escalate',
      decidedAtUnix: NOW,
    })

    expect(updated.flags.map((f) => f.code)).toContain('human_escalated')
    expect(updated.verdict).toBe('RESTRICTED')
    expect(queue.pending()).toBe(1)
  })

  it('refuses a second decision on a decided item', async () => {
    const queue = new PaidMediaReviewQueue()
    const item = await itemFor()
    queue.enqueue(item)
    queue.decide('item', { reviewerId: 'reviewer-1', decision: 'reject', decidedAtUnix: NOW })

    expect(() =>
      queue.decide('item', { reviewerId: 'reviewer-2', decision: 'approve', decidedAtUnix: NOW }),
    ).toThrow(/already decided/)
  })

  it('refuses an unknown decision value', async () => {
    const queue = new PaidMediaReviewQueue()
    const item = await itemFor()
    queue.enqueue(item)

    expect(() =>
      queue.decide('item', {
        reviewerId: 'reviewer-1',
        decision: 'looks_fine' as unknown as 'approve',
        decidedAtUnix: NOW,
      }),
    ).toThrow(ScreeningFailClosed)
  })

  it('refuses a decision on an item it does not hold', () => {
    const queue = new PaidMediaReviewQueue()
    expect(() =>
      queue.decide('nope', { reviewerId: 'r', decision: 'approve', decidedAtUnix: NOW }),
    ).toThrow(/no review item/)
  })

  it('never permits paid media on a RESTRICTED subject, approval or not', async () => {
    const report: ScreeningReport = await testEngine().screen(metadata({ name: 'Disney Dog' }))
    const item = await itemFor({ id: 'restricted', report })
    expect(() => assertPaidMediaApproved(item, NOW, 'approve')).toThrow(/RESTRICTED/)
  })
})
