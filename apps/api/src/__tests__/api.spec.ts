import { describe, expect, it } from 'vitest'
import type { Consent, ScreeningResult, Vault } from '@fee-split-vaults/core'
import { TERMS, devBps } from '../../../../config/protocol.js'
import { addressFromPublicKey, bytesToHex, hexToBytes, keccakHex, utf8 } from '../crypto/address.js'
import { bigIntTo32Bytes, publicKeyFromPrivate, signRecoverable } from '../crypto/secp256k1.js'
import {
  CONSENT_TYPE_STRING,
  consentDigest,
  consentSalt,
  domainSeparator,
  hashStruct,
  signingPayload,
  verifyConsent,
  type Eip712Domain,
} from '../eip712.js'
import { ZERO_ADDRESS, assertCommercialTerms, draftConsent, summariseConsent } from '../consent.js'
import { FakeVaultDeployer, predictVault, type FactoryDescriptor } from '../deploy.js'
import {
  DEFAULT_ANTI_SNIPE_HOLD_SECONDS,
  InMemoryOnboardingStore,
  Onboarding,
  canTransition,
  type FleetStores,
  type RecipientReader,
} from '../onboarding.js'
import { FakeVaultChain, type VaultOperatorPort } from '../vault-chain.js'
import { buildWeeklyReport, explainRefusals } from '../report.js'
import { Ledger, InMemoryLedgerStore } from '@fee-split-vaults/ledger'
import { InMemoryReceiptStore, type PinnedUsdPrice } from '@fee-split-vaults/orchestrator'
import type { DiligenceReport } from '@fee-split-vaults/screening'

const NOW = 1_788_652_800
const DAY = 86_400

const DEV_KEY = 7n
const DEV_SIGNER = addressFromPublicKey(publicKeyFromPrivate(DEV_KEY))
const DEV_PAYOUT = '0x3333333333333333333333333333333333333333'
const ADAPTER = '0x8888888888888888888888888888888888888888'
const TOKEN = '0x2222222222222222222222222222222222222222'
const FACTORY_ADDRESS = '0xfac70000000000000000000000000000000000f1'
const DEPLOYER_ADDRESS = '0xdeb10000000000000000000000000000000000d2'
const TERMS_HASH = keccakHex(utf8('MSA v1'))
const NONCE = keccakHex(utf8('nonce-1'))

const FACTORY: FactoryDescriptor = {
  factory: FACTORY_ADDRESS,
  deployer: DEPLOYER_ADDRESS,
  vaultInitCodeHash: keccakHex(utf8('CoinVault init code')),
  chainId: 4663,
}
const DOMAIN: Eip712Domain = { chainId: 4663, verifyingContract: FACTORY_ADDRESS }

function makeConsent(overrides: Partial<Consent> = {}): Consent {
  return {
    ...draftConsent({
      devSigner: DEV_SIGNER,
      devPayout: DEV_PAYOUT,
      token: TOKEN,
      termsHash: TERMS_HASH,
      adapter: ADAPTER,
      nonce: NONCE,
      nowUnix: NOW,
    }),
    ...overrides,
  }
}

function sign(consent: Consent, key = DEV_KEY, k = 0x0f1e2d3c4b5a69788796a5b4c3d2e1f0n): string {
  const digest = hexToBytes(consentDigest(consent, DOMAIN))
  const sig = signRecoverable(digest, key, k)
  const out = new Uint8Array(65)
  out.set(bigIntTo32Bytes(sig.r), 0)
  out.set(bigIntTo32Bytes(sig.s), 32)
  out[64] = 27 + sig.recovery
  return bytesToHex(out)
}

// ---------------------------------------------------------------------------

