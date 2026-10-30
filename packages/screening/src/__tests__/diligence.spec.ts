import { describe, expect, it } from 'vitest'
import { ScreeningFailClosed } from '../flags.js'
import { InMemoryDeclineList, declineRecordFor } from '../declineList.js'
import {
  DEFAULT_DILIGENCE_POLICY,
  FakeChainDiligenceProbe,
  FakeIdentityProvider,
  assertOnboardingAdmitted,
  runFraudDiligence,
  type DiligenceDeps,
  type DiligencePolicy,
} from '../diligence.js'
import { NOW, metadata, testEngine } from './fixtures.js'

const TOKEN = '0x00000000000000000000000000000000000000aa'
const DEV = '0x00000000000000000000000000000000000000de'
const LOCKER = '0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952'

const POLICY: DiligencePolicy = { ...DEFAULT_DILIGENCE_POLICY, allowedLockers: [LOCKER] }

function goodDeps(): DiligenceDeps & { probe: FakeChainDiligenceProbe } {
  const probe = new FakeChainDiligenceProbe()
  probe.set(TOKEN, {
    mintRevoked: 'pass',
    freezeRevoked: 'pass',
    lp: {
      locked: 'pass',
      lockerAddress: LOCKER,
      unlockAtUnix: NOW + 400 * 24 * 60 * 60,
    },
    sell: { outcome: 'pass', effectiveTaxBps: 100 },
    launchedAtUnix: NOW - 3600,
  })
  const identity = new FakeIdentityProvider()
  identity.set(DEV, { verified: 'pass', verifiedAtUnix: NOW - 1000, fileRef: 'kyc-1' })
  return { probe, identity, policy: POLICY }
}

describe('the fraud diligence gate is a conjunction', () => {
  it('admits only when every check passes', async () => {
    const report = await runFraudDiligence(TOKEN, DEV, goodDeps(), NOW)
    expect(report.admitted).toBe(true)
    expect(report.blockers).toEqual([])
    expect(() => assertOnboardingAdmitted(report)).not.toThrow()
  })

  it('treats an unknown as a failure, with no benefit of the doubt', async () => {
    const deps = goodDeps()
    deps.probe.set(TOKEN, { mintRevoked: 'unknown', freezeRevoked: 'pass' })
    const report = await runFraudDiligence(TOKEN, DEV, deps, NOW)

    expect(report.admitted).toBe(false)
    expect(report.blockers).toContain('mint_authority_revoked')
    expect(() => assertOnboardingAdmitted(report)).toThrow(ScreeningFailClosed)
  })

  it('treats an unreachable RPC as a failure, not a pass', async () => {
    const deps = goodDeps()
    deps.probe.set(TOKEN, { throwOn: { mint: true } })
    const report = await runFraudDiligence(TOKEN, DEV, deps, NOW)
    expect(report.blockers).toContain('mint_authority_revoked')
  })

  it('rejects a lock held by an address that is not an allowlisted locker', async () => {
    const deps = goodDeps()
    const state = {
      mintRevoked: 'pass' as const,
      freezeRevoked: 'pass' as const,
      lp: { locked: 'pass' as const, lockerAddress: '0xdeadbeef', unlockAtUnix: NOW + 10 ** 8 },
      sell: { outcome: 'pass' as const, effectiveTaxBps: 100 },
      launchedAtUnix: NOW - 3600,
    }
    deps.probe.set(TOKEN, state)
    const report = await runFraudDiligence(TOKEN, DEV, deps, NOW)
    expect(report.blockers).toEqual(['lp_locked'])
  })

  it('rejects a lock that expires too soon', async () => {
    const deps = goodDeps()
    deps.probe.set(TOKEN, {
      mintRevoked: 'pass',
      freezeRevoked: 'pass',
      lp: { locked: 'pass', lockerAddress: LOCKER, unlockAtUnix: NOW + 86_400 },
      sell: { outcome: 'pass', effectiveTaxBps: 100 },
      launchedAtUnix: NOW - 3600,
    })
    const report = await runFraudDiligence(TOKEN, DEV, deps, NOW)
    expect(report.blockers).toEqual(['lp_locked'])
  })

  it('fails every lock when no locker has been allowlisted', async () => {
    const deps = { ...goodDeps(), policy: DEFAULT_DILIGENCE_POLICY }
    const report = await runFraudDiligence(TOKEN, DEV, deps, NOW)
    expect(report.blockers).toContain('lp_locked')
  })

  it('rejects a punitive exit tax as a honeypot', async () => {
    const deps = goodDeps()
    deps.probe.set(TOKEN, {
      mintRevoked: 'pass',
      freezeRevoked: 'pass',
      lp: { locked: 'pass', lockerAddress: LOCKER, unlockAtUnix: NOW + 10 ** 8 },
      sell: { outcome: 'pass', effectiveTaxBps: 5_000 },
      launchedAtUnix: NOW - 3600,
    })
    const report = await runFraudDiligence(TOKEN, DEV, deps, NOW)
    expect(report.blockers).toEqual(['not_honeypot'])
  })

  it('rejects a dev with no current identity verification', async () => {
    const deps = goodDeps()
    const identity = new FakeIdentityProvider()
    identity.set(DEV, { verified: 'pass', verifiedAtUnix: NOW - 5 * 365 * 24 * 60 * 60 })
    const report = await runFraudDiligence(TOKEN, DEV, { ...deps, identity }, NOW)
    expect(report.blockers).toEqual(['dev_identity_known'])
  })
})

