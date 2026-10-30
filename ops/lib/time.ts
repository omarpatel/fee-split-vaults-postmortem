/**
 * Time as a dependency.
 *
 * Nothing in ops/ calls Date.now() directly. A scheduler whose clock is a global
 * cannot be tested for the properties that matter - "does the 24h forced sweep
 * fire exactly once per day", "does a daily job that ran at 23:59:59 refuse to
 * run again at 00:00:01" - and those are the properties that decide whether a
 * job is idempotent or whether it double-spends.
 */

export const SECOND = 1
export const MINUTE = 60
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
export const WEEK = 7 * DAY

export interface Clock {
  /** Unix seconds. Integer. */
  nowUnix(): number
}

export class SystemClock implements Clock {
  nowUnix(): number {
    return Math.floor(Date.now() / 1000)
  }
}

/** Test double. Advances only when told to. */
export class FixedClock implements Clock {
  #now: number

  constructor(startUnix: number) {
    this.#now = Math.floor(startUnix)
  }

  nowUnix(): number {
    return this.#now
  }

  advance(seconds: number): number {
    this.#now += Math.floor(seconds)
    return this.#now
  }

  set(unix: number): number {
    this.#now = Math.floor(unix)
    return this.#now
  }
}

/** UTC calendar decomposition. All scheduling in this repo is UTC; no local time, ever. */
export interface UtcParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** 0 = Sunday. */
  dayOfWeek: number
}

export function utcParts(unix: number): UtcParts {
  const d = new Date(unix * 1000)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    dayOfWeek: d.getUTCDay(),
  }
}

/** yyyy-mm-dd in UTC. The period key for every daily job. */
export function utcDayKey(unix: number): string {
  const p = utcParts(unix)
  return `${pad(p.year, 4)}-${pad(p.month, 2)}-${pad(p.day, 2)}`
}

/** yyyy-mm-ddThh in UTC. */
export function utcHourKey(unix: number): string {
  return `${utcDayKey(unix)}T${pad(utcParts(unix).hour, 2)}`
}

/**
 * ISO week key, yyyy-Www. Used as the period key for the weekly jobs so that a
 * restart mid-week cannot re-send a dev report that already went out.
 */
export function utcIsoWeekKey(unix: number): string {
  const d = new Date(unix * 1000)
  // ISO 8601: week 1 is the week containing the first Thursday of the year.
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = (target.getUTCDay() + 6) % 7
  target.setUTCDate(target.getUTCDate() - dayNum + 3)
  const isoYear = target.getUTCFullYear()
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4))
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3)
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * DAY * 1000))
  return `${pad(isoYear, 4)}-W${pad(week, 2)}`
}

/** Start of the UTC day containing `unix`. */
export function startOfUtcDay(unix: number): number {
  return unix - (((unix % DAY) + DAY) % DAY)
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

/**
 * Deterministic exponential backoff with a fixed jitter fraction derived from a
 * seed rather than from Math.random(), so a replayed run reproduces its schedule.
 */
export function backoffSeconds(attempt: number, baseSeconds: number, capSeconds: number, seed: number): number {
  const exponent = Math.min(attempt - 1, 16)
  const raw = Math.min(baseSeconds * 2 ** exponent, capSeconds)
  // +/- 20%, seeded.
  const jitter = ((seed % 401) - 200) / 1000
  return Math.max(1, Math.round(raw * (1 + jitter)))
}
