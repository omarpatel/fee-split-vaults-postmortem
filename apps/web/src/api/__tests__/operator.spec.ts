import { describe, expect, it } from 'vitest'

import { ApiError } from '../client.js'
import { DecodeError } from '../decode.js'
import { FixtureApiClient } from '../fixtures/client.js'
import { FIXTURE_OPERATOR_TOKEN } from '../fixtures/operator.js'
import {
  HttpOperatorApiClient,
  decodeNarrative,
  decodeOnboardingRecord,
  decodePurchaseQueue,
  decodeUsdDecimal,
  isUnauthorized,
  type NarrativeWire,
  type OnboardingRecordWire,
  type PurchaseQueue,
  type PurchaseQueueWire,
} from '../operator.js'

/**
 * The operator client's boundary.
 *
 * The decoders are what stands between apps/api's JSON and a console that
 * would otherwise render a malformed record as a plausible one. Each case
 * below is a deviation the server COULD produce - a state outside the closed
 * set, a colour that is not a colour, a dollar figure that arrived as a number
 * - and the assertion is that the console refuses it rather than displaying
 * something that looks fine.
 */

const NOW = 1_780_000_000
const AUTH = { token: FIXTURE_OPERATOR_TOKEN }
const ADDR = `0x${'ab'.repeat(20)}`

function record(overrides: Partial<OnboardingRecordWire> = {}): OnboardingRecordWire {
  return {
    id: 'onb_1',
    state: 'signed',
    vault: ADDR,
    token: ADDR,
    coinRef: 'coin_1',
    createdAtUnix: NOW - 100,
    updatedAtUnix: NOW,
    subject: { name: 'One', symbol: 'ONE', linkCount: 1, narrativeSourceCount: 2 },
    consent: {
      devSigner: ADDR,
      devPayout: ADDR,
      token: ADDR,
      termsHash: `0x${'00'.repeat(32)}`,
      operatorBps: 2_000,
      budgetBpsMax: 3_000,
      adapter: ADDR,
      referrer: `0x${'00'.repeat(20)}`,
      referrerBps: 0,
      expiryUnix: NOW + 1_000,
      nonce: `0x${'11'.repeat(32)}`,
    },
    narrativeApproved: false,
    history: [{ atUnix: NOW, from: 'drafted', to: 'signed', code: 'signature_verified' }],
    ...overrides,
  }
}

describe('decodeOnboardingRecord', () => {
  it('decodes the public record with absent optionals as null, not undefined', () => {
    const view = decodeOnboardingRecord(record())
    expect(view.state).toBe('signed')
    expect(view.screening).toBeNull()
    expect(view.diligence).toBeNull()
    expect(view.declineReason).toBeNull()
    expect(view.history[0]?.detail).toBeNull()
    expect(view.vault).toBe(ADDR)
  })

  it('refuses a state outside the closed set', () => {
    expect(() => decodeOnboardingRecord(record({ state: 'approved' }))).toThrow(DecodeError)
  })

  it('refuses a history event whose transition names an unknown state', () => {
    expect(() =>
      decodeOnboardingRecord(record({ history: [{ atUnix: NOW, from: 'drafted', to: 'live', code: 'x' }] })),
    ).toThrow(DecodeError)
  })

  it('refuses a screening verdict it does not know', () => {
    expect(() =>
      decodeOnboardingRecord(
        record({ screening: { verdict: 'MAYBE', paidMediaPermitted: true, flags: [], screenedAtUnix: NOW } }),
      ),
    ).toThrow(DecodeError)
  })
})

