import { useState } from 'react'

import { ApiError } from '../../api/client.js'
import type { PublicCoin } from '../../api/model.js'
import {
  PROMOTION_ELIGIBLE_STATES,
  type LabelAttestation,
  type OnboardingRecordView,
  type XAuthorization,
  type XBinding,
} from '../../api/operator.js'
import { useApp, useAsync } from '../../app/context.js'
import { Badge, ErrorPanel, Skeleton, Timestamp } from '../../components/primitives.js'
import { RecordLine, RecordPicker, RefusalPanel, useAction, useOperator, type Refusal } from './common.js'

/**
 * Accounts: one platform account speaks for exactly one coin.
 *
 * Three moves, in the order they happen: start the X OAuth handshake (the
 * console shows the URL and the operator visits it in their own browser
 * session - the token never comes back here), bind the authorised account to
 * the coin under its own ticker, and attest that the Automated label is on the
 * profile, which lapses after `days` and has to be re-attested.
 *
 * The Telegram chat the desk answers in is fleet configuration
 * (coins[].accounts.telegram), not an API object; what the API knows is the
 * handle on the public record, and that is what is shown.
 */

export function AccountsPage({ id }: { id: string | null }) {
  const { operator, auth, nowUnix } = useOperator()
  const { client } = useApp()
  const records = useAsync(() => (id === null ? operator.listOnboardings(auth) : Promise.resolve([])), [auth.token, id])
  const record = useAsync(() => (id === null ? Promise.resolve(null) : operator.getOnboarding(auth, id)), [auth.token, id])
  const coin = useAsync<PublicCoin | null>(async () => {
    if (record.data === null) return null
    try {
      return await client.getCoin(record.data.vault)
    } catch (error: unknown) {
      // Not on the public directory yet is an answer, not a failure.
      if (error instanceof ApiError && error.status === 404) return null
      throw error
    }
  }, [record.data?.vault])

  if (id === null) {
    if (records.error !== null) return <ErrorPanel error={records.error} onRetry={records.reload} />
    if (records.data === null) return <Skeleton height={200} />
    return (
      <div className="stack">
        <p className="small muted">An account is bound once the coin has pointed at the vault. Pick a record.</p>
        <RecordPicker
          records={records.data}
          page="accounts"
          eligible={(candidate) => PROMOTION_ELIGIBLE_STATES.includes(candidate.state)}
          emptyNote="No onboarding has pointed at its vault yet, so there is nothing to bind an account to."
        />
      </div>
    )
  }

  if (record.error !== null) return <ErrorPanel error={record.error} onRetry={record.reload} />
  if (record.data === null) return <Skeleton height={320} />

  return (
    <AccountsView
      record={record.data}
      coin={coin.data}
      coinError={coin.error}
      nowUnix={nowUnix}
      onAuthorize={(accountId) => operator.authorizeX(auth, record.data!.coinRef, accountId)}
      onBind={(accountId, ticker) => operator.bindX(auth, { accountId, coinRef: record.data!.coinRef, ticker })}
      onAttest={(accountId, attestedBy, days) => operator.attestLabel(auth, { accountId, attestedBy, days })}
    />
  )
}

