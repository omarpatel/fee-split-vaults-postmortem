/**
 * Postgres-backed implementations of the scheduler's three durable stores.
 *
 * These are what makes the operations plane survivable across a restart and
 * safe across two workers. The in-memory versions in idempotency.ts,
 * deadletter.ts and scheduler.ts are for tests and for `run-local`; production
 * runs these.
 *
 * THE CLAIM IS ONE STATEMENT. `begin()` is a single conditional upsert, so two
 * workers racing for the same run key both issue it and exactly one gets a row
 * back. Doing it as SELECT-then-UPDATE would open a window in which both read
 * "not claimed" and both proceed, and for the escrow sweep that window is a
 * second on-chain claim.
 */

import { randomUUID } from 'node:crypto'
import type { SqlDriver } from '../../migrations/driver.js'
import type { DeadLetter, DeadLetterQueue } from '../deadletter.js'
import { RunStoreUnavailable, type BeginInput, type RunRecord, type RunState, type RunStore } from '../idempotency.js'
import type { FreezeGate } from '../scheduler.js'
import type { JobId, RunReason } from '../types.js'

interface RunRow {
  run_key: string
  job_id: string
  scope: string
  period: string
  state: string
  attempt: number
  started_at_unix: number
  updated_at_unix: number
  lease_expires_at_unix: number | null
  completed_at_unix: number | null
  code: string | null
}

function toRecord(row: RunRow): RunRecord {
  const record: RunRecord = {
    runKey: row.run_key,
    jobId: row.job_id,
    scope: row.scope,
    period: row.period,
    state: row.state as RunState,
    attempt: Number(row.attempt),
    startedAtUnix: Number(row.started_at_unix),
    updatedAtUnix: Number(row.updated_at_unix),
  }
  if (row.lease_expires_at_unix !== null) record.leaseExpiresAtUnix = Number(row.lease_expires_at_unix)
  if (row.completed_at_unix !== null) record.completedAtUnix = Number(row.completed_at_unix)
  if (row.code !== null) record.code = row.code
  return record
}

export class SqlRunStore implements RunStore {
  constructor(private readonly driver: SqlDriver) {}

  async begin(input: BeginInput): Promise<RunRecord | null> {
    try {
      // A `completed` or `dead_lettered` row does not satisfy the WHERE clause,
      // so a finished period can never be reopened by a retry. That is the
      // property the whole idempotency argument rests on.
      const rows = await this.driver.query<RunRow>(
        `INSERT INTO ops_job_run
             (run_key, job_id, scope, period, state, attempt, started_at_unix, updated_at_unix, lease_expires_at_unix)
         VALUES ($1, $2, $3, $4, 'in_progress', 1, $5, $5, $6)
         ON CONFLICT (run_key) DO UPDATE
            SET state = 'in_progress',
                attempt = ops_job_run.attempt + 1,
                updated_at_unix = $5,
                lease_expires_at_unix = $6
          WHERE ops_job_run.state IN ('retry', 'in_progress')
            AND (ops_job_run.lease_expires_at_unix IS NULL OR ops_job_run.lease_expires_at_unix <= $5)
            AND ops_job_run.attempt < $7
         RETURNING run_key, job_id, scope, period, state, attempt, started_at_unix,
                   updated_at_unix, lease_expires_at_unix, completed_at_unix, code`,
        [input.runKey, input.jobId, input.scope, input.period, input.nowUnix, input.nowUnix + input.leaseSeconds, input.maxAttempts],
      )
      const row = rows[0]
      return row === undefined ? null : toRecord(row)
    } catch (error) {
      throw new RunStoreUnavailable('begin failed', error)
    }
  }

  async complete(runKey: string, atUnix: number, code: string): Promise<void> {
    try {
      await this.driver.execute(
        `UPDATE ops_job_run
            SET state = 'completed', updated_at_unix = $1, completed_at_unix = $1,
                code = $2, lease_expires_at_unix = NULL
          WHERE run_key = $3`,
        [atUnix, code, runKey],
      )
    } catch (error) {
      throw new RunStoreUnavailable('complete failed', error)
    }
  }

  async fail(runKey: string, atUnix: number, code: string, willRetry: boolean): Promise<void> {
    try {
      await this.driver.execute(
        `UPDATE ops_job_run
            SET state = $1, updated_at_unix = $2, code = $3, lease_expires_at_unix = NULL
          WHERE run_key = $4 AND state <> 'completed'`,
        [willRetry ? 'retry' : 'dead_lettered', atUnix, code, runKey],
      )
    } catch (error) {
      throw new RunStoreUnavailable('fail failed', error)
    }
  }

  async get(runKey: string): Promise<RunRecord | undefined> {
    const rows = await this.driver.query<RunRow>(
      `SELECT run_key, job_id, scope, period, state, attempt, started_at_unix,
              updated_at_unix, lease_expires_at_unix, completed_at_unix, code
         FROM ops_job_run WHERE run_key = $1`,
      [runKey],
    )
    const row = rows[0]
    return row === undefined ? undefined : toRecord(row)
  }