describe('the anti-snipe window is not a honeypot', () => {
  it('returns unknown inside the decay window rather than calling it a scam', async () => {
    const deps = goodDeps()
    deps.probe.set(TOKEN, {
      mintRevoked: 'pass',
      freezeRevoked: 'pass',
      lp: { locked: 'pass', lockerAddress: LOCKER, unlockAtUnix: NOW + 10 ** 8 },
      // A sell here would show ~99% tax purely because of the anti-snipe decay.
      sell: { outcome: 'pass', effectiveTaxBps: 9_900 },
      launchedAtUnix: NOW - 2,
    })

    const report = await runFraudDiligence(TOKEN, DEV, deps, NOW)

    expect(report.admitted).toBe(false)
    expect(report.blockers).toEqual(['not_honeypot'])
    expect(report.retryable).toBe(true)
    const honeypot = report.results.find((r) => r.check === 'not_honeypot')
    expect(honeypot?.outcome).toBe('unknown')
    expect(honeypot?.detail).toMatch(/anti-snipe/)
  })

  it('admits the same token once the window has passed', async () => {
    const deps = goodDeps()
    const report = await runFraudDiligence(TOKEN, DEV, deps, NOW)
    expect(report.admitted).toBe(true)
    expect(report.retryable).toBe(false)
  })

  it('refuses when the launch block cannot be established', async () => {
    const deps = goodDeps()
    deps.probe.set(TOKEN, {
      mintRevoked: 'pass',
      freezeRevoked: 'pass',
      lp: { locked: 'pass', lockerAddress: LOCKER, unlockAtUnix: NOW + 10 ** 8 },
      sell: { outcome: 'pass', effectiveTaxBps: 100 },
    })
    const report = await runFraudDiligence(TOKEN, DEV, deps, NOW)
    expect(report.blockers).toEqual(['not_honeypot'])
    expect(report.retryable).toBe(false)
  })
})

describe('a declined token cannot be re-onboarded under a new vault', () => {
  it('blocks onboarding for anything on the decline list', async () => {
    const declineList = new InMemoryDeclineList()
    const blocked = await testEngine().screen(metadata({ token: TOKEN, name: 'ZORBLAT' }))
    await declineList.publish(declineRecordFor(blocked))

    const report = await runFraudDiligence(TOKEN, DEV, { ...goodDeps(), declineList }, NOW)

    expect(report.admitted).toBe(false)
    expect(report.blockers).toEqual(['not_previously_declined'])
  })
})
