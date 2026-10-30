/**
 * EIP-712 for Consent, mirroring contracts/src/lib/ConsentLib.sol and
 * VaultFactory's domain byte for byte.
 *
 * THIS FILE IS A MIRROR AND IT MUST STAY ONE. Three things here are copied from
 * Solidity, and each of them silently changes every vault address ever predicted
 * if it drifts:
 *
 *   1. the CONSENT type string, whose field ORDER is load-bearing;
 *   2. the domain name "VenueVaultFactory" and version "1";
 *   3. `salt = keccak256(abi.encode(consent))`, which is the CREATE2 salt and
 *      is DELIBERATELY different from hashStruct - the salt has no typehash
 *      prefix, so the two hashes of the same struct are unrelated values.
 *
 * eip712.spec.ts pins the type string and re-derives the salt independently, so
 * an edit to either side has to be made on both.
 */

import type { Consent } from '@fee-split-vaults/core'
import {
  bytesToHex,
  concatBytes,
  encodeAddress,
  encodeBytes32,
  encodeUint,
  hexToBytes,
  isAddress,
  isBytes32,
  keccakHex,
  normalizeAddress,
  utf8,
} from './crypto/address.js'
import { keccak256 } from '@fee-split-vaults/indexer'
import {
  parseSignature,
  recoverPublicKey,
  type RecoverableSignature,
} from './crypto/secp256k1.js'
import { addressFromPublicKey } from './crypto/address.js'

/** Field order is load-bearing. It mirrors ConsentLib.CONSENT_TYPEHASH exactly. */
export const CONSENT_TYPE_STRING =
  'Consent(address devSigner,address devPayout,address token,bytes32 termsHash,' +
  'uint16 operatorBps,uint16 budgetBpsMax,address adapter,address referrer,' +
  'uint16 referrerBps,uint64 expiryUnix,bytes32 nonce)'

export const EIP712_DOMAIN_TYPE_STRING =
  'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'

export const DOMAIN_NAME = 'VenueVaultFactory'
export const DOMAIN_VERSION = '1'

export const CONSENT_TYPEHASH = keccakHex(utf8(CONSENT_TYPE_STRING))
export const DOMAIN_TYPEHASH = keccakHex(utf8(EIP712_DOMAIN_TYPE_STRING))

export interface Eip712Domain {
  chainId: number
  /** The VaultFactory address. The domain binds a signature to one factory. */
  verifyingContract: string
}

export class ConsentError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(`consent: ${message}`)
    this.name = 'ConsentError'
  }
}

const UINT16_MAX = 65_535
const UINT64_MAX = 18_446_744_073_709_551_615n

/**
 * Structural validation of a consent before it is hashed.
 *
 * This is not the commercial check (that lives in consent.ts and compares
 * against TERMS). It only refuses a struct that cannot be encoded, because an
 * unencodable field would otherwise throw somewhere deep in the hash and give a
 * useless error at exactly the moment a dev is trying to sign.
 */
export function assertEncodableConsent(consent: Consent): void {
  const addressFields: Array<[string, string]> = [
    ['devSigner', consent.devSigner],
    ['devPayout', consent.devPayout],
    ['token', consent.token],
    ['adapter', consent.adapter],
    ['referrer', consent.referrer],
  ]
  for (const [field, value] of addressFields) {
    if (!isAddress(value)) throw new ConsentError(`${field} is not an address`, field)
  }
  if (!isBytes32(consent.termsHash)) {
    throw new ConsentError('termsHash must be a 32-byte hex string', 'termsHash')
  }
  if (!isBytes32(consent.nonce)) {
    // core types the nonce as a string; on chain it is bytes32. A short nonce
    // would be silently zero-padded, and two different short nonces can pad to
    // the same word, which is a salt collision.
    throw new ConsentError('nonce must be a 32-byte hex string', 'nonce')
  }
  for (const [field, value] of [
    ['operatorBps', consent.operatorBps],
    ['budgetBpsMax', consent.budgetBpsMax],
    ['referrerBps', consent.referrerBps],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > UINT16_MAX) {
      throw new ConsentError(`${field} must be a uint16`, field)
    }
  }
  if (
    !Number.isInteger(consent.expiryUnix) ||
    consent.expiryUnix < 0 ||
    BigInt(consent.expiryUnix) > UINT64_MAX
  ) {
    throw new ConsentError('expiryUnix must be a uint64', 'expiryUnix')
  }
}

