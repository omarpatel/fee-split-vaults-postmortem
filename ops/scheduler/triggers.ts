/**
 * Trigger arithmetic, shared by every job so the "is it due" question is
 * answered the same way everywhere.
 *
 * PERIOD KEYS ARE THE IDEMPOTENCY UNIT. An interval job's period is a fixed grid
 * bucket, not "now": if it were "now", every tick would mint a fresh run key and
 * the idempotency record would never match, so a job that crashed halfway would
 * be free to redo its work. A grid bucket means at most one run per window, and
 * the last-success check is what stops it firing at the top of every window when
 * it has just run.
 */

import { DAY, startOfUtcDay, utcDayKey, utcIsoWeekKey, utcParts } from '../lib/time.js'

export interface IntervalDue {
  due: boolean
  period: string
  sinceLastSeconds: number
}

export function intervalDue(nowUnix: number, lastSuccessUnix: number | undefined, everySeconds: number): IntervalDue {
  if (everySeconds <= 0) throw new Error('intervalDue: everySeconds must be positive')
  const bucket = Math.floor(nowUnix / everySeconds)
  const period = `i${everySeconds}-${bucket}`
  if (lastSuccessUnix === undefined) {
    return { due: true, period, sinceLastSeconds: Number.POSITIVE_INFINITY }
  }
  const since = nowUnix - lastSuccessUnix
  return { due: since >= everySeconds, period, sinceLastSeconds: since }
}

export interface CalendarDue {
  due: boolean
  period: string
}

/**
 * A daily job is due once the wall clock has passed its scheduled minute and it
 * has not already succeeded today. A restart at 03:00 for an 02:00 job still
 * runs it; a restart at 03:05 after it ran at 02:00 does not.
 */
export function dailyDue(
  nowUnix: number,
  atUtcHour: number,
  atUtcMinute: number,
  lastSuccessUnix: number | undefined,
): CalendarDue {
  const period = utcDayKey(nowUnix)
  const scheduledAt = startOfUtcDay(nowUnix) + atUtcHour * 3600 + atUtcMinute * 60
  if (nowUnix < scheduledAt) return { due: false, period }
  if (lastSuccessUnix !== undefined && lastSuccessUnix >= scheduledAt) return { due: false, period }
  return { due: true, period }
}

/**
 * A weekly job is due once the scheduled weekday+hour has passed and it has not
 * already succeeded in this ISO week.
 */
export function weeklyDue(
  nowUnix: number,
  dayOfWeekUtc: number,
  atUtcHour: number,
  lastSuccessUnix: number | undefined,
): CalendarDue {
  const period = utcIsoWeekKey(nowUnix)
  const parts = utcParts(nowUnix)
  // Days since the most recent occurrence of the scheduled weekday.
  const daysSince = (parts.dayOfWeek - dayOfWeekUtc + 7) % 7
  const scheduledAt = startOfUtcDay(nowUnix) - daysSince * DAY + atUtcHour * 3600
  if (nowUnix < scheduledAt) return { due: false, period }
  if (lastSuccessUnix !== undefined && lastSuccessUnix >= scheduledAt) return { due: false, period }
  return { due: true, period }
}

/**
 * Deterministic spread of a per-scope job across its window.
 *
 * Without it, 400 vaults all become due at the same second on every interval and
 * the RPC quorum reads arrive as one spike. The offset is a hash of the scope,
 * so it is stable across restarts - a vault does not migrate around the hour.
 */
export function scopeOffsetSeconds(scope: string, windowSeconds: number): number {
  if (windowSeconds <= 0) return 0
  let h = 2166136261
  for (let i = 0; i < scope.length; i += 1) {
    h ^= scope.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h) % windowSeconds
}

/**
 * Interval due with the per-scope offset applied.
 *
 * The offset shifts the GRID, not the elapsed-time test: `since` is still
 * measured against the real clock, so a scope never waits longer than its
 * interval just because of where its hash landed.
 */
export function staggeredIntervalDue(
  nowUnix: number,
  scope: string,
  lastSuccessUnix: number | undefined,
  everySeconds: number,
): IntervalDue {
  const offset = scopeOffsetSeconds(scope, everySeconds)
  const bucket = Math.floor((nowUnix - offset) / everySeconds)
  const period = `i${everySeconds}-${bucket}+${offset}`
  if (lastSuccessUnix === undefined) {
    return { due: true, period, sinceLastSeconds: Number.POSITIVE_INFINITY }
  }
  const since = nowUnix - lastSuccessUnix
  return { due: since >= everySeconds, period, sinceLastSeconds: since }
}
