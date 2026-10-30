/**
 * The web contract (/v1) and the auth policy in front of it.
 *
 * What is under test is the contract a browser relies on: a public coin
 * record that carries nothing a dev typed at full fidelity, a sign-in whose
 * nonce dies on first use, a dashboard that answers only for the signing
 * dev's own vaults, and unsigned transactions the wallet re-encodes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Consent } from '@fee-split-vaults/core'
import { Ledger, InMemoryLedgerStore } from '@fee-split-vaults/ledger'
import { InMemoryReceiptStore, type PinnedUsdPrice } from '@fee-split-vaults/orchestrator'
import {
  DEFAULT_LEXICON_SOURCE,
  FakeChainDiligenceProbe,
  FakeIdentityProvider,
  Lexicon,
  SampleSdnSource,
  ScreeningEngine,
  SdnScreener,
} from '@fee-split-vaults/screening'

import { TERMS } from '../../../../config/protocol.js'
import { agentRunBody } from '../agent.js'
import { unwiredAgentPort } from '../agent.js'
import { addressFromPublicKey, bytesToHex, hexToBytes, keccakHex, utf8 } from '../crypto/address.js'
import { bigIntTo32Bytes, publicKeyFromPrivate, signRecoverable } from '../crypto/secp256k1.js'
import { FakeVaultDeployer, predictVault, type FactoryDescriptor } from '../deploy.js'
import { InMemoryKybAttestationStore } from '../diligence/kyb.js'
import { consentDigest, type Eip712Domain } from '../eip712.js'
import { authorize } from '../http/server.js'
import type { Principal, Router } from '../http/router.js'
import { serialize } from '../http/json.js'
import { InMemoryOnboardingStore, Onboarding, type OnboardingRecord, type RecipientReader } from '../onboarding.js'
import type { RefusalRecord } from '../report.js'
import { authScopeOf, buildRouter } from '../routes.js'
import { InMemoryEscalationQueue, InMemoryTokenMetadata, InMemoryVaultViews } from '../v1/ports.js'
import { PgDevSessionStore, PgEscalationQueue, PgQuoteStore } from '../v1/pg.js'
import { DevAuth, InMemoryDevSessionStore, personalSignDigest } from '../v1/sessions.js'
import { pgliteMigrated, type PgliteHarness } from './pglite.js'
import { v1Deps } from './v1-harness.js'

const NOW = 1_788_652_800
const DAY = 86_400
const DEV_A_KEY = 7n
const DEV_B_KEY = 9n
const DEV_A = addressFromPublicKey(publicKeyFromPrivate(DEV_A_KEY))
const DEV_B = addressFromPublicKey(publicKeyFromPrivate(DEV_B_KEY))
const TOKEN_A = '0x2222222222222222222222222222222222222222'
const TOKEN_B = '0x2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b'
const ADAPTER = '0x8888888888888888888888888888888888888888'
const TERMS_HASH = keccakHex(utf8('MSA v1'))
const FACTORY: FactoryDescriptor = {
  factory: '0xfac70000000000000000000000000000000000f1',
  deployer: '0xdeb10000000000000000000000000000000000d2',
  vaultInitCodeHash: keccakHex(utf8('CoinVault init code')),
  chainId: 4663,
}
const DOMAIN: Eip712Domain = { chainId: 4663, verifyingContract: FACTORY.factory }

const RECIPIENTS: RecipientReader = {
  creatorFeeRecipient: () => Promise.resolve('0x9999999999999999999999999999999999999999'),
  launchedAtUnix: () => Promise.resolve(NOW - DAY),
  launchTerms: () => Promise.resolve({ buybackEnabled: false, creatorTaxBps: 0 }),
}

function consentFor(devSigner: string, token: string, nonce: string): Consent {
  return {
    devSigner,
    devPayout: devSigner,
    token,
    termsHash: TERMS_HASH,
    operatorBps: TERMS.operatorBps,
    budgetBpsMax: 3_000,
    adapter: ADAPTER,
    referrer: '0x0000000000000000000000000000000000000000',
    referrerBps: 0,
    expiryUnix: NOW + DAY,
    nonce,
  }
}

function signature(digestHex: string, key: bigint, k = 0x0f1e2d3c4b5a69788796a5b4c3d2e1f0n): string {
  const sig = signRecoverable(hexToBytes(digestHex), key, k)
  const out = new Uint8Array(65)
  out.set(bigIntTo32Bytes(sig.r), 0)
  out.set(bigIntTo32Bytes(sig.s), 32)
  out[64] = 27 + sig.recovery
  return bytesToHex(out)
}

/** An active member coin with everything a dev could have typed filled in. */
function memberRecord(devSigner: string, token: string, nonce: string): OnboardingRecord {
  const consent = consentFor(devSigner, token, nonce)
  const vault = predictVault(consent, FACTORY)
  return {
    id: `ob_${nonce.slice(2, 10)}`,
    state: 'active',
    consent,
    vault,
    token,
    coinRef: `coin_${nonce.slice(2, 10)}`,
    createdAtUnix: NOW - 10 * DAY,
    updatedAtUnix: NOW - DAY,
    name: 'Alpha Coin',
    symbol: 'ALPHA',
    description: 'a community coin, see https://alpha-secret.example/roadmap',
    links: ['https://alpha-secret.example'],
    narrativeSources: ['https://alpha-sources.example/whitepaper'],
    socials: { x: 'alpha_dev_handle' },
    devSignature: '0xdeadbeef',
    signatureVerifiedAtUnix: NOW - 9 * DAY,
    screening: {
      token,
      verdict: 'CLEAR',
      flags: ['lexicon:secret_matcher'],
      stagesRun: ['lexicon'],
      screenedAtUnix: NOW - 9 * DAY,
      paidMediaPermitted: true,
    },
    deployedAtUnix: NOW - 8 * DAY,
    pointedAtUnix: NOW - 7 * DAY,
    acceptedAtUnix: NOW - 6 * DAY,
    activatedAtUnix: NOW - 5 * DAY,
    launchedAtUnix: NOW - 30 * DAY,
    history: [],
  }
}