/** abi.encode(Consent) - eleven static words, no typehash prefix. */
export function encodeConsent(consent: Consent): Uint8Array {
  assertEncodableConsent(consent)
  return concatBytes(
    encodeAddress(consent.devSigner),
    encodeAddress(consent.devPayout),
    encodeAddress(consent.token),
    encodeBytes32(consent.termsHash),
    encodeUint(consent.operatorBps),
    encodeUint(consent.budgetBpsMax),
    encodeAddress(consent.adapter),
    encodeAddress(consent.referrer),
    encodeUint(consent.referrerBps),
    encodeUint(consent.expiryUnix),
    encodeBytes32(consent.nonce),
  )
}

/**
 * The CREATE2 salt. NOT the EIP-712 struct hash: no typehash prefix.
 *
 * Because this covers every economic term, a vault at a given address can only
 * ever have had one set of rates. Repricing an existing customer is not merely
 * forbidden, it is unrepresentable.
 */
export function consentSalt(consent: Consent): string {
  return keccakHex(encodeConsent(consent))
}

/** EIP-712 hashStruct(Consent): keccak(typehash || the same eleven words). */
export function hashStruct(consent: Consent): string {
  return keccakHex(concatBytes(hexToBytes(CONSENT_TYPEHASH), encodeConsent(consent)))
}

export function domainSeparator(domain: Eip712Domain): string {
  return keccakHex(
    concatBytes(
      hexToBytes(DOMAIN_TYPEHASH),
      keccak256(utf8(DOMAIN_NAME)),
      keccak256(utf8(DOMAIN_VERSION)),
      encodeUint(domain.chainId),
      encodeAddress(domain.verifyingContract),
    ),
  )
}

/** The exact 32 bytes a dev's wallet signs. */
export function consentDigest(consent: Consent, domain: Eip712Domain): string {
  return keccakHex(
    concatBytes(
      new Uint8Array([0x19, 0x01]),
      hexToBytes(domainSeparator(domain)),
      hexToBytes(hashStruct(consent)),
    ),
  )
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type ConsentVerification =
  | { ok: true; signer: string; digest: string; salt: string }
  | { ok: false; reason: string; digest?: string }

/**
 * Verify a dev's signature over a consent.
 *
 * FAIL CLOSED IN EVERY DIRECTION: a malformed signature, a high-s signature, a
 * recovered address that is not devSigner, an expired consent, and a signature
 * over a different domain all return `ok: false`. Nothing here ever recovers an
 * address and then decides it is "close enough".
 *
 * ERC-1271 (contract wallets) is NOT handled here, because verifying one
 * requires an on-chain call and this function is pure. Use `verifyConsent1271`
 * with an injected reader; the contracts accept both, and so must the service.
 */
export function verifyConsent(
  consent: Consent,
  signatureHex: string,
  domain: Eip712Domain,
  nowUnix: number,
): ConsentVerification {
  let digest: string
  try {
    assertEncodableConsent(consent)
    digest = consentDigest(consent, domain)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }

  if (consent.expiryUnix <= nowUnix) {
    return { ok: false, reason: 'consent has expired', digest }
  }

  let sig: RecoverableSignature
  try {
    sig = parseSignature(hexToBytes(signatureHex))
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), digest }
  }

  let recovered: string
  try {
    recovered = addressFromPublicKey(recoverPublicKey(hexToBytes(digest), sig))
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), digest }
  }

  if (normalizeAddress(recovered) !== normalizeAddress(consent.devSigner)) {
    return { ok: false, reason: 'signature does not recover to devSigner', digest }
  }
  return { ok: true, signer: normalizeAddress(recovered), digest, salt: consentSalt(consent) }
}

