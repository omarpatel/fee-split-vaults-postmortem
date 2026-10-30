import { useCallback, useMemo, useState, type FormEvent } from 'react'

import { useApp } from '../../app/context.js'
import { Link, OPS_PAGES, type OpsPage } from '../../app/router.js'
import { Badge } from '../../components/primitives.js'
import { AccountsPage } from './Accounts.js'
import { CreativePage } from './Creative.js'
import { KybPage } from './Kyb.js'
import { NarrativePage } from './Narrative.js'
import { PurchasesPage } from './Purchases.js'
import { QueuePage } from './Queue.js'
import { OperatorProvider, RefusalPanel, describeRefusal, type Refusal } from './common.js'

/**
 * The operator console.
 *
 * ONE credential, entered once. The operator bearer is the same token every
 * operator route on apps/api checks; it is held in sessionStorage so a reload
 * does not ask again and a closed tab forgets it, and it is never placed in a
 * URL, where it would land in history, referrer headers and screenshots.
 *
 * The gate proves the token before it lets anyone in, by making the cheapest
 * operator read there is. A wrong token is shown as the server's own
 * `unauthorized`, not as a friendlier lie.
 */

const TOKEN_KEY = 'fee-split-vaults/operator-token'

const PAGE_LABELS: Readonly<Record<OpsPage, string>> = {
  queue: 'Queue',
  narrative: 'Narrative',
  creative: 'Creative',
  accounts: 'Accounts',
  purchases: 'Purchases',
  kyb: 'KYB',
}

function readStoredToken(): string | null {
  try {
    return globalThis.sessionStorage?.getItem(TOKEN_KEY) ?? null
  } catch {
    return null
  }
}

function writeStoredToken(token: string | null): void {
  try {
    if (token === null) globalThis.sessionStorage?.removeItem(TOKEN_KEY)
    else globalThis.sessionStorage?.setItem(TOKEN_KEY, token)
  } catch {
    // Storage disabled: the token lives for this render tree only.
  }
}

export function OpsConsole({ page, id }: { page: OpsPage; id: string | null }) {
  const { env } = useApp()
  const [token, setToken] = useState<string | null>(readStoredToken)
  const [gateRefusal, setGateRefusal] = useState<Refusal | null>(null)
  const [checking, setChecking] = useState(false)
  const nowUnix = Math.floor(Date.now() / 1_000)

  const signIn = useCallback(
    async (candidate: string) => {
      setChecking(true)
      setGateRefusal(null)
      try {
        await env.operator.listOnboardings({ token: candidate })
        writeStoredToken(candidate)
        setToken(candidate)
      } catch (error: unknown) {
        setGateRefusal(describeRefusal(error))
      } finally {
        setChecking(false)
      }
    },
    [env.operator],
  )

  const signOut = useCallback(() => {
    writeStoredToken(null)
    setToken(null)
  }, [])

  const context = useMemo(
    () => (token === null ? null : { auth: { token }, operator: env.operator, nowUnix, isDemo: env.isDemo, signOut }),
    // nowUnix is read once per sign-in on purpose: the pages take it as "when this render happened".
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token, env.operator, env.isDemo, signOut],
  )

  if (context === null) {
    return (
      <OperatorGate
        onSubmit={signIn}
        refusal={gateRefusal}
        checking={checking}
        demoToken={env.demoOperatorToken}
        isDemo={env.isDemo}
      />
    )
  }

  return (
    <OperatorProvider value={context}>
      <OpsConsoleView page={page} id={id} isDemo={env.isDemo} onSignOut={signOut} />
    </OperatorProvider>
  )
}

/** The gate, as a pure view. Renders with no storage and no window. */
export function OperatorGate({
  onSubmit,
  refusal,
  checking,
  demoToken,
  isDemo,
}: {
  onSubmit: (token: string) => void
  refusal: Refusal | null
  checking: boolean
  demoToken: string | null
  isDemo: boolean
}) {
  const [draft, setDraft] = useState('')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (draft.trim().length === 0) return
    onSubmit(draft.trim())
  }

  return (
    <div className="page stack-loose" style={{ paddingTop: 'var(--gap-5)' }}>
      <header className="stack">
        <span className="eyebrow">Operator console</span>
        <h1>Operator token</h1>
        <p className="lede">
          Every route behind this page is the operator surface of the API: the onboarding queue,
          narrative approval, the creative handoff, X accounts, invoices and identity attestations.
          The bearer is <code>VENUE_OPERATOR_API_TOKEN</code>. It is kept in this tab&rsquo;s session
          storage and never in a URL.
        </p>
        {isDemo && <Badge tone="warn">demo data</Badge>}
      </header>

      <form className="card stack" onSubmit={submit} style={{ maxWidth: '36rem' }}>
        <div className="field">
          <label htmlFor="operator-token">Bearer token</label>
          <input
            id="operator-token"
            type="password"
            autoComplete="off"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            aria-invalid={refusal !== null}
          />
          {demoToken !== null && (
            <span className="field-hint">
              Demo mode: the fixture backend accepts <code>{demoToken}</code>.
            </span>
          )}
        </div>
        {refusal !== null && <RefusalPanel refusal={refusal} title="Token refused" />}
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={checking || draft.trim().length === 0}>
            {checking ? 'Checking…' : 'Enter console'}
          </button>
        </div>
      </form>
    </div>
  )
}

/** Everything past the gate, given a client and a page. Pure enough to render to markup. */
export function OpsConsoleView({
  page,
  id,
  isDemo,
  onSignOut,
}: {
  page: OpsPage
  id: string | null
  isDemo: boolean
  onSignOut: () => void
}) {
  return (
    <div className="page stack-loose" style={{ paddingTop: 'var(--gap-4)' }}>
      <header className="stack">
        <div className="row-between">
          <div>
            <span className="eyebrow">Operator console</span>
            <h1>{PAGE_LABELS[page]}</h1>
          </div>
          <div className="row">
            {isDemo && <Badge tone="warn">demo data</Badge>}
            <button type="button" className="btn btn-small btn-ghost" onClick={onSignOut}>
              Forget token
            </button>
          </div>
        </div>
        <nav className="row" aria-label="Console pages">
          {OPS_PAGES.map((candidate) => (
            <Link
              key={candidate}
              to={{ name: 'ops', page: candidate, id: null }}
              className={`btn btn-small${candidate === page ? ' btn-primary' : ''}`}
            >
              {PAGE_LABELS[candidate]}
            </Link>
          ))}
        </nav>
      </header>

      {page === 'queue' && <QueuePage />}
      {page === 'narrative' && <NarrativePage id={id} />}
      {page === 'creative' && <CreativePage id={id} />}
      {page === 'accounts' && <AccountsPage id={id} />}
      {page === 'purchases' && <PurchasesPage vault={id} />}
      {page === 'kyb' && <KybPage />}
    </div>
  )
}
