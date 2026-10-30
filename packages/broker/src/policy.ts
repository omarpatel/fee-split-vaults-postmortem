/**
 * THE SIGNED POLICY OBJECT.
 *
 * Every spend decision is made against a short-lived, service-key-signed token.
 * Three properties matter and all three are structural:
 *
 *   1. NO MODEL CONTEXT CAN REACH THE KEY. The key material lives behind a
 *      keyring whose toJSON and inspect hooks redact it, so a token cannot leak
 *      by being accidentally serialised into a prompt, a log line, or a digest.
 *   2. NO MODEL CONTEXT CAN FORGE THE TOKEN. The planner has no signer, and the
 *      broker will not evaluate a proposal without a valid signature.
 *   3. A TOKEN CANNOT LOOSEN A LIMIT. Compiled SPEND_LIMITS is the ceiling; a
 *      token that tries to raise any cap is refused outright rather than
 *      clamped, because a loosened token is evidence of key misuse, not a
 *      configuration choice. Tightening is honoured.
 *
 * Fetch failure, malformed payload, unknown key id, bad signature, TTL longer
 * than SPEND_LIMITS.policyTokenTtlSeconds, expiry, or a token bound to a
 * different vault all mean the same thing: NO SPEND.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Address, AssetAddress } from '@fee-split-vaults/core'
import { PolicyError } from './errors.js'
import { exactCentsFromUsd, fractionToBps, CLOCK_SKEW_TOLERANCE_SECONDS } from './money.js'
import { SPEND_LIMITS, TIER_ORDER } from './protocol.js'
import type { TierId } from './protocol.js'
import type { HttpClient } from './http.js'

/** Mirrors SPEND_LIMITS. A token may lower any of these; never raise one. */
export interface PolicyLimits {
  rollingCapOfMedian: number
  lifetimeCapOfRealizedFees: number
  humanApprovalThresholdUsd: number
  fleetVendorDailyCapUsd: number
  relatedPartyCapOf30dBudget: number
}

export interface PolicyClaims {
  /** Schema version. Unknown versions are refused, never best-effort parsed. */
  v: 1
  /** Key id, so the service key can be rotated without a deploy. */
  kid: string
  vault: Address
  tier: TierId
  /** Fleet-wide kill switch. False means no spend for anyone. */
  spendEnabled: boolean
  /**
   * Per-asset kill switch. Every approved quote asset on this chain is an
   * upgradeable, pausable, issuer-controlled proxy; an asset that has been
   * paused, upgraded, or otherwise made suspect is removed from this list and
   * settlement in it stops without a deploy. An asset absent from the list is
   * disabled - the list is an allowlist, not a denylist.
   */
  enabledAssets: AssetAddress[]
  limits: PolicyLimits
  issuedAtUnix: number
  expiresAtUnix: number
  nonce: string
}

/** Integer form of the limits actually in force for one decision. */
export interface EffectiveLimits {
  rollingCapOfMedianBps: number
  lifetimeCapOfRealizedFeesBps: number
  humanApprovalThresholdCents: bigint
  fleetVendorDailyCapCents: bigint
  relatedPartyCapOf30dBudgetBps: number
}

export interface VerifiedPolicy {
  claims: PolicyClaims
  limits: EffectiveLimits
  verifiedAtUnix: number
}

const CLAIM_KEYS: ReadonlySet<string> = new Set([
  'v',
  'kid',
  'vault',
  'tier',
  'spendEnabled',
  'enabledAssets',
  'limits',
  'issuedAtUnix',
  'expiresAtUnix',
  'nonce',
])

const LIMIT_KEYS: ReadonlySet<string> = new Set([
  'rollingCapOfMedian',
  'lifetimeCapOfRealizedFees',
  'humanApprovalThresholdUsd',
  'fleetVendorDailyCapUsd',
  'relatedPartyCapOf30dBudget',
])

/**
 * Holds service key material. Redacted on every serialisation path so that a
 * key cannot ride into a model context inside a logged object graph.
 */
export class PolicyKeyring {
  readonly #keys: Map<string, Buffer>

  constructor(keys: Record<string, string | Uint8Array>) {
    this.#keys = new Map()
    for (const [kid, key] of Object.entries(keys)) {
      const buf = typeof key === 'string' ? Buffer.from(key, 'utf8') : Buffer.from(key)
      if (buf.length < 32) {
        throw new PolicyError('weak_key', `service key "${kid}" is shorter than 32 bytes`)
      }
      this.#keys.set(kid, buf)
    }
    if (this.#keys.size === 0) {
      throw new PolicyError('no_keys', 'keyring is empty; refusing to start')
    }
  }

  keyFor(kid: string): Buffer | undefined {
    return this.#keys.get(kid)
  }

