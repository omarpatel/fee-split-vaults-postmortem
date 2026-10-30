/**
 * The delivery-predicate queue, Postgres-backed. Both ends of one pipe.
 *
 * The orchestrator's spend path enqueues a PredicateSchedule after a
 * reimbursement settles; the ops delivery.predicates job lists what is due,
 * records each verdict and, on a failure, withholds and penalises. One class
 * implements both ports so the composition root can hand the same instance to
 * createSandboxWorld (as `predicates`) and to OpsPorts (as `predicates`), and
 * there is no second table for the two sides to disagree about.
 *
 * IDEMPOTENT BY KEY, NOT BY CHECK. enqueue() expands the spec's offsets into
 * rows under ON CONFLICT DO NOTHING on (disbursement_id, offset_seconds): a
 * tick that retries after the pull landed schedules nothing twice. recordResult()
 * only touches an unchecked row, so a job attempt that crashed after verifying
 * but before its own bookkeeping re-verifies once and records once - it cannot
 * overwrite a verdict that is already on the record.
 *
 * NOTHING HERE MOVES MONEY. withholdPayment and penalizeVendor write records
 * the dispute runbook reads. See 0013_predicate_queue.sql.
 */

import type { DeliveryPredicateSpec, PredicateResult } from '@fee-split-vaults/core'
import type { PredicateQueue as OrchestratorPredicateQueue, PredicateSchedule } from '@fee-split-vaults/orchestrator'
import type { Clock } from '../../lib/time.js'
import type { SqlDriver } from '../../migrations/driver.js'
import type { DuePredicateCheck, PredicateQueue } from '../ports.js'

interface CheckRow {
  disbursement_id: string
  offset_seconds: number
  vault: string
  token: string
  sku_id: string
  vendor_id: string
  cost_usd: number
  funded_at_unix: number | string
  due_at_unix: number | string
  spec: unknown
  baseline: unknown
}

const PREDICATE_KINDS: Record<string, true> = {
  eti_listing: true,
  boost_delta: true,
  trending_rank: true,
  kol_post: true,
  manual_attestation: true,
}

export class PgPredicateQueue implements OrchestratorPredicateQueue, PredicateQueue {
  constructor(
    private readonly driver: SqlDriver,
    private readonly clock: Clock,
  ) {}

  // -- orchestrator side ----------------------------------------------------

  async enqueue(schedule: PredicateSchedule): Promise<void> {
    const offsets = [...new Set(schedule.spec.verifyAtOffsetsSeconds)].sort((a, b) => a - b)
    if (offsets.length === 0) {
      throw new RangeError(`predicate schedule for ${schedule.disbursementId} has no verification offsets`)
    }
    for (const offsetSeconds of offsets) {
      if (!Number.isInteger(offsetSeconds) || offsetSeconds < 0) {
        throw new RangeError(`predicate schedule for ${schedule.disbursementId} has offset ${String(offsetSeconds)}`)
      }
    }
    const spec = JSON.stringify(schedule.spec)
    const baseline = schedule.baseline === undefined ? null : JSON.stringify(schedule.baseline)
    const enqueuedAtUnix = this.clock.nowUnix()
    await this.driver.transaction(async (tx) => {
      for (const offsetSeconds of offsets) {
        await tx.execute(
          `INSERT INTO ops_predicate_check
               (disbursement_id, offset_seconds, vault, token, sku_id, vendor_id, cost_usd,
                funded_at_unix, due_at_unix, spec, baseline, enqueued_at_unix)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)
           ON CONFLICT (disbursement_id, offset_seconds) DO NOTHING`,
          [
            schedule.disbursementId,
            offsetSeconds,
            schedule.vault.toLowerCase(),
            schedule.token.toLowerCase(),
            schedule.skuId,
            schedule.vendorId,
            schedule.costUsd,
            schedule.fundedAtUnix,
            schedule.fundedAtUnix + offsetSeconds,
            spec,
            baseline,
            enqueuedAtUnix,
          ],
        )
      }
    })
  }

  // -- ops side -------------------------------------------------------------

  async listDue(nowUnix: number, limit: number): Promise<DuePredicateCheck[]> {
    const rows = await this.driver.query<CheckRow>(
      `SELECT disbursement_id, offset_seconds, vault, token, sku_id, vendor_id, cost_usd,
              funded_at_unix, due_at_unix, spec, baseline
         FROM ops_predicate_check
        WHERE checked_at_unix IS NULL AND due_at_unix <= $1
        ORDER BY due_at_unix, disbursement_id, offset_seconds
        LIMIT $2`,
      [nowUnix, limit],
    )
    return rows.map(toCheck)
  }

  async recordResult(input: { disbursementId: string; offsetSeconds: number; result: PredicateResult }): Promise<void> {
    const { result } = input
    await this.driver.execute(
      `UPDATE ops_predicate_check
          SET checked_at_unix = $3, passed = $4, evidence_uri = $5, evidence_hash = $6, note = $7
        WHERE disbursement_id = $1 AND offset_seconds = $2 AND checked_at_unix IS NULL`,
      [
        input.disbursementId,
        input.offsetSeconds,
        result.checkedAtUnix,
        result.passed,
        result.evidenceUri ?? null,
        result.evidenceHash ?? null,
        result.note ?? null,
      ],
    )
  }

  async withholdPayment(input: { disbursementId: string; vendorId: string; reason: string }): Promise<void> {
    await this.driver.execute(
      `INSERT INTO ops_predicate_withhold (disbursement_id, vendor_id, reason, withheld_at_unix)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (disbursement_id) DO NOTHING`,
      [input.disbursementId, input.vendorId, input.reason, this.clock.nowUnix()],
    )
  }

