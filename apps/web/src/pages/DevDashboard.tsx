import { useState } from 'react'

import type { Escalation, UnsignedTx, WeeklyReportView } from '../api/model.js'
import { useApp, useAsync } from '../app/context.js'
import { Link, useRouter } from '../app/router.js'
import { BudgetDial } from '../components/BudgetDial.js'
import { ReceiptsLedger } from '../components/ReceiptsLedger.js'
import { TxPanel } from '../components/TxPanel.js'
import { WalletConnect } from '../components/WalletConnect.js'
import { AddressChip, Badge, Callout, ErrorPanel, Skeleton, Timestamp, TokenAmount, Usd } from '../components/primitives.js'
import { encodeSetDial, encodeTerminate } from '../crypto/calldata.js'
import { formatUsd } from '../domain/money.js'
import { TERMS } from '../protocol.js'

/**
 * The dev dashboard. Wallet-signature auth, no passwords.
 *
 * Four things, in this order: the dial with its break-even multiple, the weekly
 * reports, the escalation queue, and the exit. The exit is not buried at the
 * bottom of a settings page - a termination control that is hard to find is a
 * retention tactic, and the whole argument for this architecture is that the
 * client can leave.
 */

export function DevDashboard({ vault }: { vault: string | null }) {
  const { client, session, protocol } = useApp()
  const { navigate } = useRouter()

  const vaultsQuery = useAsync(
    async () => (session === null ? [] : await client.listDevVaults(session)),
    [session?.token],
  )

  if (session === null) {
    return (
      <div className="page stack-loose" style={{ paddingTop: 'var(--gap-5)' }}>
        <header className="stack">
          <span className="eyebrow">Dev dashboard</span>
          <h1>Your coin, your dial, your exit</h1>
          <p className="lede">
            Sign in with the wallet that controls your vault. There is no password to lose and no
            account for anyone to take over.
          </p>
        </header>
        <WalletConnect />
      </div>
    )
  }

  const vaults = vaultsQuery.data ?? []
  const active = vault ?? vaults[0]?.vault ?? null

  return (
    <div className="page stack-loose" style={{ paddingTop: 'var(--gap-5)' }}>
      <header className="stack">
        <div className="row-between">
          <div>
            <span className="eyebrow">Dev dashboard</span>
            <h1>Your coins</h1>
          </div>
          <WalletConnect compact />
        </div>

        {vaults.length > 1 && (
          <div className="row">
            {vaults.map((entry) => (
              <button
                key={entry.vault}
                type="button"
                className={`btn btn-small${entry.vault === active ? ' btn-primary' : ''}`}
                onClick={() => navigate({ name: 'dev', vault: entry.vault })}
              >
                {entry.symbol}
              </button>
            ))}
          </div>
        )}
      </header>

      {vaultsQuery.error !== null && <ErrorPanel error={vaultsQuery.error} onRetry={vaultsQuery.reload} />}

      {active === null ? (
        vaultsQuery.loading ? (
          <Skeleton height={140} />
        ) : (
          <Callout tone="info" title="No vault is bound to this address">
            <p>
              This address does not control a member vault. If you are onboarding a token, start at{' '}
              <Link to={{ name: 'onboarding' }}>the onboarding flow</Link>.
            </p>
            {protocol !== null && (
              <p className="tiny mono faint">factory {protocol.factory}</p>
            )}
          </Callout>
        )
      ) : (
        <VaultPanel vault={active} />
      )}
    </div>
  )
}

