/**
 * THE DELIVERY-PREDICATE FRAMEWORK.
 *
 * No SKU without a predicate, and no predicate without a verifier that can
 * actually run. Delivery is a machine-checked fact, evaluated on a fixed
 * schedule after funding, and every check fails closed: absent evidence,
 * malformed evidence, and negative evidence are all "not delivered". A vendor
 * that goes dark is a vendor that does not get paid.
 *
 * KOL posts are checked TWICE - at T+24h and again at T+7d - because the
 * failure mode is not "the post never appeared", it is "the post appeared, was
 * paid for, and was quietly deleted a day later". The 7d check also re-verifies
 * that the disclosure is still in the live post, which is the only way the
 * disclosure obligation survives contact with a third party.
 *
 * Baselines are captured BEFORE the purchase. A delta measured against a
 * baseline read after the fact is not a delta.
 */
import type { Address, DeliveryPredicateSpec, PredicateResult } from '@fee-split-vaults/core'
import { BrokerError } from './errors.js'
import { sha256Hex } from './hash.js'
import type { HttpClient } from './http.js'
import { KOL_CHECK_OFFSETS_SECONDS } from './limits.js'

export const PREDICATE_KINDS = [
  'eti_listing',
  'boost_delta',
  'trending_rank',
  'kol_post',
  'manual_attestation',
] as const

export type PredicateKind = (typeof PREDICATE_KINDS)[number]

export function isPredicateKind(value: unknown): value is PredicateKind {
  return typeof value === 'string' && (PREDICATE_KINDS as readonly string[]).includes(value)
}

export interface PredicateParamVocabulary {
  /** Absent means the SKU cannot be verified; the catalog refuses to load it. */
  required: readonly string[]
  /** Read by the verifier when present. */
  optional: readonly string[]
}

/**
 * THE ONE PARAM VOCABULARY. The verifiers below read params by these names and
 * the catalog loader requires them by these names, so a SKU that loads is a SKU
 * whose predicate can run. A second copy of this table anywhere is the bug that
 * shipped a catalog whose every boost SKU failed closed at first verification.
 */
export const PREDICATE_PARAMS: Readonly<Record<PredicateKind, PredicateParamVocabulary>> = {
  eti_listing: {
    required: ['chain', 'pairSource', 'expectFieldPresent'],
    optional: ['minSocialsPresent'],
  },
  boost_delta: {
    required: ['expectedBoostDelta', 'rankSnapshotCount', 'effectWindowSeconds'],
    optional: [],
  },
  trending_rank: {
    required: ['requiredRankMax', 'minChecks', 'jitterSeconds', 'clawback', 'randomized'],
    optional: [],
  },
  kol_post: {
    required: ['requireHandleMatch', 'requireDisclosureLiteral', 'requireStillLive'],
    optional: ['minImpressions24h', 'minImpressions7d'],
  },
  manual_attestation: {
    required: ['evidenceKind'],
    optional: ['coverageSecondsPerUnit', 'assetCount'],
  },
}

export interface EvidenceRef {
  uri: string
  hash: string
}

/** What a pair-record read established about an enhanced listing. */
export interface EtiListingObservation {
  /** Chain id the record was read for. Must equal the predicate's `chain`. */
  chain: string
  /** Which API the record came from. Must equal the predicate's `pairSource`. */
  pairSource: string
  /** Top-level keys present on the pair record. The predicate names one. */
  presentFields: readonly string[]
  /** Distinct social links attached to the record. */
  socialsPresent: number
  ref: EvidenceRef
}

/**
 * The narrow observation surface. Every method returns null when the fact could
 * not be established - transport failure, non-200, malformed body - and null is
 * treated as failure, never as "unknown, try again later and pay anyway".
 */
export interface EvidenceSource {
  etiListing(token: Address): Promise<EtiListingObservation | null>
  boostCount(token: Address): Promise<{ boosts: number; ref: EvidenceRef } | null>
  trendingRank(token: Address): Promise<{ rank: number | null; ref: EvidenceRef } | null>
  post(
    postRef: string,
  ): Promise<{ exists: boolean; impressions: number; containsDisclosure: boolean; ref: EvidenceRef } | null>
  attestation(
    attestationRef: string,
  ): Promise<{ signerId: string; signatureValid: boolean; ref: EvidenceRef } | null>
}