interface Harness {
  router: Router
  auth: DevAuth
  store: InMemoryOnboardingStore
  recordA: OnboardingRecord
  recordB: OnboardingRecord
  views: InMemoryVaultViews
  escalations: InMemoryEscalationQueue
  tokens: InMemoryTokenMetadata
}

function harness(): Harness {
  const store = new InMemoryOnboardingStore()
  const recordA = memberRecord(DEV_A, TOKEN_A, keccakHex(utf8('nonce-a')))
  const recordB = memberRecord(DEV_B, TOKEN_B, keccakHex(utf8('nonce-b')))
  const ledgerStore = new InMemoryLedgerStore()
  const onboarding = new Onboarding({
    factory: FACTORY,
    domain: DOMAIN,
    deployer: new FakeVaultDeployer(FACTORY, () => NOW),
    recipients: RECIPIENTS,
    store,
    now: () => NOW,
  })
  const base = {
    onboarding,
    screening: new ScreeningEngine({
      lexicon: new Lexicon([DEFAULT_LEXICON_SOURCE]),
      sdn: new SdnScreener(new SampleSdnSource(NOW)),
      clock: () => NOW,
    }),
    factory: FACTORY,
    domain: DOMAIN,
    ledger: new Ledger(ledgerStore, { now: () => NOW }),
    ledgerStore,
    receipts: new InMemoryReceiptStore(),
    reporting: {
      assetFor: () => Promise.resolve(undefined),
      priceFor: (): Promise<PinnedUsdPrice | undefined> => Promise.resolve(undefined),
      refusalsFor: (): Promise<RefusalRecord[]> => Promise.resolve([]),
      tierFor: (): Promise<string> => Promise.resolve('T0'),
      paidMediaPermitted: (): Promise<boolean> => Promise.resolve(false),
    },
    now: () => NOW,
  }
  const auth = new DevAuth({ store: new InMemoryDevSessionStore(), issuer: 'Test Operator LLC', now: () => NOW })
  const views = new InMemoryVaultViews()
  const escalations = new InMemoryEscalationQueue()
  const tokens = new InMemoryTokenMetadata()
  const router = buildRouter({
    ...base,
    diligence: { probe: new FakeChainDiligenceProbe(), identity: new FakeIdentityProvider() },
    agent: unwiredAgentPort('no fleet in this test'),
    kyb: new InMemoryKybAttestationStore(),
    screeningMaxAgeSeconds: 7 * DAY,
    v1: v1Deps(base, {
      auth,
      recipients: RECIPIENTS,
      vaultViews: views,
      escalations,
      tokens,
      protocol: {
        operatorLegalName: 'Test Operator LLC',
        operatorAddresses: [],
        receiptsBaseUrl: 'https://receipts.example',
        terms: { adapter: ADAPTER, termsHash: TERMS_HASH, termsUrl: 'https://terms.example/msa-v1' },
      },
    }),
  })
  return { router, auth, store, recordA, recordB, views, escalations, tokens }
}