function VaultPanel({ vault }: { vault: string }) {
  const { client, session } = useApp()
  const nowUnix = Math.floor(Date.now() / 1_000)
  const [dialTx, setDialTx] = useState<{ tx: UnsignedTx; expected: string } | null>(null)
  const [terminateTx, setTerminateTx] = useState<UnsignedTx | null>(null)
  const [terminateArmed, setTerminateArmed] = useState(false)

  const detail = useAsync(
    async () => (session === null ? null : await client.getDevVault(session, vault)),
    [session?.token, vault],
  )
  const reports = useAsync(
    async () => (session === null ? [] : await client.listWeeklyReports(session, vault)),
    [session?.token, vault],
  )
  const escalations = useAsync(
    async () => (session === null ? [] : await client.listEscalations(session, vault)),
    [session?.token, vault],
  )

  if (detail.error !== null) return <ErrorPanel error={detail.error} onRetry={detail.reload} />
  if (detail.data === null) return <Skeleton height={300} />

  const { coin, devPayout, claimable, pendingDial, deadManUnix, lastHeartbeatUnix } = detail.data

  async function prepareDial(budgetBps: number) {
    if (session === null) return
    const tx = await client.buildDialTx(session, vault, budgetBps)
    setDialTx({ tx, expected: encodeSetDial(budgetBps) })
  }

  async function prepareTerminate() {
    if (session === null) return
    setTerminateTx(await client.buildTerminateTx(session, vault))
  }

  return (
    <div className="stack-loose">
      <section className="card stack-tight">
        <div className="row-between">
          <div>
            <h2>
              {coin.identity.name} <span className="faint">{coin.identity.symbol}</span>
            </h2>
            <div className="row small muted">
              <span>
                vault <AddressChip address={coin.identity.vault} />
              </span>
              <span>
                your payout <AddressChip address={devPayout} />
              </span>
              <Badge tone={coin.state === 'ACTIVE' ? 'good' : 'warn'}>{coin.state}</Badge>
            </div>
          </div>
          <Link to={{ name: 'coin', vault: coin.identity.vault }} className="btn btn-small">
            View public page
          </Link>
        </div>

        <div className="figure-grid" style={{ marginTop: 'var(--gap-2)' }}>
          {claimable.map((leg) => (
            <div className="figure" key={leg.asset.address}>
              <span className="figure-label">Withdrawable — {leg.asset.symbol}</span>
              <span className="figure-value">
                <TokenAmount amount={leg.devMinor} decimals={leg.asset.decimals} symbol={leg.asset.symbol} />
              </span>
              <span className="figure-sub">
                <Usd cents={leg.usd.cents} provenance={leg.usd} /> at {leg.usd.priceSource}
              </span>
              <span className="figure-note">
                Pull-only. You withdraw it from your own payout address; there is no operator key
                that can move it, and no operator action that can freeze it.
              </span>
            </div>
          ))}
        </div>
      </section>

      <BudgetDial
        currentBudgetBps={coin.budgetBps}
        budgetBpsMax={coin.budgetBpsMax}
        operatorBps={coin.operatorBps}
        qfPerDayUsd={coin.qfPerDayUsd}
        pending={pendingDial}
        disabled={session === null}
        onApply={(bps) => void prepareDial(bps)}
      />

      {dialTx !== null && (
        <TxPanel tx={dialTx.tx} expectedData={dialTx.expected} title="Dial change transaction" />
      )}

      <section className="stack">
        <div className="section-head">
          <div>
            <span className="eyebrow">Escalations</span>
            <h2>What the desk would not decide on its own</h2>
          </div>
          <p>
            Evidence is defanged before it reaches you: hosts are shown, links are not live. A queue
            that rendered working drainer URLs would be a phishing channel with an audit trail.
          </p>
        </div>
        {escalations.error !== null ? (
          <ErrorPanel error={escalations.error} onRetry={escalations.reload} />
        ) : escalations.data === null ? (
          <Skeleton height={120} />
        ) : escalations.data.length === 0 ? (
          <div className="card-flat muted small">Nothing is waiting on you.</div>
        ) : (
          <div className="stack-tight">
            {escalations.data.map((escalation) => (
              <EscalationCard
                key={escalation.id}
                escalation={escalation}
                nowUnix={nowUnix}
                onAck={async (note) => {
                  if (session === null) return
                  await client.ackEscalation(session, vault, escalation.id, {
                    decision: 'acknowledged',
                    note,
                  })
                  escalations.reload()
                }}
              />
            ))}
          </div>
        )}
      </section>

      <section className="stack">
        <div className="section-head">
          <div>
            <span className="eyebrow">Weekly reports</span>
            <h2>What happened, week by week</h2>
          </div>
        </div>
        {reports.error !== null ? (
          <ErrorPanel error={reports.error} onRetry={reports.reload} />
        ) : reports.data === null ? (
          <Skeleton height={160} />
        ) : (
          <div className="stack">
            {reports.data.map((report) => (
              <WeeklyReportCard key={report.periodStartUnix} report={report} nowUnix={nowUnix} />
            ))}
          </div>
        )}
      </section>

      <section className="card stack" id="terminate">
        <div className="section-head">
          <div>
            <span className="eyebrow">Exit</span>
            <h2>End the engagement</h2>
          </div>
        </div>

        <Callout tone="info" title="What terminate() does, in plain language">
          <ul style={{ paddingLeft: '1.1em', margin: 0 }}>
            <li>
              <strong>It always succeeds.</strong> It is a function on your own vault that only you
              can call. It does not need the operator&rsquo;s cooperation, its signature, or its
              servers to be running.
            </li>
            <li>
              <strong>Charging stops immediately.</strong> From that block on, 100% of the creator
              fees credited to this vault are yours. No operator fee, no procurement slice.
            </li>
            <li>
              <strong>Your unspent budget is released.</strong> It is frozen for refund back to your
              own leg rather than kept.
            </li>
            <li>
              <strong>Recipiency is handed back to your payout address.</strong> That hand-back is
              attempted inside a try/catch and its failure cannot block your exit — the vault stays
              able to claim and settle to you at 100% either way.
            </li>
            <li>
              <strong>It is not reversible</strong>, and re-joining later would mean a new vault at a
              new address on newly signed terms.
            </li>
          </ul>
        </Callout>

        <p className="small muted">
          You do not have to terminate to stop paid work: set the dial to 0% and the procurement
          slice goes to zero while the desk keeps running. Terminate is for ending the operator
          relationship entirely. The operator can also leave, on{' '}
          {TERMS.operatorWithdrawNoticeDays} days&rsquo; notice with a full budget refund, and after{' '}
          {TERMS.deadManDays} days of operator silence anyone at all can release your funds.
          {deadManUnix !== null && (
            <>
              {' '}
              The dead-man release for this vault is currently dated{' '}
              {new Date(deadManUnix * 1_000).toISOString().slice(0, 10)}
              {lastHeartbeatUnix !== null && (
                <>
                  , last operator heartbeat <Timestamp unix={lastHeartbeatUnix} relativeTo={nowUnix} />
                </>
              )}
              .
            </>
          )}
        </p>

        {terminateTx === null ? (
          <div className="row">
            <label className="row small" style={{ fontWeight: 400 }}>
              <input
                type="checkbox"
                checked={terminateArmed}
                onChange={(event) => setTerminateArmed(event.currentTarget.checked)}
                style={{ width: 'auto' }}
              />
              I understand this ends the engagement and cannot be undone.
            </label>
            <button
              type="button"
              className="btn btn-danger"
              disabled={!terminateArmed}
              onClick={() => void prepareTerminate()}
            >
              Prepare terminate()
            </button>
          </div>
        ) : (
          <TxPanel tx={terminateTx} expectedData={encodeTerminate()} title="terminate()" />
        )}
      </section>
    </div>
  )
}

