/**
 * THE DUAL-CONSENT MACHINE.
 *
 * Nobody can put a coin into service alone. Three separate acts are required,
 * by three different parties, and two of them the operator cannot perform:
 *
 *   1. THE DEV SIGNS. An EIP-712 consent over every economic term. Only the
 *      dev's key can produce it, and the terms are inside the CREATE2 salt, so
 *      a signature is a signature for exactly one address at exactly one rate.
 *
 *   2. THE DEV POINTS. transferCreatorFeeRecipient is self-service by the
 *      CURRENT recipient, immediate, with no timelock. The operator has no way
 *      to do this for them. Until the chain says our vault IS the fee recipient,
 *      there is nothing to serve, and we do not take the dev's word for it - the
 *      indexer's RecipientWatcher confirms it at a pinned block.
 *
 *   3. THE OPERATOR ACTIVATES. Affirmative, revocable, and refusable. This is
 *      the step where screening, fraud diligence and the anti-snipe window are
 *      enforced. A dev who has signed and pointed is still not a client.
 *
 * WHY IT IS SPLIT THIS WAY. Charging happens exclusively in ACTIVE. So every
 * reason to refuse service is also a reason not to charge, and the two are the
 * same switch. A coin that fails screening is never activated, so it is never
 * charged, so the decline costs the dev nothing and they keep every fee.
 *
 * THE ANTI-SNIPE DECISION. The contracts flagged this as undecided: the 99%
 * tax at t=0 decays over ~3 seconds and flows to the fee recipient along
 * ordinary rails, so a quote-denominated windfall would be charged like
 * ordinary revenue and generate support tickets. The clean mitigation needs no
 * contract change - activate only after the window - and this machine
 * implements it, because "someone must decide and write it into the runbook"
 * is a decision that should live in code where it can be tested.
 */

import type { Address, Consent, NarrativeProfile, ScreeningResult, Vault } from '@fee-split-vaults/core'
import { validateNarrativeProfile } from '@fee-split-vaults/core'
import type { DiligenceReport, ScreeningReport } from '@fee-split-vaults/screening'
import { normalizeAddress } from './crypto/address.js'
import { assertCommercialTerms } from './consent.js'
import { verifyConsent, type Eip712Domain } from './eip712.js'
import { predictVault, type FactoryDescriptor, type VaultDeployer } from './deploy.js'
import type { VaultOperatorPort, VaultStateReader } from './vault-chain.js'

export type OnboardingState =
  | 'drafted'
  | 'signed'
  | 'screened'
  | 'deployed'
  | 'awaiting_pointing'
  | 'pointed'
  | 'accepted'
  | 'active'
  | 'declined'
  | 'withdrawn'

export const ONBOARDING_STATES: readonly OnboardingState[] = [
  'drafted',
  'signed',
  'screened',
  'deployed',
  'awaiting_pointing',
  'pointed',
  'accepted',
  'active',
  'declined',
  'withdrawn',
]

/**
 * A derived-but-unapproved profile. Same closed shape as NarrativeProfile minus
 * the approval stamp; approving it is what turns it into one. Structurally the
 * runtime's NarrativeCandidate, restated here so this record type does not
 * depend on the cognition package.
 */
export type NarrativeCandidate = Omit<NarrativeProfile, 'approvedAtUnix' | 'approvedBy'>

/**
 * What the dev claims about their own accounts. Kept for the operator who
 * registers the X account, and for nobody else: never echoed on the public
 * record and never shown to a model.
 */
export interface OnboardingSocials {
  x?: string
}

export interface OnboardingRecord {
  id: string
  state: OnboardingState
  consent: Consent
  /** Predicted before deployment and confirmed after. Never re-derived from input. */
  vault: Address
  token: Address
  coinRef: string
  createdAtUnix: number
  updatedAtUnix: number