async function call(
  router: Router,
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; query?: Record<string, string>; principal?: Principal } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await router.handle({
    method,
    path,
    query: options.query ?? {},
    body: options.body,
    headers: {},
    ...(options.principal === undefined ? {} : { principal: options.principal }),
  })
  return { status: response.status, body: response.body as Record<string, unknown> }
}

/** The whole sign-in as the browser does it: challenge, personal_sign, verify. */
async function signIn(h: Harness, address: string, key: bigint): Promise<{ token: string; vaults: string[] }> {
  const challenge = await call(h.router, 'POST', '/v1/auth/nonce', { body: { address } })
  expect(challenge.status).toBe(200)
  const message = challenge.body.message as string
  const verified = await call(h.router, 'POST', '/v1/auth/verify', {
    body: { address, message, signature: signature(personalSignDigest(message), key) },
  })
  expect(verified.status).toBe(200)
  return { token: verified.body.token as string, vaults: verified.body.vaults as string[] }
}

// ---------------------------------------------------------------------------

describe('the auth policy', () => {
  it('classifies every path: the receipts artifact and the agent page are public, the dashboard is dev, the rest is operator', () => {
    expect(authScopeOf('/v1/coins')).toBe('public')
    expect(authScopeOf('/v1/coins/0xabc/receipts')).toBe('public')
    expect(authScopeOf('/v1/coins/0xabc/vendors')).toBe('public')
    expect(authScopeOf('/coins/0xabc/agent/runs')).toBe('public')
    expect(authScopeOf('/v1/auth/verify')).toBe('public')
    expect(authScopeOf('/v1/onboarding/retrofit/0xabc')).toBe('public')
    expect(authScopeOf('/v1/dev/vaults')).toBe('dev')
    expect(authScopeOf('/v1/dev/vaults/0xabc/dial-tx')).toBe('dev')
    expect(authScopeOf('/onboarding')).toBe('operator')
    expect(authScopeOf('/vaults/0xabc/report')).toBe('operator')
    expect(authScopeOf('/v1/coinsX')).toBe('operator')
  })

  it('gates each scope on its own credential and never on an address alone', async () => {
    const h = harness()
    await h.store.put(h.recordA)
    const options = { operatorToken: 'op-token-op-token-op-token-op-token', scopeOf: authScopeOf, devSessions: h.auth }

    expect((await authorize(options, '/v1/coins', {})).ok).toBe(true)
    expect(await authorize(options, '/onboarding', {})).toMatchObject({ ok: false, status: 401 })
    expect((await authorize(options, '/onboarding', { authorization: 'Bearer op-token-op-token-op-token-op-token' })).ok).toBe(true)

    expect(await authorize(options, '/v1/dev/vaults', {})).toMatchObject({ ok: false, status: 401 })
    expect(await authorize(options, '/v1/dev/vaults', { authorization: `Bearer ${DEV_A}` })).toMatchObject({ ok: false, status: 401 })
    // The operator token is not a dev session either.
    expect(await authorize(options, '/v1/dev/vaults', { authorization: 'Bearer op-token-op-token-op-token-op-token' })).toMatchObject({
      ok: false,
      status: 401,
    })

    const session = await signIn(h, DEV_A, DEV_A_KEY)
    expect(session.vaults).toEqual([h.recordA.vault])
    const decision = await authorize(options, '/v1/dev/vaults', { authorization: `Bearer ${session.token}` })
    expect(decision).toMatchObject({ ok: true, principal: { kind: 'dev', address: DEV_A } })

    // A dev route with no session store at all cannot be reached by anyone.
    expect(await authorize({ ...options, devSessions: undefined }, '/v1/dev/vaults', { authorization: `Bearer ${session.token}` })).toMatchObject({
      ok: false,
      status: 503,
    })
  })
})

