/** UTC day bucketing. Every "day" in every tool here is a UTC calendar day. */

export const SECONDS_PER_DAY = 86_400

export function dayStartUnix(unixSeconds: number): number {
  return Math.floor(unixSeconds / SECONDS_PER_DAY) * SECONDS_PER_DAY
}

export function dayIndex(unixSeconds: number): number {
  return Math.floor(unixSeconds / SECONDS_PER_DAY)
}

export function isoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10)
}

export function isoDateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace('.000', '')
}

export function parseSinceArg(value: string, nowUnix: number): number {
  const relative = /^(\d+)([dhw])$/.exec(value.trim())
  if (relative) {
    const n = Number(relative[1])
    const unit = relative[2]
    const seconds = unit === 'h' ? 3600 : unit === 'w' ? 7 * SECONDS_PER_DAY : SECONDS_PER_DAY
    return nowUnix - n * seconds
  }
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) throw new Error(`cannot parse a time from "${value}"`)
  return Math.floor(parsed / 1000)
}

/** Inclusive list of UTC day-start timestamps spanning [from, to]. */
export function daySpan(fromUnix: number, toUnix: number): number[] {
  const out: number[] = []
  for (let d = dayStartUnix(fromUnix); d <= dayStartUnix(toUnix); d += SECONDS_PER_DAY) {
    out.push(d)
  }
  return out
}
