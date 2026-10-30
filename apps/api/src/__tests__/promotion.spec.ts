/**
 * The promotion surface through the router: narrative derive/approve, the X
 * account handshake, invoices, creative handoff.
 *
 * The model is a fake at the `derive` seam (the reader plane is the runtime's
 * to test); the fetch is a fake `fetch` under the REAL adapter, so the strip-
 * and-hash path runs. What is asserted is the boundary discipline: refusals
 * for ineligible states and malformed money, the airlock on the stored
 * candidate, and that no token ever appears in a response body.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Consent, ImageAsset, ImageAssetStore } from '@fee-split-vaults/core'
import { InMemoryImageAssetStore } from '@fee-split-vaults/creative'
import { fetchNarrativeSource, type NarrativeSource } from '@fee-split-vaults/adapters'
import { invoiceHashFor } from '@fee-split-vaults/broker'
import { Ledger, InMemoryLedgerStore } from '@fee-split-vaults/ledger'
import { InMemoryInvoiceRegistry, InMemoryPendingPurchaseStore, InMemoryReceiptStore, type PinnedUsdPrice } from '@fee-split-vaults/orchestrator'
import {
  InMemoryAccountCredentialStore,
  InMemoryLabelAttestationStore,
  createInMemoryAccountRegistry,
  type MutableAccountRegistry,
  type XCredentials,
  type XOAuth2Client,
} from '@fee-split-vaults/publisher'
import {
  DEFAULT_LEXICON_SOURCE,
  FakeChainDiligenceProbe,
  FakeIdentityProvider,
  Lexicon,
  SampleSdnSource,
  ScreeningEngine,
  SdnScreener,
} from '@fee-split-vaults/screening'
import type { Asset } from '@fee-split-vaults/core'

import { unwiredAgentPort } from '../agent.js'
import { keccakHex, utf8 } from '../crypto/address.js'
import { draftConsent } from '../consent.js'
import { FakeVaultDeployer, type FactoryDescriptor } from '../deploy.js'
import type { Eip712Domain } from '../eip712.js'
import { serialize } from '../http/json.js'
import type { Method, Response, Router } from '../http/router.js'
import type { NarrativeDeps } from '../promotion.js'
import {
  InMemoryOnboardingStore,
  Onboarding,
  type NarrativeCandidate,
  type OnboardingState,
  type RecipientReader,
} from '../onboarding.js'
import type { RefusalRecord } from '../report.js'
import { buildRouter, type RouteDeps } from '../routes.js'
import { withV1 } from './v1-harness.js'
import { InMemoryKybAttestationStore } from '../diligence/kyb.js'

const NOW = 1_788_652_800
const TOKEN = '0x2222222222222222222222222222222222222222'
const FACTORY: FactoryDescriptor = {
  factory: '0xfac70000000000000000000000000000000000f1',
  deployer: '0xdeb10000000000000000000000000000000000d2',
  vaultInitCodeHash: keccakHex(utf8('CoinVault init code')),
  chainId: 4663,
}
const DOMAIN: Eip712Domain = { chainId: 4663, verifyingContract: FACTORY.factory }
const RECIPIENTS: RecipientReader = {
  creatorFeeRecipient: () => Promise.reject(new Error('not wired')),
  launchedAtUnix: () => Promise.resolve(NOW - 86_400),
  launchTerms: () => Promise.resolve({ buybackEnabled: false, creatorTaxBps: 0 }),
}

const LAUNCH_HTML = '<html><body><script>steal()</script><h1>Alpha</h1><p>A coin about frogs &amp; friends.</p></body></html>'

function fakeFetch(pages: Record<string, string>): typeof fetch {
  return (async (input: string | URL | Request): Promise<globalThis.Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const html = pages[url]
    if (html === undefined) return new globalThis.Response('nope', { status: 404 })
    return new globalThis.Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
  }) as typeof fetch
}

/** Stands in for the reader plane: a closed candidate that names its inputs. */
function fakeDerive(tagline = 'a coin about frogs and friends') {
  return async (sources: readonly NarrativeSource[]): Promise<NarrativeCandidate> => ({
    version: 1,
    tagline,
    themes: ['how_to_buy'],
    tone: 'playful',
    palette: { primary: '#22aa44', secondary: '#113322' },
    sourceHashes: sources.map((s) => s.sha256),
  })
}