describe('EIP-712 mirrors the contract', () => {
  it('pins the Consent type string, field order included', () => {
    // If this changes, ConsentLib.CONSENT_TYPEHASH must change with it, and
    // every vault address ever predicted changes. That is the whole point of
    // pinning it in a test rather than trusting two files to stay equal.
    expect(CONSENT_TYPE_STRING).toBe(
      'Consent(address devSigner,address devPayout,address token,bytes32 termsHash,' +
        'uint16 operatorBps,uint16 budgetBpsMax,address adapter,address referrer,' +
        'uint16 referrerBps,uint64 expiryUnix,bytes32 nonce)',
    )
  })

  it('the CREATE2 salt is NOT the EIP-712 struct hash', () => {
    const consent = makeConsent()
    // salt = keccak(abi.encode(c)); hashStruct = keccak(typehash || the same
    // words). Same struct, unrelated values, and confusing them would produce
    // vault addresses that do not exist.
    expect(consentSalt(consent)).not.toBe(hashStruct(consent))
  })

  it('the domain binds a signature to one chain and one factory', () => {
    const a = domainSeparator(DOMAIN)
    expect(domainSeparator({ ...DOMAIN, chainId: 1 })).not.toBe(a)
    expect(domainSeparator({ ...DOMAIN, verifyingContract: DEPLOYER_ADDRESS })).not.toBe(a)
  })

  it('a different rate is a different salt, so a different vault address', () => {
    // The discount is DERIVED from the published rate rather than written down.
    // A literal here would silently degenerate into comparing a consent with
    // itself the day TERMS.operatorBps happens to equal it, and the test would
    // then pass while proving nothing.
    const discounted = Math.floor(TERMS.operatorBps / 2)
    expect(discounted).not.toBe(TERMS.operatorBps)
    const cheap = makeConsent({ operatorBps: discounted })
    const dear = makeConsent({ operatorBps: TERMS.operatorBps })
    expect(predictVault(cheap, FACTORY)).not.toBe(predictVault(dear, FACTORY))
  })

  it('CREATE2 hashes the DEPLOYER, not the factory', () => {
    const consent = makeConsent()
    const viaDeployer = predictVault(consent, FACTORY)
    const viaFactory = predictVault(consent, { ...FACTORY, deployer: FACTORY_ADDRESS })
    expect(viaDeployer).not.toBe(viaFactory)
  })

  it('the signing payload restates exactly the terms that were hashed', () => {
    const consent = makeConsent()
    const payload = signingPayload(consent, DOMAIN)
    expect(payload.digest).toBe(consentDigest(consent, DOMAIN))
    expect(payload.message.operatorBps).toBe(consent.operatorBps)
    expect(payload.types.Consent?.map((f) => f.name).join(',')).toBe(
      'devSigner,devPayout,token,termsHash,operatorBps,budgetBpsMax,adapter,referrer,referrerBps,expiryUnix,nonce',
    )
  })
})

describe('consent verification fails closed', () => {
  it('accepts a signature from devSigner', () => {
    const consent = makeConsent()
    const result = verifyConsent(consent, sign(consent), DOMAIN, NOW + 60)
    expect(result.ok).toBe(true)
  })

  it('refuses a signature from anyone else', () => {
    const consent = makeConsent()
    const result = verifyConsent(consent, sign(consent, 9n), DOMAIN, NOW + 60)
    expect(result.ok).toBe(false)
  })

  it('refuses a signature over a different domain', () => {
    const consent = makeConsent()
    const signature = sign(consent)
    const result = verifyConsent(consent, signature, { ...DOMAIN, chainId: 1 }, NOW + 60)
    expect(result.ok).toBe(false)
  })

  it('refuses a valid signature over an expired consent', () => {
    const consent = makeConsent()
    const result = verifyConsent(consent, sign(consent), DOMAIN, consent.expiryUnix + 1)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/expired/)
  })

  it('refuses a consent whose terms were altered after signing', () => {
    const consent = makeConsent()
    const signature = sign(consent)
    const tampered = { ...consent, operatorBps: consent.operatorBps - 1 }
    expect(verifyConsent(tampered, signature, DOMAIN, NOW + 60).ok).toBe(false)
  })

  it('refuses a short nonce rather than zero-padding it into a salt collision', () => {
    // Two different short nonces pad to the same 32-byte word, and an
    // ambiguous salt preimage is a collision.
    expect(() => assertCommercialTerms(makeConsent({ nonce: '0x01' }))).toThrow(/nonce/)
    expect(() =>
      draftConsent({
        devSigner: DEV_SIGNER,
        devPayout: DEV_PAYOUT,
        token: TOKEN,
        termsHash: TERMS_HASH,
        adapter: ADAPTER,
        nonce: '0x01',
        nowUnix: NOW,
      }),
    ).toThrow(/nonce/)
  })
})