/**
 * What the operator recorded at delivery. Every field here is written by
 * operator code from operator observation. None of it is ever taken from a
 * model output, a community message, or token metadata.
 */
export interface DeliveryRecord {
  disbursementId: string
  vault: Address
  token: Address
  fundedAtUnix: number
  /** The specific post being paid for, recorded when the KOL delivered it. */
  postRef?: string
  attestationRef?: string
  /** Captured before the purchase so that a delta is a real delta. */
  baseline?: { boosts?: number; rank?: number }
}

export interface PredicateCheck {
  spec: DeliveryPredicateSpec
  delivery: DeliveryRecord
  offsetSeconds: number
  nowUnix: number
}

export type Verifier = (check: PredicateCheck, evidence: EvidenceSource) => Promise<PredicateResult>

function result(
  check: PredicateCheck,
  passed: boolean,
  note: string,
  ref?: EvidenceRef,
): PredicateResult {
  const out: PredicateResult = {
    checkedAtUnix: check.nowUnix,
    offsetSeconds: check.offsetSeconds,
    passed,
    note,
  }
  if (ref !== undefined) {
    out.evidenceUri = ref.uri
    out.evidenceHash = ref.hash
  }
  return out
}

function numberParam(spec: DeliveryPredicateSpec, key: string): number | undefined {
  const value = spec.params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BrokerError('measurability', 'bad_param', `predicate param "${key}" is not a number`)
  }
  return value
}

function requiredNumberParam(spec: DeliveryPredicateSpec, key: string): number {
  const value = numberParam(spec, key)
  if (value === undefined) {
    throw new BrokerError('measurability', 'missing_param', `predicate requires param "${key}"`)
  }
  return value
}

function requiredStringParam(spec: DeliveryPredicateSpec, key: string): string {
  const value = spec.params[key]
  if (value === undefined) {
    throw new BrokerError('measurability', 'missing_param', `predicate requires param "${key}"`)
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new BrokerError('measurability', 'bad_param', `predicate param "${key}" is not a string`)
  }
  return value
}

const verifyEtiListing: Verifier = async (check, evidence) => {
  const chain = requiredStringParam(check.spec, 'chain')
  const pairSource = requiredStringParam(check.spec, 'pairSource')
  const field = requiredStringParam(check.spec, 'expectFieldPresent')
  const minSocials = numberParam(check.spec, 'minSocialsPresent') ?? 0
  const observed = await evidence.etiListing(check.delivery.token)
  if (observed === null) {
    return result(check, false, 'listing evidence unavailable')
  }
  if (observed.chain !== chain || observed.pairSource !== pairSource) {
    // Evidence from the wrong chain or the wrong API is not evidence of this SKU.
    return result(
      check,
      false,
      `evidence came from ${observed.pairSource} on chain ${observed.chain}; predicate expects ${pairSource} on ${chain}`,
      observed.ref,
    )
  }
  if (!observed.presentFields.includes(field)) {
    return result(check, false, `pair record carries no "${field}" field`, observed.ref)
  }
  return result(
    check,
    observed.socialsPresent >= minSocials,
    `"${field}" present with ${observed.socialsPresent} socials against a required ${minSocials}`,
    observed.ref,
  )
}