function fakeOAuth(exchanged: { code?: string; verifier?: string } = {}): XOAuth2Client {
  return {
    authorizeUrl: (state, challenge, scopes) =>
      `https://x.test/authorize?state=${state}&code_challenge=${challenge}&scope=${scopes.join('%20')}`,
    exchange: async (code, codeVerifier): Promise<XCredentials> => {
      exchanged.code = code
      exchanged.verifier = codeVerifier
      return { accessToken: 'SECRET_ACCESS', refreshToken: 'SECRET_REFRESH', expiresAtUnix: NOW + 7_200, scopes: ['tweet.write'] }
    },
    refresh: async () => {
      throw new Error('not used')
    },
  }
}

interface Harness {
  router: Router
  store: InMemoryOnboardingStore
  onboarding: Onboarding
  credentials: InMemoryAccountCredentialStore
  registry: MutableAccountRegistry
  labels: InMemoryLabelAttestationStore
  invoices: InMemoryInvoiceRegistry
  pending: InMemoryPendingPurchaseStore
  exchanged: { code?: string; verifier?: string }
}

function makeHarness(
  options: { derive?: NarrativeDeps['derive']; images?: ImageAssetStore; unconfigured?: boolean } = {},
): Harness {
  const store = new InMemoryOnboardingStore()
  const onboarding = new Onboarding({
    factory: FACTORY,
    domain: DOMAIN,
    deployer: new FakeVaultDeployer(FACTORY, () => NOW),
    recipients: RECIPIENTS,
    store,
    now: () => NOW,
  })
  const ledgerStore = new InMemoryLedgerStore()
  const credentials = new InMemoryAccountCredentialStore()
  const registry = createInMemoryAccountRegistry()
  const labels = new InMemoryLabelAttestationStore()
  const invoices = new InMemoryInvoiceRegistry()
  const pending = new InMemoryPendingPurchaseStore()
  const exchanged: Harness['exchanged'] = {}
  const fetch = fakeFetch({ 'https://alpha.example/launch': LAUNCH_HTML })

  const promotion: Pick<RouteDeps, 'narrative' | 'accounts' | 'purchases' | 'creative'> = options.unconfigured
    ? {}
    : {
        narrative: {
          fetchSource: (url) => fetchNarrativeSource(url, { fetch, maxBytes: 256_000, timeoutMs: 1_000 }),
          derive: options.derive ?? fakeDerive(),
        },
        accounts: { oauth: fakeOAuth(exchanged), credentials, registry, labels, handshakeTtlSeconds: 600 },
        purchases: { pending, invoices },
        ...(options.images === undefined ? {} : { creative: { images: options.images, fontFiles: [] } }),
      }

  const router = buildRouter(withV1({ onboarding,
  screening: new ScreeningEngine({
    lexicon: new Lexicon([DEFAULT_LEXICON_SOURCE]),
    sdn: new SdnScreener(new SampleSdnSource(NOW)),
    clock: () => NOW,
  }),
  diligence: { probe: new FakeChainDiligenceProbe(), identity: new FakeIdentityProvider() },
  factory: FACTORY,
  domain: DOMAIN,
  ledger: new Ledger(ledgerStore, { now: () => NOW }),
  ledgerStore,
  receipts: new InMemoryReceiptStore(),
  reporting: {
    assetFor: (): Promise<Asset | undefined> => Promise.resolve(undefined),
    priceFor: (): Promise<PinnedUsdPrice | undefined> => Promise.resolve(undefined),
    refusalsFor: (): Promise<RefusalRecord[]> => Promise.resolve([]),
    tierFor: (): Promise<string> => Promise.resolve('T0'),
    paidMediaPermitted: (): Promise<boolean> => Promise.resolve(false),
  },
  agent: unwiredAgentPort('no fleet in this test'),
  kyb: new InMemoryKybAttestationStore(),
  screeningMaxAgeSeconds: 7 * 86_400,
  now: () => NOW,
  ...promotion, }))
  return { router, store, onboarding, credentials, registry, labels, invoices, pending, exchanged }
}

function consent(): Consent {
  return draftConsent({
    devSigner: '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
    devPayout: '0x3333333333333333333333333333333333333333',
    token: TOKEN,
    termsHash: keccakHex(utf8('MSA v1')),
    adapter: '0x8888888888888888888888888888888888888888',
    nonce: keccakHex(utf8('n1')),
    nowUnix: NOW,
  })
}