describe('commercial terms', () => {
  it('refuses an operator rate above the published one', () => {
    expect(() => assertCommercialTerms(makeConsent({ operatorBps: TERMS.operatorBps + 1 }))).toThrow(
      /operatorBps/,
    )
  })

  it('allows a rate BELOW the published one', () => {
    expect(() => assertCommercialTerms(makeConsent({ operatorBps: 0, referrer: ZERO_ADDRESS }))).not.toThrow()
  })

  it('refuses a referrer with no operator slice to be paid from', () => {
    expect(() =>
      assertCommercialTerms(
        makeConsent({ operatorBps: 0, referrer: DEV_PAYOUT, referrerBps: 100 }),
      ),
    ).toThrow(/referrer/)
  })

  it('refuses terms that leave the dev nothing at the maximum dial', () => {
    // The dial that zeroes the dev is not a number to be written down: it is
    // whatever is left after the published operator take. At the published rate
    // that dial is refused - by the ceiling gate, which fires before the dev
    // floor gate ever sees it, and which is the same refusal from the dev's
    // side. Either message satisfies the requirement; the refusal is the point.
    const zeroesTheDev = 10_000 - TERMS.operatorBps
    expect(() =>
      assertCommercialTerms(
        makeConsent({ operatorBps: TERMS.operatorBps, budgetBpsMax: zeroesTheDev }),
      ),
    ).toThrow(/budgetBpsMax|dev/)

    // And the terms the operator actually publishes must never be able to reach
    // that dial: the published ceiling has to leave the dev a positive share at
    // the published rate. This is the invariant the refusal above protects.
    expect(devBps(TERMS.budgetBpsMax)).toBeGreaterThan(0)
  })

  it('summarises the break-even multiple the dev is actually agreeing to', () => {
    const consent = makeConsent()
    const summary = summariseConsent(consent, predictVault(consent, FACTORY))
    expect(summary.devBpsAtDefaultDial).toBe(
      10_000 - consent.operatorBps - TERMS.budgetBpsDefault,
    )
    expect(summary.breakEvenMultipleAtDefaultDial).toBeCloseTo(
      10_000 / summary.devBpsAtDefaultDial,
      9,
    )
  })
})

// ---------------------------------------------------------------------------

function admittedDiligence(): DiligenceReport {
  return {
    token: TOKEN,
    devAddress: DEV_SIGNER,
    admitted: true,
    results: [],
    blockers: [],
    retryable: false,
    assessedAtUnix: NOW,
  }
}

function screeningResult(overrides: Partial<ScreeningResult> = {}): ScreeningResult {
  return {
    token: TOKEN,
    verdict: 'CLEAR',
    flags: [],
    stagesRun: ['lexicon'],
    screenedAtUnix: NOW,
    paidMediaPermitted: true,
    ...overrides,
  }
}

interface Harness {
  onboarding: Onboarding
  clock: { now: number }
  recipient: { address: string; launchedAtUnix: number; fail?: string }
  deployer: FakeVaultDeployer
  chain: FakeVaultChain
  /** Set to make the operator port lose its receipt after the chain has moved. */
  operator: { loseReceipts: boolean }
  vault: string
  /** Every vault_record put, in order. */
  vaultRows: Vault[]
  screeningRows: ScreeningResult[]
}

