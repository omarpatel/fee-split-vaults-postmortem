/**
 * The FactSheet cache.
 *
 * T0 answers slash commands from CACHED chain reads. That is not only a cost
 * decision (the tier has to run at about a cent per coin per day) - it is the
 * same control the airlock applies to the reader: refreshes happen on a fixed
 * schedule, so no inbound message can trigger an RPC round trip. Flooding the
 * chat costs an attacker everything and costs the desk nothing.
 *
 * A refresh that fails leaves the previous sheet in place. That is safe because
 * usability is decided per field by TTL, not per sheet: an old sheet simply
 * runs out of answerable fields until a refresh succeeds.
 */

import { buildFactSheet, type BuildFactSheetInput, type FactSheet } from './builder.js'

export interface FactSheetCacheOptions {
  /** Minimum seconds between refresh attempts. */
  refreshIntervalSeconds: number
  clock: () => number
  onError?: (error: unknown) => void
}

export class FactSheetCache {
  private sheet: FactSheet | undefined
  private lastAttemptUnix = 0
  private lastSuccessUnix = 0
  private lastError: unknown

  constructor(
    private readonly input: Omit<BuildFactSheetInput, 'nowUnix'>,
    private readonly options: FactSheetCacheOptions,
  ) {}

  /** The cached sheet, or undefined if no refresh has ever succeeded. */
  get(): FactSheet | undefined {
    return this.sheet
  }

  get lastRefreshUnix(): number {
    return this.lastSuccessUnix
  }

  get lastRefreshError(): unknown {
    return this.lastError
  }

  isDue(): boolean {
    return this.options.clock() - this.lastAttemptUnix >= this.options.refreshIntervalSeconds
  }

  /** Called by the scheduler, never by a message handler. */
  async refresh(): Promise<FactSheet | undefined> {
    const nowUnix = this.options.clock()
    this.lastAttemptUnix = nowUnix
    try {
      const sheet = await buildFactSheet({ ...this.input, nowUnix })
      this.sheet = sheet
      this.lastSuccessUnix = nowUnix
      this.lastError = undefined
      return sheet
    } catch (error) {
      this.lastError = error
      this.options.onError?.(error)
      return this.sheet
    }
  }

  /** Refresh only if the interval has elapsed. Safe to call from a tick loop. */
  async refreshIfDue(): Promise<FactSheet | undefined> {
    if (!this.isDue()) return this.sheet
    return this.refresh()
  }
}
