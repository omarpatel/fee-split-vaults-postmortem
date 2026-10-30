import { ApiError } from '../api/client.js'
import { useApp, useAsync } from '../app/context.js'
import { Link } from '../app/router.js'
import { AgentTeamCard } from '../components/AgentTeam.js'
import { BandExplainer, BandedBalanceCard } from '../components/BalanceBands.js'
import { DisclosurePanel, WhatWeDidNotDo } from '../components/DisclosurePanel.js'
import { FeeFlow } from '../components/FeeFlow.js'
import { ReceiptsLedger } from '../components/ReceiptsLedger.js'
import { TierPanel } from '../components/TierPanel.js'
import { VendorScorecards } from '../components/VendorScorecards.js'
import { AddressChip, Badge, ErrorPanel, Skeleton, Timestamp } from '../components/primitives.js'
import { formatBps } from '../domain/money.js'

/**
 * The public coin page. No auth, no personalisation, no cookie.
 *
 * This is the artifact the whole business is judged on, so its ordering is
 * deliberate: identity and status, then the four fee numbers, then the receipts
 * with the lag applied, then vendors, then what we did not do, then the
 * disclosure. The disclosure is last on the page but is not "buried": the tags
 * are in the header, and the compensation sentence is repeated in the summary
 * strip at the top, because 17(b) is about the disclosure being IN the
 * communication, not about it existing somewhere.
 */

