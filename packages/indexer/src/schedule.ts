/**
 * Decaying poll schedule.
 *
 * Attention is a cost. A coin's first day decides whether it ever qualifies, and
 * a coin at day 200 changes slowly, so the cadence decays with age.
 *
 * THE FLOOR MATTERS MORE THAN THE DECAY. A vault with live spend authority must
 * be visited at least once per sweep interval, because the recipient watcher's
 * guarantee - halt within one sweep interval - is only as good as the cadence
 * that runs it. Weekly polling plus live spend authority would mean a week of
 * spending against fees that were being redirected to someone else. So the decay
 * is a ceiling on frequency for idle vaults, never a licence to stop watching an
 * active one.
 */

export interface PollBand {
  /** Upper bound of vault age this band applies to, exclusive. */
  readonly untilAgeSeconds: number
  readonly intervalSeconds: number
}

export const DAY_SECONDS = 86_400

const STEADY_STATE_INTERVAL_SECONDS = 7 * DAY_SECONDS

export const POLL_SCHEDULE: readonly PollBand[] = [
  { untilAgeSeconds: DAY_SECONDS, intervalSeconds: 60 },
  { untilAgeSeconds: 7 * DAY_SECONDS, intervalSeconds: 600 },
  { untilAgeSeconds: 30 * DAY_SECONDS, intervalSeconds: 3_600 },
  { untilAgeSeconds: Number.POSITIVE_INFINITY, intervalSeconds: STEADY_STATE_INTERVAL_SECONDS },
]

/** Cadence from age alone, before any floor is applied. */
export function scheduledIntervalSeconds(ageSeconds: number): number {
  const age = Math.max(0, ageSeconds)
  for (const band of POLL_SCHEDULE) {
    if (age < band.untilAgeSeconds) return band.intervalSeconds
  }
  return STEADY_STATE_INTERVAL_SECONDS
}

export interface PollPolicyInput {
  readonly ageSeconds: number
  /** True while the vault can authorise spending. Forces the sweep-interval floor. */
  readonly spendAuthorityActive: boolean
  readonly sweepIntervalSeconds: number
  /** A proposed owner override compresses cadence: 3 days is the whole window. */
  readonly pendingOverride?: boolean
  /** Still catching up. Backfill runs continuously, not on the decayed cadence. */
  readonly backfilling?: boolean
}

export const PENDING_OVERRIDE_INTERVAL_SECONDS = 600

export function effectiveIntervalSeconds(input: PollPolicyInput): number {
  if (input.backfilling === true) return 0

  let interval = scheduledIntervalSeconds(input.ageSeconds)
  if (input.spendAuthorityActive) {
    interval = Math.min(interval, input.sweepIntervalSeconds)
  }
  if (input.pendingOverride === true) {
    interval = Math.min(interval, PENDING_OVERRIDE_INTERVAL_SECONDS)
  }
  return interval
}

export function nextPollAtUnix(lastPollUnix: number, input: PollPolicyInput): number {
  return lastPollUnix + effectiveIntervalSeconds(input)
}

export function isPollDue(lastPollUnix: number, nowUnix: number, input: PollPolicyInput): boolean {
  return nowUnix >= nextPollAtUnix(lastPollUnix, input)
}