  async penalizeVendor(input: { vendorId: string; reason: string }): Promise<void> {
    await this.driver.execute(
      `INSERT INTO ops_vendor_penalty (vendor_id, reason, penalized_at_unix) VALUES ($1, $2, $3)`,
      [input.vendorId, input.reason, this.clock.nowUnix()],
    )
  }

  // -- reads for operators and tests ---------------------------------------

  /** Every recorded verdict for one disbursement, by offset. Unchecked rows are omitted. */
  async results(disbursementId: string): Promise<PredicateResult[]> {
    const rows = await this.driver.query<{
      offset_seconds: number
      checked_at_unix: number | string
      passed: boolean
      evidence_uri: string | null
      evidence_hash: string | null
      note: string | null
    }>(
      `SELECT offset_seconds, checked_at_unix, passed, evidence_uri, evidence_hash, note
         FROM ops_predicate_check
        WHERE disbursement_id = $1 AND checked_at_unix IS NOT NULL
        ORDER BY offset_seconds`,
      [disbursementId],
    )
    return rows.map((row) => {
      const result: PredicateResult = {
        checkedAtUnix: unixFromSql(row.checked_at_unix, 'checked_at_unix'),
        offsetSeconds: row.offset_seconds,
        passed: row.passed,
      }
      if (row.evidence_uri !== null) result.evidenceUri = row.evidence_uri
      if (row.evidence_hash !== null) result.evidenceHash = row.evidence_hash
      if (row.note !== null) result.note = row.note
      return result
    })
  }

  async withheld(disbursementId: string): Promise<{ vendorId: string; reason: string; withheldAtUnix: number } | undefined> {
    const rows = await this.driver.query<{ vendor_id: string; reason: string; withheld_at_unix: number | string }>(
      `SELECT vendor_id, reason, withheld_at_unix FROM ops_predicate_withhold WHERE disbursement_id = $1`,
      [disbursementId],
    )
    const row = rows[0]
    if (row === undefined) return undefined
    return { vendorId: row.vendor_id, reason: row.reason, withheldAtUnix: unixFromSql(row.withheld_at_unix, 'withheld_at_unix') }
  }

  async penaltyCount(vendorId: string): Promise<number> {
    const rows = await this.driver.query<{ n: number | string }>(
      `SELECT count(*) AS n FROM ops_vendor_penalty WHERE vendor_id = $1`,
      [vendorId],
    )
    return Number(rows[0]?.n ?? 0)
  }
}

function toCheck(row: CheckRow): DuePredicateCheck {
  const check: DuePredicateCheck = {
    disbursementId: row.disbursement_id,
    vault: row.vault,
    token: row.token,
    skuId: row.sku_id,
    vendorId: row.vendor_id,
    spec: specFromSql(row.spec, row.disbursement_id),
    offsetSeconds: row.offset_seconds,
    fundedAtUnix: unixFromSql(row.funded_at_unix, 'funded_at_unix'),
    dueAtUnix: unixFromSql(row.due_at_unix, 'due_at_unix'),
    costUsd: Number(row.cost_usd),
  }
  const baseline = baselineFromSql(row.baseline, row.disbursement_id)
  if (baseline !== undefined) check.baseline = baseline
  return check
}

/** pg returns BIGINT as a string; pglite as a number. Both are honest. */
function unixFromSql(value: number | string, field: string): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(n)) throw new TypeError(`${field} is ${String(value)}, not a unix timestamp`)
  return n
}

/**
 * The spec is re-validated on the way back out. A row this build cannot
 * interpret is refused at the read, so a malformed schedule surfaces as a
 * thrown job attempt rather than as a check that silently passes or never runs.
 */
function specFromSql(value: unknown, disbursementId: string): DeliveryPredicateSpec {
  // pg hands JSONB back parsed; a driver that did not is still honest.
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`ops_predicate_check.spec for ${disbursementId} is not an object`)
  }
  const spec = parsed as Record<string, unknown>
  if (typeof spec.kind !== 'string' || PREDICATE_KINDS[spec.kind] !== true) {
    throw new TypeError(`ops_predicate_check.spec for ${disbursementId} has unknown kind ${String(spec.kind)}`)
  }
  const offsets = spec.verifyAtOffsetsSeconds
  if (!Array.isArray(offsets) || offsets.some((o) => typeof o !== 'number')) {
    throw new TypeError(`ops_predicate_check.spec for ${disbursementId} has malformed offsets`)
  }
  const params = spec.params
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new TypeError(`ops_predicate_check.spec for ${disbursementId} has malformed params`)
  }
  for (const [key, param] of Object.entries(params as Record<string, unknown>)) {
    if (typeof param !== 'string' && typeof param !== 'number') {
      throw new TypeError(`ops_predicate_check.spec for ${disbursementId} param ${key} is ${typeof param}`)
    }
  }
  return {
    kind: spec.kind as DeliveryPredicateSpec['kind'],
    verifyAtOffsetsSeconds: offsets as number[],
    params: params as Record<string, string | number>,
  }
}

function baselineFromSql(value: unknown, disbursementId: string): DuePredicateCheck['baseline'] {
  if (value === null || value === undefined) return undefined
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`ops_predicate_check.baseline for ${disbursementId} is not an object`)
  }
  const baseline: { boosts?: number; rank?: number } = {}
  const { boosts, rank } = parsed as Record<string, unknown>
  if (boosts !== undefined) {
    if (typeof boosts !== 'number') throw new TypeError(`ops_predicate_check.baseline.boosts for ${disbursementId} is not a number`)
    baseline.boosts = boosts
  }
  if (rank !== undefined) {
    if (typeof rank !== 'number') throw new TypeError(`ops_predicate_check.baseline.rank for ${disbursementId} is not a number`)
    baseline.rank = rank
  }
  return baseline
}
