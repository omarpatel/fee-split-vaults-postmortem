import { useState } from 'react'

import type { KybAttestation, KybAttestationInput, KybLookup } from '../../api/operator.js'
import { AddressChip, Badge, Timestamp } from '../../components/primitives.js'
import { RefusalPanel, useAction, useOperator } from './common.js'

/**
 * KYB: an operator who verified the dev signer's identity OUTSIDE records
 * that they did, with a handle into the provider's file and an expiry. No
 * vendor is in the loop here; the diligence gate reads the latest unexpired
 * attestation. The lookup says whether one is on file and whether it is
 * still current, which are two different questions.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const DAY = 86_400

export function KybPage() {
  const { operator, auth, nowUnix } = useOperator()
  return (
    <KybView
      nowUnix={nowUnix}
      onAttest={(input) => operator.attestKyb(auth, input)}
      onLookup={(devSigner) => operator.getKyb(auth, devSigner)}
    />
  )
}

export function KybView({
  nowUnix,
  onAttest,
  onLookup,
}: {
  nowUnix: number
  onAttest: (input: KybAttestationInput) => Promise<KybAttestation>
  onLookup: (devSigner: string) => Promise<KybLookup>
}) {
  const [lookupSigner, setLookupSigner] = useState('')
  const lookup = useAction<KybLookup>()

  const [devSigner, setDevSigner] = useState('')
  const [attestedBy, setAttestedBy] = useState('')
  const [providerRef, setProviderRef] = useState('')
  const [validDays, setValidDays] = useState('365')
  const attest = useAction<KybAttestation>()

  const days = Number.parseInt(validDays, 10)
  const attestValid =
    ADDRESS.test(devSigner) && attestedBy.trim().length > 0 && providerRef.trim().length > 0 && /^\d{1,4}$/.test(validDays) && days >= 1

  return (
    <div className="stack-loose">
      <section className="stack">
        <div className="section-head">
          <div>
            <span className="eyebrow">Lookup</span>
            <h2>Is there a current attestation for this signer?</h2>
          </div>
        </div>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ maxWidth: '30rem', flex: 1 }}>
            <label htmlFor="kyb-lookup">Dev signer address</label>
            <input
              id="kyb-lookup"
              type="text"
              value={lookupSigner}
              onChange={(event) => setLookupSigner(event.currentTarget.value)}
              aria-invalid={lookupSigner.length > 0 && !ADDRESS.test(lookupSigner)}
            />
          </div>
          <button type="button" className="btn" disabled={lookup.busy || !ADDRESS.test(lookupSigner)} onClick={() => void lookup.run(() => onLookup(lookupSigner))}>
            Look up
          </button>
        </div>
        {lookup.refusal !== null && <RefusalPanel refusal={lookup.refusal} title="Lookup refused" />}
        {lookup.result !== null && <AttestationCard attestation={lookup.result.attestation} current={lookup.result.current} nowUnix={nowUnix} />}
      </section>

      <section className="stack">
        <div className="section-head">
          <div>
            <span className="eyebrow">Attest</span>
            <h2>Record a verification performed outside</h2>
          </div>
          <p>
            The provider reference is a handle into the provider&rsquo;s file, not the file. The attestation is what the
            diligence gate reads; an expired one is the same as none.
          </p>
        </div>
        <div className="card stack">
          <div className="grid-2">
            <div className="field">
              <label htmlFor="kyb-signer">Dev signer address</label>
              <input id="kyb-signer" type="text" value={devSigner} onChange={(event) => setDevSigner(event.currentTarget.value)} aria-invalid={devSigner.length > 0 && !ADDRESS.test(devSigner)} />
            </div>
            <div className="field">
              <label htmlFor="kyb-by">Attested by (operator id)</label>
              <input id="kyb-by" type="text" value={attestedBy} onChange={(event) => setAttestedBy(event.currentTarget.value)} />
            </div>
            <div className="field">
              <label htmlFor="kyb-ref">Provider reference</label>
              <input id="kyb-ref" type="text" placeholder="e.g. sumsub:apl_7f3c2" value={providerRef} onChange={(event) => setProviderRef(event.currentTarget.value)} />
            </div>
            <div className="field">
              <label htmlFor="kyb-days">Valid for (days)</label>
              <input id="kyb-days" type="text" inputMode="numeric" value={validDays} onChange={(event) => setValidDays(event.currentTarget.value)} aria-invalid={!/^\d{1,4}$/.test(validDays)} />
              <span className="field-hint">
                Expires <Timestamp unix={nowUnix + (Number.isFinite(days) ? days : 0) * DAY} relativeTo={nowUnix} />, as unix seconds on the wire.
              </span>
            </div>
          </div>
          {attest.refusal !== null && <RefusalPanel refusal={attest.refusal} title="Attestation refused" />}
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={attest.busy || !attestValid}
              onClick={() =>
                void attest.run(() =>
                  onAttest({
                    devSigner: devSigner.toLowerCase(),
                    attestedBy: attestedBy.trim(),
                    providerRef: providerRef.trim(),
                    expiresAtUnix: nowUnix + days * DAY,
                  }),
                )
              }
            >
              Record attestation
            </button>
          </div>
          {attest.result !== null && <AttestationCard attestation={attest.result} current={attest.result.expiresAtUnix > nowUnix} nowUnix={nowUnix} />}
        </div>
      </section>
    </div>
  )
}

function AttestationCard({ attestation, current, nowUnix }: { attestation: KybAttestation; current: boolean; nowUnix: number }) {
  return (
    <article className="card-flat stack-tight">
      <div className="row-between">
        <span className="row">
          <AddressChip address={attestation.devSigner} />
          <Badge tone={current ? 'good' : 'bad'}>{current ? 'current' : 'expired'}</Badge>
        </span>
        <span className="small muted">
          expires <Timestamp unix={attestation.expiresAtUnix} relativeTo={nowUnix} />
        </span>
      </div>
      <p className="small" style={{ margin: 0 }}>
        Attested by <code>{attestation.attestedBy}</code> <Timestamp unix={attestation.attestedAtUnix} relativeTo={nowUnix} />, provider
        reference <code>{attestation.providerRef}</code>.
      </p>
    </article>
  )
}