/** A drafted coin moved to `state` directly; the machine's transitions have their own tests. */
async function seedCoin(h: Harness, state: OnboardingState, narrativeSources = ['https://alpha.example/launch']) {
  const record = await h.onboarding.draft({
    id: 'ob_1',
    consent: consent(),
    coinRef: 'coin_alpha',
    token: TOKEN,
    name: 'Alpha Coin',
    symbol: 'ALPHA',
    narrativeSources,
    socials: { x: 'alpha_coin' },
  })
  record.state = state
  return record
}

async function call(h: Harness, method: Method, path: string, body?: unknown, query: Record<string, string> = {}) {
  const response: Response = await h.router.handle({ method, path, query, body, headers: {} })
  return { status: response.status, body: response.body as Record<string, unknown>, headers: response.headers }
}

// ---------------------------------------------------------------------------

describe('narrative', () => {
  it('derives from the fetched sources, stores a candidate, and only approval makes a profile', async () => {
    const h = makeHarness()
    await seedCoin(h, 'pointed')

    const derived = await call(h, 'POST', '/onboarding/ob_1/narrative/derive')
    expect(derived.status).toBe(200)
    const narrative = derived.body.narrative as { candidate: NarrativeCandidate; approved: unknown }
    expect(narrative.approved).toBeUndefined()
    expect(narrative.candidate.sourceHashes).toEqual([
      createHash('sha256').update(LAUNCH_HTML, 'utf8').digest('hex'),
    ])
    // Not yet a narrative as far as anything downstream is concerned.
    expect((await h.store.get('ob_1'))?.narrative).toBeUndefined()

    const approved = await call(h, 'POST', '/onboarding/ob_1/narrative/approve', { approvedBy: 'op.alice' })
    expect(approved.status).toBe(200)
    const stored = (await h.store.get('ob_1'))?.narrative
    expect(stored?.approvedBy).toBe('op.alice')
    expect(stored?.approvedAtUnix).toBe(NOW)
    expect(stored?.tagline).toBe('a coin about frogs and friends')

    const read = await call(h, 'GET', '/onboarding/ob_1/narrative')
    expect((read.body.narrative as { approved: unknown }).approved).toEqual(stored)
    // The public record says it exists and nothing more.
    const pub = await call(h, 'GET', '/onboarding/ob_1')
    expect((pub.body.onboarding as Record<string, unknown>).narrativeApproved).toBe(true)
    expect(serialize(pub.body)).not.toContain('alpha_coin')
    expect(serialize(pub.body)).not.toContain('alpha.example')
  })

  it('refuses to derive before the coin has pointed at the vault', async () => {
    const h = makeHarness()
    await seedCoin(h, 'screened')
    const result = await call(h, 'POST', '/onboarding/ob_1/narrative/derive')
    expect(result.status).toBe(409)
    expect(result.body.error).toBe('narrative_not_eligible')
  })

  it('refuses a candidate whose tagline carries a destination, and stores nothing', async () => {
    const h = makeHarness({ derive: fakeDerive('buy at 0x1234567890abcdef1234567890abcdef12345678 now') })
    await seedCoin(h, 'active')
    const result = await call(h, 'POST', '/onboarding/ob_1/narrative/derive')
    expect(result.status).toBe(400)
    expect(result.body.error).toBe('narrative_invalid')
    expect((await h.store.get('ob_1'))?.narrativeCandidate).toBeUndefined()
  })

  it('refuses to approve when there is no candidate', async () => {
    const h = makeHarness()
    await seedCoin(h, 'active')
    const result = await call(h, 'POST', '/onboarding/ob_1/narrative/approve', { approvedBy: 'op.alice' })
    expect(result.status).toBe(400)
    expect(result.body.error).toBe('narrative_candidate_missing')
  })

  it('reports an unreadable source by code, not by URL', async () => {
    const h = makeHarness()
    await seedCoin(h, 'pointed', ['https://alpha.example/missing'])
    const result = await call(h, 'POST', '/onboarding/ob_1/narrative/derive')
    expect(result.status).toBe(400)
    expect(result.body.error).toBe('narrative_source_unavailable')
    expect(serialize(result.body)).not.toContain('alpha.example')
  })

  it('answers 503 feature_unconfigured when no model is wired', async () => {
    const h = makeHarness({ unconfigured: true })
    await seedCoin(h, 'pointed')
    const result = await call(h, 'POST', '/onboarding/ob_1/narrative/derive')
    expect(result.status).toBe(503)
    expect(result.body.error).toBe('feature_unconfigured')
  })
})