describe('decodeNarrative', () => {
  const candidate: NarrativeWire['candidate'] = {
    version: 1,
    tagline: 'A coin with a plan it wrote down.',
    themes: ['community'],
    tone: 'community',
    palette: { primary: '#2f5d50', secondary: '#f0c987' },
    sourceHashes: ['a'.repeat(64)],
  }

  it('keeps the tagline verbatim and the palette as lowercase hex', () => {
    const view = decodeNarrative({ id: 'onb_1', state: 'pointed', sources: ['https://x.example/a'], candidate })
    expect(view.candidate?.tagline).toBe('A coin with a plan it wrote down.')
    expect(view.candidate?.palette).toEqual({ primary: '#2f5d50', secondary: '#f0c987' })
    expect(view.approved).toBeNull()
  })

  it('refuses a palette entry that is not #rrggbb', () => {
    expect(() =>
      decodeNarrative({ id: 'onb_1', state: 'pointed', sources: [], candidate: { ...candidate, palette: { primary: 'teal', secondary: '#f0c987' } } }),
    ).toThrow(DecodeError)
  })

  it('refuses a tone outside the closed vocabulary', () => {
    expect(() => decodeNarrative({ id: 'onb_1', state: 'pointed', sources: [], candidate: { ...candidate, tone: 'edgy' } })).toThrow(DecodeError)
  })

  it('refuses a source hash that is not sha256 hex', () => {
    expect(() =>
      decodeNarrative({ id: 'onb_1', state: 'pointed', sources: [], candidate: { ...candidate, sourceHashes: ['https://x.example/a'] } }),
    ).toThrow(DecodeError)
  })
})

describe('money on the operator wire', () => {
  it('turns a printed dollar string into cents without a float', () => {
    expect(decodeUsdDecimal('1450.00', 'amountUsd')).toBe(145_000n)
    expect(decodeUsdDecimal('12.3', 'amountUsd')).toBe(1_230n)
    expect(decodeUsdDecimal('7', 'amountUsd')).toBe(700n)
  })

  it('refuses a number, three decimals, or a leading zero', () => {
    expect(() => decodeUsdDecimal(12.3, 'amountUsd')).toThrow(DecodeError)
    expect(() => decodeUsdDecimal('12.345', 'amountUsd')).toThrow(DecodeError)
    expect(() => decodeUsdDecimal('012', 'amountUsd')).toThrow(DecodeError)
  })

  it('refuses a quote that arrived as a JSON number', () => {
    const wire = {
      vault: ADDR,
      atUnix: NOW,
      awaitingInvoice: [{ vendorId: 'v', skuId: 's', quantity: 1, quoteUsdCents: 1450, proposedAtUnix: NOW }],
      pendingInvoices: [],
    } as unknown as PurchaseQueueWire
    expect(() => decodePurchaseQueue(wire)).toThrow(DecodeError)
  })
})

