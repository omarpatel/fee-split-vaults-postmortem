/**
 * The alert evaluator.
 *
 * A pure function from a signal snapshot to a set of firings, plus a small
 * amount of state for the two things a stateless evaluator gets wrong:
 *
 *   FOR-DURATION. An alert with forSeconds > 0 must hold across consecutive
 *   evaluations before it fires. Otherwise a one-tick blip pages someone.
 *   DEDUPE. The same firing on the same scope must not page again every 30
 *   seconds while the responder is working on it.
 *
 * Both are keyed on (alertId, scope), so two different vaults with the same
 * problem are two different pages - which is right, because they are two
 * different pieces of work.
 */

import type { AlertDefinition, AlertFiring, OpsSignals } from './types.js'
import { ALERTS } from './alerts.js'

export interface EvaluationOptions {
  /** Suppress a repeat of the same (alertId, scope) for this long after firing. */
  repeatSuppressionSeconds?: number
  definitions?: readonly AlertDefinition[]
}

interface PendingState {
  firstSeenUnix: number
  lastFiredUnix?: number
}

export interface EvaluationResult {
  atUnix: number
  /** Firings that passed the for-duration and dedupe filters. Act on these. */
  firing: AlertFiring[]
  /** Conditions that are true but have not held long enough yet. */
  pending: AlertFiring[]
  /** Firings suppressed because the same (alertId, scope) fired recently. */
  suppressed: AlertFiring[]
}

export class AlertEvaluator {
  readonly #definitions: readonly AlertDefinition[]
  readonly #state = new Map<string, PendingState>()
  readonly #suppressionSeconds: number

  constructor(options: EvaluationOptions = {}) {
    this.#definitions = options.definitions ?? ALERTS
    this.#suppressionSeconds = options.repeatSuppressionSeconds ?? 30 * 60
  }

  evaluate(signals: OpsSignals): EvaluationResult {
    const firing: AlertFiring[] = []
    const pending: AlertFiring[] = []
    const suppressed: AlertFiring[] = []
    const seen = new Set<string>()

    for (const definition of this.#definitions) {
      let candidates: AlertFiring[]
      try {
        candidates = definition.evaluate(signals)
      } catch {
        // A broken predicate must not take the whole evaluation down with it -
        // the other nineteen alerts are still the only warning anyone gets.
        continue
      }
      for (const candidate of candidates) {
        const key = `${candidate.alertId}#${candidate.scope}`
        seen.add(key)
        const state = this.#state.get(key) ?? { firstSeenUnix: signals.atUnix }
        this.#state.set(key, state)

        if (signals.atUnix - state.firstSeenUnix < definition.forSeconds) {
          pending.push(candidate)
          continue
        }
        if (
          state.lastFiredUnix !== undefined &&
          signals.atUnix - state.lastFiredUnix < this.#suppressionSeconds
        ) {
          suppressed.push(candidate)
          continue
        }
        state.lastFiredUnix = signals.atUnix
        firing.push(candidate)
      }
    }

    // A condition that stopped being true resets, so the next occurrence pages
    // rather than being swallowed by an old suppression window.
    for (const key of [...this.#state.keys()]) {
      if (!seen.has(key)) this.#state.delete(key)
    }

    return { atUnix: signals.atUnix, firing, pending, suppressed }
  }

  /** For a status endpoint: what is currently latched. */
  active(): string[] {
    return [...this.#state.keys()].sort()
  }
}

/** Definitions indexed by id, for the runbook lookup and the docs generator. */
export function alertsById(definitions: readonly AlertDefinition[] = ALERTS): Map<string, AlertDefinition> {
  const map = new Map<string, AlertDefinition>()
  for (const definition of definitions) map.set(definition.id, definition)
  return map
}

/**
 * Render the catalog as a markdown table. Used by ops/runbooks/README.md so the
 * index cannot drift from the definitions - it is generated from them.
 */
export function renderAlertTable(definitions: readonly AlertDefinition[] = ALERTS): string {
  const rows = definitions.map(
    (d) => `| \`${d.id}\` | ${d.severity} | ${d.autoAction} | [${d.runbook.split('/').pop()}](../../${d.runbook}) |`,
  )
  return ['| Alert | Severity | Auto-action | Runbook |', '| --- | --- | --- | --- |', ...rows].join('\n')
}