  get keyIds(): string[] {
    return [...this.#keys.keys()]
  }

  toJSON(): string {
    return '[redacted:PolicyKeyring]'
  }

  toString(): string {
    return '[redacted:PolicyKeyring]'
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[redacted:PolicyKeyring]'
  }
}

function canonicalJson(claims: PolicyClaims): string {
  // Field order is fixed so that signing and verification agree byte for byte.
  return JSON.stringify({
    v: claims.v,
    kid: claims.kid,
    vault: claims.vault,
    tier: claims.tier,
    spendEnabled: claims.spendEnabled,
    enabledAssets: [...claims.enabledAssets].sort(),
    limits: {
      rollingCapOfMedian: claims.limits.rollingCapOfMedian,
      lifetimeCapOfRealizedFees: claims.limits.lifetimeCapOfRealizedFees,
      humanApprovalThresholdUsd: claims.limits.humanApprovalThresholdUsd,
      fleetVendorDailyCapUsd: claims.limits.fleetVendorDailyCapUsd,
      relatedPartyCapOf30dBudget: claims.limits.relatedPartyCapOf30dBudget,
    },
    issuedAtUnix: claims.issuedAtUnix,
    expiresAtUnix: claims.expiresAtUnix,
    nonce: claims.nonce,
  })
}

function mac(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload, 'utf8').digest('hex')
}

/**
 * Mints policy tokens. Lives in the control plane. There is deliberately no
 * path from the planner or any model-facing surface to an instance of this.
 */
export class PolicyTokenSigner {
  readonly #keyring: PolicyKeyring
  readonly #kid: string

  constructor(keyring: PolicyKeyring, kid: string) {
    if (keyring.keyFor(kid) === undefined) {
      throw new PolicyError('unknown_kid', `keyring has no key "${kid}"`)
    }
    this.#keyring = keyring
    this.#kid = kid
  }

  sign(claims: Omit<PolicyClaims, 'kid'>): string {
    const full: PolicyClaims = { ...claims, kid: this.#kid }
    const key = this.#keyring.keyFor(this.#kid)
    if (key === undefined) {
      throw new PolicyError('unknown_kid', `keyring has no key "${this.#kid}"`)
    }
    const payload = Buffer.from(canonicalJson(full), 'utf8').toString('base64url')
    return `${payload}.${mac(key, payload)}`
  }

  toJSON(): string {
    return '[redacted:PolicyTokenSigner]'
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[redacted:PolicyTokenSigner]'
  }
}

function asFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PolicyError('bad_claim', `${field} must be a finite number`)
  }
  return value
}

function parseLimits(raw: unknown): PolicyLimits {
  if (typeof raw !== 'object' || raw === null) {
    throw new PolicyError('bad_claim', 'limits must be an object')
  }
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (!LIMIT_KEYS.has(key)) {
      throw new PolicyError('bad_claim', `unexpected limit "${key}" - schema is closed`)
    }
  }
  const r = raw as Record<string, unknown>
  return {
    rollingCapOfMedian: asFiniteNumber(r.rollingCapOfMedian, 'limits.rollingCapOfMedian'),
    lifetimeCapOfRealizedFees: asFiniteNumber(
      r.lifetimeCapOfRealizedFees,
      'limits.lifetimeCapOfRealizedFees',
    ),
    humanApprovalThresholdUsd: asFiniteNumber(
      r.humanApprovalThresholdUsd,
      'limits.humanApprovalThresholdUsd',
    ),
    fleetVendorDailyCapUsd: asFiniteNumber(
      r.fleetVendorDailyCapUsd,
      'limits.fleetVendorDailyCapUsd',
    ),
    relatedPartyCapOf30dBudget: asFiniteNumber(
      r.relatedPartyCapOf30dBudget,
      'limits.relatedPartyCapOf30dBudget',
    ),
  }
}

function parseClaims(raw: unknown): PolicyClaims {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PolicyError('bad_claim', 'claims must be an object')
  }
  const r = raw as Record<string, unknown>
  for (const key of Object.keys(r)) {
    if (!CLAIM_KEYS.has(key)) {
      throw new PolicyError('bad_claim', `unexpected claim "${key}" - schema is closed`)
    }
  }
  if (r.v !== 1) {
    throw new PolicyError('bad_version', `unsupported policy version ${String(r.v)}`)
  }
  if (typeof r.kid !== 'string' || r.kid.length === 0) {
    throw new PolicyError('bad_claim', 'kid must be a non-empty string')
  }
  if (typeof r.vault !== 'string' || r.vault.length === 0) {
    throw new PolicyError('bad_claim', 'vault must be a non-empty string')
  }
  if (typeof r.tier !== 'string' || !(TIER_ORDER as readonly string[]).includes(r.tier)) {
    throw new PolicyError('bad_claim', `unknown tier "${String(r.tier)}"`)
  }
  if (typeof r.spendEnabled !== 'boolean') {
    throw new PolicyError('bad_claim', 'spendEnabled must be a boolean')
  }
  if (!Array.isArray(r.enabledAssets) || r.enabledAssets.some((a) => typeof a !== 'string')) {
    throw new PolicyError('bad_claim', 'enabledAssets must be an array of addresses')
  }
  if (typeof r.nonce !== 'string' || r.nonce.length === 0) {
    throw new PolicyError('bad_claim', 'nonce must be a non-empty string')
  }
  return {
    v: 1,
    kid: r.kid,
    vault: r.vault,
    tier: r.tier as TierId,
    spendEnabled: r.spendEnabled,
    enabledAssets: r.enabledAssets as AssetAddress[],
    limits: parseLimits(r.limits),
    issuedAtUnix: asFiniteNumber(r.issuedAtUnix, 'issuedAtUnix'),
    expiresAtUnix: asFiniteNumber(r.expiresAtUnix, 'expiresAtUnix'),
    nonce: r.nonce,
  }
}

