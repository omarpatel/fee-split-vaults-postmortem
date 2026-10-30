import type { FeeFlowPeriod } from '../api/model.js'
import { buildFeeFlowRows, creatorRateBps, type SplitConfig } from '../domain/fees.js'
import { formatBps, formatUsd } from '../domain/money.js'
import { Figure, TokenAmount, Usd } from './primitives.js'

/**
 * The fee flow.
 *
 * FOUR NUMBERS, NEVER THREE. QF received, dev leg, procurement budget, operator
 * fee (plus the referrer slice when there is one), each as its own figure. The
 * page never prints a combined "retained" total: adding the dev leg to the
 * budget would imply the budget is the dev's to keep, and folding the operator
 * fee into anything would hide the one number a client most needs to see.
 *
 * The legs are recomputed here from the gross using the same integer split the
 * contract settles with, and checked against the server's figures. A mismatch
 * is shown rather than smoothed over: it means the page and the chain disagree,
 * which is the single most important thing this artifact could tell anyone.
 */

export function FeeFlow({
  period,
  config,
  charging,
  buybackEnabled,
  creatorTaxBps,
  heading,
  note,
}: {
  period: FeeFlowPeriod
  config: SplitConfig
  charging: boolean
  buybackEnabled: boolean
  creatorTaxBps: number
  heading: string
  note: string
}) {
  const rows = buildFeeFlowRows(period.qfGrossCents, config, charging)
  const rate = creatorRateBps(buybackEnabled, creatorTaxBps)

  const serverFigures: Record<string, bigint> = {
    dev: period.devLegCents,
    budget: period.budgetCents,
    operator: period.operatorFeeCents,
    referrer: period.referrerCents,
  }
  const mismatches = rows
    .filter((row) => row.key !== 'qf' && serverFigures[row.key] !== row.amount)
    .map((row) => row.label)

  return (
    <section className="stack">
      <div className="section-head">
        <div>
          <span className="eyebrow">Fee flow</span>
          <h2>{heading}</h2>
        </div>
        <p>{note}</p>
      </div>

      <div className="figure-grid">
        {rows.map((row) => (
          <Figure
            key={row.key}
            label={row.label}
            value={<Usd cents={row.amount} />}
            isSource={row.isSource}
            sub={row.bps === undefined ? undefined : `${formatBps(row.bps)} of credited fees`}
            note={row.note}
          />
        ))}
      </div>

      {mismatches.length > 0 && (
        <div className="callout callout-bad">
          <div className="callout-title">These figures do not agree with the split</div>
          <p className="small">
            Recomputing {mismatches.join(', ')} from the gross using the vault&rsquo;s own split
            arithmetic gives a different answer than the API returned. Treat every number on this
            page as unverified until that is resolved.
          </p>
        </div>
      )}

      <div className="card-flat stack-tight">
        <div className="row-between">
          <div>
            <span className="eyebrow">Creator rate for this token</span>
            <div className="figure-value">{formatBps(rate)} of trade volume</div>
          </div>
          <div className="small muted" style={{ maxWidth: '46ch' }}>
            Buyback is <strong>{buybackEnabled ? 'on' : 'off'}</strong> for this token, so the
            creator&rsquo;s net is {formatBps(rate)} rather than{' '}
            {formatBps(creatorRateBps(!buybackEnabled, creatorTaxBps))}. This is a per-token
            setting; there is no single creator rate on this platform.
            {creatorTaxBps > 0 && (
              <>
                {' '}
                A creator tax of {formatBps(creatorTaxBps)} of the base pool fee is included in that
                figure and is paid 100% to the creator, never split.
              </>
            )}
          </div>
        </div>
      </div>

      <div className="table-scroll">
        <table>
          <caption className="tiny faint" style={{ captionSide: 'bottom', padding: '0.5rem' }}>
            Fees are credited in the pool&rsquo;s quote asset. USD is a conversion, and each row
            carries the price source it was converted at.
          </caption>
          <thead>
            <tr>
              <th>Quote asset</th>
              <th className="num">Credited</th>
              <th className="num">USD</th>
              <th>Priced by</th>
            </tr>
          </thead>
          <tbody>
            {period.perAsset.map((entry) => (
              <tr key={entry.asset.address}>
                <td>
                  <strong>{entry.asset.symbol}</strong>
                </td>
                <td className="num">
                  <TokenAmount
                    amount={entry.creditedMinor}
                    decimals={entry.asset.decimals}
                    symbol={entry.asset.symbol}
                  />
                </td>
                <td className="num">
                  <Usd cents={entry.usd.cents} provenance={entry.usd} />
                </td>
                <td className="tiny mono muted">
                  {entry.usd.priceSource}
                  <br />
                  {new Date(entry.usd.pricedAtUnix * 1_000).toISOString().slice(0, 16).replace('T', ' ')}
                </td>
              </tr>
            ))}
            <tr>
              <td>
                <strong>Total</strong>
              </td>
              <td className="num faint">—</td>
              <td className="num">
                <strong>{formatUsd(period.qfGrossCents)}</strong>
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  )
}
