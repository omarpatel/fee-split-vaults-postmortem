/**
 * The chain diligence probe over a recording rpc, and the operator's
 * attestation route. The bytecode fixtures are hand-assembled dispatchers so
 * the test states exactly which selectors are present, and one of them hides
 * a selector inside PUSH data to prove the walk skips immediates.
 */
import { describe, expect, it } from 'vitest'
import { VENUE } from '../../../../config/protocol.js'
import { encodeAddressArgCall, selector, type BlockRef, type Hex, type LaunchedToken, type PinnedCall } from '@fee-split-vaults/indexer'
import { runFraudDiligence, DEFAULT_DILIGENCE_POLICY, type IdentityProvider } from '@fee-split-vaults/screening'

import {
  ChainDiligenceProbe,
  MINT_SELECTORS,
  scanBytecode,
  selectorPresence,
  type DiligenceChainReads,
  type LaunchReader,
} from '../diligence/probe.js'
import { InMemoryKybAttestationStore, ManualKybAttestationProvider } from '../diligence/kyb.js'
import { buildRouter } from '../routes.js'
import { withV1 } from './v1-harness.js'
import { Onboarding, InMemoryOnboardingStore, type RecipientReader } from '../onboarding.js'
import { FakeVaultDeployer, type FactoryDescriptor } from '../deploy.js'
import { unwiredAgentPort } from '../agent.js'
import { Ledger, InMemoryLedgerStore } from '@fee-split-vaults/ledger'
import { InMemoryReceiptStore } from '@fee-split-vaults/orchestrator'
import {
  DEFAULT_LEXICON_SOURCE,
  FakeChainDiligenceProbe,
  Lexicon,
  SampleSdnSource,
  SdnScreener,
  ScreeningEngine,
} from '@fee-split-vaults/screening'
import { keccakHex, utf8 } from '../crypto/address.js'

const NOW = 1_788_652_800
const TOKEN = '0x2222222222222222222222222222222222222222'
const CURVE = '0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0'
const HEAD: BlockRef = { number: 100n, hash: `0x${'ab'.repeat(32)}`, parentHash: `0x${'aa'.repeat(32)}`, timestampUnix: NOW }

/** A dispatcher: for each selector, `PUSH4 sel EQ`, then STOP. */
function dispatcher(selectors: readonly string[], options: { delegate?: boolean; hidden?: string } = {}): Hex {
  let code = '60806040' // PUSH1 80 PUSH1 40, the usual prologue
  for (const sel of selectors) code += `63${sel.slice(2)}14`
  if (options.hidden !== undefined) {
    // PUSH8 with a selector inside its immediate: not a dispatcher entry.
    code += `6763${options.hidden.slice(2)}000000`
  }
  if (options.delegate === true) code += 'f4'
  code += '00'
  return `0x${code}`
}