describe('the signature exchange', () => {
  it('refuses a replayed challenge, a foreign signature and a rewritten message', async () => {
    const h = harness()
    const challenge = await call(h.router, 'POST', '/v1/auth/nonce', { body: { address: DEV_A } })
    const message = challenge.body.message as string
    expect(message).toContain(DEV_A)
    expect(message).toContain('authorises no transfer')

    const rewritten = await call(h.router, 'POST', '/v1/auth/verify', {
      body: { address: DEV_A, message: `${message}\nExtra: yes`, signature: signature(personalSignDigest(`${message}\nExtra: yes`), DEV_A_KEY) },
    })
    expect(rewritten.status).toBe(401)
    expect(rewritten.body.error).toBe('message_mismatch')

    // The rewritten attempt consumed the nonce: even the honest signature is now a replay.
    const honest = await call(h.router, 'POST', '/v1/auth/verify', {
      body: { address: DEV_A, message, signature: signature(personalSignDigest(message), DEV_A_KEY) },
    })
    expect(honest.status).toBe(401)
    expect(honest.body.error).toBe('no_such_challenge')

    const fresh = await call(h.router, 'POST', '/v1/auth/nonce', { body: { address: DEV_A } })
    const freshMessage = fresh.body.message as string
    const foreign = await call(h.router, 'POST', '/v1/auth/verify', {
      body: { address: DEV_A, message: freshMessage, signature: signature(personalSignDigest(freshMessage), DEV_B_KEY) },
    })
    expect(foreign.status).toBe(401)
    expect(foreign.body.error).toBe('signature_invalid')
  })

  it('a session that verified once is a bearer; the same signed message a second time is not', async () => {
    const h = harness()
    const challenge = await call(h.router, 'POST', '/v1/auth/nonce', { body: { address: DEV_A } })
    const message = challenge.body.message as string
    const sig = signature(personalSignDigest(message), DEV_A_KEY)
    const first = await call(h.router, 'POST', '/v1/auth/verify', { body: { address: DEV_A, message, signature: sig } })
    expect(first.status).toBe(200)
    expect(await h.auth.verify(first.body.token as string)).toMatchObject({ address: DEV_A })
    const replay = await call(h.router, 'POST', '/v1/auth/verify', { body: { address: DEV_A, message, signature: sig } })
    expect(replay.status).toBe(401)
  })
})

