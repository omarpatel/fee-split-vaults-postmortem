import { monthlyProcurementUsd, tierDescription, tierStatus, type TierInput } from '../domain/tier.js'
import { formatUsd, usdToCents } from '../domain/money.js'
import { QUALIFICATION_FLOOR_MONTHLY_USD } from '../protocol.js'
import { Badge } from './primitives.js'

/**
 * Tier and qualification.
 *
 * The gate is stated in QF, never in volume, because the volume that produces a
 * given QF depends on the token's own buyback setting. The volume figure shown
 * is computed per coin from that setting and is labelled as such.
 *
 * The qualification floor is surfaced rather than buried: below
 * QUALIFICATION_FLOOR_MONTHLY_USD of PROCUREMENT BUDGET — the dial's slice,
 * not the coin's whole fee flow — a paid tier cannot fund even its cheapest
 * deliverable, and telling a small coin that up front is more useful than
 * selling it a service its own fee flow cannot pay for. The figure is rendered
 * from the constant and the slice is computed from the coin's own dial, so
 * neither is written down here.
 */

export function TierPanel({ input }: { input: TierInput }) {
  const status = tierStatus(input)
  // The dial is this coin's own, never a literal: monthlyProcurementUsd() reads
  // input.budgetBps and falls back to TERMS.budgetBpsDefault. This figure drives
  // the below-floor warning below, so a dial written down here would tell a dev
  // the wrong thing about their own coin the moment they moved it.
  const monthlyBudgetUsd = monthlyProcurementUsd(input)
  const belowFloor = monthlyBudgetUsd < QUALIFICATION_FLOOR_MONTHLY_USD

  return (
    <section className="card stack">
      <div className="row-between">
        <div>
          <span className="eyebrow">Service tier</span>
          <h2>
            {status.tier.name}{' '}
            <Badge tone={status.tier.usesModel ? 'accent' : 'neutral'}>{status.tier.id}</Badge>
          </h2>
        </div>
        <div className="row">
          {status.tier.paidMedia && input.paidMediaPermitted && <Badge tone="good">paid media allowed</Badge>}
          {!input.paidMediaPermitted && <Badge tone="warn">paid media blocked</Badge>}
          {!status.hasEnoughHistory && <Badge tone="warn">insufficient history</Badge>}
        </div>
      </div>

      <p className="small muted">{tierDescription(status.tier)}</p>

      <div className="figure-grid">
        <div className="figure">
          <span className="figure-label">Creator fees, 7-day median</span>
          <span className="figure-value">{formatUsd(status.qfPerDayCents)}<span className="figure-sub"> / day</span></span>
          <span className="figure-note">
            A median, not a mean. A mean is farmable with a single day of wash volume.
          </span>
        </div>
        <div className="figure">
          <span className="figure-label">Days observed</span>
          <span className="figure-value">{status.observedDays}</span>
          <span className="figure-note">
            {status.hasEnoughHistory
              ? 'Enough history for a 7-day median.'
              : 'Fewer than 7 days. No tier can be granted on a shorter window.'}
          </span>
        </div>
        <div className="figure">
          <span className="figure-label">Held at gate</span>
          <span className="figure-value">{status.sustainedDays} d</span>
          <span className="figure-note">
            {status.next === null
              ? 'Top tier.'
              : `${status.next.name} requires ${status.next.sustainedDays} consecutive days.`}
          </span>
        </div>
      </div>

      {status.next !== null && (
        <div className="stack-tight">
          <div className="row-between">
            <strong className="small">Toward {status.next.name}</strong>
            <span className="small muted">
              gate: {formatUsd(usdToCents(status.next.gateQfPerDay))}/day of creator fees
            </span>
          </div>
          <div className="progress">
            <div style={{ width: `${Math.round(status.gateProgress * 100)}%` }} />
          </div>
          {status.volumePerDayForNextGateUsd !== null && (
            <p className="tiny faint" style={{ margin: 0 }}>
              For <em>this</em> token, with buyback {input.buybackEnabled ? 'on' : 'off'}, that gate
              needs roughly {formatUsd(usdToCents(status.volumePerDayForNextGateUsd))} of Venue-pool
              volume per day. That number is not the same for every coin, so it is never published
              as a universal threshold.
            </p>
          )}
        </div>
      )}

      {status.blockers.length > 0 && (
        <div className="callout callout-warn">
          <div className="callout-title">Not yet qualified for the next tier</div>
          <ul className="small" style={{ margin: 0, paddingLeft: '1.1em' }}>
            {status.blockers.map((blocker, index) => (
              <li key={index}>{blocker}</li>
            ))}
          </ul>
        </div>
      )}

      {belowFloor && (
        <div className="callout callout-info">
          <div className="callout-title">Below the qualification floor</div>
          <p className="small" style={{ margin: 0 }}>
            At the current fee flow the procurement slice is about{' '}
            {formatUsd(usdToCents(monthlyBudgetUsd))} a month, and the cheapest useful deliverable —
            a Dexscreener Enhanced Token Info listing — is $299 one-time. Below roughly{' '}
            {formatUsd(usdToCents(QUALIFICATION_FLOOR_MONTHLY_USD))} a month a paid tier cannot fund
            its own smallest purchase, so it is not offered. The deterministic desk runs regardless
            and costs the coin nothing extra.
          </p>
        </div>
      )}
    </section>
  )
}
