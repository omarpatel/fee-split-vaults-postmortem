import { TOPIC_CODES } from '@fee-split-vaults/core'
import type { Digest, TopicCode } from '@fee-split-vaults/core'

/**
 * DIVERGENCE FREEZE.
 *
 * The airlock stops an injected instruction from naming a payee. It does not
 * stop a slower attack: flood a channel until the topic histogram itself shifts,
 * and the planner - reasoning correctly over a corrupted picture of reality -
 * genuinely wants to spend. Nothing in the airlock is violated. The counts are
 * real. The conclusion is wrong.
 *
 * The detector treats a large, sudden category shift that COINCIDES with a
 * mention spike as evidence the histogram is being steered rather than moving.
 * Coincidence is the whole signal: organic topic drift is slow and does not need
 * a volume spike to arrive, while a steering attack has to move volume to move
 * the shares.
 *
 * On a hit, proposals freeze. Freezing is cheap - a window of silence costs
 * nothing - and the alternative is a spend decision taken on manufactured input.
 */

export type FreezeLevel = 'none' | 'purchases' | 'all'

export interface WindowObservation {
  windowStartUnix: number
  windowEndUnix: number
  admittedMessageCount: number
  droppedMessageCount: number
  /** Share of admitted messages per topic, summing to at most 1. */
  topicShares: Partial<Record<TopicCode, number>>
}

export interface CategoryShift {
  topic: TopicCode
  share: number
  mean: number
  sigma: number
  z: number
}

export interface DivergenceVerdict {
  freeze: FreezeLevel
  reason: string
  shifts: CategoryShift[]
  mentionSpike: boolean
  mentionZ: number
  baselineWindows: number
  frozenUntilUnix?: number
}

export interface DetectorOptions {
  /** Windows of history used as the baseline. */
  baselineWindows?: number
  /** Below this many observations nothing can be measured, so purchases freeze. */
  minBaselineWindows?: number
  sigmaThreshold?: number
  /**
   * Floor on sigma, in share units. Without it a category that has been exactly
   * zero for six windows has sigma 0 and any appearance at all is infinite-sigma,
   * which would freeze the desk permanently on its first quiet week.
   */
  minSigma?: number
  /** Mention volume z-score above which a window counts as a spike. */
  mentionSigmaThreshold?: number
  /** How long a mention spike keeps a category shift suspicious. */
  correlationWindowHours?: number
  /** How long a freeze lasts once it fires. */
  freezeDurationHours?: number
}

const DEFAULTS = {
  baselineWindows: 48,
  minBaselineWindows: 6,
  sigmaThreshold: 3,
  minSigma: 0.05,
  mentionSigmaThreshold: 3,
  correlationWindowHours: 6,
  freezeDurationHours: 6,
} as const

interface HistoryEntry {
  windowEndUnix: number
  volume: number
  shares: Partial<Record<TopicCode, number>>
}

export class DivergenceDetector {
  private readonly opts: Required<DetectorOptions>
  private readonly history: HistoryEntry[] = []
  private readonly mentionSpikes: number[] = []
  private frozenUntilUnix = 0

  constructor(options: DetectorOptions = {}) {
    this.opts = { ...DEFAULTS, ...options }
    if (this.opts.minSigma <= 0) throw new Error('minSigma must be positive')
    if (this.opts.baselineWindows < this.opts.minBaselineWindows) {
      throw new Error('baselineWindows must be at least minBaselineWindows')
    }
  }