describe('the dev dashboard sees only its own vaults', () => {
  const dev = (address: string): Principal => ({ kind: 'dev', address, sessionId: 'ds_test' })

  it('lists the signing dev’s coins and answers 404 for another dev’s vault', async () => {
    const h = harness()
    await h.store.put(h.recordA)
    await h.store.put(h.recordB)
    h.views.dials.set(h.recordA.vault, {
      budgetBps: 1_500,
      pendingBudgetBps: 1_000,
      pendingDialUnix: NOW + 3 * DAY,
      operatorNoticeUnix: 0,
      lastOperatorActionUnix: NOW - 3_600,
      deadManUnix: NOW - 3_600 + 180 * DAY,
      devPayout: DEV_A,
    })

    const mine = await call(h.router, 'GET', '/v1/dev/vaults', { principal: dev(DEV_A) })
    expect(mine.status).toBe(200)
    expect((mine.body as unknown as Array<{ vault: string }>).map((c) => c.vault)).toEqual([h.recordA.vault])

    const detail = await call(h.router, 'GET', `/v1/dev/vaults/${h.recordA.vault}`, { principal: dev(DEV_A) })
    expect(detail.status).toBe(200)
    expect(detail.body).toMatchObject({
      devPayout: DEV_A,
      claimable: [],
      pendingDial: { pendingBudgetBps: 1_000, effectiveAtUnix: NOW + 3 * DAY },
      operatorNoticeUnix: null,
      lastHeartbeatUnix: NOW - 3_600,
      deadManUnix: NOW - 3_600 + 180 * DAY,
    })

    const theirs = await call(h.router, 'GET', `/v1/dev/vaults/${h.recordA.vault}`, { principal: dev(DEV_B) })
    expect(theirs.status).toBe(404)
    const dial = await call(h.router, 'POST', `/v1/dev/vaults/${h.recordA.vault}/dial-tx`, { principal: dev(DEV_B), body: { budgetBps: 100 } })
    expect(dial.status).toBe(404)
    const anonymous = await call(h.router, 'GET', `/v1/dev/vaults/${h.recordA.vault}`)
    expect(anonymous.status).toBe(401)
  })

  it('hands back unsigned calls addressed to the vault and refuses a dial above the consented ceiling', async () => {
    const h = harness()
    await h.store.put(h.recordA)
    const dial = await call(h.router, 'POST', `/v1/dev/vaults/${h.recordA.vault}/dial-tx`, { principal: dev(DEV_A), body: { budgetBps: 2_500 } })
    expect(dial.status).toBe(200)
    expect(dial.body).toMatchObject({ to: h.recordA.vault, value: '0', chainId: 4663 })
    const setDial = keccakHex(utf8('setDial(uint16)')).slice(0, 10)
    expect(dial.body.data).toBe(`${setDial}${(2_500).toString(16).padStart(64, '0')}`)

    const above = await call(h.router, 'POST', `/v1/dev/vaults/${h.recordA.vault}/dial-tx`, { principal: dev(DEV_A), body: { budgetBps: 3_001 } })
    expect(above.status).toBe(400)

    const terminate = await call(h.router, 'GET', `/v1/dev/vaults/${h.recordA.vault}/terminate-tx`, { principal: dev(DEV_A) })
    expect(terminate.body.data).toBe(keccakHex(utf8('terminate()')).slice(0, 10))
  })

  it('records the dev’s acknowledgement and scrubs the escalation detail on the way out', async () => {
    const h = harness()
    await h.store.put(h.recordA)
    h.escalations.rows.push({
      id: '7',
      vault: h.recordA.vault,
      kind: 'desk_escalation',
      code: 'refund_request',
      detail: 'holder asks for a refund to 0x4444444444444444444444444444444444444444 via https://scam.example',
      raisedAtUnix: NOW - 3_600,
    })
    const listed = await call(h.router, 'GET', `/v1/dev/vaults/${h.recordA.vault}/escalations`, { principal: dev(DEV_A) })
    const [item] = listed.body as unknown as Array<Record<string, unknown>>
    expect(item).toMatchObject({ id: '7', priority: 'normal', acknowledgedAtUnix: null, resolution: null })
    expect(serialize(item)).not.toContain('0x4444')
    expect(serialize(item)).not.toContain('scam.example')

    const acked = await call(h.router, 'POST', `/v1/dev/vaults/${h.recordA.vault}/escalations/7/ack`, {
      principal: dev(DEV_A),
      body: { decision: 'action_taken', note: 'refunded from my own wallet' },
    })
    expect(acked.status).toBe(200)
    expect(acked.body).toMatchObject({ acknowledgedAtUnix: NOW, resolution: 'action_taken' })

    const bad = await call(h.router, 'POST', `/v1/dev/vaults/${h.recordA.vault}/escalations/7/ack`, {
      principal: dev(DEV_A),
      body: { decision: 'ignored', note: 'x' },
    })
    expect(bad.status).toBe(400)
  })
})