/**
 * A token may only tighten. Any attempt to raise a compiled ceiling is refused,
 * so a stolen key still cannot widen the blast radius beyond what shipped.
 */
function assertNotLoosened(limits: PolicyLimits): void {
  const checks: Array<[keyof PolicyLimits, number]> = [
    ['rollingCapOfMedian', SPEND_LIMITS.rollingCapOfMedian],
    ['lifetimeCapOfRealizedFees', SPEND_LIMITS.lifetimeCapOfRealizedFees],
    ['humanApprovalThresholdUsd', SPEND_LIMITS.humanApprovalThresholdUsd],
    ['fleetVendorDailyCapUsd', SPEND_LIMITS.fleetVendorDailyCapUsd],
    ['relatedPartyCapOf30dBudget', SPEND_LIMITS.relatedPartyCapOf30dBudget],
  ]
  for (const [key, compiled] of checks) {
    const proposed = limits[key]
    if (proposed < 0) {
      throw new PolicyError('bad_claim', `limits.${key} is negative`)
    }
    if (proposed > compiled) {
      throw new PolicyError(
        'limit_loosened',
        `limits.${key} (${proposed}) exceeds the compiled ceiling (${compiled})`,
      )
    }
  }
}

function toEffectiveLimits(limits: PolicyLimits): EffectiveLimits {
  return {
    rollingCapOfMedianBps: fractionToBps(limits.rollingCapOfMedian, 'rollingCapOfMedian'),
    lifetimeCapOfRealizedFeesBps: fractionToBps(
      limits.lifetimeCapOfRealizedFees,
      'lifetimeCapOfRealizedFees',
    ),
    humanApprovalThresholdCents: exactCentsFromUsd(
      limits.humanApprovalThresholdUsd,
      'humanApprovalThresholdUsd',
    ),
    fleetVendorDailyCapCents: exactCentsFromUsd(
      limits.fleetVendorDailyCapUsd,
      'fleetVendorDailyCapUsd',
    ),
    relatedPartyCapOf30dBudgetBps: fractionToBps(
      limits.relatedPartyCapOf30dBudget,
      'relatedPartyCapOf30dBudget',
    ),
  }
}

/** The compiled ceiling, as a token payload. Used by the control plane. */
export function compiledPolicyLimits(): PolicyLimits {
  return {
    rollingCapOfMedian: SPEND_LIMITS.rollingCapOfMedian,
    lifetimeCapOfRealizedFees: SPEND_LIMITS.lifetimeCapOfRealizedFees,
    humanApprovalThresholdUsd: SPEND_LIMITS.humanApprovalThresholdUsd,
    fleetVendorDailyCapUsd: SPEND_LIMITS.fleetVendorDailyCapUsd,
    relatedPartyCapOf30dBudget: SPEND_LIMITS.relatedPartyCapOf30dBudget,
  }
}

