/**
 * Commercial validation of a consent, as opposed to the structural validation
 * in eip712.ts.
 *
 * The distinction matters: eip712 refuses a struct that CANNOT BE ENCODED, and
 * this refuses a struct that could be encoded perfectly well but offers terms
 * the operator does not offer. Both run, in that order, and a consent that
 * fails either is never presented to a dev for signature.
 *
 * OPERATOR_BPS IS A PARAMETER, NOT A CONSTANT, AND IT HAS ALREADY MOVED ONCE.
 * config/protocol.ts carries the reasoning: Phase 0 measured live take rates of
 * 0%, 1% and 5% on this platform, the 10% benchmark the original spec used is
 * unverified, and the rate is now the 500bps market norm. Nothing in this module
 * writes that number down - it reads TERMS.operatorBps and refuses anything
 * above it, so the pricing decision stays one edit in one file. Because
 * operatorBps is inside the CREATE2 salt, changing it can only ever affect NEW
 * customers. An existing vault's rate is unrepresentable-to-change.
 */

import type { Address, Consent } from '@fee-split-vaults/core'
import { TERMS } from '../../../config/protocol.js'
import { isAddress, isBytes32, normalizeAddress } from './crypto/address.js'
import { ConsentError, assertEncodableConsent } from './eip712.js'

/** Structural rails the factory enforces on chain. Mirrored so we refuse first. */
export const MAX_OPERATOR_BPS = 2_000
export const MAX_BUDGET_BPS_MAX = 5_000

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export interface ConsentDraftInput {
  devSigner: Address
  devPayout: Address
  /** Zero on the greenfield path, where bind() supplies the token later. */
  token?: Address
  termsHash: string
  /** Defaults to TERMS.operatorBps. Offering LESS is allowed; more is not. */
  operatorBps?: number
  budgetBpsMax?: number
  adapter: Address
  referrer?: Address
  referrerBps?: number
  /** Seconds from now. Bounded so a stale draft cannot be deployed months later. */
  ttlSeconds?: number
  /** 32-byte hex. Two identical term sets can still be two distinct vaults. */
  nonce: string
  nowUnix: number
}

/** A signature older than this cannot deploy. Long enough for a hardware wallet. */
export const MAX_CONSENT_TTL_SECONDS = 7 * 24 * 60 * 60
export const DEFAULT_CONSENT_TTL_SECONDS = 24 * 60 * 60

/**
 * Build the consent the operator is willing to sign against.
 *
 * The client supplies WHO and WHICH TOKEN. It does not supply the rate: every
 * economic field is defaulted from config and then bounds-checked, so a crafted
 * request cannot talk the service into offering terms nobody approved.
 */
export function draftConsent(input: ConsentDraftInput): Consent {
  const operatorBps = input.operatorBps ?? TERMS.operatorBps
  const budgetBpsMax = input.budgetBpsMax ?? TERMS.budgetBpsMax
  const referrer = input.referrer ?? ZERO_ADDRESS
  const referrerBps = input.referrerBps ?? 0
  const ttl = input.ttlSeconds ?? DEFAULT_CONSENT_TTL_SECONDS

  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_CONSENT_TTL_SECONDS) {
    throw new ConsentError(`ttlSeconds must be 1..${String(MAX_CONSENT_TTL_SECONDS)}`, 'ttlSeconds')
  }

  const consent: Consent = {
    devSigner: normalizeAddress(input.devSigner),
    devPayout: normalizeAddress(input.devPayout),
    token: normalizeAddress(input.token ?? ZERO_ADDRESS),
    termsHash: input.termsHash,
    operatorBps,
    budgetBpsMax,
    adapter: normalizeAddress(input.adapter),
    referrer: normalizeAddress(referrer),
    referrerBps,
    expiryUnix: input.nowUnix + ttl,
    nonce: input.nonce,
  }
  assertCommercialTerms(consent)
  return consent
}