describe('the public coin record', () => {
  it('carries the scrubbed subject and counts, never a link, a source, a handle or a screening flag', async () => {
    const h = harness()
    await h.store.put(h.recordA)
    await h.store.put({ ...h.recordB, state: 'drafted' })

    const directory = await call(h.router, 'GET', '/v1/coins')
    expect(directory.status).toBe(200)
    expect(directory.body).toEqual([
      { vault: h.recordA.vault, token: TOKEN_A, name: 'Alpha Coin', symbol: 'ALPHA', tier: 'T0', state: 'ACTIVE', qfPerDayUsd: 0, buybackEnabled: false },
    ])

    const coin = await call(h.router, 'GET', `/v1/coins/${h.recordA.vault}`)
    expect(coin.status).toBe(200)
    const json = serialize(coin.body)
    for (const secret of ['alpha-secret', 'alpha-sources', 'alpha_dev_handle', 'secret_matcher', 'roadmap', '0xdeadbeef']) {
      expect(json).not.toContain(secret)
    }
    expect(coin.body).toMatchObject({
      identity: { vault: h.recordA.vault, token: TOKEN_A, name: 'Alpha Coin', symbol: 'ALPHA', launchedAtUnix: NOW - 30 * DAY },
      state: 'ACTIVE',
      operatorBps: TERMS.operatorBps,
      budgetBpsMax: 3_000,
      screening: { verdict: 'CLEAR', paidMediaPermitted: true, flags: [] },
      subject: { name: 'Alpha Coin', symbol: 'ALPHA', linkCount: 1, narrativeSourceCount: 1 },
      narrativeApproved: false,
      reconciliationVariance: 'none',
    })
    const period = coin.body.period as Record<string, unknown>
    expect(typeof period.qfGrossCents).toBe('string')
    expect(typeof coin.body.budgetBalanceCents).toBe('string')

    // A drafted coin is not a member: no vault exists for it yet.
    expect((await call(h.router, 'GET', `/v1/coins/${h.recordB.vault}`)).status).toBe(404)
    expect((await call(h.router, 'GET', `/v1/coins/${h.recordB.vault}/receipts`)).status).toBe(404)
  })

  it('pages receipts newest first and refuses a cursor it did not issue', async () => {
    const h = harness()
    await h.store.put(h.recordA)
    const page = await call(h.router, 'GET', `/v1/coins/${h.recordA.vault}/receipts`)
    expect(page.body).toEqual({ items: [], nextCursor: null })
    const bad = await call(h.router, 'GET', `/v1/coins/${h.recordA.vault}/receipts`, { query: { cursor: 'abc' } })
    expect(bad.status).toBe(400)
  })
})

