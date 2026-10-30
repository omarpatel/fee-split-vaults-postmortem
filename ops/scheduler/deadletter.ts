/**
 * The dead-letter path.
 *
 * A job that has exhausted its attempts stops retrying and is parked with enough
 * context to be replayed by hand. Two rules:
 *
 *   1. Nothing is dropped. A dead letter is a durable record, and the alert on
 *      dead-letter growth (ops/monitoring/alerts.ts) is what makes someone look.
 *   2. The payload is machine data only - job id, scope, period, attempt, error
 *      code, and a bounded fact map. No untrusted text, so replaying a dead
 *      letter into a terminal cannot become the injection vector.
 */

import type { JobId, RunReason } from './types.js'

export interface DeadLetter {
  id: string
  jobId: JobId
  scope: string
  period: string
  runKey: string
  attempts: number
  errorCode: string
  /** Bounded, machine-generated. Never a raw error message from a remote service. */
  facts: Record<string, string | number | boolean>
  reason: RunReason
  firstFailedAtUnix: number
  lastFailedAtUnix: number
  /** Set when an operator has decided what to do. Never cleared automatically. */
  resolvedAtUnix?: number
  resolvedBy?: string
  resolution?: 'replayed' | 'discarded' | 'fixed_out_of_band'
}

export interface DeadLetterQueue {
  park(letter: Omit<DeadLetter, 'id'>): Promise<DeadLetter>
  list(options?: { includeResolved?: boolean; limit?: number }): Promise<DeadLetter[]>
  resolve(id: string, atUnix: number, by: string, resolution: DeadLetter['resolution']): Promise<void>
  /** Unresolved count. The monitoring plane reads this. */
  openCount(): Promise<number>
}

export class InMemoryDeadLetterQueue implements DeadLetterQueue {
  readonly #letters: DeadLetter[] = []
  #seq = 0

  async park(letter: Omit<DeadLetter, 'id'>): Promise<DeadLetter> {
    this.#seq += 1
    const stored: DeadLetter = { ...letter, id: `dl-${String(this.#seq).padStart(8, '0')}` }
    this.#letters.push(stored)
    return { ...stored }
  }

  async list(options: { includeResolved?: boolean; limit?: number } = {}): Promise<DeadLetter[]> {
    const includeResolved = options.includeResolved ?? false
    const limit = options.limit ?? 100
    return this.#letters
      .filter((l) => includeResolved || l.resolvedAtUnix === undefined)
      .slice(-limit)
      .map((l) => ({ ...l }))
  }

  async resolve(id: string, atUnix: number, by: string, resolution: DeadLetter['resolution']): Promise<void> {
    const found = this.#letters.find((l) => l.id === id)
    if (!found) throw new Error(`dead letter ${id} not found`)
    found.resolvedAtUnix = atUnix
    found.resolvedBy = by
    found.resolution = resolution
  }

  async openCount(): Promise<number> {
    return this.#letters.filter((l) => l.resolvedAtUnix === undefined).length
  }
}