function EscalationCard({
  escalation,
  nowUnix,
  onAck,
}: {
  escalation: Escalation
  nowUnix: number
  onAck: (note: string) => Promise<void>
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const overdue = escalation.acknowledgedAtUnix === null && nowUnix > escalation.slaDueAtUnix

  const tone =
    escalation.priority === 'critical' ? 'bad' : escalation.priority === 'high' ? 'warn' : 'neutral'

  return (
    <article className="card-flat stack-tight">
      <div className="row-between">
        <div className="row">
          <Badge tone={tone}>{escalation.priority}</Badge>
          <strong>{escalation.reason.replace(/_/g, ' ')}</strong>
          {overdue && <Badge tone="bad">past SLA</Badge>}
          {escalation.acknowledgedAtUnix !== null && <Badge tone="good">acknowledged</Badge>}
        </div>
        <span className="small muted">
          <Timestamp unix={escalation.openedAtUnix} relativeTo={nowUnix} />
        </span>
      </div>

      <p className="small" style={{ margin: 0 }}>
        {escalation.summary}
      </p>

      {escalation.evidence.length > 0 && (
        <ul className="tiny mono muted" style={{ margin: 0, paddingLeft: '1.1em' }}>
          {escalation.evidence.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}

      {escalation.acknowledgedAtUnix === null ? (
        <div className="row">
          <input
            type="text"
            placeholder="What you want done (optional)"
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
            style={{ maxWidth: '28rem' }}
          />
          <button
            type="button"
            className="btn btn-small"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void onAck(note).finally(() => setBusy(false))
            }}
          >
            Acknowledge
          </button>
        </div>
      ) : (
        escalation.resolution !== null && <p className="tiny muted" style={{ margin: 0 }}>{escalation.resolution}</p>
      )}
    </article>
  )
}

function WeeklyReportCard({ report, nowUnix }: { report: WeeklyReportView; nowUnix: number }) {
  const [open, setOpen] = useState(false)
  const period = `${new Date(report.periodStartUnix * 1_000).toISOString().slice(0, 10)} → ${new Date(
    report.periodEndUnix * 1_000,
  )
    .toISOString()
    .slice(0, 10)}`

  return (
    <div className="card stack-tight">
      <div className="row-between">
        <div>
          <span className="eyebrow">Week</span>
          <h3>{period}</h3>
        </div>
        <button type="button" className="btn btn-small" onClick={() => setOpen((value) => !value)}>
          {open ? 'Hide detail' : 'Show detail'}
        </button>
      </div>

      <div className="figure-grid">
        <div className="figure">
          <span className="figure-label">Creator fees received</span>
          <span className="figure-value is-source">{formatUsd(report.qfReceivedCents)}</span>
        </div>
        <div className="figure">
          <span className="figure-label">Your leg</span>
          <span className="figure-value">{formatUsd(report.devLegCents)}</span>
        </div>
        <div className="figure">
          <span className="figure-label">Budget spent</span>
          <span className="figure-value">{formatUsd(report.budgetSpentCents)}</span>
        </div>
        <div className="figure">
          <span className="figure-label">Operator fee</span>
          <span className="figure-value">{formatUsd(report.operatorFeeCents)}</span>
        </div>
      </div>

      <p className="small muted" style={{ margin: 0 }}>
        {report.verifiedReachSummary}
        {report.costPerAttributedBuyerCents !== null && (
          <>
            {' '}
            Cost per attributed new buyer: <strong>{formatUsd(report.costPerAttributedBuyerCents)}</strong>{' '}
            across {report.attributedNewBuyers} buyers.
          </>
        )}
      </p>

      {report.withheldPayments.length > 0 && (
        <Callout tone="warn" title="Payments withheld this week">
          <ul style={{ margin: 0, paddingLeft: '1.1em' }}>
            {report.withheldPayments.map((payment, index) => (
              <li key={index}>
                {formatUsd(payment.amountCents)} to {payment.vendorName} — {payment.reason}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      {open && (
        <div className="stack">
          {/* The 72h lag is a protection for the PUBLIC page, not a secret kept
              from the client. The dev is entitled to see their own committed
              purchases immediately, so lag enforcement is off here. */}
          <ReceiptsLedger
            receipts={report.lineItems}
            nowUnix={nowUnix}
            enforceLag={false}
            showWithheldNotice={false}
          />
          <div className="card-flat">
            <h4>What we did not do</h4>
            <ul className="checklist" style={{ marginTop: '0.5rem' }}>
              {report.whatWeDidNotDo.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}