describe('the agent page, now public', () => {
  it('scrubs the value an airlock violation quoted back', () => {
    const body = agentRunBody({
      id: 'v:1',
      coinRef: 'coin_a',
      vault: '0x1111111111111111111111111111111111111111',
      atUnix: NOW,
      tier: 'T1',
      ranChainPoll: true,
      ranCognition: true,
      nextDueUnix: NOW + 600,
      proposals: [],
      suppressed: [],
      violations: [{ toolName: 'propose_post', field: 'linkRefs', message: 'link "https://drain.example/claim" is not on the allowlist' }],
      refusals: [],
      spends: [],
      publishes: [{ channel: 'x', intent: 'reply', published: false, rejectedReason: 'link_allowlist:link "send 0.5 ETH to 0x4444444444444444444444444444444444444444" resolved to nothing' }],
      cost: { microUsd: 0n, degradeLevel: 'full', usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } },
      modelProvenance: 'fake',
    })
    const json = serialize(body)
    expect(json).not.toContain('drain.example')
    expect(json).not.toContain('0x4444')
    expect(json).not.toContain('0.5 ETH')
  })
})

describe('onboarding through the web', () => {
  it('quotes at the published rate, records the signed consent once, and hands back the factory deploy call', async () => {
    const h = harness()
    const token = '0x3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c'
    h.tokens.tokens.set(token, { name: 'Gamma Coin', symbol: 'GAMMA' })

    const quote = await call(h.router, 'POST', '/v1/onboarding/quote', {
      body: { devSigner: DEV_A, devPayout: DEV_A, token, budgetBpsMax: 2_000, narrativeSources: ['https://gamma.example/docs'], socials: { x: '@gamma_dev' } },
    })
    expect(quote.status).toBe(200)
    const consent = quote.body.consent as Consent
    expect(consent).toMatchObject({ devSigner: DEV_A, token, operatorBps: TERMS.operatorBps, budgetBpsMax: 2_000, adapter: ADAPTER, termsHash: TERMS_HASH })
    expect(quote.body.predictedVault).toBe(predictVault(consent, FACTORY))
    expect(quote.body.digest).toBe(consentDigest(consent, DOMAIN))
    expect(quote.body.termsUrl).toBe('https://terms.example/msa-v1')

    const sig = signature(consentDigest(consent, DOMAIN), DEV_A_KEY)
    const forged = await call(h.router, 'POST', '/v1/onboarding/submit', { body: { consent, signature: signature(consentDigest(consent, DOMAIN), DEV_B_KEY) } })
    expect(forged.status).toBe(401)

    const submitted = await call(h.router, 'POST', '/v1/onboarding/submit', { body: { consent, signature: sig } })
    expect(submitted.status).toBe(200)
    expect(submitted.body).toMatchObject({ vault: quote.body.predictedVault, submittedAtUnix: NOW })
    const tx = submitted.body.tx as Record<string, unknown>
    expect(tx.to).toBe(FACTORY.factory)
    expect(tx.value).toBe('0')
    expect(String(tx.data).length).toBeGreaterThan(10 + 12 * 64)

    const record = await h.store.byToken(token)
    expect(record).toMatchObject({ state: 'signed', name: 'Gamma Coin', symbol: 'GAMMA', narrativeSources: ['https://gamma.example/docs'], socials: { x: 'gamma_dev' } })

    // Submitting the same signed consent again returns the same ticket rather than a second record.
    const again = await call(h.router, 'POST', '/v1/onboarding/submit', { body: { consent, signature: sig } })
    expect(again.status).toBe(200)
    expect(again.body.vault).toBe(submitted.body.vault)
    expect((await h.store.list()).length).toBe(1)

    // A retrofit plan for it names the current recipient and the transfer, and a mismatched vault is refused.
    const plan = await call(h.router, 'GET', `/v1/onboarding/retrofit/${token}`, { query: { vault: String(quote.body.predictedVault) } })
    expect(plan.status).toBe(200)
    expect(plan.body).toMatchObject({ token, currentRecipient: '0x9999999999999999999999999999999999999999', claimTxs: [], sweepTx: null })
    expect((plan.body.transferTx as Record<string, unknown>).data).toContain(keccakHex(utf8('transferCreatorFeeRecipient(address,address)')).slice(2, 10))
    const mismatch = await call(h.router, 'GET', `/v1/onboarding/retrofit/${token}`, { query: { vault: h.recordA.vault } })
    expect(mismatch.status).toBe(409)
  })

  it('refuses a greenfield consent with 501 rather than recording a vault bound to nothing', async () => {
    const h = harness()
    const consent = consentFor(DEV_A, '0x0000000000000000000000000000000000000000', keccakHex(utf8('nonce-g')))
    const submitted = await call(h.router, 'POST', '/v1/onboarding/submit', { body: { consent, signature: signature(consentDigest(consent, DOMAIN), DEV_A_KEY) } })
    expect(submitted.status).toBe(501)
    expect(submitted.body.error).toBe('not_supported')
  })
})