const verifyBoostDelta: Verifier = async (check, evidence) => {
  const expectedDelta = requiredNumberParam(check.spec, 'expectedBoostDelta')
  const snapshots = requiredNumberParam(check.spec, 'rankSnapshotCount')
  const effectWindow = requiredNumberParam(check.spec, 'effectWindowSeconds')
  if (check.spec.verifyAtOffsetsSeconds.length < snapshots) {
    return result(
      check,
      false,
      `${check.spec.verifyAtOffsetsSeconds.length} scheduled checks cannot produce ${snapshots} snapshots`,
    )
  }
  if (check.offsetSeconds > effectWindow) {
    // Boosts decay over hours. A count read after the effect window has closed
    // measures nothing the vendor sold.
    return result(check, false, `check at +${check.offsetSeconds}s is outside the ${effectWindow}s effect window`)
  }
  const baseline = check.delivery.baseline?.boosts
  if (baseline === undefined) {
    return result(check, false, 'no pre-purchase boost baseline was captured')
  }
  const observed = await evidence.boostCount(check.delivery.token)
  if (observed === null) {
    return result(check, false, 'boost evidence unavailable')
  }
  const delta = observed.boosts - baseline
  return result(
    check,
    delta >= expectedDelta,
    `boost delta ${delta} against a required ${expectedDelta}`,
    observed.ref,
  )
}

const verifyTrendingRank: Verifier = async (check, evidence) => {
  const maxRank = requiredNumberParam(check.spec, 'requiredRankMax')
  const observed = await evidence.trendingRank(check.delivery.token)
  if (observed === null) {
    return result(check, false, 'trending evidence unavailable')
  }
  if (observed.rank === null) {
    return result(check, false, 'token does not appear in the trending set', observed.ref)
  }
  return result(
    check,
    observed.rank <= maxRank,
    `rank ${observed.rank} against a required top ${maxRank}`,
    observed.ref,
  )
}

const verifyKolPost: Verifier = async (check, evidence) => {
  const [firstOffset, secondOffset] = KOL_CHECK_OFFSETS_SECONDS
  if (check.offsetSeconds !== firstOffset && check.offsetSeconds !== secondOffset) {
    // A kol_post check at an unscheduled offset is a bug, not a pass.
    return result(check, false, `kol_post has no check defined at +${check.offsetSeconds}s`)
  }
  const postRef = check.delivery.postRef
  if (postRef === undefined || postRef.length === 0) {
    return result(check, false, 'no post reference was recorded at delivery')
  }
  const observed = await evidence.post(postRef)
  if (observed === null) {
    return result(check, false, 'post evidence unavailable')
  }
  if (!observed.exists) {
    return result(
      check,
      false,
      check.offsetSeconds === secondOffset
        ? 'post was deleted before the T+7d check'
        : 'post does not exist',
      observed.ref,
    )
  }
  if (!observed.containsDisclosure) {
    return result(check, false, 'live post does not carry the required disclosure', observed.ref)
  }
  const requiredImpressions =
    check.offsetSeconds === firstOffset
      ? (numberParam(check.spec, 'minImpressions24h') ?? 0)
      : (numberParam(check.spec, 'minImpressions7d') ?? 0)
  return result(
    check,
    observed.impressions >= requiredImpressions,
    `${observed.impressions} impressions against a required ${requiredImpressions}`,
    observed.ref,
  )
}

const verifyManualAttestation: Verifier = async (check, evidence) => {
  const ref = check.delivery.attestationRef
  if (ref === undefined || ref.length === 0) {
    return result(check, false, 'no attestation was recorded')
  }
  const observed = await evidence.attestation(ref)
  if (observed === null) {
    return result(check, false, 'attestation evidence unavailable')
  }
  return result(
    check,
    observed.signatureValid,
    observed.signatureValid
      ? `attested by ${observed.signerId}`
      : 'attestation signature does not verify',
    observed.ref,
  )
}

const VERIFIERS: Readonly<Record<PredicateKind, Verifier>> = {
  eti_listing: verifyEtiListing,
  boost_delta: verifyBoostDelta,
  trending_rank: verifyTrendingRank,
  kol_post: verifyKolPost,
  manual_attestation: verifyManualAttestation,
}

export class PredicateRegistry {
  readonly #evidence: EvidenceSource

  constructor(evidence: EvidenceSource) {
    this.#evidence = evidence
  }

  /** The kinds this runtime can actually verify. The gate reads this. */
  get kinds(): ReadonlySet<string> {
    return new Set(PREDICATE_KINDS)
  }

