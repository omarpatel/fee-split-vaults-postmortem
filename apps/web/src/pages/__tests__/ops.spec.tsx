import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'

import { FixtureApiClient } from '../../api/fixtures/client.js'
import { FIXTURE_OPERATOR_TOKEN } from '../../api/fixtures/operator.js'
import type { OnboardingRecordView } from '../../api/operator.js'
import { RouterProvider } from '../../app/router.js'
import { AccountsView } from '../ops/Accounts.js'
import { CreativeView } from '../ops/Creative.js'
import { KybView } from '../ops/Kyb.js'
import { NarrativePageView } from '../ops/Narrative.js'
import { OperatorGate, OpsConsoleView } from '../ops/OpsConsole.js'
import { PurchasesView } from '../ops/Purchases.js'
import { DeclineForm, QueueView } from '../ops/Queue.js'
import { OperatorProvider, describeRefusal } from '../ops/common.js'

/**
 * THE CONSOLE, RENDERED.
 *
 * Each page is rendered to markup from the real fixture backend through the
 * real components, and what is asserted is what an operator would be misled
 * by if it were wrong: a gate that let a bad token through, a queue offering
 * "Activate" on a record the service would refuse it for, a refusal code
 * paraphrased into something friendlier, a tagline tidied before approval.
 */

const NOW = 1_780_000_000
const AUTH = { token: FIXTURE_OPERATOR_TOKEN }
const never = async () => {
  throw new Error('not called in a static render')
}

function api(): FixtureApiClient {
  return new FixtureApiClient({ now: () => NOW })
}

function render(node: ReactNode): string {
  return renderToStaticMarkup(<RouterProvider>{node}</RouterProvider>)
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&rsquo;/g, '’')
    .replace(/\s+/g, ' ')
    .trim()
}

describe('the token gate', () => {
  it('renders the gate and no console when there is no token', () => {
    const html = render(<OperatorGate onSubmit={() => undefined} refusal={null} checking={false} demoToken={null} isDemo={false} />)
    expect(html).toContain('id="operator-token"')
    expect(html).toContain('type="password"')
    expect(text(html)).not.toContain('Run diligence')
    // A real API: no hint about any token.
    expect(text(html)).not.toContain('accepts')
  })

  it('shows the demo token only in demo mode, as a badge says the data is fixture', () => {
    const body = text(render(<OperatorGate onSubmit={() => undefined} refusal={null} checking={false} demoToken={FIXTURE_OPERATOR_TOKEN} isDemo />))
    expect(body).toContain(`accepts ${FIXTURE_OPERATOR_TOKEN}`)
    expect(body).toContain('demo data')
  })

  it('surfaces a wrong token as the server’s 401 and its code, not as a friendlier lie', async () => {
    const failure = await api().operator.listOnboardings({ token: 'wrong' }).catch((error: unknown) => error)
    const refusal = describeRefusal(failure)
    expect(refusal.status).toBe(401)
    expect(refusal.code).toBe('unauthorized')
    const html = render(<OperatorGate onSubmit={() => undefined} refusal={refusal} checking={false} demoToken={null} isDemo={false} />)
    expect(html).toContain('aria-invalid="true"')
    const body = text(html)
    expect(body).toContain('Token refused')
    expect(body).toContain('401')
    expect(body).toContain('unauthorized')
    expect(body).toContain('operator token required')
  })
})

describe('the console shell', () => {
  it('names every page and marks the current one, with the demo badge when the data is fixture', () => {
    const client = api()
    const html = render(
      <OperatorProvider value={{ auth: AUTH, operator: client.operator, nowUnix: NOW, isDemo: true, signOut: () => undefined }}>
        <OpsConsoleView page="kyb" id={null} isDemo onSignOut={() => undefined} />
      </OperatorProvider>,
    )
    for (const label of ['Queue', 'Narrative', 'Creative', 'Accounts', 'Purchases', 'KYB']) expect(text(html)).toContain(label)
    expect(html).toContain('href="/ops/kyb"')
    expect(html).toContain('class="btn btn-small btn-primary">KYB<')
    expect(text(html)).toContain('demo data')
    expect(text(html)).toContain('Forget token')
  })
})

