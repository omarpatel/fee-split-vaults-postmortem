import { describe, expect, it } from 'vitest'
import {
  DAY_SECONDS,
  effectiveIntervalSeconds,
  isPollDue,
  PENDING_OVERRIDE_INTERVAL_SECONDS,
  scheduledIntervalSeconds,
} from '../schedule.js'

describe('scheduledIntervalSeconds', () => {
  it('decays with vault age', () => {
    expect(scheduledIntervalSeconds(0)).toBe(60)
    expect(scheduledIntervalSeconds(DAY_SECONDS - 1)).toBe(60)
    expect(scheduledIntervalSeconds(DAY_SECONDS)).toBe(600)
    expect(scheduledIntervalSeconds(6 * DAY_SECONDS)).toBe(600)
    expect(scheduledIntervalSeconds(7 * DAY_SECONDS)).toBe(3_600)
    expect(scheduledIntervalSeconds(29 * DAY_SECONDS)).toBe(3_600)
    expect(scheduledIntervalSeconds(30 * DAY_SECONDS)).toBe(7 * DAY_SECONDS)
    expect(scheduledIntervalSeconds(365 * DAY_SECONDS)).toBe(7 * DAY_SECONDS)
  })

  it('treats a negative age as brand new rather than ancient', () => {
    expect(scheduledIntervalSeconds(-5)).toBe(60)
  })
})

describe('effectiveIntervalSeconds', () => {
  const sweepIntervalSeconds = 3_600

  it('never lets a spending vault decay past one sweep interval', () => {
    // A 200-day-old vault is on the weekly band, but if it can still spend it
    // must be visited every sweep interval or the halt guarantee is a fiction.
    const idle = effectiveIntervalSeconds({
      ageSeconds: 200 * DAY_SECONDS,
      spendAuthorityActive: false,
      sweepIntervalSeconds,
    })
    const spending = effectiveIntervalSeconds({
      ageSeconds: 200 * DAY_SECONDS,
      spendAuthorityActive: true,
      sweepIntervalSeconds,
    })

    expect(idle).toBe(7 * DAY_SECONDS)
    expect(spending).toBe(sweepIntervalSeconds)
    expect(spending).toBeLessThanOrEqual(sweepIntervalSeconds)
  })

  it('keeps the tighter of the two when day-one cadence is already faster', () => {
    expect(
      effectiveIntervalSeconds({ ageSeconds: 0, spendAuthorityActive: true, sweepIntervalSeconds }),
    ).toBe(60)
  })

  it('compresses cadence while an owner override is pending', () => {
    expect(
      effectiveIntervalSeconds({
        ageSeconds: 200 * DAY_SECONDS,
        spendAuthorityActive: false,
        sweepIntervalSeconds,
        pendingOverride: true,
      }),
    ).toBe(PENDING_OVERRIDE_INTERVAL_SECONDS)
  })

  it('does not wait at all while backfilling', () => {
    expect(
      effectiveIntervalSeconds({
        ageSeconds: 200 * DAY_SECONDS,
        spendAuthorityActive: false,
        sweepIntervalSeconds,
        backfilling: true,
      }),
    ).toBe(0)
  })
})

describe('isPollDue', () => {
  it('is due exactly one interval after the last poll', () => {
    const input = { ageSeconds: 0, spendAuthorityActive: false, sweepIntervalSeconds: 3_600 }
    expect(isPollDue(1_000, 1_059, input)).toBe(false)
    expect(isPollDue(1_000, 1_060, input)).toBe(true)
  })
})
