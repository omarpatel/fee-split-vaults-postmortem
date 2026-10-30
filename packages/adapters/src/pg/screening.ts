/**
 * Screening verdicts over Postgres, on 0005's `screening_result`.
 *
 * `latest()` is the `is_current` row. `put()` retires the previous current
 * row and inserts the new one in one transaction, so there is never a moment
 * with two governing verdicts or none. The table's own constraint refuses a
 * RESTRICTED or BLOCKED result that claims paid-media permission; that is not
 * caught and softened here. It is a fail-closed refusal at the last line.
 */

import { randomUUID } from 'node:crypto'
import type { Address, ScreeningResult, ScreeningVerdict } from '@fee-split-vaults/core'
import type { ScreeningStore } from '@fee-split-vaults/orchestrator'
import { boolFromSql, enumFromSql, guarded, optStrFromSql, stringArrayFromSql, strFromSql, withOptional } from './rows.js'
import { countFromSql, type SqlDriver } from './sql.js'

const VERDICTS: readonly ScreeningVerdict[] = ['CLEAR', 'RESTRICTED', 'BLOCKED']
const STAGES = ['lexicon', 'trademark', 'perceptual', 'adjudication', 'human'] as const
type Stage = (typeof STAGES)[number]

export class PgScreeningStore implements ScreeningStore {
  constructor(private readonly driver: SqlDriver) {}

  async latest(token: Address): Promise<ScreeningResult | undefined> {
    const rows = await guarded('screening_result', () =>
      this.driver.query(
        `SELECT token, verdict, flags, stages_run, screened_at_unix, paid_media_permitted, note
           FROM screening_result WHERE token = $1 AND is_current`,
        [token.toLowerCase()],
      ),
    )
    const row = rows[0]
    if (row === undefined) return undefined
    const f = 'screening_result'
    const stagesText = strFromSql(row.stages_run, `${f}.stages_run`)
    const stagesRun = stagesText.length === 0 ? [] : stagesText.split(',')
    const base: ScreeningResult = {
      token: strFromSql(row.token, `${f}.token`),
      verdict: enumFromSql(row.verdict, VERDICTS, `${f}.verdict`),
      flags: stringArrayFromSql(row.flags, `${f}.flags`),
      stagesRun: stagesRun.map((stage): Stage => enumFromSql(stage, STAGES, `${f}.stages_run`)),
      screenedAtUnix: countFromSql(row.screened_at_unix, `${f}.screened_at_unix`),
      paidMediaPermitted: boolFromSql(row.paid_media_permitted, `${f}.paid_media_permitted`),
    }
    return withOptional(base, 'note', optStrFromSql(row.note, `${f}.note`))
  }

  async put(result: ScreeningResult): Promise<void> {
    await guarded('screening_result', () =>
      this.driver.transaction(async (tx) => {
        const token = result.token.toLowerCase()
        await tx.execute('UPDATE screening_result SET is_current = FALSE WHERE token = $1 AND is_current', [token])
        await tx.execute(
          `INSERT INTO screening_result
               (id, token, verdict, paid_media_permitted, stages_run, flags, screened_at_unix, note, is_current)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, TRUE)`,
          [
            randomUUID(),
            token,
            result.verdict,
            result.paidMediaPermitted,
            result.stagesRun.join(','),
            JSON.stringify(result.flags),
            result.screenedAtUnix,
            result.note ?? null,
          ],
        )
      }),
    )
  }
}