describe('the queue', () => {
  async function records(): Promise<OnboardingRecordView[]> {
    return api().operator.listOnboardings(AUTH)
  }

  it('groups records by state and offers exactly the move the service accepts from each', async () => {
    const html = render(<QueueView records={await records()} nowUnix={NOW} onAction={never} onDecline={never} />)
    const body = text(html)
    expect(body).toContain('1 signed')
    expect(body).toContain('Run diligence')
    expect(body).toContain('Deploy vault')
    expect(body).toContain('Confirm pointing')
    expect(body).toContain('Record acceptance')
    expect(body).toContain('Activate')
    // Exactly one of each forward move: one record per queue state in the fixture.
    expect(html.match(/>Run diligence</g)).toHaveLength(1)
    expect(html.match(/>Activate</g)).toHaveLength(1)
  })

  it('offers no forward move and no decline on a terminal record, and says why', async () => {
    const declined = (await records()).filter((record) => record.state === 'declined')
    const html = render(<QueueView records={declined} nowUnix={NOW} onAction={never} onDecline={never} />)
    const body = text(html)
    expect(body).toContain('Terminal. The dev keeps every fee.')
    expect(body).toContain('declined diligence_failed')
    expect(html).not.toContain('>Decline…<')
    expect(html).not.toContain('>Activate<')
  })

  it('links an active record to its narrative, creative, accounts, purchases and public page', async () => {
    const active = (await records()).filter((record) => record.state === 'active')
    const html = render(<QueueView records={active} nowUnix={NOW} onAction={never} onDecline={never} />)
    const first = active[0]!
    expect(html).toContain(`href="/ops/narrative/${first.id}"`)
    expect(html).toContain(`href="/ops/creative/${first.id}"`)
    expect(html).toContain(`href="/ops/accounts/${first.id}"`)
    expect(html).toContain(`href="/ops/purchases/${first.vault}"`)
    expect(html).toContain(`href="/${first.vault}"`)
  })

  it('renders a refusal on the decline form with the code verbatim', () => {
    const refusal = { code: 'chain_state_mismatch', status: 400, message: 'chain says ACTIVE, not PENDING' }
    const html = render(
      <DeclineForm busy={false} code="rug_pull" detail="" refusal={refusal} onCode={() => undefined} onDetail={() => undefined} onCancel={() => undefined} onSubmit={() => undefined} />,
    )
    expect(html).toContain('<code class="refusal-code">chain_state_mismatch</code>')
    expect(text(html)).not.toContain('something went wrong')
  })
})

describe('narrative', () => {
  it('shows the tagline verbatim, the tone, and both palette swatches with their hex', async () => {
    const operator = api().operator
    const pointed = (await operator.listOnboardings(AUTH, 'pointed'))[0]!
    const narrative = await operator.getNarrative(AUTH, pointed.id)
    const html = render(
      <NarrativePageView
        narrative={narrative}
        nowUnix={NOW}
        deriving={false}
        deriveRefusal={null}
        onDerive={() => undefined}
        approving={false}
        approveRefusal={null}
        approval={null}
        onApprove={() => undefined}
      />,
    )
    const tagline = narrative.candidate!.tagline
    expect(html).toMatch(new RegExp(`<blockquote[^>]*data-tagline="true">${tagline}</blockquote>`))
    expect(html).toContain(`background:${narrative.candidate!.palette.primary}`)
    expect(html).toContain(`background:${narrative.candidate!.palette.secondary}`)
    const body = text(html)
    expect(body).toContain(narrative.candidate!.palette.primary)
    expect(body).toContain('candidate awaiting approval')
    expect(body).toContain('Approve these exact words')
    for (const source of narrative.sources) expect(body).toContain(source)
  })

  it('renders a derive refusal with the code the service used', async () => {
    const operator = api().operator
    const screened = (await operator.listOnboardings(AUTH, 'screened'))[0]!
    const narrative = await operator.getNarrative(AUTH, screened.id)
    const failure = await operator.deriveNarrative(AUTH, screened.id).catch((error: unknown) => error)
    const html = render(
      <NarrativePageView
        narrative={narrative}
        nowUnix={NOW}
        deriving={false}
        deriveRefusal={describeRefusal(failure)}
        onDerive={() => undefined}
        approving={false}
        approveRefusal={null}
        approval={null}
        onApprove={() => undefined}
      />,
    )
    expect(html).toContain('<code class="refusal-code">narrative_not_eligible</code>')
    expect(text(html)).toContain('409')
  })
})