describe('HttpOperatorApiClient', () => {
  function stub(handler: (url: string, init: RequestInit) => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init: init ?? {} })
      return handler(url, init ?? {})
    }
    return { calls, client: new HttpOperatorApiClient({ baseUrl: 'https://api.example', fetchImpl }) }
  }

  it('sends the operator bearer on every route, without a /v1 prefix', async () => {
    const { calls, client } = stub(() => Response.json({ onboardings: [record()] }))
    await client.listOnboardings({ token: 'tok' }, 'signed')
    expect(calls[0]?.url).toBe('https://api.example/onboarding?state=signed')
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer tok')
  })

  it('surfaces the server refusal code verbatim, with its status', async () => {
    const { client } = stub(() => Response.json({ error: 'feature_unconfigured', message: 'narrative is not configured' }, { status: 503 }))
    const failure = await client.deriveNarrative({ token: 'tok' }, 'onb_1').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    const refused = failure as ApiError
    expect(refused.code).toBe('feature_unconfigured')
    expect(refused.status).toBe(503)
    expect(refused.message).toBe('feature_unconfigured: narrative is not configured')
  })

  it('distinguishes a wrong token from a refused request', async () => {
    const { client } = stub(() => Response.json({ error: 'unauthorized', message: 'operator token required' }, { status: 401 }))
    const failure = await client.listOnboardings({ token: 'wrong' }).catch((error: unknown) => error)
    expect(isUnauthorized(failure)).toBe(true)
    expect((failure as ApiError).code).toBe('unauthorized')
  })

  it('sends the invoice amount as the decimal string it was given', async () => {
    const { calls, client } = stub(() =>
      Response.json({
        vault: ADDR,
        invoice: { vendorId: 'v', skuId: 's', quantity: 1, amountUsd: '1450.00', invoiceHash: `0x${'aa'.repeat(32)}`, issuedAtUnix: NOW },
      }),
    )
    await client.recordInvoice({ token: 'tok' }, {
      vault: ADDR,
      vendorId: 'v',
      skuId: 's',
      quantity: 1,
      amountUsd: '1450.00',
      vendorCountersig: '0xbeef',
      issuedAtUnix: NOW,
    })
    const body = JSON.parse(String(calls[0]?.init.body)) as { amountUsd: unknown }
    expect(body.amountUsd).toBe('1450.00')
  })

  it('reads the rendered image as bytes with its sha256 from the ETag', async () => {
    const { calls, client } = stub(
      () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png', etag: `"${'c'.repeat(64)}"` } }),
    )
    const image = await client.getCreative({ token: 'tok' }, 'onb_1', 'banner')
    expect(calls[0]?.url).toBe('https://api.example/onboarding/onb_1/creative/banner')
    expect(image.mime).toBe('image/png')
    expect(image.bytes).toEqual(new Uint8Array([137, 80, 78, 71]))
    expect(image.sha256).toBe('c'.repeat(64))
  })
})

