import { describe, expect, it } from 'vitest'
import { DAY, HOUR, utcDayKey, utcIsoWeekKey, startOfUtcDay, backoffSeconds } from '../../lib/time.js'
import { dailyDue, intervalDue, scopeOffsetSeconds, staggeredIntervalDue, weeklyDue } from '../triggers.js'

const MON_2026_09_07_0900 = Math.floor(Date.UTC(2026, 8, 7, 9, 0, 0) / 1000)

describe('intervalDue', () => {
  it('is due when it has never run, so a cold start catches up', () => {
    const result = intervalDue(MON_2026_09_07_0900, undefined, HOUR)
    expect(result.due).toBe(true)
    expect(result.sinceLastSeconds).toBe(Number.POSITIVE_INFINITY)
  })

  it('is not due until the interval has elapsed since the last SUCCESS', () => {
    expect(intervalDue(MON_2026_09_07_0900, MON_2026_09_07_0900 - 59, 60).due).toBe(false)
    expect(intervalDue(MON_2026_09_07_0900, MON_2026_09_07_0900 - 60, 60).due).toBe(true)
  })

  it('gives a stable grid period so a retry keeps the same run key', () => {
    const a = intervalDue(MON_2026_09_07_0900, undefined, 300)
    const b = intervalDue(MON_2026_09_07_0900 + 120, undefined, 300)
    expect(a.period).toBe(b.period)
  })

  it('moves to a new period once the grid bucket rolls over', () => {
    const a = intervalDue(MON_2026_09_07_0900, undefined, 300)
    const b = intervalDue(MON_2026_09_07_0900 + 300, undefined, 300)
    expect(a.period).not.toBe(b.period)
  })

  it('refuses a non-positive interval rather than dividing by zero', () => {
    expect(() => intervalDue(MON_2026_09_07_0900, undefined, 0)).toThrow()
  })
})

describe('staggeredIntervalDue', () => {
  it('spreads scopes across the window deterministically', () => {
    const a = scopeOffsetSeconds('0xaaa', DAY)
    const b = scopeOffsetSeconds('0xbbb', DAY)
    expect(a).not.toBe(b)
    expect(scopeOffsetSeconds('0xaaa', DAY)).toBe(a)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThan(DAY)
  })

  it('still measures elapsed time against the real clock', () => {
    // The offset shifts which bucket a scope lands in, not how long it waits.
    const last = MON_2026_09_07_0900 - DAY
    for (const scope of ['0xaaa', '0xbbb', '0xccc']) {
      expect(staggeredIntervalDue(MON_2026_09_07_0900, scope, last, DAY).due).toBe(true)
      expect(staggeredIntervalDue(MON_2026_09_07_0900, scope, MON_2026_09_07_0900 - 10, DAY).due).toBe(false)
    }
  })
})

describe('dailyDue', () => {
  it('is not due before the scheduled minute', () => {
    const beforeTwo = Math.floor(Date.UTC(2026, 8, 7, 1, 59, 0) / 1000)
    expect(dailyDue(beforeTwo, 2, 0, undefined).due).toBe(false)
  })

  it('is due after the scheduled minute when it has not run today', () => {
    const afterTwo = Math.floor(Date.UTC(2026, 8, 7, 2, 1, 0) / 1000)
    expect(dailyDue(afterTwo, 2, 0, undefined).due).toBe(true)
  })

  it('is not due again once it has run after today’s scheduled time', () => {
    const ranAt = Math.floor(Date.UTC(2026, 8, 7, 2, 0, 30) / 1000)
    const later = Math.floor(Date.UTC(2026, 8, 7, 23, 0, 0) / 1000)
    expect(dailyDue(later, 2, 0, ranAt).due).toBe(false)
  })

  it('is due again the next day even though it ran yesterday', () => {
    const ranYesterday = Math.floor(Date.UTC(2026, 8, 6, 2, 0, 30) / 1000)
    const today = Math.floor(Date.UTC(2026, 8, 7, 2, 0, 30) / 1000)
    const result = dailyDue(today, 2, 0, ranYesterday)
    expect(result.due).toBe(true)
    expect(result.period).toBe(utcDayKey(today))
  })

  it('a restart after the window still runs the missed job', () => {
    // Ran at 23:59 yesterday, restarted at 03:00 today: today's 02:00 job is owed.
    const ranLastNight = Math.floor(Date.UTC(2026, 8, 6, 23, 59, 0) / 1000)
    const restart = Math.floor(Date.UTC(2026, 8, 7, 3, 0, 0) / 1000)
    expect(dailyDue(restart, 2, 0, ranLastNight).due).toBe(true)
  })
})

describe('weeklyDue', () => {
  it('fires on the scheduled weekday and not before', () => {
    const sundayEarly = Math.floor(Date.UTC(2026, 8, 6, 2, 0, 0) / 1000)
    const sundayLate = Math.floor(Date.UTC(2026, 8, 6, 4, 0, 0) / 1000)
    expect(weeklyDue(sundayEarly, 0, 3, undefined).due).toBe(false)
    expect(weeklyDue(sundayLate, 0, 3, undefined).due).toBe(true)
  })

  it('does not fire twice in the same ISO week', () => {
    const sunday = Math.floor(Date.UTC(2026, 8, 6, 4, 0, 0) / 1000)
    const wednesday = Math.floor(Date.UTC(2026, 8, 9, 4, 0, 0) / 1000)
    expect(weeklyDue(wednesday, 0, 3, sunday).due).toBe(false)
  })

  it('uses an ISO week key, so a Monday-start job is stable across a year boundary', () => {
    expect(utcIsoWeekKey(Math.floor(Date.UTC(2026, 11, 31) / 1000))).toBe('2026-W53')
    expect(utcIsoWeekKey(Math.floor(Date.UTC(2027, 0, 1) / 1000))).toBe('2026-W53')
  })
})

describe('time helpers', () => {
  it('startOfUtcDay lands on midnight UTC', () => {
    expect(startOfUtcDay(MON_2026_09_07_0900)).toBe(Math.floor(Date.UTC(2026, 8, 7) / 1000))
  })

  it('backoff grows, is capped, and is deterministic for a given key', () => {
    const seed = 12345
    const a = backoffSeconds(1, 60, 3600, seed)
    const b = backoffSeconds(4, 60, 3600, seed)
    expect(b).toBeGreaterThan(a)
    expect(backoffSeconds(20, 60, 3600, seed)).toBeLessThanOrEqual(3600 * 1.2)
    expect(backoffSeconds(3, 60, 3600, seed)).toBe(backoffSeconds(3, 60, 3600, seed))
  })
})