  async verify(check: PredicateCheck): Promise<PredicateResult> {
    if (!isPredicateKind(check.spec.kind)) {
      throw new BrokerError(
        'measurability',
        'unknown_predicate_kind',
        `no verifier for predicate kind "${String(check.spec.kind)}"`,
      )
    }
    const verifier = VERIFIERS[check.spec.kind]
    try {
      return await verifier(check, this.#evidence)
    } catch (cause) {
      // A verifier that throws has not established delivery. Fail closed.
      return result(check, false, `verifier error: ${String(cause)}`)
    }
  }

  /**
   * Runs every scheduled check whose time has come and which has no result yet.
   * Idempotent: re-running produces nothing for offsets already recorded, so a
   * crashed run can simply be repeated.
   */
  async verifyDue(
    spec: DeliveryPredicateSpec,
    delivery: DeliveryRecord,
    existing: readonly PredicateResult[],
    nowUnix: number,
  ): Promise<PredicateResult[]> {
    const recorded = new Set(existing.map((r) => r.offsetSeconds))
    const fresh: PredicateResult[] = []
    for (const offsetSeconds of [...spec.verifyAtOffsetsSeconds].sort((a, b) => a - b)) {
      if (recorded.has(offsetSeconds)) continue
      if (nowUnix < delivery.fundedAtUnix + offsetSeconds) continue
      fresh.push(await this.verify({ spec, delivery, offsetSeconds, nowUnix }))
    }
    return fresh
  }
}

// ---------------------------------------------------------------------------
// Evidence sources
// ---------------------------------------------------------------------------

export interface HttpEvidenceEndpoints {
  etiListing: (token: Address) => string
  boostCount: (token: Address) => string
  trendingRank: (token: Address) => string
  post: (postRef: string) => string
  attestation: (attestationRef: string) => string
}

export interface HttpEvidenceSourceOptions {
  client: HttpClient
  endpoints: HttpEvidenceEndpoints
  timeoutMs?: number
}

/**
 * Real evidence over HTTP. Every response is content-addressed so the receipt
 * can cite bytes rather than a claim, and every parse failure returns null,
 * which the verifiers treat as "not delivered".
 */
export class HttpEvidenceSource implements EvidenceSource {
  readonly #client: HttpClient
  readonly #endpoints: HttpEvidenceEndpoints
  readonly #timeoutMs: number

  constructor(options: HttpEvidenceSourceOptions) {
    this.#client = options.client
    this.#endpoints = options.endpoints
    this.#timeoutMs = options.timeoutMs ?? 5_000
  }

  async #get(url: string): Promise<{ body: unknown; ref: EvidenceRef } | null> {
    try {
      const response = await this.#client({ method: 'GET', url, timeoutMs: this.#timeoutMs })
      if (!response.ok) return null
      const raw = await response.text()
      return { body: JSON.parse(raw) as unknown, ref: { uri: url, hash: sha256Hex(raw) } }
    } catch {
      return null
    }
  }

  async etiListing(token: Address): Promise<EtiListingObservation | null> {
    const got = await this.#get(this.#endpoints.etiListing(token))
    if (got === null) return null
    const body = got.body as {
      chain?: unknown
      pairSource?: unknown
      presentFields?: unknown
      socialsPresent?: unknown
    }
    if (typeof body.chain !== 'string' || typeof body.pairSource !== 'string') return null
    if (!Array.isArray(body.presentFields) || !body.presentFields.every((f) => typeof f === 'string')) {
      return null
    }
    if (!Number.isInteger(body.socialsPresent) || (body.socialsPresent as number) < 0) return null
    return {
      chain: body.chain,
      pairSource: body.pairSource,
      presentFields: body.presentFields as string[],
      socialsPresent: body.socialsPresent as number,
      ref: got.ref,
    }
  }

  async boostCount(token: Address): Promise<{ boosts: number; ref: EvidenceRef } | null> {
    const got = await this.#get(this.#endpoints.boostCount(token))
    if (got === null) return null
    const boosts = (got.body as { boosts?: unknown }).boosts
    if (typeof boosts !== 'number' || !Number.isFinite(boosts) || boosts < 0) return null
    return { boosts, ref: got.ref }
  }

