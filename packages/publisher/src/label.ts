import type { AutomatedLabelProbe } from './channels/x.js'
import type { Clock } from './scheduler.js'

/**
 * The automated-account label, attested by a human.
 *
 * X shows the "Automated" label on a profile but exposes it through no API:
 * not on GET /2/users, not in any user.fields expansion. There is nothing for
 * code to observe. The honest implementation is therefore an operator
 * attestation - a named person looked at the profile on a given date and
 * confirms the label is on - with an expiry the operator chooses, after which
 * the claim lapses and posting from that account is refused until somebody
 * looks again.
 *
 * The attestation date is reported as the observation date. The publisher's
 * maxAccountLabelAgeSeconds still applies on top of the attestation's own
 * expiry, so an attestation that is valid by its own terms but older than the
 * policy allows is stale. Both bounds fail closed.
 */
export interface LabelAttestation {
  accountId: string
  /** Who looked. An operator identity, never a model. */
  attestedBy: string
  attestedAtUnix: number
  expiresAtUnix: number
}

export interface LabelAttestationStore {
  get(accountId: string): Promise<LabelAttestation | null>
  put(attestation: LabelAttestation): Promise<void>
}

export class InMemoryLabelAttestationStore implements LabelAttestationStore {
  readonly #records = new Map<string, LabelAttestation>()

  constructor(seed: readonly LabelAttestation[] = []) {
    for (const attestation of seed) this.#records.set(attestation.accountId, attestation)
  }

  async get(accountId: string): Promise<LabelAttestation | null> {
    return this.#records.get(accountId) ?? null
  }

  async put(attestation: LabelAttestation): Promise<void> {
    this.#records.set(attestation.accountId, attestation)
  }
}

/** Labeled iff an attestation exists and has not expired. Anything else is unlabeled. */
export function createAttestedLabelProbe(store: LabelAttestationStore, clock: Clock): AutomatedLabelProbe {
  return {
    async observe(accountId) {
      const now = clock.nowUnix()
      const attestation = await store.get(accountId)
      if (attestation === null || attestation.expiresAtUnix <= now || attestation.attestedAtUnix > now) {
        return { labeled: false, observedAtUnix: now }
      }
      return { labeled: true, observedAtUnix: attestation.attestedAtUnix }
    },
  }
}