describe('onboarding intake with narrative sources and socials', () => {
  const body = {
    id: 'ob_9',
    coinRef: 'coin_nine',
    token: '0x9999999999999999999999999999999999999999',
    name: 'Nine',
    symbol: 'NINE',
    devSigner: '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
    devPayout: '0x3333333333333333333333333333333333333333',
    termsHash: keccakHex(utf8('MSA v1')),
    adapter: '0x8888888888888888888888888888888888888888',
    nonce: keccakHex(utf8('n9')),
  }

  it('stores validated sources and the handle, and keeps the handle off the public record', async () => {
    const h = makeHarness()
    const result = await call(h, 'POST', '/onboarding', {
      ...body,
      narrativeSources: ['https://nine.example/launch', 'https://nine.example/launch'],
      socials: { x: '@nine_coin' },
    })
    expect(result.status).toBe(201)
    const stored = await h.store.get('ob_9')
    expect(stored?.narrativeSources).toEqual(['https://nine.example/launch'])
    expect(stored?.socials).toEqual({ x: 'nine_coin' })
    expect(stored?.name).toBe('Nine')
    expect(serialize(result.body)).not.toContain('nine_coin')
  })

  it.each([
    ['http://nine.example/'],
    ['https://user@nine.example/'],
    ['https://nine.example:8443/'],
    ['https://10.0.0.1/'],
    ['https://xn--nine.example/'],
  ])('refuses a narrative source %s', async (url) => {
    const h = makeHarness()
    const result = await call(h, 'POST', '/onboarding', { ...body, narrativeSources: [url] })
    expect(result.status).toBe(400)
    expect(result.body.error).toBe('bad_narrative_source')
  })

  it('refuses more than four sources and a malformed handle', async () => {
    const h = makeHarness()
    const many = await call(h, 'POST', '/onboarding', {
      ...body,
      narrativeSources: [1, 2, 3, 4, 5].map((i) => `https://nine.example/${String(i)}`),
    })
    expect(many.status).toBe(400)
    const handle = await call(h, 'POST', '/onboarding', { ...body, socials: { x: 'has space' } })
    expect(handle.status).toBe(400)
    expect(handle.body.error).toBe('bad_x_handle')
  })
})

describe('X accounts', () => {
  it('authorize then callback stores the credential and returns no token', async () => {
    const h = makeHarness()
    await seedCoin(h, 'active')

    const auth = await call(h, 'GET', '/accounts/x/authorize', undefined, { coinRef: 'coin_alpha', accountId: '12345' })
    expect(auth.status).toBe(200)
    const url = new URL(auth.body.url as string)
    const state = url.searchParams.get('state')
    expect(state).toBe(auth.body.state)
    expect(url.searchParams.get('scope')).toContain('offline.access')
    const challenge = url.searchParams.get('code_challenge')

    const cb = await call(h, 'GET', '/accounts/x/callback', undefined, { code: 'the-code', state: state! })
    expect(cb.status).toBe(200)
    expect(cb.body.accountId).toBe('12345')
    expect(serialize(cb.body)).not.toContain('SECRET')
    expect(h.exchanged.code).toBe('the-code')
    // PKCE: the challenge X saw is the hash of the verifier we redeemed with.
    const expected = createHash('sha256').update(h.exchanged.verifier!, 'ascii').digest('base64url')
    expect(challenge).toBe(expected)
    expect((await h.credentials.get('12345'))?.accessToken).toBe('SECRET_ACCESS')

    // A state is single use.
    const replay = await call(h, 'GET', '/accounts/x/callback', undefined, { code: 'the-code', state: state! })
    expect(replay.status).toBe(404)
  })

  it('refuses to bind an account with no credential, then binds with the coin symbol', async () => {
    const h = makeHarness()
    await seedCoin(h, 'active')
    const refused = await call(h, 'POST', '/accounts/x/bind', { accountId: '12345', coinRef: 'coin_alpha', ticker: 'ALPHA' })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe('account_not_authorised')

    await h.credentials.put('12345', { accessToken: 't', refreshToken: null, expiresAtUnix: NOW + 10, scopes: [] })
    const wrongTicker = await call(h, 'POST', '/accounts/x/bind', { accountId: '12345', coinRef: 'coin_alpha', ticker: 'BETA' })
    expect(wrongTicker.body.error).toBe('ticker_mismatch')

    const bound = await call(h, 'POST', '/accounts/x/bind', { accountId: '12345', coinRef: 'coin_alpha', ticker: 'alpha' })
    expect(bound.status).toBe(201)
    const binding = await h.registry.get('x_operator', '12345')
    expect(binding?.coinRef).toBe('coin_alpha')
    expect(binding?.token).toBe(TOKEN)
    expect(binding?.delegated).toBe(false)
  })

  it('records a label attestation that lapses after the given days', async () => {
    const h = makeHarness()
    const result = await call(h, 'POST', '/accounts/x/attest-label', { accountId: '12345', attestedBy: 'op.bob', days: 30 })
    expect(result.status).toBe(201)
    expect(await h.labels.get('12345')).toEqual({
      accountId: '12345',
      attestedBy: 'op.bob',
      attestedAtUnix: NOW,
      expiresAtUnix: NOW + 30 * 86_400,
    })
    const tooLong = await call(h, 'POST', '/accounts/x/attest-label', { accountId: '12345', attestedBy: 'op.bob', days: 400 })
    expect(tooLong.status).toBe(400)
  })

  it('answers 503 feature_unconfigured without an X application', async () => {
    const h = makeHarness({ unconfigured: true })
    const result = await call(h, 'GET', '/accounts/x/authorize', undefined, { coinRef: 'coin_alpha', accountId: '1' })
    expect(result.status).toBe(503)
    expect(result.body.error).toBe('feature_unconfigured')
  })
})

