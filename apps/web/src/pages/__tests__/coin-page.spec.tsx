import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ApiError } from '../../api/client.js'
import { FixtureApiClient } from '../../api/fixtures/client.js'
import { RouterProvider } from '../../app/router.js'
import { ReceiptsLedger } from '../../components/ReceiptsLedger.js'
import { NoSuchVault } from '../CoinPage.js'

/**
 * The public receipts page is the link the publisher stamps into every
 * disclosure. Two things it must do when it has less than a full record:
 * say "no such vault" for an address the API has no record of - not crash,
 * not offer a retry - and state the 72-hour embargo on unexecuted commitments
 * even when nothing happens to be withheld, because a ledger that only
 * mentioned the lag when it was in effect would read as complete when it was
 * merely quiet.
 */

const NOW = 1_780_000_000

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim()
}

describe('a vault the API has no record of', () => {
  it('is a 404 from the client, carrying the code, not an exception the page has to guess at', async () => {
    const client = new FixtureApiClient({ now: () => NOW })
    const failure = await client.getCoin(`0x${'f'.repeat(40)}`).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).status).toBe(404)
  })

  it('renders as "no such vault" with the address and the API’s code, and a way back, not a retry', () => {
    const vault = `0x${'f'.repeat(40)}`
    const html = renderToStaticMarkup(
      <RouterProvider>
        <NoSuchVault vault={vault} code="no_such_vault" />
      </RouterProvider>,
    )
    const body = text(html)
    expect(body).toContain('No such vault')
    expect(body).toContain(vault)
    expect(body).toContain('no_such_vault')
    expect(body).toContain('Nothing is estimated for it')
    expect(html).toContain('href="/"')
    expect(body).not.toContain('Try again')
  })
})

describe('the receipts embargo note', () => {
  it('renders on the public ledger even when nothing is withheld', () => {
    const html = renderToStaticMarkup(<ReceiptsLedger receipts={[]} nowUnix={NOW} />)
    expect(html).toContain('data-embargo')
    const body = text(html)
    expect(body).toContain('Nothing withheld right now')
    expect(body).toContain('72-hour lag')
  })

  it('counts what is withheld, and names the next reveal, when the lag is in effect', async () => {
    const client = new FixtureApiClient({ now: () => NOW })
    const flagship = (await client.listCoins()).find((coin) => coin.tier === 'T3')!
    const page = await client.listReceipts(flagship.vault)
    const body = text(renderToStaticMarkup(<ReceiptsLedger receipts={page.items} nowUnix={NOW} />))
    expect(body).toMatch(/\d+ commitments? withheld/)
    expect(body).toContain('The next one publishes')
  })

  it('is absent from the dev’s own ledger, where the lag is not enforced', () => {
    const html = renderToStaticMarkup(<ReceiptsLedger receipts={[]} nowUnix={NOW} enforceLag={false} />)
    expect(html).not.toContain('data-embargo')
  })
})
