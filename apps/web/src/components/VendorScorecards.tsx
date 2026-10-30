import type { VendorScorecard } from '../api/model.js'
import { SPEND_LIMITS } from '../protocol.js'
import { Badge, Timestamp, Usd } from './primitives.js'

/**
 * Vendor scorecards.
 *
 * Cost per attributed new buyer is the only number here that is any use, and it
 * is measured by the indexer against on-chain first-buy events, not reported by
 * the vendor. Where attribution is not meaningful - moderation, creative - the
 * cell says so instead of showing a zero, because "$0.00 per buyer" reads as a
 * triumph and means nothing.
 *
 * The related-party flag is not a footnote. It appears on the row, in the
 * summary line, and on every receipt that vendor touches.
 */

export function VendorScorecards({ vendors }: { vendors: readonly VendorScorecard[] }) {
  const relatedSpend = vendors
    .filter((vendor) => vendor.isRelatedParty)
    .reduce((sum, vendor) => sum + vendor.spendCents, 0n)
  const totalSpend = vendors.reduce((sum, vendor) => sum + vendor.spendCents, 0n)
  const relatedShare = totalSpend > 0n ? Number((relatedSpend * 1_000n) / totalSpend) / 10 : 0

  return (
    <section className="stack">
      <div className="section-head">
        <div>
          <span className="eyebrow">Vendors</span>
          <h2>What each vendor cost, and what it actually produced</h2>
        </div>
        <p>
          New buyers are attributed on chain, not reported by the vendor. Withheld amounts are
          purchases whose delivery predicate failed; they are excluded from spend, so a vendor
          cannot improve its own cost-per-buyer by failing to deliver.
        </p>
      </div>

      {vendors.length === 0 ? (
        <div className="card-flat muted small">No vendor has been paid for this coin.</div>
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th className="num">Purchases</th>
                  <th className="num">Spend</th>
                  <th className="num">New buyers</th>
                  <th className="num">Cost / buyer</th>
                  <th className="num">Delivered</th>
                  <th className="num">Withheld</th>
                  <th>Last</th>
                </tr>
              </thead>
              <tbody>
                {vendors.map((vendor) => (
                  <tr key={vendor.vendorId}>
                    <td>
                      <div className="row">
                        <strong>{vendor.displayName}</strong>
                        {vendor.isRelatedParty && (
                          <Badge
                            tone="related"
                            title="Operator-affiliated. Capped as a share of this coin's 30-day budget and requires the dev's opt-in."
                          >
                            related party
                          </Badge>
                        )}
                        {!vendor.enabled && <Badge tone="warn">disabled</Badge>}
                      </div>
                      <div className="tiny faint">
                        reliability {(vendor.reliabilityScore * 100).toFixed(0)}%
                      </div>
                    </td>
                    <td className="num">{vendor.purchases}</td>
                    <td className="num">
                      <Usd cents={vendor.spendCents} />
                    </td>
                    <td className="num">
                      {vendor.attributedNewBuyers > 0 ? (
                        vendor.attributedNewBuyers
                      ) : (
                        <span className="faint">n/a</span>
                      )}
                    </td>
                    <td className="num">
                      {vendor.costPerAttributedBuyerCents === null ? (
                        <span
                          className="faint"
                          title="This deliverable has no buyer attribution. A zero here would be a false positive, not a bargain."
                        >
                          not attributable
                        </span>
                      ) : (
                        <strong>
                          <Usd cents={vendor.costPerAttributedBuyerCents} />
                        </strong>
                      )}
                    </td>
                    <td className="num">
                      <span className="predicate-pass">{vendor.predicatesPassed}</span>
                      {vendor.predicatesFailed > 0 && (
                        <>
                          {' / '}
                          <span className="predicate-fail">{vendor.predicatesFailed} failed</span>
                        </>
                      )}
                    </td>
                    <td className="num">
                      {vendor.withheldCents > 0n ? (
                        <span className="predicate-fail">
                          <Usd cents={vendor.withheldCents} />
                        </span>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td className="small muted">
                      {vendor.lastPurchaseAtUnix === null ? (
                        '—'
                      ) : (
                        <Timestamp unix={vendor.lastPurchaseAtUnix} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {relatedSpend > 0n && (
            <div className="callout callout-warn">
              <div className="callout-title">Operator-affiliated spend on this coin</div>
              <p className="small" style={{ margin: 0 }}>
                {relatedShare.toFixed(1)}% of this coin&rsquo;s procurement spend went to a vendor
                affiliated with the operator. Related-party vendors are capped at{' '}
                {(SPEND_LIMITS.relatedPartyCapOf30dBudget * 100).toFixed(0)}% of the coin&rsquo;s
                30-day budget and require the dev&rsquo;s explicit opt-in. They are listed here
                because a conflict disclosed is a conflict a client can price.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  )
}