describe('purchases and invoices', () => {
  const VAULT = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
  const invoice = {
    vault: VAULT,
    vendorId: 'vendor_a',
    skuId: 'sku_listing',
    quantity: 1,
    amountUsd: '299.00',
    vendorCountersig: '0xdeadbeef',
    issuedAtUnix: NOW - 60,
  }

  it('refuses a float amount', async () => {
    const h = makeHarness()
    const result = await call(h, 'POST', '/invoices', { ...invoice, amountUsd: 299 })
    expect(result.status).toBe(400)
    expect(result.body.error).toBe('amount_not_decimal_string')
    const threeDecimals = await call(h, 'POST', '/invoices', { ...invoice, amountUsd: '299.001' })
    expect(threeDecimals.body.error).toBe('bad_amount')
  })

  it('refuses a supplied hash that is not the hash of the invoice', async () => {
    const h = makeHarness()
    const result = await call(h, 'POST', '/invoices', { ...invoice, invoiceHash: `0x${'00'.repeat(32)}` })
    expect(result.status).toBe(400)
    expect(result.body.error).toBe('invoice_hash_mismatch')
    expect(await h.invoices.listPending(VAULT)).toEqual([])
  })

  it('records the invoice under the broker hash, lists it as pending, and clears the purchase it evidences', async () => {
    const h = makeHarness()
    await h.pending.record({ vault: VAULT, vendorId: 'vendor_a', skuId: 'sku_listing', quantity: 1, quoteCents: 29_900n, proposedAtUnix: NOW - 600 })
    await h.pending.record({ vault: VAULT, vendorId: 'vendor_a', skuId: 'sku_listing', quantity: 3, quoteCents: 89_700n, proposedAtUnix: NOW - 300 })
    const expectedHash = invoiceHashFor({ vendorId: 'vendor_a', skuId: 'sku_listing', quantity: 1, amountUsd: 299, issuedAtUnix: NOW - 60 })

    const before = await call(h, 'GET', '/purchases', undefined, { vault: VAULT })
    expect(before.body.awaitingInvoice).toEqual([
      { vendorId: 'vendor_a', skuId: 'sku_listing', quantity: 1, quoteUsdCents: '29900', proposedAtUnix: NOW - 600 },
      { vendorId: 'vendor_a', skuId: 'sku_listing', quantity: 3, quoteUsdCents: '89700', proposedAtUnix: NOW - 300 },
    ])

    const result = await call(h, 'POST', '/invoices', { ...invoice, invoiceHash: expectedHash.toUpperCase().replace('0X', '0x') })
    expect(result.status).toBe(201)
    expect((result.body.invoice as { invoiceHash: string }).invoiceHash).toBe(expectedHash)
    expect(expectedHash).toMatch(/^0x[0-9a-f]{64}$/)

    // Only the (sku, quantity) the invoice evidences leaves the to-do list.
    const listed = await call(h, 'GET', '/purchases', undefined, { vault: VAULT })
    expect(listed.status).toBe(200)
    expect(listed.body.awaitingInvoice).toEqual([
      { vendorId: 'vendor_a', skuId: 'sku_listing', quantity: 3, quoteUsdCents: '89700', proposedAtUnix: NOW - 300 },
    ])
    expect((listed.body.pendingInvoices as unknown[]).length).toBe(1)
    expect(serialize(listed.body)).not.toContain('deadbeef')

    const duplicate = await call(h, 'POST', '/invoices', invoice)
    expect(duplicate.status).toBe(409)
  })

  it('refuses an invoice dated in the future', async () => {
    const h = makeHarness()
    const result = await call(h, 'POST', '/invoices', { ...invoice, issuedAtUnix: NOW + 3_600 })
    expect(result.status).toBe(400)
  })
})

