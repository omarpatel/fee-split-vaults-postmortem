/**
 * Receipts over Postgres, on 0004's `receipt`.
 *
 * THE EMBARGO IS APPLIED IN THE QUERY. `list()` with `publishedOnly` (the
 * default) filters on publish_after_unix <= now, so a caller that forgets the
 * option gets the embargoed view rather than the purchase calendar. put() is
 * idempotent on id, matching the in-memory store: a retried tick re-records
 * the same receipt and nothing changes.
 */

import type { Address, Receipt } from '@fee-split-vaults/core'
import type { ReceiptQuery, ReceiptStore } from '@fee-split-vaults/orchestrator'
import { enumFromSql, guarded, optStrFromSql, strFromSql, withOptional } from './rows.js'
import { countFromSql, type SqlDriver, type SqlValue } from './sql.js'

const KINDS = ['procurement', 'operations', 'refund', 'fee'] as const

const COLUMNS =
  'id, vault, disbursement_id, kind, amount_usd, description, publish_after_unix, occurred_at_unix, evidence_uri'

function rowToReceipt(row: Record<string, unknown>): Receipt {
  const f = 'receipt'
  const amount = row.amount_usd
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new TypeError(`${f}.amount_usd is not a finite number`)
  }
  const base: Receipt = {
    id: strFromSql(row.id, `${f}.id`),
    vault: strFromSql(row.vault, `${f}.vault`),
    kind: enumFromSql(row.kind, KINDS, `${f}.kind`),
    amountUsd: amount,
    description: strFromSql(row.description, `${f}.description`),
    publishAfterUnix: countFromSql(row.publish_after_unix, `${f}.publish_after_unix`),
    occurredAtUnix: countFromSql(row.occurred_at_unix, `${f}.occurred_at_unix`),
  }
  const withDisbursement = withOptional(base, 'disbursementId', optStrFromSql(row.disbursement_id, `${f}.disbursement_id`))
  return withOptional(withDisbursement, 'evidenceUri', optStrFromSql(row.evidence_uri, `${f}.evidence_uri`))
}

export class PgReceiptStore implements ReceiptStore {
  constructor(
    private readonly driver: SqlDriver,
    private readonly nowUnix: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async put(receipt: Receipt): Promise<void> {
    await guarded('receipt', () =>
      this.driver.execute(
        `INSERT INTO receipt (${COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [
          receipt.id,
          receipt.vault.toLowerCase(),
          receipt.disbursementId ?? null,
          receipt.kind,
          receipt.amountUsd,
          receipt.description,
          receipt.publishAfterUnix,
          receipt.occurredAtUnix,
          receipt.evidenceUri ?? null,
        ],
      ),
    )
  }

  async list(vault: Address, options: ReceiptQuery = {}): Promise<Receipt[]> {
    const where = ['vault = $1']
    const params: SqlValue[] = [vault.toLowerCase()]
    const bind = (clause: string, value: SqlValue): void => {
      params.push(value)
      where.push(clause.replace('?', `$${params.length}`))
    }
    if (options.fromUnix !== undefined) bind('occurred_at_unix >= ?', options.fromUnix)
    if (options.toUnix !== undefined) bind('occurred_at_unix <= ?', options.toUnix)
    if (options.publishedOnly ?? true) bind('publish_after_unix <= ?', options.nowUnix ?? this.nowUnix())
    const rows = await guarded('receipt', () =>
      this.driver.query(
        `SELECT ${COLUMNS} FROM receipt WHERE ${where.join(' AND ')} ORDER BY occurred_at_unix, id`,
        params,
      ),
    )
    return rows.map(rowToReceipt)
  }

  async get(id: string): Promise<Receipt | undefined> {
    const rows = await guarded('receipt', () => this.driver.query(`SELECT ${COLUMNS} FROM receipt WHERE id = $1`, [id]))
    const row = rows[0]
    return row === undefined ? undefined : rowToReceipt(row)
  }
}
