import type { ReceiptItem } from '../api/model.js'
import {
  formatRevealDelay,
  lagVisibility,
  partitionByLag,
  PUBLISH_LAG_SECONDS,
} from '../domain/lag.js'
import { formatOffset } from '../domain/time.js'
import { Badge, Timestamp, Usd } from './primitives.js'

/**
 * The receipts ledger.
 *
 * The lag filter runs HERE, in the presentation layer, on top of whatever the
 * API returned. See domain/lag.ts for why: the client re-derives the 72-hour
 * floor from the commitment's own timestamp and takes the later of that and the
 * server's `publishAfterUnix`, so a bad or hostile server can delay a receipt
 * but can never publish an unexecuted commitment early.
 *
 * Withheld items are COUNTED, not hidden. "Two commitments publish in the next
 * three days" carries no timing edge and is the honest thing to say; silence
 * would look like an omission and invite the assumption that there is more.
 */

const LAG_HOURS = PUBLISH_LAG_SECONDS / 3_600

export function ReceiptsLedger({
  receipts,
  nowUnix,
  showWithheldNotice = true,
  enforceLag = true,
}: {
  receipts: readonly ReceiptItem[]
  nowUnix: number
  showWithheldNotice?: boolean
  /**
   * The lag protects the PUBLIC page. The dev's own dashboard sets this false:
   * withholding a client's own committed purchases from them would be secrecy,
   * not front-running protection. Default true so a new public surface cannot
   * forget to opt in.
   */
  enforceLag?: boolean
}) {
  const partition = partitionByLag(receipts, nowUnix)
  const published = enforceLag ? partition.published : [...receipts]
  const withheldCount = enforceLag ? partition.withheldCount : 0
  const nextRevealUnix = enforceLag ? partition.nextRevealUnix : null

  return (
    <section className="stack">
      <div className="section-head">
        <div>
          <span className="eyebrow">Receipts</span>
          <h2>Every disbursement, with what it bought and whether it arrived</h2>
        </div>
        <p>
          Cost is the vendor&rsquo;s list price. The operator buys as principal and is reimbursed at
          cost with zero markup, so what is shown here is what was paid, not what was billed.
        </p>
      </div>

      {showWithheldNotice && enforceLag && (
        <div className="withheld" data-embargo>
          <strong>
            {withheldCount === 0
              ? 'Nothing withheld right now'
              : `${withheldCount} commitment${withheldCount === 1 ? '' : 's'} withheld`}
          </strong>{' '}
          — unexecuted commitments publish on a {LAG_HOURS}-hour lag so this ledger is not a
          purchase calendar anyone can trade ahead of.
          {nextRevealUnix !== null && (
            <> The next one publishes {formatRevealDelay(nextRevealUnix - nowUnix)}.</>
          )}
        </div>
      )}

      {published.length === 0 ? (
        <div className="card-flat muted small">
          Nothing has been purchased for this coin yet. The procurement budget accrues in escrow
          until there is something worth buying that clears the spend gate.
        </div>
      ) : (
        <div className="card">
          {published.map((receipt) => (
            <ReceiptRow key={receipt.id} receipt={receipt} nowUnix={nowUnix} />
          ))}
        </div>
      )}
    </section>
  )
}

function ReceiptRow({ receipt, nowUnix }: { receipt: ReceiptItem; nowUnix: number }) {
  const verdict = lagVisibility(receipt, nowUnix)
  const withheld = receipt.withheldReason !== undefined
  const anyFailed = receipt.predicateResults.some((check) => !check.passed)

  return (
    <article className="receipt stack-tight">
      <div className="row-between">
        <div className="row">
          <strong>{receipt.skuDescription ?? receipt.description}</strong>
          {receipt.vendorName !== undefined && (
            <span className="small muted">via {receipt.vendorName}</span>
          )}
          {receipt.vendorIsRelatedParty === true && (
            <Badge tone="related" title="This vendor is affiliated with the operator.">
              related party
            </Badge>
          )}
          {withheld && <Badge tone="bad">payment withheld</Badge>}
          {!receipt.executed && verdict.visible && <Badge tone="warn">committed, not yet executed</Badge>}
        </div>
        <div className="num">
          <Usd cents={receipt.amountCents} />
        </div>
      </div>

      <div className="row small muted">
        <span>
          <Timestamp unix={receipt.occurredAtUnix} relativeTo={nowUnix} />
        </span>
        {receipt.predicateKind !== undefined && (
          <span>
            predicate: <code className="tiny">{receipt.predicateKind}</code>
          </span>
        )}
        {receipt.invoiceHash !== undefined && (
          <span className="tiny mono faint" title={receipt.invoiceHash}>
            invoice {receipt.invoiceHash.slice(0, 10)}…
          </span>
        )}
        {receipt.permalink !== undefined && (
          <a href={receipt.permalink} target="_blank" rel="noreferrer noopener" className="small">
            permalink
          </a>
        )}
      </div>

      {receipt.predicateResults.length > 0 ? (
        <div className="row">
          {receipt.predicateResults.map((check, index) => (
            <span
              key={`${receipt.id}-${index}`}
              className={`predicate ${check.passed ? 'predicate-pass' : 'predicate-fail'}`}
              title={check.note ?? check.evidenceHash ?? ''}
            >
              {check.passed ? '✓' : '✕'} T+{formatOffset(check.offsetSeconds)}
              {check.evidenceUri !== undefined && (
                <>
                  {' '}
                  <a href={check.evidenceUri} target="_blank" rel="noreferrer noopener">
                    evidence
                  </a>
                </>
              )}
            </span>
          ))}
        </div>
      ) : (
        <div className="predicate predicate-pending">
          delivery not yet checked — first check runs at T+24h
        </div>
      )}

      {withheld && (
        <div className="callout callout-bad" style={{ marginTop: '0.5rem' }}>
          <div className="callout-title">Not paid</div>
          <p className="small" style={{ margin: 0 }}>
            {receipt.withheldReason}
          </p>
        </div>
      )}

      {!withheld && anyFailed && (
        <p className="small" style={{ color: 'var(--warn)' }}>
          A delivery check failed. The vendor payment for this line is under review.
        </p>
      )}
    </article>
  )
}