describe('creative', () => {
  it('previews each rendered asset from its blob URL with a download, and a refusal where there is none', () => {
    const html = render(
      <CreativeView
        id="onb_kettle"
        slots={{
          banner: { status: 'ready', image: { kind: 'banner', url: 'blob:banner', mime: 'image/png', bytes: 1234, sha256: 'a'.repeat(64) } },
          avatar: { status: 'refused', refusal: { code: 'creative_not_rendered', status: 404, message: 'no rendered asset of that kind for this coin' } },
          card: { status: 'loading' },
        }}
        rendering={false}
        renderRefusal={null}
        lastRender={null}
        onRender={() => undefined}
      />,
    )
    expect(html).toContain('src="blob:banner"')
    expect(html).toContain('download="onb_kettle-banner.png"')
    expect(html).toContain('<code class="refusal-code">creative_not_rendered</code>')
    expect(html).toContain('skeleton')
    expect(text(html)).toContain('1500 × 500')
  })

  it('shows feature_unconfigured as the render refusal, verbatim', () => {
    const html = render(
      <CreativeView
        id="onb_kettle"
        slots={{}}
        rendering={false}
        renderRefusal={{ code: 'feature_unconfigured', status: 503, message: 'creative is not configured in this deployment' }}
        lastRender={null}
        onRender={() => undefined}
      />,
    )
    expect(html).toContain('<code class="refusal-code">feature_unconfigured</code>')
    expect(text(html)).toContain('503')
  })
})

describe('accounts', () => {
  it('shows the coin’s Telegram and X handles from the public record and the three moves in order', async () => {
    const client = api()
    const active = (await client.operator.listOnboardings(AUTH, 'active')).find((record) => record.subject.symbol === 'HYDR')!
    const coin = await client.getCoin(active.vault)
    const html = render(<AccountsView record={active} coin={coin} coinError={null} nowUnix={NOW} onAuthorize={never} onBind={never} onAttest={never} />)
    const body = text(html)
    expect(body).toContain('@hydrant_desk')
    expect(body).toContain('@hydrant_ops')
    expect(body).toContain('coins[].accounts.telegram')
    expect(body).toContain('1 · Authorise')
    expect(body).toContain('2 · Bind')
    expect(body).toContain('3 · Attest the label')
    expect(html).toContain('value="HYDR"')
    expect(html).toContain('id="label-days"')
  })

  it('says a not-yet-public coin has no accounts on record rather than failing', async () => {
    const pointed = (await api().operator.listOnboardings(AUTH, 'pointed'))[0]!
    const body = text(render(<AccountsView record={pointed} coin={null} coinError={null} nowUnix={NOW} onAuthorize={never} onBind={never} onAttest={never} />))
    expect(body).toContain('Not on the public directory yet')
    expect(body).not.toContain('Not eligible yet')
  })
})

describe('purchases', () => {
  it('lists what awaits an invoice with its quote in dollars, and the invoice form takes a decimal string', async () => {
    const operator = api().operator
    let queue = null
    for (const record of await operator.listOnboardings(AUTH, 'active')) {
      const candidate = await operator.listPurchases(AUTH, record.vault)
      if (candidate.awaitingInvoice.length > 0) {
        queue = candidate
        break
      }
    }
    expect(queue).not.toBeNull()
    const html = render(<PurchasesView queue={queue!} nowUnix={NOW} onInvoice={never} />)
    const body = text(html)
    expect(body).toContain('Approved, not yet evidenced')
    expect(body).toContain(queue!.awaitingInvoice[0]!.skuId)
    expect(body).toContain('$')
    expect(html).toContain('id="inv-amount"')
    expect(body).toContain('decimal string')
    expect(body).toContain('never as a number')
  })
})

describe('kyb', () => {
  it('renders the lookup and the attest form with an expiry stated as a date, not a day count', () => {
    const html = render(<KybView nowUnix={NOW} onAttest={never} onLookup={never} />)
    expect(html).toContain('id="kyb-lookup"')
    expect(html).toContain('id="kyb-signer"')
    expect(html).toContain('id="kyb-ref"')
    expect(html).toContain('value="365"')
    expect(text(html)).toContain('unix seconds on the wire')
    expect(html).toContain(`dateTime="${new Date((NOW + 365 * 86_400) * 1_000).toISOString()}"`)
  })
})