function harness(options: { operator?: boolean; reads?: boolean; fleet?: boolean } = {}): Harness {
  const clock = { now: NOW }
  const consentVault = predictVault(makeConsent(), FACTORY)
  const recipient: Harness['recipient'] = { address: consentVault, launchedAtUnix: NOW - 3 * DAY }
  const deployer = new FakeVaultDeployer(FACTORY, () => clock.now)
  const chain = new FakeVaultChain()
  const recipients: RecipientReader = {
    async creatorFeeRecipient() {
      if (recipient.fail !== undefined) throw new Error(recipient.fail)
      return recipient.address
    },
    async launchedAtUnix() {
      return recipient.launchedAtUnix
    },
    async launchTerms() {
      return { buybackEnabled: true, creatorTaxBps: 250 }
    },
  }
  const vaultRows: Vault[] = []
  const screeningRows: ScreeningResult[] = []
  const fleet: FleetStores = {
    vaults: {
      async get(address) {
        return [...vaultRows].reverse().find((v) => v.address.toLowerCase() === address.toLowerCase())
      },
      async put(vault) {
        vaultRows.push(structuredClone(vault))
      },
    },
    screening: {
      async put(result) {
        screeningRows.push(structuredClone(result))
      },
    },
  }
  const operator: Harness['operator'] = { loseReceipts: false }
  const operatorPort: VaultOperatorPort = {
    async bind(vault, token) {
      const receipt = await chain.bind(vault, token)
      if (operator.loseReceipts) throw new Error('receipt lost: process died after broadcast')
      return receipt
    },
    async activate(vault) {
      const receipt = await chain.activate(vault)
      if (operator.loseReceipts) throw new Error('receipt lost: process died after broadcast')
      return receipt
    },
  }
  return {
    clock,
    recipient,
    deployer,
    chain,
    operator,
    vault: consentVault,
    vaultRows,
    screeningRows,
    onboarding: new Onboarding({
      factory: FACTORY,
      domain: DOMAIN,
      // The factory's deployment leaves the vault UNBOUND on chain.
      deployer: {
        async deploy(consent, signature) {
          const receipt = await deployer.deploy(consent, signature)
          chain.deploy(receipt.vault)
          return receipt
        },
        isDeployed: (vault) => deployer.isDeployed(vault),
      },
      recipients,
      store: new InMemoryOnboardingStore(),
      ...(options.operator === false ? {} : { vaultOperator: operatorPort }),
      ...(options.reads === false ? {} : { vaultReads: chain }),
      ...(options.fleet === false ? {} : { fleet }),
      now: () => clock.now,
    }),
  }
}

async function walkToPointed(h: Harness, id = 'ob_1'): Promise<void> {
  const consent = makeConsent()
  await h.onboarding.draft({ id, consent, coinRef: 'coin_alpha', token: TOKEN, name: 'Alpha Coin', symbol: 'ALPHA' })
  await h.onboarding.submitSignature(id, sign(consent))
  await h.onboarding.recordScreening(
    id,
    { verdict: 'CLEAR', flags: [] } as never,
    admittedDiligence(),
    () => screeningResult(),
  )
  await h.onboarding.deploy(id)
  await h.onboarding.confirmPointing(id)
}

/** The dev's own transaction, then our read of it. */
async function accept(h: Harness, id = 'ob_1'): Promise<void> {
  h.chain.acceptService(h.vault)
  await h.onboarding.recordAcceptance(id)
}