const WORD_TRUE = `0x${'0'.repeat(63)}1` as Hex
const WORD_FALSE = `0x${'0'.repeat(64)}` as Hex
const word = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`

function launched(overrides: Partial<LaunchedToken> = {}): LaunchedToken {
  return {
    token: TOKEN,
    curve: CURVE,
    deployer: '0x1111111111111111111111111111111111111111',
    creatorFeeRecipient: '0x4444444444444444444444444444444444444444',
    pairToken: '0x5555555555555555555555555555555555555555',
    graduationThreshold: 0n,
    poolFee: 3000,
    tickSpacing: 60,
    creatorTaxBps: 0,
    buybackEnabled: false,
    phase: 0,
    sweptQuote: 0n,
    sweptTokens: 0n,
    sweptAt: 0n,
    exists: true,
    ...overrides,
  }
}

interface FakeChain {
  rpc: DiligenceChainReads
  launches: LaunchReader
  calls: PinnedCall[]
  code: Map<string, Hex>
  answers: Map<string, Hex>
}

function chain(options: { launched?: LaunchedToken; tokenCode?: Hex; curveCode?: Hex } = {}): FakeChain {
  const calls: PinnedCall[] = []
  const code = new Map<string, Hex>()
  const answers = new Map<string, Hex>()
  if (options.tokenCode !== undefined) code.set(TOKEN, options.tokenCode)
  if (options.curveCode !== undefined) code.set(CURVE, options.curveCode)
  const rpc: DiligenceChainReads = {
    head: async () => HEAD,
    async call(request) {
      calls.push(request)
      if (request.blockHash !== HEAD.hash) throw new Error('not pinned to the head')
      const answer = answers.get(`${request.to.toLowerCase()}:${request.data.slice(0, 10)}`)
      if (answer === undefined) throw new Error(`no fake result for ${request.to} ${request.data.slice(0, 10)}`)
      return answer
    },
    async getCode(address, blockHash) {
      if (blockHash !== HEAD.hash) throw new Error('not pinned to the head')
      return code.get(address.toLowerCase()) ?? '0x'
    },
  }
  const launches: LaunchReader = {
    launchedToken: async () => ({ launched: options.launched ?? launched(), at: HEAD }),
    launchedAtUnix: async () => NOW - 3_600,
  }
  return { rpc, launches, calls, code, answers }
}

const MINT = selector('mint(address,uint256)')
const PAUSE = selector('pause()')
const TRANSFER = selector('transfer(address,uint256)')
const LOCKER = VENUE.contracts.v2LaunchLocker.toLowerCase()

describe('scanBytecode', () => {
  it('collects dispatcher selectors and skips selectors hidden inside push data', () => {
    const scan = scanBytecode(dispatcher([TRANSFER], { hidden: MINT }))
    expect(scan.selectors.has(TRANSFER)).toBe(true)
    expect(scan.selectors.has(MINT)).toBe(false)
    expect(scan.delegates).toBe(false)
    expect(selectorPresence(scan, MINT_SELECTORS).presence).toBe('absent')
  })

  it('reports a present selector by signature', () => {
    const { presence, found } = selectorPresence(scanBytecode(dispatcher([TRANSFER, MINT])), MINT_SELECTORS)
    expect(presence).toBe('present')
    expect(found).toEqual(['mint(address,uint256)'])
  })

  it('cannot see through a delegating contract or an EIP-1167 clone, and says unknown', () => {
    expect(selectorPresence(scanBytecode(dispatcher([TRANSFER], { delegate: true })), MINT_SELECTORS).presence).toBe('unknown')
    const clone: Hex = `0x363d3d373d3d3d363d73${'11'.repeat(20)}5af43d82803e903d91602b57fd5bf3`
    expect(scanBytecode(clone).delegates).toBe(true)
    expect(selectorPresence(scanBytecode('0x'), MINT_SELECTORS).presence).toBe('unknown')
  })
})

describe('ChainDiligenceProbe', () => {
  it('mint and freeze authority come from the token bytecode at the pinned head', async () => {
    const clean = new ChainDiligenceProbe(chain({ tokenCode: dispatcher([TRANSFER]) }))
    expect(await clean.mintAuthority(TOKEN)).toEqual({ revoked: 'pass', blockHash: HEAD.hash })
    expect(await clean.freezeAuthority(TOKEN)).toEqual({ revoked: 'pass', blockHash: HEAD.hash })

    const mintable = new ChainDiligenceProbe(chain({ tokenCode: dispatcher([TRANSFER, MINT, PAUSE]) }))
    expect((await mintable.mintAuthority(TOKEN)).revoked).toBe('fail')
    expect((await mintable.freezeAuthority(TOKEN)).revoked).toBe('fail')

    const eoa = new ChainDiligenceProbe(chain())
    expect((await eoa.mintAuthority(TOKEN)).revoked).toBe('unknown')
  })

  it('a locker position is a permanent lock; a curve-phase token is factory custody; a graduated unlocked one fails', async () => {
    const curveCode = dispatcher([selector('graduated()'), selector('feeBps()'), selector('currentSnipeTaxBps(address)')])
    const c = chain({ curveCode })
    const probe = new ChainDiligenceProbe(c)

    c.answers.set(`${LOCKER}:${selector('isLocked(address)')}`, WORD_TRUE)
    expect(await probe.lpLock(TOKEN)).toEqual({ locked: 'pass', lockerAddress: LOCKER, permanent: true, blockHash: HEAD.hash })
    const lockCall = c.calls.find((call) => call.to.toLowerCase() === LOCKER)
    expect(lockCall?.data).toBe(encodeAddressArgCall(selector('isLocked(address)'), TOKEN))

    c.answers.set(`${LOCKER}:${selector('isLocked(address)')}`, WORD_FALSE)
    c.answers.set(`${CURVE}:${selector('graduated()')}`, WORD_FALSE)
    expect(await probe.lpLock(TOKEN)).toMatchObject({ locked: 'pass', lockerAddress: VENUE.contracts.v2Factory.toLowerCase(), permanent: true })

    c.answers.set(`${CURVE}:${selector('graduated()')}`, WORD_TRUE)
    expect((await probe.lpLock(TOKEN)).locked).toBe('fail')
  })

  it('quotes the exit tax from the curve views and refuses to guess after graduation or without a quote view', async () => {
    const curveCode = dispatcher([selector('graduated()'), selector('feeBps()'), selector('currentSnipeTaxBps(address)')])
    const c = chain({ curveCode })
    const probe = new ChainDiligenceProbe(c)
    c.answers.set(`${CURVE}:${selector('graduated()')}`, WORD_FALSE)
    c.answers.set(`${CURVE}:${selector('feeBps()')}`, word(100n))
    c.answers.set(`${CURVE}:${selector('currentSnipeTaxBps(address)')}`, word(250n))
    expect(await probe.simulateSell(TOKEN, 1n)).toEqual({ outcome: 'pass', effectiveTaxBps: 350 })

    c.answers.set(`${CURVE}:${selector('graduated()')}`, WORD_TRUE)
    expect((await probe.simulateSell(TOKEN, 1n)).outcome).toBe('unknown')

    const noQuote = new ChainDiligenceProbe(chain({ curveCode: dispatcher([selector('graduated()')]) }))
    expect(await noQuote.simulateSell(TOKEN, 1n)).toMatchObject({ outcome: 'unknown', revertReason: /no quote view/ })
  })

  it('admits a clean, locked, quoted, attested coin through the real gate and blocks a mintable one', async () => {
    const curveCode = dispatcher([selector('graduated()'), selector('feeBps()'), selector('currentSnipeTaxBps(address)')])
    const kyb = new InMemoryKybAttestationStore()
    const dev = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'
    await kyb.put({ devSigner: dev, attestedBy: 'op.alice', providerRef: 'ref', attestedAtUnix: NOW - 10, expiresAtUnix: NOW + 10 })
    const identity: IdentityProvider = new ManualKybAttestationProvider(kyb, () => NOW)
    const policy = { ...DEFAULT_DILIGENCE_POLICY, allowedLockers: [VENUE.contracts.v2LaunchLocker, VENUE.contracts.v2Factory] }

    const c = chain({ tokenCode: dispatcher([TRANSFER]), curveCode })
    c.answers.set(`${LOCKER}:${selector('isLocked(address)')}`, WORD_TRUE)
    c.answers.set(`${CURVE}:${selector('graduated()')}`, WORD_FALSE)
    c.answers.set(`${CURVE}:${selector('feeBps()')}`, word(100n))
    c.answers.set(`${CURVE}:${selector('currentSnipeTaxBps(address)')}`, word(0n))
    const admitted = await runFraudDiligence(TOKEN, dev, { probe: new ChainDiligenceProbe(c), identity, policy }, NOW)
    expect(admitted.admitted).toBe(true)
    expect(admitted.results.map((r) => `${r.check}:${r.outcome}`)).toEqual([
      'mint_authority_revoked:pass',
      'freeze_authority_revoked:pass',
      'lp_locked:pass',
      'not_honeypot:pass',
      'dev_identity_known:pass',
      'not_previously_declined:pass',
    ])

    const m = chain({ tokenCode: dispatcher([TRANSFER, MINT]), curveCode })
    for (const [key, value] of c.answers) m.answers.set(key, value)
    const blocked = await runFraudDiligence(TOKEN, dev, { probe: new ChainDiligenceProbe(m), identity, policy }, NOW)
    expect(blocked.admitted).toBe(false)
    expect(blocked.blockers).toEqual(['mint_authority_revoked'])
  })
})

describe('POST /diligence/kyb/attest', () => {
  const FACTORY: FactoryDescriptor = {
    factory: '0xfac70000000000000000000000000000000000f1',
    deployer: '0xdeb10000000000000000000000000000000000d2',
    vaultInitCodeHash: keccakHex(utf8('CoinVault init code')),
    chainId: 4663,
  }
  const RECIPIENTS: RecipientReader = {
    creatorFeeRecipient: () => Promise.reject(new Error('not wired')),
    launchedAtUnix: () => Promise.resolve(NOW - 86_400),
    launchTerms: () => Promise.resolve({ buybackEnabled: false, creatorTaxBps: 0 }),
  }

  function makeRouter(kyb = new InMemoryKybAttestationStore()) {
    const ledgerStore = new InMemoryLedgerStore()
    return buildRouter(withV1({ onboarding: new Onboarding({
      factory: FACTORY,
      domain: { chainId: 4663, verifyingContract: FACTORY.factory },
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
    diligence: { probe: new FakeChainDiligenceProbe(), identity: new ManualKybAttestationProvider(kyb, () => NOW) },
    factory: FACTORY,
    domain: { chainId: 4663, verifyingContract: FACTORY.factory },
    ledger: new Ledger(ledgerStore, { now: () => NOW }),
    ledgerStore,
    receipts: new InMemoryReceiptStore(),
    reporting: {
      assetFor: async () => undefined,
      priceFor: async () => undefined,
      refusalsFor: async () => [],
      tierFor: async () => 'T0',
      paidMediaPermitted: async () => false,
    },
    agent: unwiredAgentPort('no fleet in this test'),
    kyb,
    screeningMaxAgeSeconds: 7 * 86_400,
    now: () => NOW, }))
  }

  it('records an attestation, reads it back with its currency, and refuses a malformed one', async () => {
    const kyb = new InMemoryKybAttestationStore()
    const router = makeRouter(kyb)
    const dev = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'
    const created = await router.handle({
      method: 'POST',
      path: '/diligence/kyb/attest',
      query: {},
      headers: {},
      body: { devSigner: dev, attestedBy: 'op.alice', providerRef: 'sumsub:abc', expiresAtUnix: NOW + 86_400 },
    })
    expect(created.status).toBe(201)
    expect(await kyb.latest(dev)).toMatchObject({ attestedBy: 'op.alice', attestedAtUnix: NOW, expiresAtUnix: NOW + 86_400 })

    const read = await router.handle({ method: 'GET', path: `/diligence/kyb/${dev}`, query: {}, headers: {}, body: undefined })
    expect(read.status).toBe(200)
    expect(read.body).toMatchObject({ current: true, attestation: { providerRef: 'sumsub:abc' } })

    const bad = await router.handle({
      method: 'POST',
      path: '/diligence/kyb/attest',
      query: {},
      headers: {},
      body: { devSigner: dev, attestedBy: 'op.alice', providerRef: 'x', attestedAtUnix: NOW, expiresAtUnix: NOW },
    })
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ error: 'expiry_not_after_attestation' })

    const extra = await router.handle({
      method: 'POST',
      path: '/diligence/kyb/attest',
      query: {},
      headers: {},
      body: { devSigner: dev, attestedBy: 'op.alice', providerRef: 'x', expiresAtUnix: NOW + 1, documents: 'never' },
    })
    expect(extra.status).toBe(400)

    const missing = await router.handle({ method: 'GET', path: `/diligence/kyb/${'0x' + '9'.repeat(40)}`, query: {}, headers: {}, body: undefined })
    expect(missing.status).toBe(404)
  })
})