export function CoinPage({ vault }: { vault: string }) {
  const { client, protocol, env } = useApp()
  const nowUnix = Math.floor(Date.now() / 1_000)

  const coinQuery = useAsync(() => client.getCoin(vault), [vault])
  const receiptsQuery = useAsync(() => client.listReceipts(vault), [vault])
  const vendorsQuery = useAsync(() => client.listVendorScorecards(vault), [vault])

  if (coinQuery.error !== null) {
    // A vault the API has no record of is an answer, not an outage: say so in
    // those words rather than offering a retry that cannot succeed.
    if (coinQuery.cause instanceof ApiError && coinQuery.cause.status === 404) {
      return <NoSuchVault vault={vault} code={coinQuery.cause.code} />
    }
    return (
      <div className="page stack" style={{ paddingTop: 'var(--gap-4)' }}>
        <ErrorPanel error={coinQuery.error} onRetry={coinQuery.reload} />
      </div>
    )
  }

  const coin = coinQuery.data
  if (coin === null) {
    return (
      <div className="page stack" style={{ paddingTop: 'var(--gap-4)' }}>
        <Skeleton height={40} width="40%" />
        <Skeleton height={140} />
        <Skeleton height={220} />
      </div>
    )
  }

  const config = {
    operatorBps: coin.operatorBps,
    budgetBps: coin.budgetBps,
    referrerBps: coin.referrerBps,
  }
  const charging = coin.state === 'ACTIVE'

  return (
    <div className="page stack-loose" style={{ paddingTop: 'var(--gap-4)' }}>
      <header className="stack">
        <div className="row-between">
          <div>
            <span className="eyebrow">Member coin · receipts</span>
            <h1>
              {coin.identity.name} <span className="faint">({coin.identity.symbol})</span>
            </h1>
            {(coin.subject.name !== coin.identity.name ||
              coin.subject.symbol !== coin.identity.symbol) && (
              <p className="small muted" style={{ margin: 0 }}>
                onboarded as {coin.subject.name} ({coin.subject.symbol})
              </p>
            )}
          </div>
          <div className="row">
            <Badge tone={charging ? 'good' : 'warn'}>{coin.state}</Badge>
            <Badge tone="accent">{coin.tier}</Badge>
            <Badge tone={coin.identity.graduated ? 'neutral' : 'warn'}>
              {coin.identity.graduated ? 'graduated' : 'pre-graduation'}
            </Badge>
            {coin.screening.verdict !== 'CLEAR' && (
              <Badge tone="warn" title={coin.screening.flags.join(', ')}>
                screening: {coin.screening.verdict}
              </Badge>
            )}
          </div>
        </div>

        <p className="lede">
          Everything the operator did for this coin, what it cost, and whether it worked. This page
          is AI-operated and this operator is paid a percentage of this coin&rsquo;s trading fees —
          the full disclosure is <a href="#disclosure">at the bottom of this page</a> and is part of
          this page rather than a link to a policy elsewhere.
        </p>

        <div className="row small muted">
          <span>
            token <AddressChip address={coin.identity.token} />
          </span>
          <span>
            vault <AddressChip address={coin.identity.vault} />
          </span>
          <span>
            reconciled <Timestamp unix={coin.lastReconciledAtUnix} relativeTo={nowUnix} />
          </span>
          {coin.reconciliationVariance !== 'none' && (
            <Badge tone={coin.reconciliationVariance === 'critical' ? 'bad' : 'warn'}>
              ledger variance: {coin.reconciliationVariance}
            </Badge>
          )}
          {env.isDemo && <Badge tone="warn">demo data</Badge>}
        </div>
      </header>

      {!charging && (
        <div className="callout callout-info">
          <div className="callout-title">This vault is not charging</div>
          <p className="small" style={{ margin: 0 }}>
            State is <code>{coin.state}</code>. While a vault is in this state every credited fee
            passes through to the dev in full: no operator fee, no procurement slice. The figures
            below reflect that.
          </p>
        </div>
      )}

      <TierPanel
        input={{
          tierId: coin.tier,
          qfPerDayUsd: coin.qfPerDayUsd,
          observedDays: coin.observedDays,
          sustainedDays: coin.sustainedDays,
          buybackEnabled: coin.identity.buybackEnabled,
          creatorTaxBps: coin.identity.creatorTaxBps,
          paidMediaPermitted: coin.screening.paidMediaPermitted,
          budgetBps: coin.budgetBps,
        }}
      />

      <div className="card-flat row-between">
        <div>
          <strong>Narrative: {coin.narrativeApproved ? 'approved' : 'pending review'}</strong>
          <div className="small muted">
            {coin.narrativeApproved
              ? 'What the operator says about this coin was derived from the dev’s own sources and approved by a human before anything was posted.'
              : 'Nothing is posted about this coin until a human has reviewed the summary derived from the dev’s sources.'}{' '}
            The dev named {coin.subject.narrativeSourceCount}{' '}
            {coin.subject.narrativeSourceCount === 1 ? 'source' : 'sources'} and{' '}
            {coin.subject.linkCount} {coin.subject.linkCount === 1 ? 'link' : 'links'}; neither is
            listed here.
          </div>
        </div>
        <Badge tone={coin.narrativeApproved ? 'good' : 'warn'}>
          narrative: {coin.narrativeApproved ? 'approved' : 'pending'}
        </Badge>
      </div>

      {/*
        Directly under the tier panel, because the tier is what decides the
        shape of the team: which roles are awake, whether a model is in the
        loop at all, and whether there is any third-party media to buy.
      */}
      <AgentTeamCard vault={coin.identity.vault} tier={coin.tier} />

      <FeeFlow
        period={coin.period}
        config={config}
        charging={charging}
        buybackEnabled={coin.identity.buybackEnabled}
        creatorTaxBps={coin.identity.creatorTaxBps}
        heading="Last 7 days"
        note="Four numbers, never one. The dev leg, the procurement budget and the operator fee are separate because they are separately owned; adding any two of them together would misdescribe who has what."
      />

      <section className="stack">
        <div className="section-head">
          <div>
            <span className="eyebrow">Balances</span>
            <h2>What is left, in bands</h2>
          </div>
        </div>
        <div className="figure-grid">
          <BandedBalanceCard
            label="Procurement budget available"
            cents={coin.budgetBalanceCents}
            observedAtUnix={coin.balancesObservedAtUnix}
            note="Escrowed to this coin. Cannot be lent to another coin, spent on credit, or committed beyond what is already banked."
          />
          <BandedBalanceCard
            label="Committed, delivery unproven"
            cents={coin.unprovenEscrowCents}
            observedAtUnix={coin.balancesObservedAtUnix}
            note="Held pending a delivery predicate. Returns to the dev leg if the proof window closes unproven."
          />
        </div>
        <BandExplainer />
      </section>

      {receiptsQuery.error !== null ? (
        <ErrorPanel error={receiptsQuery.error} onRetry={receiptsQuery.reload} />
      ) : receiptsQuery.data === null ? (
        <Skeleton height={200} />
      ) : (
        <ReceiptsLedger receipts={receiptsQuery.data.items} nowUnix={nowUnix} />
      )}

      {vendorsQuery.error !== null ? (
        <ErrorPanel error={vendorsQuery.error} onRetry={vendorsQuery.reload} />
      ) : vendorsQuery.data === null ? (
        <Skeleton height={160} />
      ) : (
        <VendorScorecards vendors={vendorsQuery.data} />
      )}

      <section className="stack">
        <div className="section-head">
          <div>
            <span className="eyebrow">Accounts</span>
            <h2>Every account that speaks for this coin</h2>
          </div>
          <p>
            One ticker per account, always. No operator account promotes two member coins, and no
            member coin is promoted to another member&rsquo;s holders.
          </p>
        </div>
        <div className="grid-3">
          {coin.operatedAccounts.map((account) => (
            <div className="card-flat" key={`${account.channel}:${account.handle}`}>
              <div className="row-between">
                <strong>@{account.handle}</strong>
                <Badge tone="accent">AI-operated</Badge>
              </div>
              <div className="small muted">{account.channel}</div>
              <a className="small" href={account.url} target="_blank" rel="noreferrer noopener">
                {account.url}
              </a>
            </div>
          ))}
        </div>
      </section>

      <WhatWeDidNotDo />

      <DisclosurePanel
        facts={{
          operatorLegalName: protocol?.operatorLegalName ?? 'SET_ME_BEFORE_LAUNCH',
          operatorBps: coin.operatorBps,
          budgetBps: coin.budgetBps,
          operatorAddresses: protocol?.operatorAddresses ?? [],
          vaultAddress: coin.identity.vault,
          paidPromotionInUse: coin.paidPromotionInUse,
        }}
      />

      <footer className="small muted">
        The operator fee on this vault is {formatBps(coin.operatorBps)} and cannot change: it is part
        of the CREATE2 salt this vault&rsquo;s address was derived from, so a different rate would be
        a different address.{' '}
        <Link to={{ name: 'dev', vault: coin.identity.vault }}>The dev of this coin</Link> can end
        the engagement at any time and keep 100% of fees from that moment.
      </footer>
    </div>
  )
}

/** The public page for a vault the API has no record of. Exported for the route test. */
export function NoSuchVault({ vault, code }: { vault: string; code: string | null }) {
  return (
    <div className="page stack" style={{ paddingTop: 'var(--gap-5)' }}>
      <span className="eyebrow">Member coin · receipts</span>
      <h1>No such vault</h1>
      <p className="lede">
        <code>{vault}</code> is not a member vault this operator has a record of. Either it was
        never onboarded here, or the address in the link is wrong. Nothing is estimated for it and
        nothing is shown.
      </p>
      {code !== null && (
        <p className="tiny mono muted">
          the API said <code>{code}</code>
        </p>
      )}
      <div>
        <Link to={{ name: 'directory' }} className="btn">
          All member coins
        </Link>
      </div>
    </div>
  )
}