describe('the dual-consent machine', () => {
  it('refuses every transition that is not on the list', () => {
    expect(canTransition('drafted', 'active')).toBe(false)
    expect(canTransition('signed', 'deployed')).toBe(false)
    expect(canTransition('pointed', 'accepted')).toBe(true)
    expect(canTransition('declined', 'active')).toBe(false)
    expect(canTransition('active', 'declined')).toBe(false)
  })

  it('runs the whole flow: dev signs, operator binds, dev points and accepts, operator activates', async () => {
    const h = harness()
    await walkToPointed(h)
    await accept(h)
    const record = await h.onboarding.activate('ob_1', { screeningMaxAgeSeconds: 7 * DAY })
    expect(record.state).toBe('active')
    expect(record.history.map((e) => e.code)).toEqual([
      'signature_verified',
      'screening_passed',
      'vault_deployed',
      'operator_bound',
      'recipiency_confirmed',
      'dev_accepted_service',
      'operator_activated',
    ])
    // Exactly the two operator writes the design reserves for this path, in order.
    expect(h.chain.calls).toEqual([
      { op: 'bind', vault: h.vault },
      { op: 'activate', vault: h.vault },
    ])
    expect(h.chain.tokenOf(h.vault)).toBe(TOKEN)
    expect(await h.chain.state(h.vault)).toBe('ACTIVE')
  })

  it('writes the runner’s rows on every transition from deployed on, mapping state honestly', async () => {
    const h = harness()
    await walkToPointed(h)
    await accept(h)
    await h.onboarding.activate('ob_1', { screeningMaxAgeSeconds: 7 * DAY })
    expect(h.screeningRows.map((r) => r.verdict)).toEqual(['CLEAR'])
    expect(h.vaultRows.map((v) => v.state)).toEqual(['UNBOUND', 'BOUND', 'BOUND', 'PENDING', 'ACTIVE'])
    const last = h.vaultRows[h.vaultRows.length - 1]
    expect(last).toMatchObject({
      address: h.vault,
      token: TOKEN,
      tier: 'T0',
      budgetBps: 0,
      buybackEnabled: true,
      creatorTaxBps: 250,
      activatedAtUnix: NOW,
    })
  })

  it('keeps the tier the fleet raised when it re-puts the row', async () => {
    const h = harness()
    await walkToPointed(h)
    // The fleet promoted the coin between pointing and acceptance.
    const promoted = h.vaultRows[h.vaultRows.length - 1]
    if (promoted === undefined) throw new Error('no row')
    h.vaultRows.push({ ...promoted, tier: 'T1', budgetBps: 1_500 })
    await accept(h)
    expect(h.vaultRows[h.vaultRows.length - 1]).toMatchObject({ state: 'PENDING', tier: 'T1', budgetBps: 1_500 })
  })

  it('refuses acceptance until the chain shows PENDING, and never trusts a body', async () => {
    const h = harness()
    await walkToPointed(h)
    await expect(h.onboarding.recordAcceptance('ob_1')).rejects.toMatchObject({ code: 'chain_state_mismatch' })
    await expect(h.onboarding.recordAcceptance('ob_1')).rejects.toThrow(/chain says BOUND/)
    h.chain.acceptService(h.vault)
    expect((await h.onboarding.recordAcceptance('ob_1')).state).toBe('accepted')
  })

  it('refuses activation when the chain state disagrees with the record', async () => {
    const h = harness()
    await walkToPointed(h)
    await accept(h)
    // Something moved the vault on chain after we read PENDING: suspended, say.
    h.chain.set(h.vault, 'SUSPENDED')
    await expect(h.onboarding.activate('ob_1', { screeningMaxAgeSeconds: 7 * DAY })).rejects.toMatchObject({
      code: 'chain_state_mismatch',
    })
    expect(h.chain.calls.map((c) => c.op)).toEqual(['bind'])
    expect(h.vaultRows[h.vaultRows.length - 1]?.state).toBe('PENDING')
  })

  it('an unreadable chain refuses acceptance and activation rather than assuming', async () => {
    const h = harness()
    await walkToPointed(h)
    h.chain.failReads('rpc unreachable')
    await expect(h.onboarding.recordAcceptance('ob_1')).rejects.toThrow(/rpc unreachable/)
  })

  it('refuses to bind or activate with no operator signer wired, and says so', async () => {
    const h = harness({ operator: false })
    const consent = makeConsent()
    await h.onboarding.draft({ id: 'ob_1', consent, coinRef: 'coin_alpha', token: TOKEN, name: 'Alpha Coin', symbol: 'ALPHA' })
    await h.onboarding.submitSignature('ob_1', sign(consent))
    await h.onboarding.recordScreening('ob_1', { verdict: 'CLEAR', flags: [] } as never, admittedDiligence(), () => screeningResult())
    await expect(h.onboarding.deploy('ob_1')).rejects.toMatchObject({ code: 'operator_unwired' })
    // The deployment itself happened and was recorded; only the bind is refused, and it is retryable.
    expect((await h.onboarding.store.get('ob_1'))?.state).toBe('deployed')
    expect(h.vaultRows.map((v) => v.state)).toEqual(['UNBOUND'])
  })

  it('a bind that landed but was not recorded is caught up on retry without a second transaction', async () => {
    const h = harness()
    const consent = makeConsent()
    await h.onboarding.draft({ id: 'ob_1', consent, coinRef: 'coin_alpha', token: TOKEN, name: 'Alpha Coin', symbol: 'ALPHA' })
    await h.onboarding.submitSignature('ob_1', sign(consent))
    await h.onboarding.recordScreening('ob_1', { verdict: 'CLEAR', flags: [] } as never, admittedDiligence(), () => screeningResult())
    // The broadcast confirms but the process dies before the record advances:
    // the record is `deployed`, the chain already says BOUND.
    h.operator.loseReceipts = true
    await expect(h.onboarding.deploy('ob_1')).rejects.toThrow(/receipt lost/)
    expect((await h.onboarding.store.get('ob_1'))?.state).toBe('deployed')
    expect(await h.chain.state(h.vault)).toBe('BOUND')
    h.operator.loseReceipts = false
    h.chain.calls.length = 0
    const record = await h.onboarding.deploy('ob_1')
    expect(record.state).toBe('awaiting_pointing')
    expect(record.history.find((e) => e.code === 'operator_bound')?.detail).toBe('already bound on chain')
    expect(h.chain.calls).toEqual([])
    expect(h.vaultRows.map((v) => v.state)).toEqual(['UNBOUND', 'BOUND'])
  })

  it('refuses to activate before the anti-snipe hold has elapsed', async () => {
    const h = harness()
    h.recipient.launchedAtUnix = NOW - 10
    await walkToPointed(h)
    await accept(h)
    await expect(
      h.onboarding.activate('ob_1', { screeningMaxAgeSeconds: 7 * DAY }),
    ).rejects.toThrow(/anti_snipe_hold|anti-snipe/)
    expect(DEFAULT_ANTI_SNIPE_HOLD_SECONDS).toBeGreaterThan(60)
  })

  it('refuses to activate if recipiency moved away after pointing', async () => {
    const h = harness()
    await walkToPointed(h)
    await accept(h)
    h.recipient.address = '0x9999999999999999999999999999999999999999'
    await expect(
      h.onboarding.activate('ob_1', { screeningMaxAgeSeconds: 7 * DAY }),
    ).rejects.toThrow(/recipiency_lost|moved away/)
  })

  it('refuses to activate on an expired screening', async () => {
    const h = harness()
    await walkToPointed(h)
    await accept(h)
    h.clock.now = NOW + 30 * DAY
    await expect(
      h.onboarding.activate('ob_1', { screeningMaxAgeSeconds: 7 * DAY }),
    ).rejects.toThrow(/screening_stale|expired/)
  })

  it('refuses to confirm pointing when the chain says someone else is the recipient', async () => {
    const h = harness()
    const consent = makeConsent()
    await h.onboarding.draft({ id: 'ob_2', consent, coinRef: 'coin_alpha', token: TOKEN, name: 'Alpha Coin', symbol: 'ALPHA' })
    await h.onboarding.submitSignature('ob_2', sign(consent))
    await h.onboarding.recordScreening(
      'ob_2',
      { verdict: 'CLEAR', flags: [] } as never,
      admittedDiligence(),
      () => screeningResult(),
    )
    await h.onboarding.deploy('ob_2')
    h.recipient.address = '0x9999999999999999999999999999999999999999'
    await expect(h.onboarding.confirmPointing('ob_2')).rejects.toThrow(/not_pointed|not the vault/)
  })

  it('a read failure is a refusal, never an assumed yes', async () => {
    const h = harness()
    const consent = makeConsent()
    await h.onboarding.draft({ id: 'ob_3', consent, coinRef: 'coin_alpha', token: TOKEN, name: 'Alpha Coin', symbol: 'ALPHA' })
    await h.onboarding.submitSignature('ob_3', sign(consent))
    await h.onboarding.recordScreening(
      'ob_3',
      { verdict: 'CLEAR', flags: [] } as never,
      admittedDiligence(),
      () => screeningResult(),
    )
    await h.onboarding.deploy('ob_3')
    h.recipient.fail = 'rpc unavailable'
    await expect(h.onboarding.confirmPointing('ob_3')).rejects.toThrow(/rpc unavailable/)
  })

  it('a BLOCKED screening declines before any vault exists', async () => {
    const h = harness()
    const consent = makeConsent()
    await h.onboarding.draft({ id: 'ob_4', consent, coinRef: 'coin_alpha', token: TOKEN, name: 'Alpha Coin', symbol: 'ALPHA' })
    await h.onboarding.submitSignature('ob_4', sign(consent))
    const record = await h.onboarding.recordScreening(
      'ob_4',
      { verdict: 'BLOCKED', flags: [{ code: 'sanctions_match' }] } as never,
      admittedDiligence(),
      () => screeningResult({ verdict: 'BLOCKED', paidMediaPermitted: false }),
    )
    expect(record.state).toBe('declined')
    expect(h.deployer.deployed.size).toBe(0)
  })

  it('refuses an unsigned deployment', async () => {
    const h = harness()
    const consent = makeConsent()
    await h.onboarding.draft({ id: 'ob_5', consent, coinRef: 'coin_alpha', token: TOKEN, name: 'Alpha Coin', symbol: 'ALPHA' })
    await expect(h.onboarding.deploy('ob_5')).rejects.toThrow(/unsigned|no verified signature/)
  })

  it('deploys to exactly the predicted address', async () => {
    const h = harness()
    await walkToPointed(h, 'ob_6')
    const record = await h.onboarding.store.get('ob_6')
    expect(record?.vault).toBe(predictVault(makeConsent(), FACTORY))
    expect(h.deployer.deployed.has(record?.vault ?? '')).toBe(true)
  })
})

