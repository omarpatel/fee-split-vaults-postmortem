/**
 * Every error here is a REFUSAL. There is no error in this package that means
 * "carry on with a default": a missing price, an unknown asset, a stale
 * screening or an unreachable dependency all stop the phase that needed them.
 */

export class OrchestratorError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly phase: TickPhase,
  ) {
    super(message)
    this.name = 'OrchestratorError'
  }
}

/**
 * The ordered phases of one coin tick. A phase that refuses does not prevent
 * later phases that do not depend on it, but a phase never runs on inputs an
 * earlier phase failed to produce.
 */
export type TickPhase =
  | 'guard'
  | 'ingest'
  | 'accrual'
  | 'measure'
  | 'tier'
  | 'cognition'
  | 'desk'
  | 'spend'
  | 'publish'
  | 'receipts'

export const TICK_PHASES: readonly TickPhase[] = [
  'guard',
  'ingest',
  'accrual',
  'measure',
  'tier',
  'cognition',
  'desk',
  'spend',
  'publish',
  'receipts',
] as const

/** A coin's work touched another coin's state. Always a bug, never a warning. */
export class CoinIsolationError extends OrchestratorError {
  constructor(expected: string, actual: string, detail: string) {
    super(
      `coin isolation: expected ${expected} but got ${actual} (${detail})`,
      'coin_isolation',
      'guard',
    )
    this.name = 'CoinIsolationError'
  }
}

/** Something that must be present before money or speech is not present. */
export class FailClosed extends OrchestratorError {
  constructor(phase: TickPhase, code: string, message: string) {
    super(message, code, phase)
    this.name = 'FailClosed'
  }
}

export function assertSameCoin(expected: string, actual: string, detail: string): void {
  if (expected !== actual) throw new CoinIsolationError(expected, actual, detail)
}