  /**
   * Evaluate the current window against the baseline. Pure: call observe()
   * afterwards to fold the window into the baseline, so a window is never
   * measured against itself.
   */
  evaluate(current: WindowObservation): DivergenceVerdict {
    const baseline = this.history.slice(-this.opts.baselineWindows)
    const volume = current.admittedMessageCount + current.droppedMessageCount
    const mentionZ = zScore(
      volume,
      baseline.map((h) => h.volume),
      1,
    )
    const mentionSpike = baseline.length >= this.opts.minBaselineWindows
      ? mentionZ >= this.opts.mentionSigmaThreshold
      : false

    if (current.windowEndUnix < this.frozenUntilUnix) {
      return {
        freeze: 'all',
        reason: 'freeze still in effect from an earlier divergence',
        shifts: [],
        mentionSpike,
        mentionZ,
        baselineWindows: baseline.length,
        frozenUntilUnix: this.frozenUntilUnix,
      }
    }

    if (baseline.length < this.opts.minBaselineWindows) {
      return {
        freeze: 'purchases',
        reason: `cold start: ${String(baseline.length)} of ${String(
          this.opts.minBaselineWindows,
        )} baseline windows observed`,
        shifts: [],
        mentionSpike,
        mentionZ,
        baselineWindows: baseline.length,
      }
    }

    const shifts: CategoryShift[] = []
    for (const topic of TOPIC_CODES) {
      const share = current.topicShares[topic] ?? 0
      const samples = baseline.map((h) => h.shares[topic] ?? 0)
      const mean = average(samples)
      const sigma = Math.max(standardDeviation(samples, mean), this.opts.minSigma)
      const z = (share - mean) / sigma
      if (Math.abs(z) >= this.opts.sigmaThreshold) {
        shifts.push({ topic, share, mean, sigma, z })
      }
    }

    const recentSpike = this.mentionSpikeWithin(current.windowEndUnix) || mentionSpike

    if (shifts.length > 0 && recentSpike) {
      this.frozenUntilUnix =
        current.windowEndUnix + this.opts.freezeDurationHours * 3_600
      return {
        freeze: 'all',
        reason:
          `${String(shifts.length)} category shift(s) beyond ` +
          `${String(this.opts.sigmaThreshold)} sigma within ` +
          `${String(this.opts.correlationWindowHours)}h of a mention spike`,
        shifts,
        mentionSpike: recentSpike,
        mentionZ,
        baselineWindows: baseline.length,
        frozenUntilUnix: this.frozenUntilUnix,
      }
    }

    if (shifts.length > 0) {
      return {
        freeze: 'purchases',
        reason: 'category shift without a correlated mention spike',
        shifts,
        mentionSpike: recentSpike,
        mentionZ,
        baselineWindows: baseline.length,
      }
    }

    return {
      freeze: 'none',
      reason: 'within baseline',
      shifts: [],
      mentionSpike: recentSpike,
      mentionZ,
      baselineWindows: baseline.length,
    }
  }

  observe(current: WindowObservation): void {
    const volume = current.admittedMessageCount + current.droppedMessageCount
    const baseline = this.history.slice(-this.opts.baselineWindows)
    if (baseline.length >= this.opts.minBaselineWindows) {
      const z = zScore(
        volume,
        baseline.map((h) => h.volume),
        1,
      )
      if (z >= this.opts.mentionSigmaThreshold) this.mentionSpikes.push(current.windowEndUnix)
    }
    this.history.push({
      windowEndUnix: current.windowEndUnix,
      volume,
      shares: { ...current.topicShares },
    })
    if (this.history.length > this.opts.baselineWindows * 2) {
      this.history.splice(0, this.history.length - this.opts.baselineWindows * 2)
    }
    const cutoff = current.windowEndUnix - this.opts.correlationWindowHours * 3_600
    while (this.mentionSpikes.length > 0 && (this.mentionSpikes[0] ?? 0) < cutoff) {
      this.mentionSpikes.shift()
    }
  }

  /** Manual freeze, for an operator who sees something the detector did not. */
  freezeUntil(unix: number): void {
    this.frozenUntilUnix = Math.max(this.frozenUntilUnix, unix)
  }

  get observedWindows(): number {
    return this.history.length
  }

  private mentionSpikeWithin(nowUnix: number): boolean {
    const cutoff = nowUnix - this.opts.correlationWindowHours * 3_600
    return this.mentionSpikes.some((t) => t >= cutoff && t <= nowUnix)
  }
}

/** Topic shares from a digest, normalised by admitted messages. */
export function toObservation(digest: Digest): WindowObservation {
  const denominator = Math.max(digest.admittedMessageCount, 1)
  const topicShares: Partial<Record<TopicCode, number>> = {}
  for (const topic of TOPIC_CODES) {
    const count = digest.topicCounts[topic]
    if (count !== undefined && count > 0) topicShares[topic] = count / denominator
  }
  return {
    windowStartUnix: digest.windowStartUnix,
    windowEndUnix: digest.windowEndUnix,
    admittedMessageCount: digest.admittedMessageCount,
    droppedMessageCount: digest.droppedMessageCount,
    topicShares,
  }
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0
  let total = 0
  for (const v of values) total += v
  return total / values.length
}

function standardDeviation(values: readonly number[], mean: number): number {
  if (values.length < 2) return 0
  let sum = 0
  for (const v of values) sum += (v - mean) ** 2
  return Math.sqrt(sum / (values.length - 1))
}

function zScore(value: number, samples: readonly number[], minSigma: number): number {
  if (samples.length < 2) return 0
  const mean = average(samples)
  const sigma = Math.max(standardDeviation(samples, mean), minSigma)
  return (value - mean) / sigma
}
