/**
 * THE DEV DASHBOARD'S SIGN-IN.
 *
 * There is no password and no account. A dev proves they hold an address by
 * signing, with that wallet, a message this service issued a moment ago. The
 * message says in plain words that it moves nothing, because the habit this
 * industry teaches devs is to sign whatever appears.
 *
 * THREE RULES THIS MODULE HOLDS.
 *
 *   1. THE NONCE IS SINGLE-USE, AND USE IS ANY PRESENTATION. A challenge is
 *      consumed the first time /v1/auth/verify names it, whether or not the
 *      signature checks out. A replay of a good signature is refused by the
 *      consumed row; a guess against a bad one costs a fresh challenge.
 *
 *   2. THE MESSAGE IS COMPARED BYTE FOR BYTE. The verify body carries the
 *      message back, but the service does not verify what it is handed: it
 *      loads the message it issued for that nonce and refuses anything that
 *      is not identical. A client cannot get a dev to sign a different text
 *      and have it count.
 *
 *   3. THE BEARER IS NEVER STORED. Only its sha256 is, so a read of the
 *      session table yields nothing a request can carry.
 */

import { createHash, randomBytes } from 'node:crypto'

import type { Address } from '@fee-split-vaults/core'

import {
  addressFromPublicKey,
  concatBytes,
  hexToBytes,
  keccakHex,
  normalizeAddress,
  utf8,
} from '../crypto/address.js'
import { parseSignature, recoverPublicKey } from '../crypto/secp256k1.js'
import type { DevSessionVerifier } from '../http/server.js'

/** A challenge outlives a hardware-wallet prompt and nothing longer. */
export const CHALLENGE_TTL_SECONDS = 10 * 60
/** One working day. Reloading the page costs one signature. */
export const SESSION_TTL_SECONDS = 24 * 60 * 60

export interface DevChallenge {
  nonce: string
  address: Address
  message: string
  issuedAtUnix: number
  expiresAtUnix: number
}

export interface DevSession {
  id: string
  /** sha256 of the bearer, lowercase hex. The bearer itself is not held. */
  tokenHash: string
  address: Address
  issuedAtUnix: number
  expiresAtUnix: number
}

export interface DevSessionStore {
  putChallenge(challenge: DevChallenge): Promise<void>
  /**
   * Mark the challenge consumed and return it. Undefined when there is no
   * such nonce or it was already consumed; the caller treats both as a
   * refusal. MUST be atomic: two concurrent presentations get one success.
   */
  consumeChallenge(nonce: string, atUnix: number): Promise<DevChallenge | undefined>
  putSession(session: DevSession): Promise<void>
  sessionByTokenHash(tokenHash: string): Promise<DevSession | undefined>
}

export class InMemoryDevSessionStore implements DevSessionStore {
  readonly #challenges = new Map<string, DevChallenge & { consumedAtUnix?: number }>()
  readonly #sessions = new Map<string, DevSession>()

  async putChallenge(challenge: DevChallenge): Promise<void> {
    this.#challenges.set(challenge.nonce, { ...challenge })
  }

  async consumeChallenge(nonce: string, atUnix: number): Promise<DevChallenge | undefined> {
    const held = this.#challenges.get(nonce)
    if (held === undefined || held.consumedAtUnix !== undefined) return undefined
    held.consumedAtUnix = atUnix
    const { consumedAtUnix: _consumed, ...challenge } = held
    return challenge
  }

  async putSession(session: DevSession): Promise<void> {
    this.#sessions.set(session.tokenHash, { ...session })
  }

  async sessionByTokenHash(tokenHash: string): Promise<DevSession | undefined> {
    const held = this.#sessions.get(tokenHash)
    return held === undefined ? undefined : { ...held }
  }
}

// ---------------------------------------------------------------------------
// The message and its signature
// ---------------------------------------------------------------------------

const NONCE_LINE = /^Nonce: (0x[0-9a-f]{64})$/m

export function challengeMessage(input: {
  issuer: string
  address: Address
  nonce: string
  issuedAtUnix: number
  expiresAtUnix: number
}): string {
  return [
    `${input.issuer} asks you to sign in with your Ethereum account:`,
    input.address,
    '',
    'This signature authorises no transfer and changes nothing on chain. It only proves you hold this address.',
    '',
    `Nonce: ${input.nonce}`,
    `Issued at: ${new Date(input.issuedAtUnix * 1000).toISOString()}`,
    `Expires at: ${new Date(input.expiresAtUnix * 1000).toISOString()}`,
  ].join('\n')
}

