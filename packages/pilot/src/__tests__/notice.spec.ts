import { AirlockViolation } from '@fee-split-vaults/core'
import { describe, expect, it } from 'vitest'

import { generateAssignment, makePilotConfig } from '../assignment.js'
import {
  assertDisclosureUsable,
  awayNoticeSchedule,
  buildAwayNotice,
  DisclosureError,
  withDisclosure,
  type DeskDisclosure,
} from '../notice.js'
import { syntheticCoins } from '../testing/synthetic.js'

const START = Date.UTC(2026, 9, 1) / 1_000

const DISCLOSURE: DeskDisclosure = {
  operatorName: 'Bridgehead Desk',
  aiOperationTag: 'AI-operated',
  paidPromotionTag: '#ad',
}

const coins = syntheticCoins(3, START - 86_400)
const assignment = generateAssignment(
  makePilotConfig('pilot-2026-q4', 'published-seed-a3f9', START),
  coins,
  START - 3_600,
)
const firstCoin = assignment.coins[0]!
const unstaffed = firstCoin.blocks.find((b) => b.arm === 'UNSTAFFED')!
const staffed = firstCoin.blocks.find((b) => b.arm === 'STAFFED')!

describe('disclosure injection', () => {
  it('refuses an unset operator name rather than publishing anonymously', () => {
    expect(() =>
      assertDisclosureUsable({ ...DISCLOSURE, operatorName: 'SET_ME_BEFORE_LAUNCH' }),
    ).toThrow(DisclosureError)
    expect(() => assertDisclosureUsable({ ...DISCLOSURE, aiOperationTag: '' })).toThrow(
      DisclosureError,
    )
  })

  it('strips a model-authored disclosure and re-adds the canonical one', () => {
    const modelAuthored = 'Bridgehead Desk here (AI-operated, honest!) - the desk is away.'
    const out = withDisclosure(modelAuthored, DISCLOSURE, 280)
    expect(out.endsWith(' — Bridgehead Desk · AI-operated')).toBe(true)
    // Exactly one occurrence of each token: the injected one.
    expect(out.split('Bridgehead Desk')).toHaveLength(2)
    expect(out.split('AI-operated')).toHaveLength(2)
  })

  it('truncates the BODY and never the disclosure', () => {
    const long = 'x'.repeat(5_000)
    const out = withDisclosure(long, DISCLOSURE, 280)
    expect(out).toHaveLength(280)
    expect(out.endsWith(' — Bridgehead Desk · AI-operated')).toBe(true)
    expect(out).toContain('…')
  })

  it('refuses to publish at all when the channel cannot hold the disclosure', () => {
    expect(() => withDisclosure('anything', DISCLOSURE, 8)).toThrow(/cannot hold the disclosure/)
  })

  it('adds the paid-promotion tag only for a promotional emission', () => {
    expect(withDisclosure('body', DISCLOSURE, 280, false)).not.toContain('#ad')
    expect(withDisclosure('body', DISCLOSURE, 280, true)).toContain('#ad')
    expect(() =>
      withDisclosure('body', { ...DISCLOSURE, paidPromotionTag: undefined }, 280, true),
    ).toThrow(/paid-promotion tag/)
  })
})

describe('away notice', () => {
  it('says when the desk is back, in UTC', () => {
    const notice = buildAwayNotice(unstaffed, DISCLOSURE)
    const backHour = new Date(unstaffed.endUnixExclusive * 1_000).getUTCHours()
    expect(notice.text).toContain(`${String(backHour).padStart(2, '0')}:00 UTC`)
    expect(notice.postAtUnix).toBe(unstaffed.startUnix)
    expect(notice.backAtUnix).toBe(unstaffed.endUnixExclusive)
  })

  it('is honest that the hours are randomized and the service is free', () => {
    const notice = buildAwayNotice(unstaffed, DISCLOSURE)
    expect(notice.text).toContain('chosen at random')
    expect(notice.text).toContain('free')
    expect(notice.text).toContain('full coverage for the second half')
    expect(notice.text).toContain('AI-operated')
  })

  it('carries no destination an injection could ride in on', () => {
    const notice = buildAwayNotice(unstaffed, DISCLOSURE, {
      scheduleUri: 'https://example.invalid/schedule',
    })
    expect(notice.text).not.toContain('http')
    expect(notice.text).not.toContain('0x')
    // The schedule link travels beside the body, for the channel to attach.
    expect(notice.scheduleUri).toBe('https://example.invalid/schedule')
    expect(() => buildAwayNotice(unstaffed, DISCLOSURE)).not.toThrow(AirlockViolation)
  })

  it('cannot be built for a staffed block', () => {
    expect(() => buildAwayNotice(staffed, DISCLOSURE)).toThrow(/only be built for an UNSTAFFED/)
  })

  it('produces one notice per unstaffed block and none in the second half', () => {
    const schedule = awayNoticeSchedule(assignment, firstCoin.coinRef, DISCLOSURE)
    expect(schedule).toHaveLength(30)
    expect(schedule.every((n) => n.blockIndex < 60)).toBe(true)
    expect(new Set(schedule.map((n) => n.blockIndex)).size).toBe(30)
  })

  it('is computable in full before the pilot starts', () => {
    const a = awayNoticeSchedule(assignment, firstCoin.coinRef, DISCLOSURE)
    const b = awayNoticeSchedule(assignment, firstCoin.coinRef, DISCLOSURE)
    expect(b).toEqual(a)
  })
})
