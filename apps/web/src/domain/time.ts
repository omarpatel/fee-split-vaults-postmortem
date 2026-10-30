/**
 * Time formatting, kept out of the components so it is testable in a Node
 * runner alongside the rest of the presentation arithmetic.
 */

/**
 * A relative timestamp, falling back to the item's OWN date beyond a month.
 *
 * The fallback matters: an earlier version fell back to today's date, so a
 * two-month-old disbursement rendered as if it had happened this morning. On a
 * receipts page that is not a cosmetic bug.
 */
export function formatRelative(unix: number, nowUnix: number): string {
  const delta = nowUnix - unix
  const ahead = delta < 0
  const seconds = Math.abs(delta)
  const render = (value: number, unit: string): string =>
    `${ahead ? 'in ' : ''}${value} ${unit}${value === 1 ? '' : 's'}${ahead ? '' : ' ago'}`

  if (seconds < 90) return ahead ? 'in under a minute' : 'just now'
  if (seconds < 3_600) return render(Math.round(seconds / 60), 'minute')
  if (seconds < 86_400) return render(Math.round(seconds / 3_600), 'hour')
  if (seconds < 30 * 86_400) return render(Math.round(seconds / 86_400), 'day')
  return isoDate(unix)
}

export function isoDate(unix: number): string {
  return new Date(unix * 1_000).toISOString().slice(0, 10)
}

export function isoMinute(unix: number): string {
  return new Date(unix * 1_000).toISOString().replace('T', ' ').slice(0, 16)
}

/**
 * A predicate re-check offset. Hours below two days, so the first check reads
 * "T+24h" and matches the copy that says when the first check runs.
 */
export function formatOffset(seconds: number): string {
  if (seconds < 2 * 86_400 && seconds % 3_600 === 0) return `${seconds / 3_600}h`
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`
  return `${Math.round(seconds / 60)}m`
}
