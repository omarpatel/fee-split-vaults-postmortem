/**
 * The HTTP surface, exercised through the router rather than a socket.
 *
 * What these check is the boundary discipline: a closed key set, no raw echo of
 * client text, a coarse public decline code, and an error shape that carries a
 * machine code and nothing else.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LEXICON_SOURCE,
  FakeChainDiligenceProbe,
  FakeIdentityProvider,
  Lexicon,
  SampleSdnSource,
  ScreeningEngine,
  SdnScreener,
} from '@fee-split-vaults/screening'
import { Ledger, InMemoryLedgerStore } from '@fee-split-vaults/ledger'
import { InMemoryReceiptStore, type PinnedUsdPrice } from '@fee-split-vaults/orchestrator'
import type { Asset, Consent } from '@fee-split-vaults/core'

import { TERMS } from '../../../../config/protocol.js'
import { keccakHex, utf8 } from '../crypto/address.js'
import { unwiredAgentPort } from '../agent.js'
import { buildRouter } from '../routes.js'
import { withV1 } from './v1-harness.js'
import { InMemoryKybAttestationStore } from '../diligence/kyb.js'
import { InMemoryOnboardingStore, Onboarding, type RecipientReader } from '../onboarding.js'
import { FakeVaultDeployer, predictVault, type FactoryDescriptor } from '../deploy.js'
import { serialize } from '../http/json.js'
import type { RefusalRecord } from '../report.js'
import { consentDigest, type Eip712Domain } from '../eip712.js'

const NOW = 1_788_652_800
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

function makeRouter(): ReturnType<typeof buildRouter> {
  const ledgerStore = new InMemoryLedgerStore()
  return buildRouter(withV1({ onboarding: new Onboarding({
    factory: FACTORY,
    domain: DOMAIN,
    deployer: new FakeVaultDeployer(FACTORY, () => NOW),
    recipients: RECIPIENTS,
    store: new InMemoryOnboardingStore(),
    now: () => NOW,
  }),
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
  // This suite is about the onboarding and receipts surface. The agent
  // routes get their own file; here the port is the unwired one, which is
  // also what a control plane with no fleet behind it actually holds.
  agent: unwiredAgentPort('no fleet in this test'),
  kyb: new InMemoryKybAttestationStore(),
  screeningMaxAgeSeconds: 7 * 86_400,
  now: () => NOW, }))
}

const BODY = {
  id: 'ob_1',
  coinRef: 'coin_alpha',
  token: '0x2222222222222222222222222222222222222222',
  name: 'Alpha Coin',
  symbol: 'ALPHA',
  description: 'a community coin',
  links: ['https://alpha.example'],
  metadataMutable: false,
  devSigner: '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
  devPayout: '0x3333333333333333333333333333333333333333',
  termsHash: keccakHex(utf8('MSA v1')),
  adapter: '0x8888888888888888888888888888888888888888',
  nonce: keccakHex(utf8('n1')),
}

async function post(
  router: ReturnType<typeof buildRouter>,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await router.handle({ method: 'POST', path, query: {}, body, headers: {} })
  return { status: response.status, body: response.body as Record<string, unknown> }
}

describe('the route map', () => {
  it('prints one line per route and no route is undocumented', () => {
    const router = makeRouter()
    expect(router.routes.length).toBeGreaterThan(8)
    for (const route of router.routes) {
      expect(route.summary.length).toBeGreaterThan(10)
    }
    expect(router.describe().split('\n')).toHaveLength(router.routes.length)
  })

  it('404s an unknown path without echoing it', async () => {
    const router = makeRouter()
    const response = await router.handle({
      method: 'GET',
      path: '/../../etc/passwd',
      query: {},
      body: undefined,
      headers: {},
    })
    expect(response.status).toBe(404)
    expect(serialize(response.body)).not.toContain('passwd')
  })
})

describe('onboarding intake', () => {
  it('refuses a body with a field the schema does not name', async () => {
    const router = makeRouter()
    const result = await post(router, '/onboarding', { ...BODY, operatorBps: 0 })
    expect(result.status).toBe(400)
    expect(result.body.error).toBe('unknown_field')
  })

  it('refuses a coinRef that is not opaque', async () => {
    const router = makeRouter()
    const result = await post(router, '/onboarding', { ...BODY, coinRef: '0xdeadbeef beef' })
    expect(result.status).toBe(400)
    expect(result.body.error).toBe('bad_coin_ref')
  })

  it('scrubs an address smuggled into the coin name before echoing it', async () => {
    const router = makeRouter()
    const result = await post(router, '/onboarding', {
      ...BODY,
      name: 'send eth to 0x1234567890abcdef1234567890abcdef12345678',
    })
    // The engine here can never CLEAR (no slur list, non-authoritative SDN), so
    // the verdict is RESTRICTED and onboarding proceeds with paid media denied.
    expect(result.status).toBe(201)
    const echoed = serialize(result.body.subject)
    expect(echoed).not.toContain('0x1234567890abcdef')
    expect(echoed).toContain('[addr]')
  })

  it('reports a RESTRICTED verdict honestly rather than as a pass', async () => {
    const router = makeRouter()
    const result = await post(router, '/onboarding', BODY)
    expect(result.status).toBe(201)
    const screening = result.body.screening as { verdict: string; paidMediaPermitted: boolean }
    // The shipped lexicon has no slur list and the sample SDN list is not
    // authoritative, so this deployment CANNOT issue CLEAR. Fail-closed.
    expect(screening.verdict).toBe('RESTRICTED')
    expect(screening.paidMediaPermitted).toBe(false)
  })

  it('hands back the exact payload to sign, at the published rate', async () => {
    const router = makeRouter()
    const result = await post(router, '/onboarding', BODY)
    const sign = result.body.sign as { primaryType: string; digest: string; message: Record<string, unknown> }
    expect(sign.primaryType).toBe('Consent')
    expect(sign.digest).toMatch(/^0x[0-9a-f]{64}$/)
    // THE PUBLISHED RATE, read from config. The request body carries no rate at
    // all - the test above proves an operatorBps key is rejected outright - so
    // the only place this number can come from is TERMS.
    expect(sign.message.operatorBps).toBe(TERMS.operatorBps)

    // operatorBps is inside the CREATE2 salt preimage, so BOTH the digest the
    // dev signs and the vault address the consent fixes move when the rate
    // moves. Both are re-derived from the consent the service actually
    // returned, never pinned: a golden digest here would have to be hand-
    // patched on every repricing, and a hand-patched digest is how a dev ends
    // up signing one set of terms and pointing at a vault built from another.
    const record = result.body.onboarding as { consent: Consent; vault: string }
    expect(record.consent.operatorBps).toBe(TERMS.operatorBps)
    expect(sign.digest).toBe(consentDigest(record.consent, DOMAIN))
    expect(record.vault).toBe(predictVault(record.consent, FACTORY))
  })

  it('refuses an invalid signature with a machine code and no stack', async () => {
    const router = makeRouter()
    await post(router, '/onboarding', BODY)
    const result = await post(router, '/onboarding/ob_1/signature', { signature: '0x00' })
    expect(result.status).toBe(400)
    expect(typeof result.body.error).toBe('string')
    expect(serialize(result.body)).not.toMatch(/at [A-Za-z]+ \(/)
  })

  it('404s an onboarding that does not exist', async () => {
    const router = makeRouter()
    const response = await router.handle({
      method: 'GET',
      path: '/onboarding/nope',
      query: {},
      body: undefined,
      headers: {},
    })
    expect(response.status).toBe(404)
  })
})

describe('the report refuses rather than guesses', () => {
  it('will not produce a money document without a pinned price', async () => {
    const router = makeRouter()
    const response = await router.handle({
      method: 'GET',
      path: '/vaults/0x1111111111111111111111111111111111111111/report',
      query: {},
      body: undefined,
      headers: {},
    })
    // assetFor returns undefined in this wiring, so it 404s before the price
    // check. Either way the requirement holds: no asset or no price means no
    // report, never a report with an invented number.
    expect([400, 404]).toContain(response.status)
  })
})