export function AccountsView({
  record,
  coin,
  coinError,
  nowUnix,
  onAuthorize,
  onBind,
  onAttest,
}: {
  record: OnboardingRecordView
  coin: PublicCoin | null
  coinError: string | null
  nowUnix: number
  onAuthorize: (accountId: string) => Promise<XAuthorization>
  onBind: (accountId: string, ticker: string) => Promise<XBinding>
  onAttest: (accountId: string, attestedBy: string, days: number) => Promise<LabelAttestation>
}) {
  const [accountId, setAccountId] = useState('')
  const [ticker, setTicker] = useState(record.subject.symbol)
  const [attestedBy, setAttestedBy] = useState('')
  const [days, setDays] = useState('30')
  const authorize = useAction<XAuthorization>()
  const bind = useAction<XBinding>()
  const attest = useAction<LabelAttestation>()

  const accountValid = /^[A-Za-z0-9_]{1,64}$/.test(accountId)
  const operatorValid = /^[A-Za-z0-9_.-]{1,64}$/.test(attestedBy)
  const daysValue = Number.parseInt(days, 10)
  const daysValid = /^\d{1,3}$/.test(days) && daysValue >= 1 && daysValue <= 365
  const eligible = PROMOTION_ELIGIBLE_STATES.includes(record.state)
  const telegram = coin?.operatedAccounts.filter((account) => account.channel === 'telegram') ?? []
  const xAccounts = coin?.operatedAccounts.filter((account) => account.channel === 'x_operator') ?? []

  return (
    <div className="stack-loose">
      <RecordLine record={record} />

      <section className="stack">
        <div className="section-head">
          <div>
            <span className="eyebrow">On the public record</span>
            <h2>Accounts that speak for this coin</h2>
          </div>
        </div>
        {coinError !== null ? (
          <ErrorPanel error={coinError} />
        ) : coin === null ? (
          <div className="card-flat small muted">Not on the public directory yet. Accounts appear there once the vault is active.</div>
        ) : (
          <div className="grid-2">
            <div className="card-flat stack-tight">
              <strong>Telegram</strong>
              {telegram.length === 0 ? (
                <span className="small muted">No Telegram chat is bound.</span>
              ) : (
                telegram.map((account) => (
                  <div key={account.handle} className="row">
                    <code>@{account.handle}</code>
                    <Badge tone="accent">desk</Badge>
                  </div>
                ))
              )}
              <span className="tiny muted">
                The chat id the desk listens in is fleet configuration (<code>coins[].accounts.telegram</code>), bound one chat to one coin at startup.
              </span>
            </div>
            <div className="card-flat stack-tight">
              <strong>X</strong>
              {xAccounts.length === 0 ? (
                <span className="small muted">No X account is bound.</span>
              ) : (
                xAccounts.map((account) => (
                  <div key={account.handle} className="row">
                    <code>@{account.handle}</code>
                    <Badge tone="accent">AI-operated</Badge>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </section>

      {!eligible && (
        <div className="callout callout-warn">
          <div className="callout-title">Not eligible yet</div>
          <p className="small" style={{ margin: 0 }}>
            State is <code>{record.state}</code>. Binding is refused with <code>coin_not_eligible</code> until the coin has pointed at the vault.
          </p>
        </div>
      )}

      <section className="stack">
        <div className="section-head">
          <div>
            <span className="eyebrow">1 · Authorise</span>
            <h2>Start the X handshake</h2>
          </div>
          <p>
            The URL is visited in the operator&rsquo;s own browser session as the account. X sends the code to the
            API&rsquo;s callback; the credential is stored there and never shown here.
          </p>
        </div>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ maxWidth: '20rem' }}>
            <label htmlFor="x-account-id">X account id (numeric user id)</label>
            <input
              id="x-account-id"
              type="text"
              value={accountId}
              onChange={(event) => setAccountId(event.currentTarget.value)}
              aria-invalid={accountId.length > 0 && !accountValid}
            />
          </div>
          <button type="button" className="btn btn-primary" disabled={authorize.busy || !accountValid} onClick={() => void authorize.run(() => onAuthorize(accountId))}>
            Get authorise link
          </button>
        </div>
        {authorize.refusal !== null && <RefusalPanel refusal={authorize.refusal} title="Authorise refused" />}
        {authorize.result !== null && (
          <div className="callout callout-info">
            <div className="callout-title">Visit this as the account</div>
            <p className="small mono" style={{ margin: 0, wordBreak: 'break-all' }}>
              <a href={authorize.result.url} target="_blank" rel="noreferrer noopener">
                {authorize.result.url}
              </a>
            </p>
            <p className="tiny muted" style={{ margin: 0 }}>
              state <code>{authorize.result.state}</code> · expires <Timestamp unix={authorize.result.expiresAtUnix} relativeTo={nowUnix} />
            </p>
          </div>
        )}
      </section>

      <section className="stack">
        <div className="section-head">
          <div>
            <span className="eyebrow">2 · Bind</span>
            <h2>One account, one ticker</h2>
          </div>
          <p>Refused with <code>account_not_authorised</code> until the handshake above has completed, and with <code>ticker_mismatch</code> if the ticker is not this coin&rsquo;s symbol.</p>
        </div>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ maxWidth: '12rem' }}>
            <label htmlFor="x-ticker">Ticker</label>
            <input id="x-ticker" type="text" value={ticker} onChange={(event) => setTicker(event.currentTarget.value)} />
          </div>
          <button type="button" className="btn btn-primary" disabled={bind.busy || !accountValid || ticker.length === 0} onClick={() => void bind.run(() => onBind(accountId, ticker))}>
            Bind {accountValid ? accountId : 'account'} to {record.subject.symbol}
          </button>
        </div>
        {bind.refusal !== null && <RefusalPanel refusal={bind.refusal} title="Bind refused" />}
        {bind.result !== null && (
          <div className="callout callout-good">
            <div className="callout-title">Bound</div>
            <p className="small mono" style={{ margin: 0 }}>
              {bind.result.accountId} · {bind.result.channel} · {bind.result.ticker} · {bind.result.coinRef}
            </p>
          </div>
        )}
      </section>

      <section className="stack">
        <div className="section-head">
          <div>
            <span className="eyebrow">3 · Attest the label</span>
            <h2>The Automated label is on the profile</h2>
          </div>
          <p>A named operator checked the profile. The attestation lapses after the days given and publishing stops until it is renewed.</p>
        </div>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ maxWidth: '16rem' }}>
            <label htmlFor="label-attested-by">Attested by (operator id)</label>
            <input
              id="label-attested-by"
              type="text"
              value={attestedBy}
              onChange={(event) => setAttestedBy(event.currentTarget.value)}
              aria-invalid={attestedBy.length > 0 && !operatorValid}
            />
          </div>
          <div className="field" style={{ maxWidth: '8rem' }}>
            <label htmlFor="label-days">Days (1–365)</label>
            <input id="label-days" type="text" inputMode="numeric" value={days} onChange={(event) => setDays(event.currentTarget.value)} aria-invalid={!daysValid} />
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={attest.busy || !accountValid || !operatorValid || !daysValid}
            onClick={() => void attest.run(() => onAttest(accountId, attestedBy, daysValue))}
          >
            Attest for {daysValid ? String(daysValue) : '…'} days
          </button>
        </div>
        {attest.refusal !== null && <RefusalPanel refusal={attest.refusal} title="Attestation refused" />}
        {attest.result !== null && (
          <div className="callout callout-good">
            <div className="callout-title">Attested</div>
            <p className="small" style={{ margin: 0 }}>
              <code>{attest.result.accountId}</code> by <code>{attest.result.attestedBy}</code>, lapses{' '}
              <Timestamp unix={attest.result.expiresAtUnix} relativeTo={nowUnix} />.
            </p>
          </div>
        )}
      </section>
    </div>
  )
}
