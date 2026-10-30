/**
 * One refusal type for every real ops port.
 *
 * Rule 8: an unreachable dependency, a missing row or an unknown enum value is
 * a TYPED refusal, never a default and never a zero. Each adapter throws this
 * with a closed-vocabulary code; the job that called it dead-letters with the
 * code, and the code is what the runbook indexes on.
 */

export type OpsAdapterErrorCode =
  | 'vault_unknown'
  | 'asset_unknown'
  | 'asset_read_failed'
  | 'binding_unknown'
  | 'price_missing'
  | 'signals_unavailable'
  | 'chat_unbound'
  | 'operator_unnamed'
  | 'delivery_failed'
  | 'metadata_unreadable'
  | 'metadata_ref_invalid'
  | 'sweep_unknown'
  | 'row_malformed'
  | 'tier_stale'
  | 'webhook_failed'
  // Chain-side ports (ops/scheduler/adapters/{escrow,sweeper,settlement,enforcement,heartbeat}.ts).
  | 'claim_pending_unresolved'
  | 'claim_event_missing'
  | 'nothing_to_settle'
  | 'settlement_event_missing'
  | 'legs_mismatch'
  | 'not_possible_on_chain'
  | 'paid_media_not_recorded'
  | 'outbox_row_conflict'
  | 'nothing_claimed'

export class OpsAdapterError extends Error {
  constructor(
    readonly code: OpsAdapterErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'OpsAdapterError'
  }
}

/** A row value that must be an integer count or timestamp. */
export function intOf(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value)
  throw new OpsAdapterError('row_malformed', `${field} is not an integer: ${String(value)}`)
}

/** A row value that must be a base-10 minor-unit string. Money never crosses as a number. */
export function bigIntOf(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
  throw new OpsAdapterError('row_malformed', `${field} is not a minor-unit string: ${String(value)}`)
}

export function strOf(value: unknown, field: string): string {
  if (typeof value === 'string') return value
  throw new OpsAdapterError('row_malformed', `${field} is not text: ${String(value)}`)
}

export function boolOf(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value
  throw new OpsAdapterError('row_malformed', `${field} is not boolean: ${String(value)}`)
}

export function floatOf(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length > 0 && Number.isFinite(Number(value))) return Number(value)
  throw new OpsAdapterError('row_malformed', `${field} is not a number: ${String(value)}`)
}
