import { describe, expect, it } from 'vitest'

import {
  BAND_EDGES_CENTS,
  bandBalance,
  bandFor,
  BandError,
  effectiveRevealUnix,
  formatRevealDelay,
  lagVisibility,
  partitionByLag,
  PUBLISH_LAG_SECONDS,
  quantizeObservationUnix,
  type LaggableItem,
} from '../lag.js'
import { formatUsd } from '../money.js'

const NOW = 1_780_000_000
const HOUR = 3_600

/**
 * A well-behaved server item: publishAfterUnix follows occurredAtUnix, so the
 * cases below isolate the client's own rule rather than the helper's defaults.
 */
function item(overrides: Partial<LaggableItem> = {}): LaggableItem {
  const occurredAtUnix = overrides.occurredAtUnix ?? NOW - 10 * HOUR
  return {
    occurredAtUnix,
    publishAfterUnix: occurredAtUnix + PUBLISH_LAG_SECONDS,
    executed: false,
    ...overrides,
  }
}

describe('publication lag', () => {
  it('is 72 hours', () => {
    expect(PUBLISH_LAG_SECONDS).toBe(72 * HOUR)
  })

  it('publishes executed disbursements immediately', () => {
    const spent = item({ executed: true, occurredAtUnix: NOW - 5, publishAfterUnix: NOW + 10 * 86_400 })
    const verdict = lagVisibility(spent, NOW)
    expect(verdict.visible).toBe(true)
    if (verdict.visible) expect(verdict.reason).toBe('executed')
  })

  it('withholds an unexecuted commitment inside the window', () => {
    const verdict = lagVisibility(item({ occurredAtUnix: NOW - HOUR }), NOW)
    expect(verdict.visible).toBe(false)
    if (!verdict.visible) {
      expect(verdict.revealsAtUnix).toBe(NOW - HOUR + PUBLISH_LAG_SECONDS)
      expect(verdict.secondsRemaining).toBe(PUBLISH_LAG_SECONDS - HOUR)
    }
  })

  it('publishes an unexecuted commitment once the window has elapsed', () => {
    const old = item({ occurredAtUnix: NOW - PUBLISH_LAG_SECONDS - 1 })
    const verdict = lagVisibility(old, NOW)
    expect(verdict.visible).toBe(true)
    if (verdict.visible) expect(verdict.reason).toBe('lag_elapsed')
  })

  it('reveals exactly at the boundary, not a second later', () => {
    const occurredAtUnix = NOW - PUBLISH_LAG_SECONDS
    expect(lagVisibility(item({ occurredAtUnix }), NOW).visible).toBe(true)
    expect(lagVisibility(item({ occurredAtUnix: occurredAtUnix + 1 }), NOW).visible).toBe(false)
  })

  // The security property: the server declares publishAfterUnix, and this
  // module must not let that declaration SHORTEN the lag.
  it('ignores a server publishAfterUnix that is earlier than the client floor', () => {
    const hostile = item({ occurredAtUnix: NOW - HOUR, publishAfterUnix: NOW - HOUR })
    expect(effectiveRevealUnix(hostile)).toBe(NOW - HOUR + PUBLISH_LAG_SECONDS)
    expect(lagVisibility(hostile, NOW).visible).toBe(false)
  })

  it('ignores a publishAfterUnix of zero', () => {
    const zeroed = item({ occurredAtUnix: NOW - HOUR, publishAfterUnix: 0 })
    expect(lagVisibility(zeroed, NOW).visible).toBe(false)
  })

  it('honours a server publishAfterUnix that is LATER than the floor', () => {
    const delayed = item({
      occurredAtUnix: NOW - 10 * 86_400,
      publishAfterUnix: NOW + 86_400,
    })
    expect(effectiveRevealUnix(delayed)).toBe(NOW + 86_400)
    expect(lagVisibility(delayed, NOW).visible).toBe(false)
  })

  it('partitions a list, counts what it withheld, and reports the earliest reveal', () => {
    const items = [
      item({ executed: true, occurredAtUnix: NOW - 30 * 86_400 }),
      item({ occurredAtUnix: NOW - 5 * 86_400 }),
      item({ occurredAtUnix: NOW - 2 * HOUR }),
      item({ occurredAtUnix: NOW - 60 * HOUR }),
    ]
    const partition = partitionByLag(items, NOW)

    expect(partition.published).toHaveLength(2)
    expect(partition.withheldCount).toBe(2)
    // The 60h-old one reveals sooner than the 2h-old one.
    expect(partition.nextRevealUnix).toBe(NOW - 60 * HOUR + PUBLISH_LAG_SECONDS)
  })

  it('reports no next reveal when nothing is withheld', () => {
    const partition = partitionByLag([item({ executed: true })], NOW)
    expect(partition.withheldCount).toBe(0)
    expect(partition.nextRevealUnix).toBeNull()
  })

  it('formats the reveal delay coarsely', () => {
    expect(formatRevealDelay(0)).toBe('now')
    expect(formatRevealDelay(HOUR)).toBe('in 1 hour')
    expect(formatRevealDelay(5 * HOUR)).toBe('in 5 hours')
    expect(formatRevealDelay(50 * HOUR)).toBe('in 3 days')
  })
})