// ---------------------------------------------------------------------------

describe('the weekly report', () => {
  const asset = {
    address: '0x6666666666666666666666666666666666666666',
    symbol: 'USDG',
    decimals: 6,
    isPausableProxy: true,
    enabled: true,
  }
  const price: PinnedUsdPrice = {
    asset: asset.address,
    centsPerWholeUnit: 100n,
    source: 'test:pinned',
    pricedAtUnix: NOW,
  }

  it('always carries the fixed section, even for a coin that did nothing', async () => {
    const store = new InMemoryLedgerStore()
    const report = await buildWeeklyReport({
      vault: '0x1111111111111111111111111111111111111111',
      asset,
      price,
      ledger: new Ledger(store),
      store,
      receipts: new InMemoryReceiptStore(),
      periodStartUnix: NOW - 7 * DAY,
      periodEndUnix: NOW,
      refusals: [],
      paidMediaPermitted: false,
      tier: 'T0',
    })
    expect(report.qfReceivedUsd).toBe(0)
    expect(report.lineItems).toHaveLength(0)
    expect(report.whatWeDidNotDo.join(' ')).toMatch(/did not trade your token/)
    expect(report.whatWeDidNotDo.join(' ')).toMatch(/did not move any of your money to a vendor/)
    expect(report.whatWeDidNotDo.join(' ')).toMatch(/no third-party paid media/)
  })

  it('turns refusal codes into sentences a client can read', () => {
    const sentences = explainRefusals([
      { code: 'solvency', atUnix: NOW },
      { code: 'solvency', atUnix: NOW },
      { code: 'a_code_nobody_mapped', atUnix: NOW },
    ])
    expect(sentences[0]).toMatch(/had not already banked/)
    expect(sentences[0]).toMatch(/2 time\(s\)/)
    // An unmapped code is still reported. A refusal nobody can explain is
    // still a refusal the client is owed.
    expect(sentences.join(' ')).toMatch(/a_code_nobody_mapped/)
  })
})