describe('creative', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  const sha = createHash('sha256').update(PNG).digest('hex')
  const asset: ImageAsset = {
    id: `coin_alpha:banner:${sha.slice(0, 16)}`,
    coinRef: 'coin_alpha',
    kind: 'banner',
    mime: 'image/png',
    width: 1500,
    height: 500,
    sha256: sha,
    bytes: PNG,
  }

  async function storeWith(...assets: ImageAsset[]): Promise<InMemoryImageAssetStore> {
    const images = new InMemoryImageAssetStore()
    for (const a of assets) await images.put(a)
    return images
  }

  it('serves the rendered PNG bytes with an image content type', async () => {
    const h = makeHarness({ images: await storeWith(asset) })
    await seedCoin(h, 'active')
    const response = await h.router.handle({ method: 'GET', path: '/onboarding/ob_1/creative/banner', query: {}, body: undefined, headers: {} })
    expect(response.status).toBe(200)
    expect(response.body).toBe(PNG)
    expect(response.headers?.['content-type']).toBe('image/png')
    expect(response.headers?.etag).toBe(`"${sha}"`)
  })

  it('404s a kind that was not rendered and 400s a kind that does not exist', async () => {
    const h = makeHarness({ images: await storeWith(asset) })
    await seedCoin(h, 'active')
    const missing = await call(h, 'GET', '/onboarding/ob_1/creative/avatar')
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('creative_not_rendered')
    const bogus = await call(h, 'GET', '/onboarding/ob_1/creative/poster')
    expect(bogus.status).toBe(400)
  })

  it('approving a narrative renders the three assets from it into the store', async () => {
    const images = new InMemoryImageAssetStore()
    const h = makeHarness({ images })
    await seedCoin(h, 'pointed')
    await call(h, 'POST', '/onboarding/ob_1/narrative/derive')

    const approved = await call(h, 'POST', '/onboarding/ob_1/narrative/approve', { approvedBy: 'op.alice' })
    expect(approved.status).toBe(200)
    const rendered = (approved.body.creative as { assets: Array<{ kind: string }> }).assets.map((a) => a.kind).sort()
    expect(rendered).toEqual(['avatar', 'banner', 'card'])

    const refs = await images.list('coin_alpha')
    expect(refs.map((r) => r.kind).sort()).toEqual(['avatar', 'banner', 'card'])
    const banner = await call(h, 'GET', '/onboarding/ob_1/creative/banner')
    expect(banner.status).toBe(200)
    expect((banner.body as unknown as Uint8Array).subarray(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  })

  it('renders on demand without a narrative for an eligible coin, and refuses an ineligible one', async () => {
    const images = new InMemoryImageAssetStore()
    const h = makeHarness({ images })
    await seedCoin(h, 'screened')
    const early = await call(h, 'POST', '/onboarding/ob_1/creative/render')
    expect(early.status).toBe(409)
    expect(early.body.error).toBe('creative_not_eligible')
    expect(await images.list('coin_alpha')).toEqual([])

    const record = await h.store.get('ob_1')
    if (record === undefined) throw new Error('fixture')
    record.state = 'pointed'
    const rendered = await call(h, 'POST', '/onboarding/ob_1/creative/render')
    expect(rendered.status).toBe(200)
    expect((rendered.body.creative as { narrative: boolean }).narrative).toBe(false)
    expect((await images.list('coin_alpha')).length).toBe(3)
  })

  it('answers 503 for every creative route when no image store is configured', async () => {
    const h = makeHarness()
    await seedCoin(h, 'active')
    const render = await call(h, 'POST', '/onboarding/ob_1/creative/render')
    expect(render.status).toBe(503)
    expect(render.body.error).toBe('feature_unconfigured')
    expect((await call(h, 'GET', '/onboarding/ob_1/creative/banner')).status).toBe(503)
  })
})
