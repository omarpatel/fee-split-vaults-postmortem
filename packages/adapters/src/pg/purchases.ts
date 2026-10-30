/**
 * Approved-but-uninvoiced purchases over Postgres.
 *
 * One row per (vault, sku, quantity). The tick loop re-decides the same line
 * every window, so `record()` is an upsert that keeps the EARLIEST proposal
 * time: a re-report is the same to-do, not a newer one. `clear()` is a plain
 * delete and is idempotent. Reads go through `guarded`, so a driver failure is
 * `SourceUnavailableError` and never an empty list.
 */

import type { Address } from '@fee-split-vaults/core'
import type { PendingPurchase, PendingPurchaseStore } from '@fee-split-vaults/orchestrator'
import { guarded, strFromSql } from './rows.js'
import { bigIntFromSql, countFromSql, type SqlDriver } from './sql.js'

export class PgPendingPurchaseStore implements PendingPurchaseStore {
  constructor(private readonly driver: SqlDriver) {}

  async awaitingInvoice(vault: Address): Promise<readonly PendingPurchase[]> {
    const rows = await guarded('pending_purchase', () =>
      this.driver.query(
        `SELECT vault, vendor_id, sku_id, quantity, quote_cents, proposed_at_unix
         FROM pending_purchase WHERE vault = $1
         ORDER BY proposed_at_unix ASC, sku_id ASC, quantity ASC`,
        [vault.toLowerCase()],
      ),
    )
    return rows.map((row) => ({
      vault: strFromSql(row.vault, 'pending_purchase.vault'),
      vendorId: strFromSql(row.vendor_id, 'pending_purchase.vendor_id'),
      skuId: strFromSql(row.sku_id, 'pending_purchase.sku_id'),
      quantity: countFromSql(row.quantity, 'pending_purchase.quantity'),
      quoteCents: bigIntFromSql(row.quote_cents, 'pending_purchase.quote_cents'),
      proposedAtUnix: countFromSql(row.proposed_at_unix, 'pending_purchase.proposed_at_unix'),
    }))
  }

  async record(purchase: PendingPurchase): Promise<void> {
    await guarded('pending_purchase', () =>
      this.driver.execute(
        `INSERT INTO pending_purchase (vault, sku_id, quantity, vendor_id, quote_cents, proposed_at_unix)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (vault, sku_id, quantity) DO UPDATE SET
             vendor_id = EXCLUDED.vendor_id,
             quote_cents = EXCLUDED.quote_cents,
             proposed_at_unix = LEAST(pending_purchase.proposed_at_unix, EXCLUDED.proposed_at_unix)`,
        [
          purchase.vault.toLowerCase(),
          purchase.skuId,
          purchase.quantity,
          purchase.vendorId,
          purchase.quoteCents.toString(),
          purchase.proposedAtUnix,
        ],
      ),
    )
  }

  async clear(vault: Address, skuId: string, quantity: number): Promise<void> {
    await guarded('pending_purchase', () =>
      this.driver.execute('DELETE FROM pending_purchase WHERE vault = $1 AND sku_id = $2 AND quantity = $3', [
        vault.toLowerCase(),
        skuId,
        quantity,
      ]),
    )
  }
}