  /**
   * The subject as the dev described it. Attacker-authored: screening read it
   * at full fidelity, and everything else reads it scrubbed or not at all.
   */
  name: string
  symbol: string
  description?: string
  links: string[]
  /** Documents the dev named as narrative sources. Validated URLs, unfetched. */
  narrativeSources: string[]
  socials?: OnboardingSocials

  devSignature?: string
  signatureVerifiedAtUnix?: number
  screening?: ScreeningResult
  diligence?: DiligenceReport
  deployedAtUnix?: number
  deployTxHash?: string
  /** When the chain first showed our vault as the fee recipient. */
  pointedAtUnix?: number
  acceptedAtUnix?: number
  activatedAtUnix?: number
  /**
   * Launch time, for the anti-snipe hold. Exact when the reader could date the
   * launch, otherwise an upper bound (launched no later than this); the hold
   * only ever asks whether enough time has passed since it. Absent means we
   * cannot clear it.
   */
  launchedAtUnix?: number
  declineReason?: string
  /** Derived by the reader from the fetched sources; not yet anybody's decision. */
  narrativeCandidate?: NarrativeCandidate
  /** The operator-approved profile. The only narrative the planner ever sees. */
  narrative?: NarrativeProfile
  /** Every refusal, in order. This is the audit trail a dispute reads. */
  history: OnboardingEvent[]
}

export interface OnboardingEvent {
  atUnix: number
  from: OnboardingState
  to: OnboardingState
  /** Machine code. Never free text from a client. */
  code: string
  detail?: string
}

export class OnboardingError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly state: OnboardingState,
  ) {
    super(`onboarding: ${message}`)
    this.name = 'OnboardingError'
  }
}

/**
 * Legal transitions. Anything not listed is refused, which is what makes
 * "activate a coin that was never screened" unrepresentable rather than merely
 * discouraged.
 */
const TRANSITIONS: Readonly<Record<OnboardingState, readonly OnboardingState[]>> = {
  drafted: ['signed', 'declined', 'withdrawn'],
  signed: ['screened', 'declined', 'withdrawn'],
  screened: ['deployed', 'declined', 'withdrawn'],
  deployed: ['awaiting_pointing', 'declined', 'withdrawn'],
  awaiting_pointing: ['pointed', 'declined', 'withdrawn'],
  pointed: ['accepted', 'declined', 'withdrawn'],
  accepted: ['active', 'declined', 'withdrawn'],
  active: ['withdrawn'],
  declined: [],
  withdrawn: [],
}

export function canTransition(from: OnboardingState, to: OnboardingState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to)
}

function advance(
  record: OnboardingRecord,
  to: OnboardingState,
  code: string,
  atUnix: number,
  detail?: string,
): void {
  if (!canTransition(record.state, to)) {
    throw new OnboardingError(
      `cannot go from ${record.state} to ${to}`,
      'illegal_transition',
      record.state,
    )
  }
  const event: OnboardingEvent = { atUnix, from: record.state, to, code }
  if (detail !== undefined) event.detail = detail
  record.history.push(event)
  record.state = to
  record.updatedAtUnix = atUnix
}

// ---------------------------------------------------------------------------

/** The per-token terms the launch factory carries. The vault row records them. */
export interface LaunchTerms {
  buybackEnabled: boolean
  creatorTaxBps: number
}

export interface RecipientReader {
  /**
   * Who the chain says the creator fee recipient is, read at a pinned block.
   * A read failure THROWS. It never returns undefined meaning "probably fine".
   */
  creatorFeeRecipient(token: Address): Promise<Address>
  /**
   * Launch time, for the anti-snipe hold. Exact when the launch can be dated,
   * otherwise an upper bound - a time the launch is known to precede - which is
   * the conservative direction for a hold. Throws if unknown.
   */
  launchedAtUnix(token: Address): Promise<number>
  /** getLaunchedToken's buybackEnabled and creatorTaxBps, at a pinned block. Throws if unreadable. */
  launchTerms(token: Address): Promise<LaunchTerms>
}

