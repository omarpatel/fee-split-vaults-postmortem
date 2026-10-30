import { describe, expect, it } from 'vitest'

import { formatOffset, formatRelative, isoDate, isoMinute } from '../time.js'

const NOW = 1_780_000_000

describe('relative timestamps', () => {
  it('describes the recent past', () => {
    expect(formatRelative(NOW - 5, NOW)).toBe('just now')
    expect(formatRelative(NOW - 600, NOW)).toBe('10 minutes ago')
    expect(formatRelative(NOW - 3_600, NOW)).toBe('1 hour ago')
    expect(formatRelative(NOW - 4 * 86_400, NOW)).toBe('4 days ago')
  })

  it('describes the near future', () => {
    expect(formatRelative(NOW + 30, NOW)).toBe('in under a minute')
    expect(formatRelative(NOW + 7_200, NOW)).toBe('in 2 hours')
  })

  // Regression: an earlier version fell back to TODAY's date beyond a month, so
  // an old disbursement rendered as if it had happened this morning.
  it('falls back to the item’s own date, never to today’s', () => {
    const old = NOW - 90 * 86_400
    expect(formatRelative(old, NOW)).toBe(isoDate(old))
    expect(formatRelative(old, NOW)).not.toBe(isoDate(NOW))
  })

  it('renders ISO forms in UTC', () => {
    expect(isoDate(0)).toBe('1970-01-01')
    expect(isoMinute(0)).toBe('1970-01-01 00:00')
  })
})

describe('predicate offsets', () => {
  it('reads the first check as hours so it matches the surrounding copy', () => {
    expect(formatOffset(24 * 3_600)).toBe('24h')
    expect(formatOffset(3_600)).toBe('1h')
  })

  it('switches to days beyond two', () => {
    expect(formatOffset(7 * 86_400)).toBe('7d')
    expect(formatOffset(30 * 86_400)).toBe('30d')
  })

  it('falls back to minutes for an odd offset', () => {
    expect(formatOffset(900)).toBe('15m')
  })
})
