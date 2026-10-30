/**
 * Dev identity, as this service can honestly know it.
 *
 * There is no KYB/KYC vendor in the loop. What exists is a named operator who
 * did the check outside - with whatever provider, against whatever documents -
 * and RECORDS THAT THEY DID: who attested, an opaque reference into the
 * provider's file, when, and until when. The diligence gate reads the latest
 * unexpired attestation for the dev signer and passes; an expired or absent
 * one is UNKNOWN, which the gate counts as a failure. No document, no name,
 * no PII of the dev ever reaches this table: `provider_ref` is a handle.
 *
 * Schema: ops/migrations/0017_api_attestations.sql.
 */

import type { Address } from '@fee-split-vaults/core'
import { countFromSql, type SqlDriver, type SqlRow } from '@fee-split-vaults/adapters'
import type { IdentityProvider, IdentityRecord } from '@fee-split-vaults/screening'
import { normalizeAddress } from '../crypto/address.js'

export interface KybAttestation {
  devSigner: Address
  /** The operator who performed the check. Never a client-supplied name. */
  attestedBy: string
  /** Opaque handle into the external provider's file. Never the file. */
  providerRef: string
  attestedAtUnix: number
  expiresAtUnix: number
}

export interface KybAttestationStore {
  put(attestation: KybAttestation): Promise<void>
  /** The most recently attested record for the signer, expired or not. */
  latest(devSigner: Address): Promise<KybAttestation | undefined>
}

export class KybAttestationError extends Error {
  constructor(
    message: string,
    readonly code: 'expiry_not_after_attestation' | 'attested_in_future',
  ) {
    super(`kyb attestation: ${message}`)
    this.name = 'KybAttestationError'
  }
}

export function assertAttestationShape(attestation: KybAttestation, nowUnix: number): void {
  if (attestation.expiresAtUnix <= attestation.attestedAtUnix) {
    throw new KybAttestationError('expiresAtUnix must be after attestedAtUnix', 'expiry_not_after_attestation')
  }
  if (attestation.attestedAtUnix > nowUnix) {
    throw new KybAttestationError('attestedAtUnix is in the future', 'attested_in_future')
  }
}

const COLUMNS = 'dev_signer, attested_by, provider_ref, attested_at_unix, expires_at_unix'

function text(row: SqlRow, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') throw new TypeError(`kyb_attestation.${column} is ${typeof value}, not text`)
  return value
}

export class PgKybAttestationStore implements KybAttestationStore {
  constructor(private readonly driver: SqlDriver) {}

  async put(attestation: KybAttestation): Promise<void> {
    await this.driver.execute(
      `INSERT INTO kyb_attestation (${COLUMNS}) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (dev_signer, attested_at_unix) DO UPDATE SET
         attested_by = EXCLUDED.attested_by, provider_ref = EXCLUDED.provider_ref, expires_at_unix = EXCLUDED.expires_at_unix`,
      [
        normalizeAddress(attestation.devSigner),
        attestation.attestedBy,
        attestation.providerRef,
        attestation.attestedAtUnix,
        attestation.expiresAtUnix,
      ],
    )
  }

  async latest(devSigner: Address): Promise<KybAttestation | undefined> {
    const rows = await this.driver.query(
      `SELECT ${COLUMNS} FROM kyb_attestation WHERE dev_signer = $1 ORDER BY attested_at_unix DESC LIMIT 1`,
      [normalizeAddress(devSigner)],
    )
    const row = rows[0]
    if (row === undefined) return undefined
    return {
      devSigner: normalizeAddress(text(row, 'dev_signer')),
      attestedBy: text(row, 'attested_by'),
      providerRef: text(row, 'provider_ref'),
      attestedAtUnix: countFromSql(row.attested_at_unix, 'kyb_attestation.attested_at_unix'),
      expiresAtUnix: countFromSql(row.expires_at_unix, 'kyb_attestation.expires_at_unix'),
    }
  }
}

export class InMemoryKybAttestationStore implements KybAttestationStore {
  readonly #bySigner = new Map<string, KybAttestation[]>()

  async put(attestation: KybAttestation): Promise<void> {
    const key = normalizeAddress(attestation.devSigner)
    const list = this.#bySigner.get(key) ?? []
    const replaced = list.filter((a) => a.attestedAtUnix !== attestation.attestedAtUnix)
    replaced.push({ ...attestation, devSigner: key })
    this.#bySigner.set(key, replaced)
  }

  async latest(devSigner: Address): Promise<KybAttestation | undefined> {
    const list = this.#bySigner.get(normalizeAddress(devSigner)) ?? []
    return list.reduce<KybAttestation | undefined>(
      (best, a) => (best === undefined || a.attestedAtUnix > best.attestedAtUnix ? a : best),
      undefined,
    )
  }
}

/**
 * The IdentityProvider the diligence gate consults. `pass` only on an
 * attestation that has not expired at the moment of the check; the gate's
 * own identityMaxAgeSeconds still applies on top of the recorded expiry.
 */
export class ManualKybAttestationProvider implements IdentityProvider {
  constructor(
    private readonly store: KybAttestationStore,
    private readonly now: () => number,
  ) {}

  async record(devAddress: string): Promise<IdentityRecord> {
    const latest = await this.store.latest(normalizeAddress(devAddress))
    if (latest === undefined || latest.expiresAtUnix <= this.now()) return { verified: 'unknown' }
    return { verified: 'pass', verifiedAtUnix: latest.attestedAtUnix, fileRef: latest.providerRef }
  }
}
