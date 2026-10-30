import { useMemo, useState } from 'react'

import { breakEvenMultipleFor, devShareBps } from '../domain/fees.js'
import { formatBps, formatUsd, usdToCents } from '../domain/money.js'
import { TERMS } from '../protocol.js'
import { Callout } from './primitives.js'

/**
 * The procurement dial.
 *
 * THE BREAK-EVEN MULTIPLE IS THE HEADLINE. Whatever the dial and this vault's
 * own frozen operator fee leave the dev, the service has to make the coin earn
 * 10,000 / devBps times what it would have earned alone before the dev is even.
 * The figure is computed per vault by breakEvenMultipleFor() and deliberately
 * not quoted here: the rate is frozen per vault and the published default has
 * moved once already, so a number in this comment would be wrong for some
 * readers and stale for the rest. That hurdle rate is the single most
 * decision-relevant number on this page and it
 * belongs at the top of it, in the largest type, not in a footnote under a
 * slider. A dashboard that showed the dial without the hurdle would be selling.
 *
 * The dial is also asymmetric on purpose and the copy says so: raising takes
 * effect immediately, lowering gives the operator notice, so a dev cannot pull
 * the budget out from under a purchase that is already committed.
 */

export function BudgetDial({
  currentBudgetBps,
  budgetBpsMax,
  operatorBps,
  qfPerDayUsd,
  pending,
  onApply,
  disabled,
}: {
  currentBudgetBps: number
  budgetBpsMax: number
  operatorBps: number
  qfPerDayUsd: number
  pending: { pendingBudgetBps: number; effectiveAtUnix: number } | null
  onApply: (budgetBps: number) => void
  disabled: boolean
}) {
  const [draft, setDraft] = useState(currentBudgetBps)

  const projection = useMemo(() => {
    const cfg = { operatorBps, budgetBps: draft }
    const dev = devShareBps(cfg)
    const multiple = breakEvenMultipleFor(cfg)
    const monthlyBudgetUsd = qfPerDayUsd * (draft / 10_000) * 30
    const monthlyDevUsd = qfPerDayUsd * (dev / 10_000) * 30
    return { dev, multiple, monthlyBudgetUsd, monthlyDevUsd }
  }, [draft, operatorBps, qfPerDayUsd])

  const lowering = draft < currentBudgetBps
  const changed = draft !== currentBudgetBps

  return (
    <section className="card stack">
      <div className="section-head">
        <div>
          <span className="eyebrow">Your dial</span>
          <h2>Procurement budget</h2>
        </div>
        <p>
          The share of your credited creator fees that goes into an escrowed budget for third-party
          media. You set it; the operator cannot. The operator fee of {formatBps(operatorBps)} is
          separate, fixed, and part of this vault&rsquo;s address.
        </p>
      </div>

      <div className="hurdle">
        <span className="eyebrow" style={{ color: 'var(--accent-ink)' }}>
          Break-even multiple at {formatBps(draft)}
        </span>
        <div className="hurdle-value">{projection.multiple.toFixed(2)}×</div>
        <p className="small" style={{ margin: '0.4rem 0 0', color: 'var(--accent-ink)' }}>
          At this setting you keep {formatBps(projection.dev)} of your creator fees. For this to be
          worth doing, the service has to make your coin earn at least{' '}
          <strong>{projection.multiple.toFixed(2)}×</strong> the fees it would have earned without
          it. Anything less and you are behind, however good the receipts look.
        </p>
      </div>

      <div className="field">
        <label htmlFor="dial">
          Dial: {formatBps(draft)}
          <span className="field-hint">
            {' '}
            (0% to {formatBps(budgetBpsMax)} — this vault&rsquo;s frozen ceiling)
          </span>
        </label>
        <input
          id="dial"
          type="range"
          min={0}
          max={budgetBpsMax}
          step={100}
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(Number(event.currentTarget.value))}
        />
        <div className="row-between tiny faint">
          <span>0%</span>
          <span>{formatBps(Math.round(budgetBpsMax / 2))}</span>
          <span>{formatBps(budgetBpsMax)}</span>
        </div>
      </div>

      <div className="dial-readout">
        <div className="figure" style={{ padding: 0 }}>
          <span className="figure-label">Your leg, per month</span>
          <span className="figure-value">{formatUsd(usdToCents(projection.monthlyDevUsd))}</span>
          <span className="figure-note">
            At the current 7-day median fee flow. Withdrawable only by your own payout address.
          </span>
        </div>
        <div className="figure" style={{ padding: 0 }}>
          <span className="figure-label">Budget, per month</span>
          <span className="figure-value">{formatUsd(usdToCents(projection.monthlyBudgetUsd))}</span>
          <span className="figure-note">
            Escrowed to this coin only. Never lent to another coin and never spent on credit.
          </span>
        </div>
        <div className="figure" style={{ padding: 0 }}>
          <span className="figure-label">Operator fee, per month</span>
          <span className="figure-value">
            {formatUsd(usdToCents(qfPerDayUsd * (operatorBps / 10_000) * 30))}
          </span>
          <span className="figure-note">Fixed for the life of this vault. Cannot be raised.</span>
        </div>
      </div>

      {pending !== null && (
        <Callout tone="warn" title="A dial change is already pending">
          You asked for {formatBps(pending.pendingBudgetBps)}. Because that is a reduction, it takes
          effect on {new Date(pending.effectiveAtUnix * 1_000).toISOString().slice(0, 10)} — {TERMS.dialLowerNoticeDays}{' '}
          days&rsquo; notice. Until then the current setting stands, so nothing already committed
          loses its funding halfway through.
        </Callout>
      )}

      {changed && (
        <Callout tone={lowering ? 'warn' : 'info'} title={lowering ? 'Lowering takes notice' : 'Raising is immediate'}>
          {lowering ? (
            <>
              Going from {formatBps(currentBudgetBps)} down to {formatBps(draft)} takes effect after{' '}
              {TERMS.dialLowerNoticeDays} days. That delay protects work already committed against
              your own banked budget; it does not let the operator spend anything new.
            </>
          ) : (
            <>
              Going from {formatBps(currentBudgetBps)} up to {formatBps(draft)} takes effect as soon
              as the transaction confirms.
            </>
          )}
        </Callout>
      )}

      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={disabled || !changed}
          onClick={() => onApply(draft)}
        >
          Prepare setDial({draft})
        </button>
        {changed && (
          <button type="button" className="btn btn-ghost" onClick={() => setDraft(currentBudgetBps)}>
            Reset
          </button>
        )}
      </div>
    </section>
  )
}
