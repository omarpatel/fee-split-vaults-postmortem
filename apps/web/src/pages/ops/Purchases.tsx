import { useState } from 'react'

import type { InvoiceInput, InvoiceView, OnboardingRecordView, PurchaseQueue } from '../../api/operator.js'
import { useAsync } from '../../app/context.js'
import { Link } from '../../app/router.js'
import { AddressChip, Badge, ErrorPanel, Skeleton, Timestamp, Usd } from '../../components/primitives.js'
import { RefusalPanel, useAction, useOperator } from './common.js'

/**
 * Purchases: what the runner approved and the operator still has to buy and
 * evidence, and the invoice that evidences it.
 *
 * The amount is typed as the vendor printed it - "1450.00" - and sent as that
 * string. It is never a number on the way to the server, for the same reason
 * the wire contract refuses JSON numbers for money: 12.30 and 12.299999 are
 * the same double, and an invoice is not allowed to be ambiguous about a cent.
 * The hash the server computes is echoed back; if the vendor's copy names a
 * different one, the server refuses with `invoice_hash_mismatch`.
 */

const USD_DECIMAL = /^(0|[1-9]\d{0,8})(?:\.(\d{1,2}))?$/
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})+$/
const INVOICE_HASH = /^0x[0-9a-fA-F]{64}$/

export function PurchasesPage({ vault }: { vault: string | null }) {
  const { operator, auth, nowUnix } = useOperator()
  const records = useAsync(() => (vault === null ? operator.listOnboardings(auth, 'active') : Promise.resolve([])), [auth.token, vault])
  const queue = useAsync(() => (vault === null ? Promise.resolve(null) : operator.listPurchases(auth, vault)), [auth.token, vault])

  if (vault === null) {
    if (records.error !== null) return <ErrorPanel error={records.error} onRetry={records.reload} />
    if (records.data === null) return <Skeleton height={200} />
    return <VaultPicker records={records.data} />
  }

  if (queue.error !== null) return <ErrorPanel error={queue.error} onRetry={queue.reload} />
  if (queue.data === null) return <Skeleton height={320} />

  return (
    <PurchasesView
      queue={queue.data}
      nowUnix={nowUnix}
      onInvoice={async (input) => {
        const result = await operator.recordInvoice(auth, input)
        queue.reload()
        return result
      }}
    />
  )
}

function VaultPicker({ records }: { records: OnboardingRecordView[] }) {
  if (records.length === 0) return <div className="card-flat small muted">No active vault. Purchases are proposed for charging vaults only.</div>
  return (
    <div className="stack">
      <p className="small muted">Pick a vault. The list is what the runner proposed and approved for it, less what is already evidenced.</p>
      <div className="card">
        {records.map((record) => (
          <div className="row-between" key={record.id} style={{ padding: 'var(--gap-2) 0', borderBottom: '1px solid var(--line)' }}>
            <span className="row">
              <strong>
                {record.subject.name} <span className="faint">({record.subject.symbol})</span>
              </strong>
              <AddressChip address={record.vault} />
            </span>
            <Link to={{ name: 'ops', page: 'purchases', id: record.vault }} className="btn btn-small">
              Open
            </Link>
          </div>
        ))}
      </div>
    </div>
  )
}

