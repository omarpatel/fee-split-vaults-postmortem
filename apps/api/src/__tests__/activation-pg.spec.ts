/**
 * The onboarding machine over the REAL runner stores (PgVaultRepository,
 * PgScreeningStore) on a real Postgres engine: what the runner reads back
 * after each transition is what it will serve, so it is what is asserted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PgScreeningStore, PgVaultRepository } from '@fee-split-vaults/adapters'
import type { Consent, ScreeningResult } from '@fee-split-vaults/core'
import type { DiligenceReport } from '@fee-split-vaults/screening'

import { addressFromPublicKey, bytesToHex, hexToBytes, keccakHex, utf8 } from '../crypto/address.js'
import { bigIntTo32Bytes, publicKeyFromPrivate, signRecoverable } from '../crypto/secp256k1.js'
import { draftConsent } from '../consent.js'
import { FakeVaultDeployer, predictVault, type FactoryDescriptor } from '../deploy.js'
import { consentDigest, type Eip712Domain } from '../eip712.js'
import { InMemoryKybAttestationStore, ManualKybAttestationProvider, PgKybAttestationStore, type KybAttestationStore } from '../diligence/kyb.js'
import { Onboarding, type RecipientReader } from '../onboarding.js'
import { PgOnboardingStore } from '../store/pg.js'
import { FakeVaultChain } from '../vault-chain.js'
import { pgliteMigrated, type PgliteHarness } from './pglite.js'

const NOW = 1_788_652_800
const DAY = 86_400
const DEV_KEY = 11n
const DEV_SIGNER = addressFromPublicKey(publicKeyFromPrivate(DEV_KEY))
const TOKEN = '0x2222222222222222222222222222222222222222'
const FACTORY: FactoryDescriptor = {
  factory: '0xfac70000000000000000000000000000000000f1',
  deployer: '0xdeb10000000000000000000000000000000000d2',
  vaultInitCodeHash: keccakHex(utf8('CoinVault init code')),
  chainId: 4663,
}
const DOMAIN: Eip712Domain = { chainId: 4663, verifyingContract: FACTORY.factory }

function consent(): Consent {
  return draftConsent({
    devSigner: DEV_SIGNER,
    devPayout: '0x3333333333333333333333333333333333333333',
    token: TOKEN,
    termsHash: keccakHex(utf8('MSA v1')),
    adapter: '0x8888888888888888888888888888888888888888',
    nonce: keccakHex(utf8('nonce-pg')),
    nowUnix: NOW,
  })
}

function sign(c: Consent): string {
  const sig = signRecoverable(hexToBytes(consentDigest(c, DOMAIN)), DEV_KEY, 0x0f1e2d3c4b5a69788796a5b4c3d2e1f0n)
  const out = new Uint8Array(65)
  out.set(bigIntTo32Bytes(sig.r), 0)
  out.set(bigIntTo32Bytes(sig.s), 32)
  out[64] = 27 + sig.recovery
  return bytesToHex(out)
}

const ADMITTED: DiligenceReport = {
  token: TOKEN,
  devAddress: DEV_SIGNER,
  admitted: true,
  results: [],
  blockers: [],
  retryable: false,
  assessedAtUnix: NOW,
}

const CLEAR: ScreeningResult = {
  token: TOKEN,
  verdict: 'CLEAR',
  flags: [],
  stagesRun: ['lexicon', 'adjudication'],
  screenedAtUnix: NOW,
  paidMediaPermitted: true,
}

let pg: PgliteHarness
beforeAll(async () => {
  pg = await pgliteMigrated()
})
afterAll(async () => {
  await pg.close()
})

describe('activation writes the runner’s rows', () => {
  it('screening_result on the verdict, vault_record UNBOUND → BOUND → PENDING → ACTIVE, tier preserved', async () => {
    const vaults = new PgVaultRepository(pg.driver)
    const screening = new PgScreeningStore(pg.driver)
    const chain = new FakeVaultChain()
    const deployer = new FakeVaultDeployer(FACTORY, () => NOW)
    const vault = predictVault(consent(), FACTORY)
    const recipients: RecipientReader = {
      creatorFeeRecipient: async () => vault,
      launchedAtUnix: async () => NOW - 3 * DAY,
      launchTerms: async () => ({ buybackEnabled: false, creatorTaxBps: 100 }),
    }
    const onboarding = new Onboarding({
      factory: FACTORY,
      domain: DOMAIN,
      deployer: {
        async deploy(c, s) {
          const receipt = await deployer.deploy(c, s)
          chain.deploy(receipt.vault)
          return receipt
        },
        isDeployed: (v) => deployer.isDeployed(v),
      },
      recipients,
      store: new PgOnboardingStore(pg.driver),
      fleet: { vaults, screening },
      vaultOperator: chain,
      vaultReads: chain,
      now: () => NOW,
    })

    const c = consent()
    await onboarding.draft({ id: 'ob_pg', consent: c, coinRef: 'coin_pg', token: TOKEN, name: 'PG Coin', symbol: 'PG' })
    await onboarding.submitSignature('ob_pg', sign(c))
    expect(await vaults.get(vault)).toBeUndefined()
    expect(await screening.latest(TOKEN)).toBeUndefined()

    await onboarding.recordScreening('ob_pg', { verdict: 'CLEAR', flags: [] } as never, ADMITTED, () => CLEAR)
    expect(await screening.latest(TOKEN)).toMatchObject({ verdict: 'CLEAR', paidMediaPermitted: true })
    expect(await vaults.get(vault)).toBeUndefined()

    await onboarding.deploy('ob_pg')
    expect(await vaults.get(vault)).toMatchObject({ state: 'BOUND', tier: 'T0', budgetBps: 0, creatorTaxBps: 100, buybackEnabled: false })

    await onboarding.confirmPointing('ob_pg')
    expect((await vaults.get(vault))?.state).toBe('BOUND')

    // The fleet promoted the coin; the next put must not undo it.
    const row = await vaults.get(vault)
    if (row === undefined) throw new Error('no row')
    await vaults.put({ ...row, tier: 'T1' })

    chain.acceptService(vault)
    await onboarding.recordAcceptance('ob_pg')
    expect(await vaults.get(vault)).toMatchObject({ state: 'PENDING', tier: 'T1' })

    const record = await onboarding.activate('ob_pg', { screeningMaxAgeSeconds: 7 * DAY })
    expect(record.state).toBe('active')
    expect(await vaults.get(vault)).toMatchObject({ state: 'ACTIVE', tier: 'T1', activatedAtUnix: NOW })
    expect((await vaults.list()).map((v) => v.address)).toEqual([vault])
  })
})

describe('KYB attestations', () => {
  for (const [name, make] of [
    ['postgres', (): KybAttestationStore => new PgKybAttestationStore(pg.driver)],
    ['in-memory', (): KybAttestationStore => new InMemoryKybAttestationStore()],
  ] as const) {
    it(`${name}: an unexpired attestation passes, an expired or absent one is UNKNOWN`, async () => {
      const store = make()
      const clock = { now: NOW }
      const provider = new ManualKybAttestationProvider(store, () => clock.now)

      expect(await provider.record(DEV_SIGNER)).toEqual({ verified: 'unknown' })

      await store.put({
        devSigner: DEV_SIGNER,
        attestedBy: 'op.alice',
        providerRef: 'sumsub:applicant/abc',
        attestedAtUnix: NOW - DAY,
        expiresAtUnix: NOW + 30 * DAY,
      })
      expect(await provider.record(DEV_SIGNER.toUpperCase().replace('0X', '0x'))).toEqual({
        verified: 'pass',
        verifiedAtUnix: NOW - DAY,
        fileRef: 'sumsub:applicant/abc',
      })

      clock.now = NOW + 30 * DAY
      expect(await provider.record(DEV_SIGNER)).toEqual({ verified: 'unknown' })

      // A newer attestation supersedes, whatever the older one said.
      await store.put({
        devSigner: DEV_SIGNER,
        attestedBy: 'op.bob',
        providerRef: 'sumsub:applicant/def',
        attestedAtUnix: NOW + 29 * DAY,
        expiresAtUnix: NOW + 60 * DAY,
      })
      expect((await store.latest(DEV_SIGNER))?.attestedBy).toBe('op.bob')
      expect(await provider.record(DEV_SIGNER)).toMatchObject({ verified: 'pass', fileRef: 'sumsub:applicant/def' })
    })
  }

  it('postgres refuses an attestation that expires before it was made', async () => {
    const store = new PgKybAttestationStore(pg.driver)
    await expect(
      store.put({ devSigner: DEV_SIGNER, attestedBy: 'op', providerRef: 'x', attestedAtUnix: NOW, expiresAtUnix: NOW }),
    ).rejects.toThrow(/kyb_attestation_expires_after_attested/)
  })
})
