/**
 * Human approvals over Postgres. One row per (vault, decision digest): the
 * approval binds to exactly one decision, and the broker verifies the binding.
 * This only has to find it, and to find nothing when the database is down is
 * the one thing it must not do - so a driver failure throws.
 */

import type { Address } from '@fee-split-vaults/core'
import type { HumanApprovalRecord } from '@fee-split-vaults/broker'
import type { ApprovalStore } from '@fee-split-vaults/orchestrator'
import { guarded, strFromSql } from './rows.js'
import { countFromSql, type SqlDriver } from './sql.js'

export class PgApprovalStore implements ApprovalStore {
  constructor(private readonly driver: SqlDriver) {}

  async find(vault: Address, decisionDigest: string): Promise<HumanApprovalRecord | undefined> {
    const rows = await guarded('human_approval', () =>
      this.driver.query(
        'SELECT approver, approved_at_unix, decision_digest FROM human_approval WHERE vault = $1 AND decision_digest = $2',
        [vault.toLowerCase(), decisionDigest],
      ),
    )
    const row = rows[0]
    if (row === undefined) return undefined
    return {
      approver: strFromSql(row.approver, 'human_approval.approver'),
      approvedAtUnix: countFromSql(row.approved_at_unix, 'human_approval.approved_at_unix'),
      decisionDigest: strFromSql(row.decision_digest, 'human_approval.decision_digest'),
    }
  }

  async put(vault: Address, record: HumanApprovalRecord): Promise<void> {
    await guarded('human_approval', () =>
      this.driver.execute(
        `INSERT INTO human_approval (vault, decision_digest, approver, approved_at_unix)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (vault, decision_digest) DO UPDATE SET
             approver = EXCLUDED.approver, approved_at_unix = EXCLUDED.approved_at_unix`,
        [vault.toLowerCase(), record.decisionDigest, record.approver, record.approvedAtUnix],
      ),
    )
  }
}
