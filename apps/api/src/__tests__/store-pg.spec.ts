/**
 * PgOnboardingStore against a real Postgres engine (pglite) with the real
 * migration applied. What matters here is the round trip: every field the
 * machine writes comes back byte-for-byte, including the ones added for
 * promotion, and a missing optional stays absent rather than becoming null.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Consent, NarrativeProfile } from '@fee-split-vaults/core'

import { PgOnboardingStore } from '../store/pg.js'
import type { OnboardingRecord } from '../onboarding.js'
import { pgliteWithOnboarding, type PgliteHarness } from './pglite.js'

const CONSENT: Consent = {
  devSigner: '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
  devPayout: '0x3333333333333333333333333333333333333333',
  token: '0x2222222222222222222222222222222222222222',
  termsHash: `0x${'11'.repeat(32)}`,
  operatorBps: 2_000,
  budgetBpsMax: 3_000,
  adapter: '0x8888888888888888888888888888888888888888',
  referrer: '0x0000000000000000000000000000000000000000',
  referrerBps: 0,
  expiryUnix: 1_788_700_000,
  nonce: `0x${'22'.repeat(32)}`,
}

const NARRATIVE: NarrativeProfile = {
  version: 1,
  tagline: 'a coin for people who like coins',
  themes: ['how_to_buy'],
  tone: 'playful',
  palette: { primary: '#112233', secondary: '#aabbcc' },
  approvedAtUnix: 1_788_652_900,
  approvedBy: 'op.alice',
  sourceHashes: ['a'.repeat(64)],
}

function fullRecord(): OnboardingRecord {
  return {
    id: 'ob_full',
    state: 'active',
    consent: CONSENT,
    vault: '0xABCDEF0000000000000000000000000000000001',
    token: CONSENT.token,
    coinRef: 'coin_alpha',
    createdAtUnix: 1_788_652_800,
    updatedAtUnix: 1_788_652_900,
    name: 'Alpha Coin',
    symbol: 'ALPHA',
    description: 'a community coin <script>alert(1)</script>',
    links: ['https://alpha.example', 'https://docs.alpha.example/x'],
    narrativeSources: ['https://alpha.example/launch'],
    socials: { x: 'alpha_coin' },
    devSignature: `0x${'ab'.repeat(65)}`,
    signatureVerifiedAtUnix: 1_788_652_810,
    screening: {
      token: CONSENT.token,
      verdict: 'RESTRICTED',
      flags: [{ code: 'lexicon_unavailable', stage: 'lexicon', detail: 'no list' }],
      paidMediaPermitted: false,
      screenedAtUnix: 1_788_652_820,
    } as unknown as OnboardingRecord['screening'],
    diligence: {
      token: CONSENT.token,
      devAddress: CONSENT.devSigner,
      admitted: true,
      blockers: [],
      retryable: false,
    } as unknown as OnboardingRecord['diligence'],
    deployedAtUnix: 1_788_652_830,
    deployTxHash: `0x${'cd'.repeat(32)}`,
    pointedAtUnix: 1_788_652_840,
    acceptedAtUnix: 1_788_652_850,
    activatedAtUnix: 1_788_652_900,
    launchedAtUnix: 1_788_600_000,
    narrativeCandidate: {
      version: 1,
      tagline: NARRATIVE.tagline,
      themes: NARRATIVE.themes,
      tone: NARRATIVE.tone,
      palette: NARRATIVE.palette,
      sourceHashes: NARRATIVE.sourceHashes,
    },
    narrative: NARRATIVE,
    history: [
      { atUnix: 1_788_652_810, from: 'drafted', to: 'signed', code: 'signature_verified' },
      { atUnix: 1_788_652_820, from: 'signed', to: 'screened', code: 'screening_passed', detail: 'RESTRICTED' },
    ],
  }
}

describe('PgOnboardingStore', () => {
  let harness: PgliteHarness
  let store: PgOnboardingStore

  beforeAll(async () => {
    harness = await pgliteWithOnboarding()
    store = new PgOnboardingStore(harness.driver)
  })
  afterAll(async () => {
    await harness.close()
  })

  it('round-trips a fully populated record, addresses normalised', async () => {
    const record = fullRecord()
    await store.put(record)
    const back = await store.get('ob_full')
    expect(back).toEqual({ ...record, vault: record.vault.toLowerCase() })
  })

  it('keeps absent optionals absent, not null', async () => {
    const record: OnboardingRecord = {
      id: 'ob_min',
      state: 'drafted',
      consent: CONSENT,
      vault: '0xabcdef0000000000000000000000000000000002',
      token: '0x4444444444444444444444444444444444444444',
      coinRef: 'coin_beta',
      createdAtUnix: 1,
      updatedAtUnix: 1,
      name: 'Beta',
      symbol: 'BETA',
      links: [],
      narrativeSources: [],
      history: [],
    }
    await store.put(record)
    const back = await store.get('ob_min')
    expect(back).toEqual(record)
    expect(back).not.toHaveProperty('socials')
    expect(back).not.toHaveProperty('narrative')
  })

  it('upserts: a second put replaces the row', async () => {
    const record = fullRecord()
    record.id = 'ob_upsert'
    await store.put(record)
    record.state = 'withdrawn'
    record.narrative = undefined
    delete record.narrative
    await store.put(record)
    const back = await store.get('ob_upsert')
    expect(back?.state).toBe('withdrawn')
    expect(back).not.toHaveProperty('narrative')
  })

  it('byToken returns the most recent onboarding for that token', async () => {
    const older = fullRecord()
    older.id = 'ob_t1'
    older.token = '0x5555555555555555555555555555555555555555'
    older.createdAtUnix = 100
    const newer = fullRecord()
    newer.id = 'ob_t2'
    newer.token = '0x5555555555555555555555555555555555555555'
    newer.createdAtUnix = 200
    await store.put(older)
    await store.put(newer)
    const found = await store.byToken('0x5555555555555555555555555555555555555555')
    expect(found?.id).toBe('ob_t2')
    expect(await store.byToken('0x9999999999999999999999999999999999999999')).toBeUndefined()
  })

  it('refuses a row whose state is not one the machine knows', async () => {
    await harness.driver.execute(`ALTER TABLE onboarding DROP CONSTRAINT onboarding_state_known`)
    const record = fullRecord()
    record.id = 'ob_bad'
    await store.put(record)
    await harness.driver.execute(`UPDATE onboarding SET state = 'limbo' WHERE id = 'ob_bad'`)
    await expect(store.get('ob_bad')).rejects.toThrow(/not a known state/)
  })
})
