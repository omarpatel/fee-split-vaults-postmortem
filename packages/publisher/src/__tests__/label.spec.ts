import { describe, expect, it } from 'vitest'
import { createAttestedLabelProbe, InMemoryLabelAttestationStore } from '../label.js'
import { createFixedClock } from '../scheduler.js'

describe('attested automated-account label', () => {
  const attest = (expiresAtUnix: number, attestedAtUnix = 1_757_000_000) =>
    new InMemoryLabelAttestationStore([{ accountId: 'acct-1', attestedBy: 'ops@desk', attestedAtUnix, expiresAtUnix }])

  it('is unlabeled with no attestation on file', async () => {
    const clock = createFixedClock(1_757_000_000)
    const probe = createAttestedLabelProbe(new InMemoryLabelAttestationStore(), clock)
    expect(await probe.observe('acct-1')).toEqual({ labeled: false, observedAtUnix: clock.nowUnix() })
  })

  it('reports the attestation date, not now, as the observation', async () => {
    const clock = createFixedClock(1_757_000_000 + 3600)
    const probe = createAttestedLabelProbe(attest(1_757_000_000 + 86_400), clock)
    expect(await probe.observe('acct-1')).toEqual({ labeled: true, observedAtUnix: 1_757_000_000 })
  })

  it('lapses at the expiry instant', async () => {
    const clock = createFixedClock(1_757_000_000)
    const probe = createAttestedLabelProbe(attest(1_757_000_000 + 10), clock)
    clock.advance(9)
    expect((await probe.observe('acct-1')).labeled).toBe(true)
    clock.advance(1)
    expect((await probe.observe('acct-1')).labeled).toBe(false)
  })

  it('does not trust an attestation dated in the future', async () => {
    const clock = createFixedClock(1_757_000_000)
    const probe = createAttestedLabelProbe(attest(1_757_000_000 + 86_400, 1_757_000_000 + 60), clock)
    expect((await probe.observe('acct-1')).labeled).toBe(false)
  })
})