/**
 * ERC-1271 magic value, for contract wallets. `0x1626ba7e`.
 *
 * The reader is injected because this file must stay pure; the API wires it to
 * a pinned eth_call. A read failure is a REFUSAL, never an assumed yes.
 */
export const ERC1271_MAGIC = '0x1626ba7e'

export interface Erc1271Reader {
  /** isValidSignature(bytes32,bytes) at a pinned block. Returns the raw 4 bytes. */
  isValidSignature(wallet: string, digest: string, signature: string): Promise<string>
}

export async function verifyConsent1271(
  consent: Consent,
  signatureHex: string,
  domain: Eip712Domain,
  nowUnix: number,
  reader: Erc1271Reader,
): Promise<ConsentVerification> {
  const eoa = verifyConsent(consent, signatureHex, domain, nowUnix)
  if (eoa.ok) return eoa
  if (eoa.digest === undefined) return eoa
  if (consent.expiryUnix <= nowUnix) return eoa

  try {
    const result = await reader.isValidSignature(consent.devSigner, eoa.digest, signatureHex)
    if (result.toLowerCase().startsWith(ERC1271_MAGIC)) {
      return {
        ok: true,
        signer: normalizeAddress(consent.devSigner),
        digest: eoa.digest,
        salt: consentSalt(consent),
      }
    }
    return { ok: false, reason: 'ERC-1271 wallet rejected the signature', digest: eoa.digest }
  } catch (error) {
    return {
      ok: false,
      reason: `ERC-1271 check unavailable: ${error instanceof Error ? error.message : String(error)}`,
      digest: eoa.digest,
    }
  }
}

/**
 * The payload a wallet needs to produce the signature. Handed to the dev as-is;
 * every field is derived here rather than accepted from the client, so a client
 * cannot get a dev to sign a domain or a type the service did not choose.
 */
export function signingPayload(
  consent: Consent,
  domain: Eip712Domain,
): {
  domain: { name: string; version: string; chainId: number; verifyingContract: string }
  primaryType: 'Consent'
  types: Record<string, Array<{ name: string; type: string }>>
  message: Record<string, string | number>
  digest: string
} {
  assertEncodableConsent(consent)
  return {
    domain: {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      chainId: domain.chainId,
      verifyingContract: normalizeAddress(domain.verifyingContract),
    },
    primaryType: 'Consent',
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      Consent: [
        { name: 'devSigner', type: 'address' },
        { name: 'devPayout', type: 'address' },
        { name: 'token', type: 'address' },
        { name: 'termsHash', type: 'bytes32' },
        { name: 'operatorBps', type: 'uint16' },
        { name: 'budgetBpsMax', type: 'uint16' },
        { name: 'adapter', type: 'address' },
        { name: 'referrer', type: 'address' },
        { name: 'referrerBps', type: 'uint16' },
        { name: 'expiryUnix', type: 'uint64' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    message: {
      devSigner: normalizeAddress(consent.devSigner),
      devPayout: normalizeAddress(consent.devPayout),
      token: normalizeAddress(consent.token),
      termsHash: consent.termsHash,
      operatorBps: consent.operatorBps,
      budgetBpsMax: consent.budgetBpsMax,
      adapter: normalizeAddress(consent.adapter),
      referrer: normalizeAddress(consent.referrer),
      referrerBps: consent.referrerBps,
      expiryUnix: consent.expiryUnix,
      nonce: consent.nonce,
    },
    digest: consentDigest(consent, domain),
  }
}

export { bytesToHex }