export interface OnboardingStore {
  put(record: OnboardingRecord): Promise<void>
  get(id: string): Promise<OnboardingRecord | undefined>
  byToken(token: Address): Promise<OnboardingRecord | undefined>
  list(): Promise<OnboardingRecord[]>
}

/**
 * The fleet's two tables, as this machine writes them. It is their ONLY
 * writer on the onboarding path: `screening_result` on every verdict and
 * `vault_record` on every transition from `deployed` onward, so the runner
 * finds a row for exactly the coins that went through here and refuses the
 * rest. Tier and dial are the fleet's to raise; a re-put keeps what it wrote.
 */
export interface FleetStores {
  vaults: {
    get(address: Address): Promise<Vault | undefined>
    put(vault: Vault): Promise<void>
  }
  screening: {
    put(result: ScreeningResult): Promise<void>
  }
}

export interface OnboardingDeps {
  factory: FactoryDescriptor
  domain: Eip712Domain
  deployer: VaultDeployer
  recipients: RecipientReader
  store: OnboardingStore
  /** Absent: no vault or screening row is written and the runner never serves the coin. */
  fleet?: FleetStores
  /** Absent: binding and activation refuse (operator_unwired). */
  vaultOperator?: VaultOperatorPort
  /** Absent: acceptance and activation refuse (chain_reads_unwired). */
  vaultReads?: VaultStateReader
  /** Seconds after launch before activation is permitted. See the header. */
  antiSnipeHoldSeconds?: number
  now: () => number
}

/** 15 minutes. Comfortably past a ~3-second decay, and short enough to onboard. */
export const DEFAULT_ANTI_SNIPE_HOLD_SECONDS = 900

/** Promotion - a narrative, a bound account - starts once the coin has pointed its fees at us, not before. */
export const PROMOTION_ELIGIBLE_STATES: readonly OnboardingState[] = ['pointed', 'accepted', 'active']

export class Onboarding {
  readonly #deps: OnboardingDeps

  constructor(deps: OnboardingDeps) {
    this.#deps = deps
  }

  get antiSnipeHoldSeconds(): number {
    return this.#deps.antiSnipeHoldSeconds ?? DEFAULT_ANTI_SNIPE_HOLD_SECONDS
  }

  /** Read-only. The routes read records; only this class writes them. */
  get store(): Pick<OnboardingStore, 'get' | 'byToken' | 'list'> {
    return this.#deps.store
  }