  async lastSuccessUnix(jobId: string, scope: string): Promise<number | undefined> {
    try {
      const rows = await this.driver.query<{ last: number | null }>(
        `SELECT max(completed_at_unix) AS last
           FROM ops_job_run
          WHERE job_id = $1 AND scope = $2 AND state = 'completed'`,
        [jobId, scope],
      )
      const value = rows[0]?.last
      return value === null || value === undefined ? undefined : Number(value)
    } catch (error) {
      throw new RunStoreUnavailable('lastSuccessUnix failed', error)
    }
  }

  async listDeadLettered(limit: number): Promise<RunRecord[]> {
    const rows = await this.driver.query<RunRow>(
      `SELECT run_key, job_id, scope, period, state, attempt, started_at_unix,
              updated_at_unix, lease_expires_at_unix, completed_at_unix, code
         FROM ops_job_run WHERE state = 'dead_lettered'
         ORDER BY updated_at_unix DESC LIMIT $1`,
      [limit],
    )
    return rows.map(toRecord)
  }
}

// ---------------------------------------------------------------------------

interface DeadLetterRow {
  id: string
  job_id: string
  scope: string
  period: string
  run_key: string
  attempts: number
  error_code: string
  facts_json: string
  reason_kind: string
  first_failed_at_unix: number
  last_failed_at_unix: number
  resolved_at_unix: number | null
  resolved_by: string | null
  resolution: string | null
}

export class SqlDeadLetterQueue implements DeadLetterQueue {
  constructor(private readonly driver: SqlDriver) {}

  async park(letter: Omit<DeadLetter, 'id'>): Promise<DeadLetter> {
    const id = randomUUID()
    await this.driver.execute(
      `INSERT INTO ops_dead_letter
           (id, job_id, scope, period, run_key, attempts, error_code, facts_json,
            reason_kind, first_failed_at_unix, last_failed_at_unix)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        letter.jobId,
        letter.scope,
        letter.period,
        letter.runKey,
        letter.attempts,
        letter.errorCode,
        JSON.stringify(letter.facts),
        letter.reason.kind,
        letter.firstFailedAtUnix,
        letter.lastFailedAtUnix,
      ],
    )
    return { ...letter, id }
  }

  async list(options: { includeResolved?: boolean; limit?: number } = {}): Promise<DeadLetter[]> {
    const rows = await this.driver.query<DeadLetterRow>(
      `SELECT * FROM ops_dead_letter
        WHERE ($1 OR resolved_at_unix IS NULL)
        ORDER BY last_failed_at_unix DESC LIMIT $2`,
      [options.includeResolved ?? false, options.limit ?? 100],
    )
    return rows.map((row) => {
      const letter: DeadLetter = {
        id: row.id,
        jobId: row.job_id as JobId,
        scope: row.scope,
        period: row.period,
        runKey: row.run_key,
        attempts: Number(row.attempts),
        errorCode: row.error_code,
        facts: parseFacts(row.facts_json),
        reason: { kind: 'manual', requestedBy: row.reason_kind } as RunReason,
        firstFailedAtUnix: Number(row.first_failed_at_unix),
        lastFailedAtUnix: Number(row.last_failed_at_unix),
      }
      if (row.resolved_at_unix !== null) letter.resolvedAtUnix = Number(row.resolved_at_unix)
      if (row.resolved_by !== null) letter.resolvedBy = row.resolved_by
      if (row.resolution !== null) letter.resolution = row.resolution as DeadLetter['resolution']
      return letter
    })
  }

  async resolve(id: string, atUnix: number, by: string, resolution: DeadLetter['resolution']): Promise<void> {
    await this.driver.execute(
      `UPDATE ops_dead_letter SET resolved_at_unix = $1, resolved_by = $2, resolution = $3
        WHERE id = $4 AND resolved_at_unix IS NULL`,
      [atUnix, by, resolution ?? 'fixed_out_of_band', id],
    )
  }

  async openCount(): Promise<number> {
    const rows = await this.driver.query<{ n: string }>(
      'SELECT count(*) AS n FROM ops_dead_letter WHERE resolved_at_unix IS NULL',
    )
    return Number(rows[0]?.n ?? 0)
  }
}

function parseFacts(json: string): Record<string, string | number | boolean> {
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------

/**
 * Reads the ledger's freeze table.
 *
 * FAIL CLOSED: a query failure throws rather than returning false, and the
 * scheduler treats a throw here as "refuse to run the money-moving job". A
 * freeze gate that answers "not frozen" when it cannot reach the database is
 * worse than no freeze gate at all.
 */
export class SqlFreezeGate implements FreezeGate {
  constructor(private readonly driver: SqlDriver) {}

  async authorizationFrozen(scope: string): Promise<boolean> {
    // Scopes may be `vault#asset`; a freeze is recorded against the vault.
    const separator = scope.indexOf('#')
    const vault = separator === -1 ? scope : scope.slice(0, separator)
    const rows = await this.driver.query<{ n: string }>(
      `SELECT count(*) AS n FROM ledger_freeze
        WHERE cleared_at_unix IS NULL
          AND (scope_kind = 'global'
               OR (scope_kind IN ('vault','vault_asset') AND scope_vault = $1))`,
      [vault],
    )
    return Number(rows[0]?.n ?? 0) > 0
  }
}