describe('the operator fixture', () => {
  const api = () => new FixtureApiClient({ now: () => NOW }).operator

  it('refuses a wrong token with the server’s own 401 code', async () => {
    const failure = await api().listOnboardings({ token: 'nope' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).status).toBe(401)
    expect((failure as ApiError).code).toBe('unauthorized')
  })

  it('lists every member coin as active and keeps a queue in front of them', async () => {
    const records = await api().listOnboardings(AUTH)
    const states = new Set(records.map((record) => record.state))
    expect(states.has('active')).toBe(true)
    expect(states.has('signed')).toBe(true)
    expect(states.has('accepted')).toBe(true)
    expect(records.filter((record) => record.state === 'declined')).toHaveLength(1)
  })

  it('walks a record through the same transitions apps/api allows and refuses the others', async () => {
    const operator = api()
    const signed = (await operator.listOnboardings(AUTH, 'signed'))[0]!

    // Out of order. Activation checks the screening first, exactly as apps/api
    // does, so a signed record is refused for having none; a screened one for
    // the transition itself.
    const unscreened = await operator.activate(AUTH, signed.id).catch((error: unknown) => error)
    expect((unscreened as ApiError).code).toBe('screening_missing')

    const screened = await operator.runDiligence(AUTH, signed.id)
    expect(screened.state).toBe('screened')
    const early = await operator.activate(AUTH, signed.id).catch((error: unknown) => error)
    expect((early as ApiError).code).toBe('illegal_transition')
    const bound = await operator.deploy(AUTH, signed.id)
    expect(bound.state).toBe('awaiting_pointing')
    expect(bound.deployedAtUnix).not.toBeNull()
    const pointed = await operator.confirmPointing(AUTH, signed.id)
    expect(pointed.state).toBe('pointed')
    const accepted = await operator.recordAcceptance(AUTH, signed.id)
    expect(accepted.state).toBe('accepted')
    const active = await operator.activate(AUTH, signed.id)
    expect(active.state).toBe('active')
    expect(active.history.at(-1)?.code).toBe('operator_activated')

    // Terminal: an active record cannot be declined.
    const late = await operator.decline(AUTH, signed.id, 'changed_mind').catch((error: unknown) => error)
    expect((late as ApiError).code).toBe('illegal_transition')
  })

  it('refuses to derive a narrative before the coin has pointed, and derives once it has', async () => {
    const operator = api()
    const screened = (await operator.listOnboardings(AUTH, 'screened'))[0]!
    const early = await operator.deriveNarrative(AUTH, screened.id).catch((error: unknown) => error)
    expect((early as ApiError).code).toBe('narrative_not_eligible')

    const pointed = (await operator.listOnboardings(AUTH, 'pointed'))[0]!
    const narrative = await operator.deriveNarrative(AUTH, pointed.id)
    expect(narrative.candidate).not.toBeNull()
    expect(narrative.candidate?.palette.primary).toMatch(/^#[0-9a-f]{6}$/)

    const approval = await operator.approveNarrative(AUTH, pointed.id, 'ops.test')
    expect(approval.narrative.approved?.approvedBy).toBe('ops.test')
    expect(approval.creative?.rendered).toBe(true)
    const banner = await operator.getCreative(AUTH, pointed.id, 'banner')
    expect(banner.bytes.byteLength).toBeGreaterThan(0)
  })

  it('refuses to bind an account that has not completed the handshake', async () => {
    const operator = api()
    const pointed = (await operator.listOnboardings(AUTH, 'pointed'))[0]!
    const unauthorised = await operator
      .bindX(AUTH, { accountId: '12345', coinRef: pointed.coinRef, ticker: pointed.subject.symbol })
      .catch((error: unknown) => error)
    expect((unauthorised as ApiError).code).toBe('account_not_authorised')

    await operator.authorizeX(AUTH, pointed.coinRef, '12345')
    const wrongTicker = await operator.bindX(AUTH, { accountId: '12345', coinRef: pointed.coinRef, ticker: 'NOPE' }).catch((error: unknown) => error)
    expect((wrongTicker as ApiError).code).toBe('ticker_mismatch')
    const binding = await operator.bindX(AUTH, { accountId: '12345', coinRef: pointed.coinRef, ticker: pointed.subject.symbol })
    expect(binding.vault).toBe(pointed.vault)
  })

  it('records an invoice, echoes its hash, and clears the purchase from the to-do list', async () => {
    const operator = api()
    let before: PurchaseQueue | null = null
    for (const record of await operator.listOnboardings(AUTH, 'active')) {
      const queue = await operator.listPurchases(AUTH, record.vault)
      if (queue.awaitingInvoice.length > 0) {
        before = queue
        break
      }
    }
    // The fixture must have at least one unexecuted procurement, or this page has nothing to demo.
    if (before === null) throw new Error('the fixture has no unexecuted procurement; the purchases page would have nothing to demo')
    const active = { vault: before.vault }
    const item = before.awaitingInvoice[0]!
    const cents = item.quoteCents
    const amountUsd = `${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, '0')}`
    const result = await operator.recordInvoice(AUTH, {
      vault: active.vault,
      vendorId: item.vendorId,
      skuId: item.skuId,
      quantity: item.quantity,
      amountUsd,
      vendorCountersig: '0xbeef',
      issuedAtUnix: NOW - 60,
    })
    expect(result.invoice.amountCents).toBe(cents)
    expect(result.invoice.invoiceHash).toMatch(/^0x[0-9a-f]{64}$/)
    const after = await operator.listPurchases(AUTH, active.vault)
    expect(after.awaitingInvoice.length).toBe(before.awaitingInvoice.length - 1)
    expect(after.pendingInvoices.some((invoice) => invoice.invoiceHash === result.invoice.invoiceHash)).toBe(true)

    const mismatch = await operator
      .recordInvoice(AUTH, {
        vault: active.vault,
        vendorId: item.vendorId,
        skuId: item.skuId,
        quantity: item.quantity,
        amountUsd,
        vendorCountersig: '0xbeef',
        issuedAtUnix: NOW - 60,
        invoiceHash: `0x${'ff'.repeat(32)}`,
      })
      .catch((error: unknown) => error)
    expect((mismatch as ApiError).code).toBe('invoice_hash_mismatch')
  })
})