  /** Step 0. Draft, predict the address, and hand back something to sign. */
  async draft(input: {
    id: string
    consent: Consent
    coinRef: string
    token: Address
    name: string
    symbol: string
    description?: string
    links?: readonly string[]
    narrativeSources?: readonly string[]
    socials?: OnboardingSocials
  }): Promise<OnboardingRecord> {
    assertCommercialTerms(input.consent)
    const now = this.#deps.now()
    const record: OnboardingRecord = {
      id: input.id,
      state: 'drafted',
      consent: input.consent,
      vault: predictVault(input.consent, this.#deps.factory),
      token: normalizeAddress(input.token),
      coinRef: input.coinRef,
      createdAtUnix: now,
      updatedAtUnix: now,
      name: input.name,
      symbol: input.symbol,
      links: [...(input.links ?? [])],
      narrativeSources: [...(input.narrativeSources ?? [])],
      history: [],
    }
    if (input.description !== undefined) record.description = input.description
    if (input.socials !== undefined) record.socials = { ...input.socials }
    await this.#deps.store.put(record)
    return record
  }

  /** Step 1, THE DEV'S SIGNATURE. Only the dev's key can produce it. */
  async submitSignature(id: string, signature: string): Promise<OnboardingRecord> {
    const record = await this.#require(id)
    const now = this.#deps.now()
    const verification = verifyConsent(record.consent, signature, this.#deps.domain, now)
    if (!verification.ok) {
      throw new OnboardingError(verification.reason, 'signature_invalid', record.state)
    }
    record.devSignature = signature
    record.signatureVerifiedAtUnix = now
    advance(record, 'signed', 'signature_verified', now)
    await this.#deps.store.put(record)
    return record
  }

  /**
   * Step 2. Screening and fraud diligence.
   *
   * A BLOCKED verdict ends the onboarding here, before any vault exists, so a
   * declined coin was never charged anything and the dev keeps every fee. That
   * is the whole point of running this before deployment rather than after.
   */
  async recordScreening(
    id: string,
    screening: ScreeningReport,
    diligence: DiligenceReport,
    toResult: (report: ScreeningReport) => ScreeningResult,
  ): Promise<OnboardingRecord> {
    const record = await this.#require(id)
    const now = this.#deps.now()
    record.screening = toResult(screening)
    record.diligence = diligence

    if (screening.verdict === 'BLOCKED') {
      record.declineReason = 'screening_blocked'
      advance(record, 'declined', 'screening_blocked', now, screening.flags.map((f) => f.code).join(','))
      // A block is recorded for the runner too: sticky, and never laundered
      // by a retry under a new onboarding id.
      await this.#deps.fleet?.screening.put(record.screening)
      await this.#deps.store.put(record)
      return record
    }
    if (!diligence.admitted) {
      // Retryable means the anti-snipe window has not settled; the coin stays
      // in `signed` and the caller tries again rather than being declined.
      if (diligence.retryable) {
        throw new OnboardingError(
          `diligence not yet conclusive: ${diligence.blockers.join(',')}`,
          'diligence_retryable',
          record.state,
        )
      }
      record.declineReason = 'diligence_blocked'
      advance(record, 'declined', 'diligence_blocked', now, diligence.blockers.join(','))
      await this.#deps.store.put(record)
      return record
    }

    advance(record, 'screened', 'screening_passed', now, screening.verdict)
    await this.#deps.fleet?.screening.put(record.screening)
    await this.#deps.store.put(record)
    return record
  }

  /**
   * Step 3. Deploy the vault at the address the consent already fixed, then
   * BIND it to the token: a vault leaves the factory UNBOUND, and only the
   * operator can bind. Two transitions, two rows (UNBOUND, then BOUND), and
   * the second is retryable on its own: a deployment whose bind did not land
   * sits in `deployed`, and calling this again binds without redeploying.
   */
  async deploy(id: string): Promise<OnboardingRecord> {
    const record = await this.#require(id)
    const now = this.#deps.now()
    if (record.devSignature === undefined) {
      throw new OnboardingError('no verified signature on file', 'unsigned', record.state)
    }

    if (record.state === 'screened') {
      const receipt = await this.#deps.deployer.deploy(record.consent, record.devSignature)
      if (normalizeAddress(receipt.vault) !== normalizeAddress(record.vault)) {
        // The deployed address must equal the predicted one. If it does not, our
        // CREATE2 mirror is wrong and every address we have quoted is suspect.
        throw new OnboardingError(
          `deployed to ${receipt.vault}, predicted ${record.vault}`,
          'address_mismatch',
          record.state,
        )
      }
      record.deployedAtUnix = receipt.deployedAtUnix
      record.deployTxHash = receipt.txHash
      advance(record, 'deployed', 'vault_deployed', now, receipt.txHash)
      await this.#syncVaultRow(record)
      await this.#deps.store.put(record)
    } else if (record.state !== 'deployed') {
      throw new OnboardingError(`cannot deploy from ${record.state}`, 'illegal_transition', record.state)
    }

    const operator = this.#requireOperator(record)
    const chainState = await this.#requireReads(record).state(record.vault)
    let detail: string
    if (chainState === 'UNBOUND') {
      detail = (await operator.bind(record.vault, record.token)).txHash
    } else if (chainState === 'BOUND') {
      // A bind that landed before the record advanced (a restart between the
      // receipt and the store). The chain is the truth; the record catches up.
      detail = 'already bound on chain'
    } else {
      throw new OnboardingError(
        `chain says ${chainState}; a vault that is not UNBOUND or BOUND cannot be bound`,
        'chain_state_mismatch',
        record.state,
      )
    }
    advance(record, 'awaiting_pointing', 'operator_bound', now, detail)
    await this.#syncVaultRow(record)
    await this.#deps.store.put(record)
    return record
  }

  /**
   * Step 4, THE DEV'S POINTING TRANSACTION.
   *
   * We do not accept a claim that it happened. We read the chain. The dev is
   * the only party who can make this true - transferCreatorFeeRecipient is
   * self-service by the current recipient - and it is the second half of the
   * dev's consent: a signature says "these terms", pointing says "and I mean it
   * enough to move my own revenue".
   */
  async confirmPointing(id: string): Promise<OnboardingRecord> {
    const record = await this.#require(id)
    const now = this.#deps.now()
    const recipient = await this.#deps.recipients.creatorFeeRecipient(record.token)
    if (normalizeAddress(recipient) !== normalizeAddress(record.vault)) {
      throw new OnboardingError(
        `fee recipient is ${recipient}, not the vault ${record.vault}`,
        'not_pointed',
        record.state,
      )
    }
    record.pointedAtUnix = now
    record.launchedAtUnix = await this.#deps.recipients.launchedAtUnix(record.token)
    advance(record, 'pointed', 'recipiency_confirmed', now)
    await this.#syncVaultRow(record)
    await this.#deps.store.put(record)
    return record
  }

  /**
   * Step 5. The dev calls acceptService() on their own vault. BOUND -> PENDING.
   *
   * Nobody tells us this happened; we read it. A request that arrives before
   * the chain shows PENDING is refused with what the chain does show, and the
   * caller asks again once the dev's transaction is visible at the pin.
   */
  async recordAcceptance(id: string): Promise<OnboardingRecord> {
    const record = await this.#require(id)
    const now = this.#deps.now()
    if (!canTransition(record.state, 'accepted')) {
      throw new OnboardingError(`cannot go from ${record.state} to accepted`, 'illegal_transition', record.state)
    }
    const chainState = await this.#requireReads(record).state(record.vault)
    if (chainState !== 'PENDING') {
      throw new OnboardingError(
        `chain says ${chainState}, not PENDING; the dev's acceptService() is not visible`,
        'chain_state_mismatch',
        record.state,
      )
    }
    record.acceptedAtUnix = now
    advance(record, 'accepted', 'dev_accepted_service', now)
    await this.#syncVaultRow(record)
    await this.#deps.store.put(record)
    return record
  }

  /**
   * Step 6, OUR AFFIRMATIVE ACTIVATION.
   *
   * Everything that could stop service is re-checked HERE rather than trusted
   * from an earlier step, because time has passed since each of them: a
   * screening can expire, a recipiency can be transferred away again, and the
   * anti-snipe window is a function of the clock.
   */
  async activate(id: string, options: { screeningMaxAgeSeconds: number }): Promise<OnboardingRecord> {
    const record = await this.#require(id)
    const now = this.#deps.now()

    const screening = record.screening
    if (screening === undefined) {
      throw new OnboardingError('no screening on file', 'screening_missing', record.state)
    }
    if (screening.verdict === 'BLOCKED') {
      throw new OnboardingError('screening blocks service', 'screening_blocked', record.state)
    }
    if (now - screening.screenedAtUnix > options.screeningMaxAgeSeconds) {
      throw new OnboardingError('screening has expired; re-screen first', 'screening_stale', record.state)
    }
    if (record.diligence?.admitted !== true) {
      throw new OnboardingError('fraud diligence did not admit this coin', 'diligence_blocked', record.state)
    }

    const launchedAt = record.launchedAtUnix
    if (launchedAt === undefined) {
      throw new OnboardingError('launch time unknown; cannot clear the anti-snipe hold', 'launch_unknown', record.state)
    }
    if (now - launchedAt < this.antiSnipeHoldSeconds) {
      // Charging happens exclusively in ACTIVE, so holding activation is the
      // whole mitigation: the 99%-at-t=0 windfall lands before we are charging.
      throw new OnboardingError(
        `anti-snipe hold: ${String(this.antiSnipeHoldSeconds - (now - launchedAt))}s remaining`,
        'anti_snipe_hold',
        record.state,
      )
    }

    // Re-read recipiency. It is self-service and immediate, so the fact that it
    // pointed at us five minutes ago proves nothing about now.
    const recipient = await this.#deps.recipients.creatorFeeRecipient(record.token)
    if (normalizeAddress(recipient) !== normalizeAddress(record.vault)) {
      throw new OnboardingError(
        'fee recipiency moved away before activation',
        'recipiency_lost',
        record.state,
      )
    }
    if (!(await this.#deps.deployer.isDeployed(record.vault))) {
      throw new OnboardingError('vault is not deployed on chain', 'vault_missing', record.state)
    }

    // The chain must agree that the dev accepted and that nobody activated
    // yet. PENDING is the only state activate() succeeds from; ACTIVE means
    // our own earlier activation landed and the record is catching up.
    const chainState = await this.#requireReads(record).state(record.vault)
    let detail: string
    if (chainState === 'PENDING') {
      detail = (await this.#requireOperator(record).activate(record.vault)).txHash
    } else if (chainState === 'ACTIVE') {
      detail = 'already active on chain'
    } else {
      throw new OnboardingError(
        `chain says ${chainState}, not PENDING; refusing to activate`,
        'chain_state_mismatch',
        record.state,
      )
    }

    record.activatedAtUnix = now
    advance(record, 'active', 'operator_activated', now, detail)
    await this.#syncVaultRow(record)
    await this.#deps.store.put(record)
    return record
  }

  /** The operator declining, at any point before activation. */
  async decline(id: string, code: string, detail?: string): Promise<OnboardingRecord> {
    const record = await this.#require(id)
    const now = this.#deps.now()
    record.declineReason = code
    advance(record, 'declined', code, now, detail)
    await this.#deps.store.put(record)
    return record
  }

  /**
   * The reader's summary of the dev's sources, held for the operator to look
   * at. Recording a candidate is not a decision: the planner still sees no
   * narrative until approveNarrative() stamps it. Only a coin that is pointed
   * at us or further along has a story worth deriving; re-deriving replaces
   * the previous candidate and leaves any approved profile untouched.
   */
  async recordNarrativeCandidate(id: string, candidate: NarrativeCandidate): Promise<OnboardingRecord> {
    const record = await this.#require(id)
    if (!PROMOTION_ELIGIBLE_STATES.includes(record.state)) {
      throw new OnboardingError('narrative may only be derived once pointed', 'narrative_not_eligible', record.state)
    }
    // Validated with a placeholder stamp so a malformed candidate cannot be
    // stored and then approved on trust.
    const checked = validateNarrativeProfile({ ...candidate, approvedAtUnix: 1, approvedBy: 'candidate' })
    record.narrativeCandidate = {
      version: checked.version,
      tagline: checked.tagline,
      themes: checked.themes,
      tone: checked.tone,
      palette: checked.palette,
      sourceHashes: checked.sourceHashes,
    }
    record.updatedAtUnix = this.#deps.now()
    await this.#deps.store.put(record)
    return record
  }

  /** The operator's approval. This is the moment a narrative starts to exist for the planner. */
  async approveNarrative(id: string, approvedBy: string): Promise<OnboardingRecord> {
    const record = await this.#require(id)
    if (record.narrativeCandidate === undefined) {
      throw new OnboardingError('no narrative candidate to approve', 'narrative_candidate_missing', record.state)
    }
    if (!PROMOTION_ELIGIBLE_STATES.includes(record.state)) {
      throw new OnboardingError('narrative may only be approved once pointed', 'narrative_not_eligible', record.state)
    }
    const now = this.#deps.now()
    record.narrative = validateNarrativeProfile({ ...record.narrativeCandidate, approvedAtUnix: now, approvedBy })
    record.updatedAtUnix = now
    await this.#deps.store.put(record)
    return record
  }

  async #require(id: string): Promise<OnboardingRecord> {
    const record = await this.#deps.store.get(id)
    if (record === undefined) {
      throw new OnboardingError(`no onboarding ${id}`, 'not_found', 'drafted')
    }
    return record
  }

  #requireOperator(record: OnboardingRecord): VaultOperatorPort {
    const operator = this.#deps.vaultOperator
    if (operator === undefined) {
      throw new OnboardingError('no operator signer is wired; refusing to write to the vault', 'operator_unwired', record.state)
    }
    return operator
  }

  #requireReads(record: OnboardingRecord): VaultStateReader {
    const reads = this.#deps.vaultReads
    if (reads === undefined) {
      throw new OnboardingError('no chain reader is wired; refusing to guess the vault state', 'chain_reads_unwired', record.state)
    }
    return reads
  }

  /**
   * The fleet's vault_record, projected from this record and the launch
   * factory's per-token terms. Written BEFORE the onboarding record advances
   * in the store, so a projection that failed to write never leaves the
   * source of truth ahead of it. Tier and dial are the fleet's: a row it
   * already raised keeps its values.
   */
  async #syncVaultRow(record: OnboardingRecord): Promise<void> {
    const fleet = this.#deps.fleet
    if (fleet === undefined) return
    const terms = await this.#deps.recipients.launchTerms(record.token)
    const vault = toVault(record, terms.buybackEnabled, terms.creatorTaxBps)
    const existing = await fleet.vaults.get(record.vault)
    if (existing !== undefined) {
      vault.tier = existing.tier
      vault.budgetBps = existing.budgetBps
    }
    await fleet.vaults.put(vault)
  }
}

