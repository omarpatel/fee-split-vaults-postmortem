import { useApp, useAsync } from '../app/context.js'
import { Link } from '../app/router.js'
import { Badge, ErrorPanel, Skeleton } from '../components/primitives.js'
import { creatorRateBps } from '../domain/fees.js'
import { formatBps, formatUsd, usdToCents } from '../domain/money.js'
import { TIERS } from '../protocol.js'

/**
 * The member directory.
 *
 * Every member coin, its tier, and its own creator rate - which differs between
 * coins because the rate branches on each token's buyback setting. Showing the
 * rate per row rather than once at the top is the point: there is no single
 * creator rate on this platform and a directory that implied one would be the
 * first place that error got made.
 */

export function Directory() {
  const { client, env } = useApp()
  const coins = useAsync(() => client.listCoins(), [])

  return (
    <div className="page stack-loose" style={{ paddingTop: 'var(--gap-5)' }}>
      <header className="stack">
        <span className="eyebrow">Creator-fee vaults</span>
        <h1 style={{ maxWidth: '20ch' }}>Receipts, per coin, whether or not the week went well</h1>
        <p className="lede">
          Each member coin has a page showing every dollar of creator fees it received, how that
          split, what was bought with it, and whether the thing that was bought was delivered. The
          operator holds no member tokens and is paid a percentage of member trading fees, so it
          profits when member trading volume rises. That is stated on every page.
        </p>
        {env.isDemo && (
          <div className="callout callout-warn">
            <div className="callout-title">Demo data</div>
            <p className="small" style={{ margin: 0 }}>
              No <code>VITE_API_BASE_URL</code> is set, so this is the in-memory fixture backend.
              The figures are internally consistent and computed with the production arithmetic, but
              they describe coins that do not exist.
            </p>
          </div>
        )}
      </header>

      {coins.error !== null ? (
        <ErrorPanel error={coins.error} onRetry={coins.reload} />
      ) : coins.data === null ? (
        <div className="stack">
          <Skeleton height={64} />
          <Skeleton height={64} />
          <Skeleton height={64} />
        </div>
      ) : (
        <div className="stack">
          {coins.data.map((coin) => {
            const tier = TIERS[coin.tier]
            const rate = creatorRateBps(coin.buybackEnabled, 0)
            return (
              <Link
                key={coin.vault}
                to={{ name: 'coin', vault: coin.vault }}
                className="card row-between"
                style={{ textDecoration: 'none', color: 'inherit' }}
              >
                <div>
                  <div className="row">
                    <strong style={{ fontSize: 'var(--step-1)' }}>{coin.name}</strong>
                    <span className="faint">{coin.symbol}</span>
                    <Badge tone={coin.state === 'ACTIVE' ? 'good' : 'warn'}>{coin.state}</Badge>
                  </div>
                  <div className="small muted">
                    {tier.name} · {tier.usesModel ? 'model-operated desk' : 'deterministic desk'}
                    {tier.paidMedia ? ' · paid media eligible' : ' · no paid media'}
                  </div>
                </div>
                <div className="row" style={{ gap: 'var(--gap-4)' }}>
                  <div style={{ textAlign: 'right' }}>
                    <div className="figure-label">Creator fees / day</div>
                    <div className="num" style={{ fontWeight: 660 }}>
                      {formatUsd(usdToCents(coin.qfPerDayUsd))}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="figure-label">Creator rate</div>
                    <div className="num" style={{ fontWeight: 660 }}>
                      {formatBps(rate)}
                    </div>
                    <div className="tiny faint">buyback {coin.buybackEnabled ? 'on' : 'off'}</div>
                  </div>
                </div>
              </Link>
            )
          })}
        </div>
      )}

      <section className="grid-2">
        <div className="card stack-tight">
          <h3>Are you a dev?</h3>
          <p className="small muted">
            Connect the wallet that controls your token&rsquo;s creator-fee recipiency. You will see
            the predicted vault address, with every economic term inside it, before you sign
            anything.
          </p>
          <div>
            <Link to={{ name: 'onboarding' }} className="btn btn-primary">
              Start onboarding
            </Link>
          </div>
        </div>
        <div className="card stack-tight">
          <h3>Already a member?</h3>
          <p className="small muted">
            Sign in with your wallet — no password, no account. The dashboard shows your dial, its
            break-even multiple, your weekly reports, and the desk&rsquo;s escalation queue.
          </p>
          <div>
            <Link to={{ name: 'dev', vault: null }} className="btn">
              Open the dev dashboard
            </Link>
          </div>
        </div>
      </section>
    </div>
  )
}