/**
 * Every check that would make an offer illegitimate rather than unencodable.
 *
 * Run on the way IN as well as the way out: a client may post a whole consent
 * for signature-verification, and a consent the operator would never have
 * offered must not be honoured just because a dev signed it.
 */
export function assertCommercialTerms(consent: Consent): void {
  assertEncodableConsent(consent)

  if (!isBytes32(consent.termsHash)) {
    throw new ConsentError('termsHash must be a 32-byte hash of the versioned MSA', 'termsHash')
  }
  if (consent.operatorBps > TERMS.operatorBps) {
    throw new ConsentError(
      `operatorBps ${String(consent.operatorBps)} exceeds the published rate ${String(TERMS.operatorBps)}`,
      'operatorBps',
    )
  }
  if (consent.operatorBps > MAX_OPERATOR_BPS) {
    throw new ConsentError('operatorBps exceeds the factory rail', 'operatorBps')
  }
  if (consent.budgetBpsMax > TERMS.budgetBpsMax || consent.budgetBpsMax > MAX_BUDGET_BPS_MAX) {
    throw new ConsentError('budgetBpsMax exceeds the published ceiling', 'budgetBpsMax')
  }
  if (consent.referrerBps > 10_000) {
    throw new ConsentError('referrerBps must be a share of operatorBps, in bps', 'referrerBps')
  }
  if (consent.referrerBps > 0 && consent.referrer === ZERO_ADDRESS) {
    throw new ConsentError('referrerBps set with no referrer', 'referrer')
  }
  // The referrer is paid out of the OPERATOR's slice, never the dev's, so a
  // referral can never dilute the client. If referrerBps could exceed the
  // operator's own take it would have to come from somewhere else.
  if (consent.referrer !== ZERO_ADDRESS && consent.operatorBps === 0) {
    throw new ConsentError('a referrer cannot be paid out of a zero operator slice', 'referrer')
  }
  if (consent.devPayout === ZERO_ADDRESS) {
    throw new ConsentError('devPayout is the sole withdrawer of the dev leg; it cannot be zero', 'devPayout')
  }
  if (consent.adapter === ZERO_ADDRESS) {
    throw new ConsentError('adapter must be pinned at signing time', 'adapter')
  }
  if (!isAddress(consent.devSigner) || consent.devSigner === ZERO_ADDRESS) {
    throw new ConsentError('devSigner must be a real address', 'devSigner')
  }
  // The dev's share at the maximum dial. devBps() would go negative before this
  // trips, so it is checked as a number rather than trusted to the helper.
  const devFloorBps = 10_000 - consent.operatorBps - consent.budgetBpsMax
  if (devFloorBps <= 0) {
    throw new ConsentError('these terms leave the dev nothing at the maximum dial', 'budgetBpsMax')
  }
}

/** What the dev is agreeing to, in the dev's own terms, for the signing screen. */
export interface ConsentSummary {
  operatorBps: number
  budgetBpsMax: number
  /** The dev's share at the DEFAULT dial, and at the worst legal dial. */
  devBpsAtDefaultDial: number
  devBpsAtMaxDial: number
  /** What the service must deliver for the dev to break even, at each dial. */
  breakEvenMultipleAtDefaultDial: number
  breakEvenMultipleAtMaxDial: number
  expiryUnix: number
  vault: Address
}

export function summariseConsent(
  consent: Consent,
  vault: Address,
  defaultDialBps = TERMS.budgetBpsDefault,
): ConsentSummary {
  const devAtDefault = 10_000 - consent.operatorBps - Math.min(defaultDialBps, consent.budgetBpsMax)
  const devAtMax = 10_000 - consent.operatorBps - consent.budgetBpsMax
  return {
    operatorBps: consent.operatorBps,
    budgetBpsMax: consent.budgetBpsMax,
    devBpsAtDefaultDial: devAtDefault,
    devBpsAtMaxDial: devAtMax,
    breakEvenMultipleAtDefaultDial: 10_000 / devAtDefault,
    breakEvenMultipleAtMaxDial: 10_000 / devAtMax,
    expiryUnix: consent.expiryUnix,
    vault,
  }
}