/**
 * Project an onboarding record into the shared Vault shape. The state is the
 * CoinVault state the record implies - deployed: UNBOUND; bound and pointed:
 * BOUND; accepted: PENDING; active: ACTIVE - which the machine only advances
 * after reading the same thing from the chain. Tier and dial start at their
 * floor; the fleet raises them.
 */
export function toVault(record: OnboardingRecord, buybackEnabled: boolean, creatorTaxBps: number): Vault {
  const vault: Vault = {
    address: record.vault,
    token: record.token,
    consent: record.consent,
    state:
      record.state === 'active'
        ? 'ACTIVE'
        : record.state === 'accepted'
          ? 'PENDING'
          : record.state === 'pointed' || record.state === 'awaiting_pointing'
            ? 'BOUND'
            : 'UNBOUND',
    tier: 'T0',
    budgetBps: 0,
    buybackEnabled,
    creatorTaxBps,
    deployedAtUnix: record.deployedAtUnix ?? record.createdAtUnix,
  }
  if (record.activatedAtUnix !== undefined) vault.activatedAtUnix = record.activatedAtUnix
  return vault
}

export class InMemoryOnboardingStore implements OnboardingStore {
  readonly #byId = new Map<string, OnboardingRecord>()

  async put(record: OnboardingRecord): Promise<void> {
    this.#byId.set(record.id, record)
  }

  async get(id: string): Promise<OnboardingRecord | undefined> {
    return this.#byId.get(id)
  }

  async byToken(token: Address): Promise<OnboardingRecord | undefined> {
    const key = normalizeAddress(token)
    for (const record of this.#byId.values()) {
      if (normalizeAddress(record.token) === key) return record
    }
    return undefined
  }

  async list(): Promise<OnboardingRecord[]> {
    return [...this.#byId.values()]
  }
}
