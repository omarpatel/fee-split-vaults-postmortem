import { describe, expect, it } from 'vitest'
import { DivergenceDetector, toObservation } from '../divergence/detector.js'
import type { WindowObservation } from '../divergence/detector.js'
import { T0, digestFixture } from './helpers.js'

const HALF_HOUR = 1_800

function steadyWindow(index: number, overrides: Partial<WindowObservation> = {}): WindowObservation {
  const start = T0 + index * HALF_HOUR
  return {
    windowStartUnix: start,
    windowEndUnix: start + HALF_HOUR,
    admittedMessageCount: 40,
    droppedMessageCount: 0,
    topicShares: { how_to_buy: 0.5, sentiment_positive: 0.3, technical_support: 0.2 },
    ...overrides,
  }
}

function warmUp(detector: DivergenceDetector, windows = 12): void {
  for (let i = 0; i < windows; i += 1) {
    const observation = steadyWindow(i, {
      // A little natural jitter, so sigma is not degenerate.
      topicShares: {
        how_to_buy: 0.5 + (i % 3) * 0.01,
        sentiment_positive: 0.3 - (i % 3) * 0.01,
        technical_support: 0.2,
      },
      admittedMessageCount: 40 + (i % 5),
    })
    detector.evaluate(observation)
    detector.observe(observation)
  }
}

describe('divergence detector', () => {
  it('freezes purchases on a cold start, because there is nothing to measure against', () => {
    const detector = new DivergenceDetector()
    const verdict = detector.evaluate(steadyWindow(0))
    expect(verdict.freeze).toBe('purchases')
    expect(verdict.reason).toMatch(/cold start/u)
  })

  it('allows a steady desk once a baseline exists', () => {
    const detector = new DivergenceDetector()
    warmUp(detector)
    const verdict = detector.evaluate(steadyWindow(12))
    expect(verdict.freeze).toBe('none')
    expect(verdict.shifts).toHaveLength(0)
  })

  it('freezes everything on a 3-sigma category shift that coincides with a mention spike', () => {
    const detector = new DivergenceDetector()
    warmUp(detector)

    const spike = steadyWindow(12, {
      admittedMessageCount: 400,
      droppedMessageCount: 40_000,
      topicShares: { how_to_buy: 0.05, raid_or_spam: 0.9, sentiment_positive: 0.05 },
    })
    const verdict = detector.evaluate(spike)

    expect(verdict.freeze).toBe('all')
    expect(verdict.mentionSpike).toBe(true)
    expect(verdict.shifts.map((s) => s.topic)).toContain('raid_or_spam')
    expect(verdict.frozenUntilUnix).toBeGreaterThan(spike.windowEndUnix)
  })

  it('freezes only purchases when the histogram moves without a volume spike', () => {
    const detector = new DivergenceDetector()
    warmUp(detector)

    const drift = steadyWindow(12, {
      topicShares: { how_to_buy: 0.05, roadmap_question: 0.9, sentiment_positive: 0.05 },
    })
    const verdict = detector.evaluate(drift)

    expect(verdict.freeze).toBe('purchases')
    expect(verdict.mentionSpike).toBe(false)
    expect(verdict.shifts.length).toBeGreaterThan(0)
  })

  it('holds the freeze for six hours after it fires', () => {
    const detector = new DivergenceDetector()
    warmUp(detector)

    const spike = steadyWindow(12, {
      admittedMessageCount: 400,
      droppedMessageCount: 40_000,
      topicShares: { raid_or_spam: 0.95 },
    })
    detector.evaluate(spike)
    detector.observe(spike)

    // Two hours later the histogram is normal again; the freeze still stands.
    const calm = steadyWindow(16)
    expect(detector.evaluate(calm).freeze).toBe('all')

    // Seven hours later it has lifted.
    const later = steadyWindow(28)
    expect(detector.evaluate(later).freeze).not.toBe('all')
  })

  it('does not fire on a category that has simply been quiet', () => {
    // sigma floors at minSigma so a topic that has been exactly zero for the
    // whole baseline does not produce an infinite z-score the first time it
    // appears once.
    const detector = new DivergenceDetector()
    warmUp(detector)
    const oneMention = steadyWindow(12, {
      topicShares: {
        how_to_buy: 0.49,
        sentiment_positive: 0.3,
        technical_support: 0.2,
        scam_report: 0.01,
      },
    })
    expect(detector.evaluate(oneMention).freeze).toBe('none')
  })

  it('accepts a manual freeze from an operator', () => {
    const detector = new DivergenceDetector()
    warmUp(detector)
    detector.freezeUntil(T0 + 100 * HALF_HOUR)
    expect(detector.evaluate(steadyWindow(12)).freeze).toBe('all')
  })

  it('derives shares from a digest without ever seeing a message', () => {
    const observation = toObservation(
      digestFixture({ admittedMessageCount: 10, topicCounts: { how_to_buy: 5, scam_report: 1 } }),
    )
    expect(observation.topicShares.how_to_buy).toBeCloseTo(0.5)
    expect(observation.topicShares.scam_report).toBeCloseTo(0.1)
    expect(Object.keys(observation)).not.toContain('gists')
  })
})