export function verifyPolicyToken(
  token: string,
  keyring: PolicyKeyring,
  vault: Address,
  nowUnix: number,
): VerifiedPolicy {
  if (typeof token !== 'string' || token.length === 0 || token.length > 8_192) {
    throw new PolicyError('malformed', 'token is empty or implausibly large')
  }
  const parts = token.split('.')
  if (parts.length !== 2) {
    throw new PolicyError('malformed', 'token must be <payload>.<mac>')
  }
  const [payload, providedMac] = parts
  if (payload === undefined || providedMac === undefined) {
    throw new PolicyError('malformed', 'token is missing a segment')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    throw new PolicyError('malformed', 'token payload is not valid JSON')
  }
  const claims = parseClaims(parsed)

  const key = keyring.keyFor(claims.kid)
  if (key === undefined) {
    throw new PolicyError('unknown_kid', `no service key for kid "${claims.kid}"`)
  }
  const expectedMac = mac(key, payload)
  const a = Buffer.from(expectedMac, 'utf8')
  const b = Buffer.from(providedMac, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new PolicyError('bad_signature', 'policy token signature does not verify')
  }

  // Re-signing the parsed claims must reproduce the payload byte for byte. This
  // closes the gap where a field the parser ignores rides along inside a
  // validly signed envelope.
  const reencoded = Buffer.from(canonicalJson(claims), 'utf8').toString('base64url')
  if (reencoded !== payload) {
    throw new PolicyError('non_canonical', 'token payload is not in canonical form')
  }

  const ttl = claims.expiresAtUnix - claims.issuedAtUnix
  if (ttl <= 0) {
    throw new PolicyError('bad_ttl', 'token expires at or before it was issued')
  }
  if (ttl > SPEND_LIMITS.policyTokenTtlSeconds) {
    throw new PolicyError(
      'bad_ttl',
      `token TTL ${ttl}s exceeds the ${SPEND_LIMITS.policyTokenTtlSeconds}s ceiling`,
    )
  }
  if (claims.issuedAtUnix > nowUnix + CLOCK_SKEW_TOLERANCE_SECONDS) {
    throw new PolicyError('not_yet_valid', 'token was issued in the future')
  }
  if (claims.expiresAtUnix <= nowUnix) {
    throw new PolicyError('expired', `token expired ${nowUnix - claims.expiresAtUnix}s ago`)
  }
  if (claims.vault !== vault) {
    throw new PolicyError('wrong_vault', 'token is bound to a different vault')
  }

  assertNotLoosened(claims.limits)

  return { claims, limits: toEffectiveLimits(claims.limits), verifiedAtUnix: nowUnix }
}

/** Where a token comes from. Any failure here means NO SPEND. */
export interface PolicyService {
  fetch(vault: Address, nowUnix: number): Promise<string>
}

export interface HttpPolicyServiceOptions {
  endpoint: string
  client: HttpClient
  timeoutMs?: number
  /** Sent as a bearer credential. Never appears in a decision or a receipt. */
  serviceToken?: string
}

export class HttpPolicyService implements PolicyService {
  readonly #endpoint: string
  readonly #client: HttpClient
  readonly #timeoutMs: number
  readonly #serviceToken: string | undefined

  constructor(options: HttpPolicyServiceOptions) {
    this.#endpoint = options.endpoint
    this.#client = options.client
    this.#timeoutMs = options.timeoutMs ?? 2_000
    this.#serviceToken = options.serviceToken
  }

  async fetch(vault: Address, nowUnix: number): Promise<string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.#serviceToken !== undefined) {
      headers.authorization = `Bearer ${this.#serviceToken}`
    }
    let response
    try {
      response = await this.#client({
        method: 'POST',
        url: this.#endpoint,
        headers,
        body: JSON.stringify({ vault, atUnix: nowUnix }),
        timeoutMs: this.#timeoutMs,
      })
    } catch (cause) {
      throw new PolicyError('fetch_failed', `policy service unreachable: ${String(cause)}`)
    }
    if (!response.ok) {
      throw new PolicyError('fetch_failed', `policy service returned ${response.status}`)
    }
    const body = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      throw new PolicyError('fetch_failed', 'policy service returned non-JSON')
    }
    const token = (parsed as { token?: unknown }).token
    if (typeof token !== 'string' || token.length === 0) {
      throw new PolicyError('fetch_failed', 'policy service response has no token')
    }
    return token
  }

  toJSON(): string {
    return '[redacted:HttpPolicyService]'
  }
}

/** In-memory service for tests. Mints a token with the compiled ceiling. */
export class InMemoryPolicyService implements PolicyService {
  #failNext = false

  constructor(
    private readonly signer: PolicyTokenSigner,
    private readonly template: {
      tier: TierId
      spendEnabled?: boolean
      enabledAssets: AssetAddress[]
      limits?: Partial<PolicyLimits>
      ttlSeconds?: number
    },
  ) {}

  /** Simulates the fetch failure that must translate into a refusal. */
  failNextFetch(): void {
    this.#failNext = true
  }

  async fetch(vault: Address, nowUnix: number): Promise<string> {
    if (this.#failNext) {
      this.#failNext = false
      throw new PolicyError('fetch_failed', 'simulated policy service outage')
    }
    const ttl = this.template.ttlSeconds ?? SPEND_LIMITS.policyTokenTtlSeconds
    return this.signer.sign({
      v: 1,
      vault,
      tier: this.template.tier,
      spendEnabled: this.template.spendEnabled ?? true,
      enabledAssets: this.template.enabledAssets,
      limits: { ...compiledPolicyLimits(), ...this.template.limits },
      issuedAtUnix: nowUnix,
      expiresAtUnix: nowUnix + ttl,
      nonce: `${vault}:${nowUnix}`,
    })
  }
}