  async trendingRank(token: Address): Promise<{ rank: number | null; ref: EvidenceRef } | null> {
    const got = await this.#get(this.#endpoints.trendingRank(token))
    if (got === null) return null
    const rank = (got.body as { rank?: unknown }).rank
    if (rank === null) return { rank: null, ref: got.ref }
    if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 1) return null
    return { rank, ref: got.ref }
  }

  async post(postRef: string): Promise<{
    exists: boolean
    impressions: number
    containsDisclosure: boolean
    ref: EvidenceRef
  } | null> {
    const got = await this.#get(this.#endpoints.post(postRef))
    if (got === null) return null
    const body = got.body as {
      exists?: unknown
      impressions?: unknown
      containsDisclosure?: unknown
    }
    if (typeof body.exists !== 'boolean') return null
    if (!body.exists) {
      return { exists: false, impressions: 0, containsDisclosure: false, ref: got.ref }
    }
    if (typeof body.impressions !== 'number' || !Number.isFinite(body.impressions)) return null
    if (typeof body.containsDisclosure !== 'boolean') return null
    return {
      exists: true,
      impressions: body.impressions,
      containsDisclosure: body.containsDisclosure,
      ref: got.ref,
    }
  }

  async attestation(
    attestationRef: string,
  ): Promise<{ signerId: string; signatureValid: boolean; ref: EvidenceRef } | null> {
    const got = await this.#get(this.#endpoints.attestation(attestationRef))
    if (got === null) return null
    const body = got.body as { signerId?: unknown; signatureValid?: unknown }
    if (typeof body.signerId !== 'string' || typeof body.signatureValid !== 'boolean') return null
    return { signerId: body.signerId, signatureValid: body.signatureValid, ref: got.ref }
  }
}

export interface FakeEvidenceSeed {
  eti?: Omit<EtiListingObservation, 'ref'>
  boosts?: number
  rank?: number | null
  posts?: Record<string, { exists: boolean; impressions: number; containsDisclosure: boolean }>
  attestations?: Record<string, { signerId: string; signatureValid: boolean }>
  /** Every read returns null, simulating an unreachable evidence provider. */
  offline?: boolean
}

/** In-memory evidence for tests. Mutable so a post can be deleted mid-window. */
export class FakeEvidenceSource implements EvidenceSource {
  seed: FakeEvidenceSeed

  constructor(seed: FakeEvidenceSeed = {}) {
    this.seed = seed
  }

  #ref(kind: string): EvidenceRef {
    return { uri: `memory://${kind}`, hash: sha256Hex(`${kind}:${JSON.stringify(this.seed)}`) }
  }

  async etiListing(): Promise<EtiListingObservation | null> {
    if (this.seed.offline === true || this.seed.eti === undefined) return null
    return { ...this.seed.eti, ref: this.#ref('eti') }
  }

  async boostCount(): Promise<{ boosts: number; ref: EvidenceRef } | null> {
    if (this.seed.offline === true || this.seed.boosts === undefined) return null
    return { boosts: this.seed.boosts, ref: this.#ref('boosts') }
  }

  async trendingRank(): Promise<{ rank: number | null; ref: EvidenceRef } | null> {
    if (this.seed.offline === true || this.seed.rank === undefined) return null
    return { rank: this.seed.rank, ref: this.#ref('trending') }
  }

  async post(postRef: string): Promise<{
    exists: boolean
    impressions: number
    containsDisclosure: boolean
    ref: EvidenceRef
  } | null> {
    if (this.seed.offline === true) return null
    const post = this.seed.posts?.[postRef]
    if (post === undefined) return null
    return { ...post, ref: this.#ref(`post:${postRef}`) }
  }

  async attestation(
    attestationRef: string,
  ): Promise<{ signerId: string; signatureValid: boolean; ref: EvidenceRef } | null> {
    if (this.seed.offline === true) return null
    const attestation = this.seed.attestations?.[attestationRef]
    if (attestation === undefined) return null
    return { ...attestation, ref: this.#ref(`attestation:${attestationRef}`) }
  }
}
