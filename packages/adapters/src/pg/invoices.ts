/**
 * Countersigned vendor invoices over Postgres.
 *
 * The operator buys as principal and is reimbursed against evidence; this is
 * the evidence. Three properties are enforced here and not left to callers:
 *
 *   - ONE ROW PER (vault, invoice hash). A second put() of the same hash is an
 *     `InvoiceConflictError`, never an upsert: two reimbursements against one
 *     invoice is exactly the failure the registry exists to prevent.
 *   - `find()` and `listPending()` answer from UNSETTLED rows only. An invoice
 *     already pulled against cannot be found and pulled against again.
 *   - `markSettled()` is idempotent for the same tx hash, refuses an unknown
 *     invoice, and refuses to overwrite a different settlement.
 *
 * The hash format (`0x` + 64 lowercase hex, the bytes32 the settlement pull
 * carries) is checked by the table's constraint; the whole invoice is kept as
 * JSONB so a field added to `VendorInvoice` later survives the round trip.
 */

import type { Address, TxHash } from '@fee-split-vaults/core'
import type { VendorInvoice } from '@fee-split-vaults/broker'
import type { InvoiceRegistry } from '@fee-split-vaults/orchestrator'
import { InvoiceConflictError, InvoiceUnknownError } from '../errors.js'
import { guarded, objectFromSql, strFromSql } from './rows.js'
import { countFromSql, type SqlDriver } from './sql.js'

const INVOICE_HASH = /^0x[0-9a-f]{64}$/

function invoiceFromSql(value: unknown): VendorInvoice {
  const o = objectFromSql(value, 'vendor_invoice.payload')
  const f = 'vendor_invoice.payload'
  const amount = o.amountUsd
  if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new TypeError(`${f}.amountUsd is not finite`)
  return {
    ...o,
    vendorId: strFromSql(o.vendorId, `${f}.vendorId`),
    skuId: strFromSql(o.skuId, `${f}.skuId`),
    quantity: countFromSql(o.quantity, `${f}.quantity`),
    amountUsd: amount,
    invoiceHash: strFromSql(o.invoiceHash, `${f}.invoiceHash`),
    vendorCountersig: strFromSql(o.vendorCountersig, `${f}.vendorCountersig`),
    issuedAtUnix: countFromSql(o.issuedAtUnix, `${f}.issuedAtUnix`),
  }
}

export class PgInvoiceRegistry implements InvoiceRegistry {
  constructor(
    private readonly driver: SqlDriver,
    private readonly nowUnix: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async put(vault: Address, invoice: VendorInvoice): Promise<void> {
    if (!INVOICE_HASH.test(invoice.invoiceHash)) {
      throw new TypeError(`invoice hash must be 0x + 64 lowercase hex, got ${JSON.stringify(invoice.invoiceHash)}`)
    }
    const key = vault.toLowerCase()
    const result = await guarded('vendor_invoice', () =>
      this.driver.execute(
        `INSERT INTO vendor_invoice (vault, invoice_hash, vendor_id, sku_id, quantity, issued_at_unix, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (vault, invoice_hash) DO NOTHING`,
        [key, invoice.invoiceHash, invoice.vendorId, invoice.skuId, invoice.quantity, invoice.issuedAtUnix, JSON.stringify(invoice)],
      ),
    )
    if (result.rowsAffected === 0) throw new InvoiceConflictError(key, invoice.invoiceHash)
  }

  async find(vault: Address, skuId: string, quantity: number, _nowUnix: number): Promise<VendorInvoice | undefined> {
    const rows = await guarded('vendor_invoice', () =>
      this.driver.query<{ payload: unknown }>(
        `SELECT payload FROM vendor_invoice
          WHERE vault = $1 AND sku_id = $2 AND quantity = $3 AND settled_tx_hash IS NULL
          ORDER BY issued_at_unix, invoice_hash LIMIT 1`,
        [vault.toLowerCase(), skuId, quantity],
      ),
    )
    const row = rows[0]
    return row === undefined ? undefined : invoiceFromSql(row.payload)
  }

  async listPending(vault: Address): Promise<readonly VendorInvoice[]> {
    const rows = await guarded('vendor_invoice', () =>
      this.driver.query<{ payload: unknown }>(
        `SELECT payload FROM vendor_invoice
          WHERE vault = $1 AND settled_tx_hash IS NULL
          ORDER BY issued_at_unix, invoice_hash`,
        [vault.toLowerCase()],
      ),
    )
    return rows.map((row) => invoiceFromSql(row.payload))
  }

  async markSettled(vault: Address, invoiceHash: string, txHash: TxHash): Promise<void> {
    const key = vault.toLowerCase()
    await guarded('vendor_invoice', () =>
      this.driver.transaction(async (tx) => {
        const rows = await tx.query<{ settled_tx_hash: unknown }>(
          'SELECT settled_tx_hash FROM vendor_invoice WHERE vault = $1 AND invoice_hash = $2',
          [key, invoiceHash],
        )
        const row = rows[0]
        if (row === undefined) throw new InvoiceUnknownError(key, invoiceHash)
        if (row.settled_tx_hash !== null && row.settled_tx_hash !== undefined) {
          if (row.settled_tx_hash === txHash) return
          throw new InvoiceConflictError(key, invoiceHash)
        }
        await tx.execute(
          `UPDATE vendor_invoice SET settled_tx_hash = $3, settled_at_unix = $4
            WHERE vault = $1 AND invoice_hash = $2 AND settled_tx_hash IS NULL`,
          [key, invoiceHash, txHash, this.nowUnix()],
        )
      }),
    )
  }
}