/** The nonce a signed message names, or undefined when it names none. */
export function nonceOf(message: string): string | undefined {
  return NONCE_LINE.exec(message)?.[1]
}

/** EIP-191 personal_sign digest: keccak("\x19Ethereum Signed Message:\n" + len + message). */
export function personalSignDigest(message: string): string {
  const body = utf8(message)
  return keccakHex(concatBytes(utf8(`\u0019Ethereum Signed Message:\n${String(body.length)}`), body))
}

/** The address that produced `signatureHex` over `message`, or undefined. Never throws. */
export function recoverPersonalSigner(message: string, signatureHex: string): Address | undefined {
  try {
    const sig = parseSignature(hexToBytes(signatureHex))
    return addressFromPublicKey(recoverPublicKey(hexToBytes(personalSignDigest(message)), sig))
  } catch {
    return undefined
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface DevAuthOptions {
  store: DevSessionStore
  /** Names the service in the wallet prompt. The operator's legal name. */
  issuer: string
  now: () => number
  /** Injected for determinism in tests. Default: node's CSPRNG. */
  randomHex?: (bytes: number) => string
}

export type VerifyOutcome =
  | { ok: true; token: string; session: DevSession }
  | { ok: false; reason: 'no_such_challenge' | 'challenge_expired' | 'message_mismatch' | 'address_mismatch' | 'signature_invalid' }

export class DevAuth implements DevSessionVerifier {
  readonly #store: DevSessionStore
  readonly #issuer: string
  readonly #now: () => number
  readonly #randomHex: (bytes: number) => string

  constructor(options: DevAuthOptions) {
    this.#store = options.store
    this.#issuer = options.issuer
    this.#now = options.now
    this.#randomHex = options.randomHex ?? ((bytes) => randomBytes(bytes).toString('hex'))
  }

  async challenge(address: Address): Promise<DevChallenge> {
    const issuedAtUnix = this.#now()
    const expiresAtUnix = issuedAtUnix + CHALLENGE_TTL_SECONDS
    const nonce = `0x${this.#randomHex(32)}`
    const normalized = normalizeAddress(address)
    const challenge: DevChallenge = {
      nonce,
      address: normalized,
      message: challengeMessage({ issuer: this.#issuer, address: normalized, nonce, issuedAtUnix, expiresAtUnix }),
      issuedAtUnix,
      expiresAtUnix,
    }
    await this.#store.putChallenge(challenge)
    return challenge
  }

  /** /v1/auth/verify: the signature exchange. Consumes the challenge on every path. */
  async signIn(input: { address: Address; message: string; signature: string }): Promise<VerifyOutcome> {
    const nonce = nonceOf(input.message)
    if (nonce === undefined) return { ok: false, reason: 'no_such_challenge' }
    const now = this.#now()
    const challenge = await this.#store.consumeChallenge(nonce, now)
    if (challenge === undefined) return { ok: false, reason: 'no_such_challenge' }
    if (challenge.expiresAtUnix <= now) return { ok: false, reason: 'challenge_expired' }
    if (challenge.message !== input.message) return { ok: false, reason: 'message_mismatch' }
    if (challenge.address !== normalizeAddress(input.address)) return { ok: false, reason: 'address_mismatch' }
    const signer = recoverPersonalSigner(challenge.message, input.signature)
    if (signer === undefined || signer !== challenge.address) return { ok: false, reason: 'signature_invalid' }

    const token = this.#randomHex(32)
    const session: DevSession = {
      id: `ds_${this.#randomHex(16)}`,
      tokenHash: hashToken(token),
      address: challenge.address,
      issuedAtUnix: now,
      expiresAtUnix: now + SESSION_TTL_SECONDS,
    }
    await this.#store.putSession(session)
    return { ok: true, token, session }
  }

  /** DevSessionVerifier: the server's bearer check. Expired is absent. */
  async verify(token: string): Promise<{ address: string; sessionId: string } | undefined> {
    if (!/^[0-9a-f]{64}$/.test(token)) return undefined
    const session = await this.#store.sessionByTokenHash(hashToken(token))
    if (session === undefined || session.expiresAtUnix <= this.#now()) return undefined
    return { address: session.address, sessionId: session.id }
  }
}