export function PurchasesView({
  queue,
  nowUnix,
  onInvoice,
}: {
  queue: PurchaseQueue
  nowUnix: number
  onInvoice: (input: InvoiceInput) => Promise<{ vault: string; invoice: InvoiceView }>
}) {
  const [draft, setDraft] = useState<{ vendorId: string; skuId: string; quantity: string; amountUsd: string; countersig: string; issuedAt: string; hash: string }>({
    vendorId: '',
    skuId: '',
    quantity: '1',
    amountUsd: '',
    countersig: '',
    issuedAt: String(nowUnix),
    hash: '',
  })
  const action = useAction<{ vault: string; invoice: InvoiceView }>()

  const quantity = Number.parseInt(draft.quantity, 10)
  const issuedAt = Number.parseInt(draft.issuedAt, 10)
  const valid =
    /^[A-Za-z0-9_.:-]{1,128}$/.test(draft.vendorId) &&
    /^[A-Za-z0-9_.:-]{1,128}$/.test(draft.skuId) &&
    /^\d{1,5}$/.test(draft.quantity) &&
    quantity >= 1 &&
    USD_DECIMAL.test(draft.amountUsd) &&
    HEX_BYTES.test(draft.countersig) &&
    /^\d{1,10}$/.test(draft.issuedAt) &&
    (draft.hash.length === 0 || INVOICE_HASH.test(draft.hash))

  const prefill = (item: PurchaseQueue['awaitingInvoice'][number]) => {
    const cents = item.quoteCents
    setDraft((prev) => ({
      ...prev,
      vendorId: item.vendorId,
      skuId: item.skuId,
      quantity: String(item.quantity),
      amountUsd: `${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, '0')}`,
    }))
  }

  return (
    <div className="stack-loose">
      <div className="row tiny muted">
        <span>
          vault <AddressChip address={queue.vault} />
        </span>
        <span>
          as of <Timestamp unix={queue.atUnix} relativeTo={nowUnix} />
        </span>
      </div>

      <section className="stack">
        <div className="section-head">
          <div>
            <span className="eyebrow">Awaiting invoice</span>
            <h2>Approved, not yet evidenced</h2>
          </div>
          <p>The runner cleared these through the spend gate. The operator buys as principal, at list, and records the vendor&rsquo;s countersigned invoice here.</p>
        </div>
        {queue.awaitingInvoice.length === 0 ? (
          <div className="card-flat small muted">Nothing is waiting on an invoice.</div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th>SKU</th>
                  <th>Qty</th>
                  <th>Quote</th>
                  <th>Proposed</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {queue.awaitingInvoice.map((item) => (
                  <tr key={`${item.skuId}:${item.proposedAtUnix}`}>
                    <td className="mono">{item.vendorId}</td>
                    <td className="mono">{item.skuId}</td>
                    <td className="num">{item.quantity}</td>
                    <td className="num">
                      <Usd cents={item.quoteCents} />
                    </td>
                    <td>
                      <Timestamp unix={item.proposedAtUnix} relativeTo={nowUnix} />
                    </td>
                    <td>
                      <button type="button" className="btn btn-small" onClick={() => prefill(item)}>
                        Invoice this
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="stack">
        <div className="section-head">
          <div>
            <span className="eyebrow">Record an invoice</span>
            <h2>As the vendor printed it</h2>
          </div>
        </div>
        <div className="card stack">
          <div className="grid-3">
            <Field id="inv-vendor" label="Vendor id" value={draft.vendorId} onChange={(vendorId) => setDraft((p) => ({ ...p, vendorId }))} />
            <Field id="inv-sku" label="SKU id" value={draft.skuId} onChange={(skuId) => setDraft((p) => ({ ...p, skuId }))} />
            <Field id="inv-qty" label="Quantity" value={draft.quantity} onChange={(quantity) => setDraft((p) => ({ ...p, quantity }))} invalid={!/^\d{1,5}$/.test(draft.quantity)} />
            <Field
              id="inv-amount"
              label="Amount USD (decimal string, e.g. 1450.00)"
              value={draft.amountUsd}
              onChange={(amountUsd) => setDraft((p) => ({ ...p, amountUsd }))}
              invalid={draft.amountUsd.length > 0 && !USD_DECIMAL.test(draft.amountUsd)}
            />
            <Field id="inv-issued" label="Issued at (unix seconds)" value={draft.issuedAt} onChange={(issuedAt) => setDraft((p) => ({ ...p, issuedAt }))} invalid={!/^\d{1,10}$/.test(draft.issuedAt)} />
            <Field
              id="inv-hash"
              label="Invoice hash on the vendor's copy (optional)"
              value={draft.hash}
              onChange={(hash) => setDraft((p) => ({ ...p, hash }))}
              invalid={draft.hash.length > 0 && !INVOICE_HASH.test(draft.hash)}
            />
          </div>
          <Field
            id="inv-countersig"
            label="Vendor countersignature (0x hex bytes)"
            value={draft.countersig}
            onChange={(countersig) => setDraft((p) => ({ ...p, countersig }))}
            invalid={draft.countersig.length > 0 && !HEX_BYTES.test(draft.countersig)}
          />
          {action.refusal !== null && <RefusalPanel refusal={action.refusal} title="Invoice refused" />}
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={action.busy || !valid}
              onClick={() =>
                void action.run(() =>
                  onInvoice({
                    vault: queue.vault,
                    vendorId: draft.vendorId,
                    skuId: draft.skuId,
                    quantity,
                    amountUsd: draft.amountUsd,
                    vendorCountersig: draft.countersig,
                    issuedAtUnix: issuedAt,
                    ...(draft.hash.length === 0 ? {} : { invoiceHash: draft.hash.toLowerCase() }),
                  }),
                )
              }
            >
              Record invoice
            </button>
            <span className="tiny muted">The amount is sent as the string above, never as a number.</span>
          </div>
          {action.result !== null && (
            <div className="callout callout-good">
              <div className="callout-title">Recorded</div>
              <p className="small" style={{ margin: 0 }}>
                hash <code className="mono">{action.result.invoice.invoiceHash}</code> · <Usd cents={action.result.invoice.amountCents} /> · {action.result.invoice.skuId} × {action.result.invoice.quantity}
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="stack">
        <div className="section-head">
          <div>
            <span className="eyebrow">Pending invoices</span>
            <h2>Evidenced, not yet settled</h2>
          </div>
        </div>
        {queue.pendingInvoices.length === 0 ? (
          <div className="card-flat small muted">No invoice is waiting on settlement.</div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Hash</th>
                  <th>Vendor</th>
                  <th>SKU</th>
                  <th>Qty</th>
                  <th>Amount</th>
                  <th>Issued</th>
                  <th>Baseline</th>
                </tr>
              </thead>
              <tbody>
                {queue.pendingInvoices.map((invoice) => (
                  <tr key={invoice.invoiceHash}>
                    <td>
                      <code className="tiny" title={invoice.invoiceHash}>
                        {invoice.invoiceHash.slice(0, 14)}…
                      </code>
                    </td>
                    <td className="mono">{invoice.vendorId}</td>
                    <td className="mono">{invoice.skuId}</td>
                    <td className="num">{invoice.quantity}</td>
                    <td className="num">
                      <Usd cents={invoice.amountCents} />
                    </td>
                    <td>
                      <Timestamp unix={invoice.issuedAtUnix} relativeTo={nowUnix} />
                    </td>
                    <td>
                      {invoice.baseline === null ? (
                        <span className="faint">—</span>
                      ) : (
                        <Badge>
                          {invoice.baseline.boosts !== null && `boosts ${invoice.baseline.boosts}`}
                          {invoice.baseline.boosts !== null && invoice.baseline.rank !== null && ' · '}
                          {invoice.baseline.rank !== null && `rank ${invoice.baseline.rank}`}
                        </Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function Field({ id, label, value, onChange, invalid = false }: { id: string; label: string; value: string; onChange: (value: string) => void; invalid?: boolean }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="text" value={value} onChange={(event) => onChange(event.currentTarget.value)} aria-invalid={invalid} />
    </div>
  )
}