describe('balance banding', () => {
  it('reports an exact zero as its own band', () => {
    const band = bandFor(0n)
    expect(band.isZero).toBe(true)
    expect(band.label).toBe('none')
  })

  it('refuses a negative balance rather than banding it', () => {
    expect(() => bandFor(-1n)).toThrow(BandError)
  })

  it('contains the value it was given', () => {
    for (const cents of [1n, 9_999n, 10_000n, 10_001n, 499_999n, 3_400_000n, 999_999_999n]) {
      const band = bandFor(cents)
      expect(cents >= band.lowerCents).toBe(true)
      if (band.upperCents !== null) expect(cents < band.upperCents).toBe(true)
    }
  })

  it('is monotone in the underlying value', () => {
    let previous = -1
    for (let cents = 0n; cents < 200_000_000n; cents = cents * 3n + 7n) {
      if (cents === 0n) continue
      const index = bandFor(cents).index
      expect(index).toBeGreaterThanOrEqual(previous)
      previous = index
    }
  })

  it('never reports an exact figure for a non-zero balance', () => {
    for (const cents of [1n, 123_456n, 7_777_777n, 40_000_001n]) {
      const band = bandFor(cents)
      expect(band.isZero).toBe(false)
      // Every non-zero bucket is at least $100 wide, so the label can never be
      // read as the balance however it is formatted.
      if (band.upperCents === null) {
        expect(band.lowerCents).toBeGreaterThan(0n)
      } else {
        expect(band.upperCents - band.lowerCents).toBeGreaterThanOrEqual(10_000n)
      }
      expect(band.label).not.toBe(formatUsd(cents))
    }
  })

  it('leaves the top of the ladder open rather than capping it', () => {
    const top = BAND_EDGES_CENTS[BAND_EDGES_CENTS.length - 1] ?? 0n
    const band = bandFor(top * 40n)
    expect(band.upperCents).toBeNull()
    expect(band.label.endsWith('+')).toBe(true)
  })

  it('gives the same band for the same value every time it is asked', () => {
    const first = bandFor(3_499_999n)
    const second = bandFor(3_499_999n)
    expect(second).toEqual(first)
  })

  it('quantises observation timestamps down to the hour and is idempotent', () => {
    const noisy = NOW + 2_351
    const snapped = quantizeObservationUnix(noisy)
    expect(snapped % HOUR).toBe(0)
    expect(snapped).toBeLessThanOrEqual(noisy)
    expect(quantizeObservationUnix(snapped)).toBe(snapped)
  })

  // Structural, not cosmetic: components cannot leak a precise balance they
  // were never handed. A reviewer confirms this by reading the type.
  it('hands the presentation layer no exact-cents field at all', () => {
    const banded = bandBalance(4_321_000n, NOW + 91)
    expect(Object.keys(banded).sort()).toEqual(['band', 'label', 'observedAtUnix'])
    const serialised = JSON.stringify(banded, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    )
    expect(serialised).not.toContain('4321000')
    expect(banded.observedAtUnix % HOUR).toBe(0)
  })

  it('bands two nearby balances identically so differencing leaks nothing', () => {
    expect(bandBalance(1_200_000n, NOW).label).toBe(bandBalance(1_290_000n, NOW).label)
  })
})