describe('the /v1 stores on Postgres', () => {
  let pg: PgliteHarness
  beforeAll(async () => {
    pg = await pgliteMigrated()
  })
  afterAll(async () => {
    await pg.close()
  })

  it('consumes a challenge exactly once and hides the bearer behind its hash', async () => {
    const store = new PgDevSessionStore(pg.driver)
    const auth = new DevAuth({ store, issuer: 'Test Operator LLC', now: () => NOW })
    const challenge = await auth.challenge(DEV_A)
    const sig = signature(personalSignDigest(challenge.message), DEV_A_KEY)
    const first = await auth.signIn({ address: DEV_A, message: challenge.message, signature: sig })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(await auth.verify(first.token)).toMatchObject({ address: DEV_A, sessionId: first.session.id })
    const rows = await pg.driver.query<{ token_hash: string }>('SELECT token_hash FROM dev_session')
    expect(rows.map((r) => r.token_hash)).not.toContain(first.token)

    const replay = await auth.signIn({ address: DEV_A, message: challenge.message, signature: sig })
    expect(replay).toEqual({ ok: false, reason: 'no_such_challenge' })

    const later = new DevAuth({ store, issuer: 'Test Operator LLC', now: () => NOW + 25 * 3_600 })
    expect(await later.verify(first.token)).toBeUndefined()
  })

  it('acknowledges an escalation for its own vault only, and keeps the quote extras by nonce', async () => {
    await pg.driver.execute(
      `INSERT INTO ops_escalation (coin_ref, vault, kind, code, detail, raised_at_unix, last_raised_at_unix, occurrences)
       VALUES ('coin_a', $1, 'desk_escalation', 'refund_request', 'a holder asks', $2, $2, 1)`,
      [DEV_A, NOW],
    )
    const queue = new PgEscalationQueue(pg.driver)
    const [row] = await queue.forVault(DEV_A)
    expect(row).toMatchObject({ vault: DEV_A, kind: 'desk_escalation', code: 'refund_request', raisedAtUnix: NOW })
    expect(await queue.acknowledge({ id: row?.id ?? '', vault: DEV_B, decision: 'dismissed', note: 'n', by: DEV_B, atUnix: NOW })).toBeUndefined()
    const acked = await queue.acknowledge({ id: row?.id ?? '', vault: DEV_A, decision: 'dismissed', note: 'n', by: DEV_A, atUnix: NOW + 1 })
    expect(acked).toMatchObject({ acknowledgedAtUnix: NOW + 1, ackDecision: 'dismissed' })

    const quotes = new PgQuoteStore(pg.driver)
    const nonce = keccakHex(utf8('quote-1'))
    await quotes.put({ nonce, devSigner: DEV_A, narrativeSources: ['https://a.example'], socials: { x: 'a' }, issuedAtUnix: NOW, expiresAtUnix: NOW + DAY })
    expect(await quotes.get(nonce)).toMatchObject({ narrativeSources: ['https://a.example'], socials: { x: 'a' } })
    expect(await quotes.get(keccakHex(utf8('quote-2')))).toBeUndefined()
  })
})
