/**
 * Escalations that survive a restart.
 *
 * "Escalations are not a log line" is the port's own comment, and the in-memory
 * sink is a log line: an array on a class instance, gone the moment the process
 * restarts. The failures that raise escalations - an indexer halt, a ledger
 * freeze, a blocked screening, a settlement that did not land - are exactly the
 * failures that also crash or restart a worker, so the in-memory sink loses its
 * contents precisely when it matters most.
 *
 * WHAT IS AND IS NOT ALLOWED IN `detail`. The port says the code is "a machine
 * code, never free text from a model or from message content", and `detail` is
 * held to the same standard here: it is written by the orchestrator from its
 * own machine facts, it is length-capped on the way in, and a human reads it in
 * a terminal - the same reason `ops_dead_letter.facts_json` carries that
 * warning. This sink does not sanitise, because sanitising would imply
 * untrusted text is acceptable here. It caps, and the callers stay honest.
 *
 * DEDUPE IS BY (vault, kind, code) WHILE OPEN. A halt re-raises on every tick
 * for as long as it holds, and one row per tick would bury the first occurrence
 * under thousands of copies. The row keeps the FIRST raise time - "since when"
 * is the question an operator actually asks - and counts the repeats.
 */

import type { Address } from '@fee-split-vaults/core'
import type { Escalation, EscalationSink } from '@fee-split-vaults/orchestrator'
import { EscalationSinkUnavailableError } from '../errors.js'
import { countFromSql, type SqlDriver } from './sql.js'

/** Bounds one escalation's stored detail. Machine-generated text is short. */
export const MAX_DETAIL_CHARS = 2_000

export interface OpenEscalation extends Escalation {
  readonly occurrences: number
  readonly lastRaisedAtUnix: number
}

interface EscalationRow {
  coin_ref: string
  vault: string
  kind: string
  code: string
  detail: string
  raised_at_unix: unknown
  last_raised_at_unix: unknown
  occurrences: unknown
}

export class PgEscalationSink implements EscalationSink {
  constructor(private readonly driver: SqlDriver) {}

  async raise(escalation: Escalation): Promise<void> {
    try {
      await this.driver.execute(
        `INSERT INTO ops_escalation
             (coin_ref, vault, kind, code, detail, raised_at_unix, last_raised_at_unix, occurrences)
         VALUES ($1, $2, $3, $4, $5, $6, $6, 1)
         ON CONFLICT (vault, kind, code) WHERE resolved_at_unix IS NULL
         DO UPDATE SET occurrences = ops_escalation.occurrences + 1,
                       last_raised_at_unix = greatest(ops_escalation.last_raised_at_unix, EXCLUDED.last_raised_at_unix),
                       detail = EXCLUDED.detail`,
        [
          escalation.coinRef,
          escalation.vault.toLowerCase(),
          escalation.kind,
          escalation.code,
          escalation.detail.slice(0, MAX_DETAIL_CHARS),
          escalation.raisedAtUnix,
        ],
      )
    } catch (error) {
      // A dropped escalation is a page nobody gets. The tick loop's `refuse`
      // path treats a throw here as a tick failure, which is louder than a
      // swallowed write and is the correct trade.
      throw new EscalationSinkUnavailableError(String(error), error)
    }
  }

  /** What a human still has to look at. Ordered oldest first. */
  async open(vault?: Address): Promise<OpenEscalation[]> {
    let rows: EscalationRow[]
    try {
      rows = await this.driver.query<EscalationRow>(
        `SELECT coin_ref, vault, kind, code, detail, raised_at_unix, last_raised_at_unix, occurrences
           FROM ops_escalation
          WHERE resolved_at_unix IS NULL
            AND ($1::text IS NULL OR vault = $1)
          ORDER BY raised_at_unix`,
        [vault === undefined ? null : vault.toLowerCase()],
      )
    } catch (error) {
      throw new EscalationSinkUnavailableError(String(error), error)
    }
    return rows.map((row) => ({
      coinRef: row.coin_ref,
      vault: row.vault,
      kind: row.kind as Escalation['kind'],
      code: row.code,
      detail: row.detail,
      raisedAtUnix: countFromSql(row.raised_at_unix, 'ops_escalation.raised_at_unix'),
      lastRaisedAtUnix: countFromSql(row.last_raised_at_unix, 'ops_escalation.last_raised_at_unix'),
      occurrences: countFromSql(row.occurrences, 'ops_escalation.occurrences'),
    }))
  }

  async resolve(
    vault: Address,
    kind: Escalation['kind'],
    code: string,
    atUnix: number,
    by: string,
  ): Promise<number> {
    try {
      const result = await this.driver.execute(
        `UPDATE ops_escalation
            SET resolved_at_unix = $4, resolved_by = $5
          WHERE vault = $1 AND kind = $2 AND code = $3 AND resolved_at_unix IS NULL`,
        [vault.toLowerCase(), kind, code, atUnix, by],
      )
      return result.rowsAffected
    } catch (error) {
      throw new EscalationSinkUnavailableError(String(error), error)
    }
  }
}
