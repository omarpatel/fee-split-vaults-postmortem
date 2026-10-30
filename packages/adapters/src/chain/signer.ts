/**
 * The operator signing key.
 *
 * This is the only place in the adapter plane that touches a private key, and
 * the only thing it will sign is a 32-byte digest handed to it by tx.ts. It has
 * no notion of a transaction, a destination or an amount: it cannot be talked
 * into signing something else because it cannot see what it is signing.
 *
 * secp256k1 comes from @noble/secp256k1 v3 (audited, dependency-free). Keccak
 * is the indexer's vendored implementation, so the address derived here is the
 * address the rest of the system already trusts for topic matching.
 */

import { bytesToHex, hexToBytes, keccak256, normalizeAddress, type Hex } from '@fee-split-vaults/indexer'
import { Signature, getPublicKey, signAsync, utils } from '@noble/secp256k1'

/** A recoverable secp256k1 signature over a 32-byte digest, in EIP-2718 form. */
export interface RecoverableSignature {
  readonly r: bigint
  readonly s: bigint
  readonly yParity: 0 | 1
}

export interface TransactionSigner {
  /** Lowercase 0x-prefixed 20-byte address the signatures recover to. */
  readonly address: string
  /** Signs a digest. The digest MUST already be keccak256 of the signing payload. */
  sign(digest: Uint8Array): Promise<RecoverableSignature>
}

export class SignerKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

const KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/

export class PrivateKeySigner implements TransactionSigner {
  readonly address: string
  readonly #key: Uint8Array

  /**
   * `keyHex` is `0x` + 64 hex chars. Zero, >= curve order and wrong-length
   * keys are refused: noble would also refuse at sign time, but a bad key must
   * fail at construction, before anything is queued behind it.
   */
  constructor(keyHex: string) {
    if (!KEY_PATTERN.test(keyHex)) {
      throw new SignerKeyError('operator signer key must be 0x-prefixed 32-byte hex')
    }
    const key = hexToBytes(keyHex as Hex)
    if (!utils.isValidSecretKey(key)) {
      throw new SignerKeyError('operator signer key is not a valid secp256k1 scalar (zero or >= n)')
    }
    this.#key = key
    this.address = addressOfPublicKey(getPublicKey(key, false))
  }

  async sign(digest: Uint8Array): Promise<RecoverableSignature> {
    if (digest.length !== 32) {
      throw new SignerKeyError(`signer expects a 32-byte digest, got ${digest.length} bytes`)
    }
    const bytes = await signAsync(digest, this.#key, { prehash: false, format: 'recovered', lowS: true })
    const sig = Signature.fromBytes(bytes, 'recovered')
    const recovery = sig.recovery
    if (recovery !== 0 && recovery !== 1) {
      // recovery 2/3 means r overflowed the field: astronomically rare, and
      // not representable in a type-2 transaction's yParity.
      throw new SignerKeyError(`signature recovery id ${String(recovery)} cannot be expressed as yParity`)
    }
    return { r: sig.r, s: sig.s, yParity: recovery }
  }
}

/** keccak256 of the 64-byte uncompressed point (without the 0x04 prefix), last 20 bytes. */
export function addressOfPublicKey(uncompressed: Uint8Array): string {
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw new SignerKeyError('expected a 65-byte uncompressed secp256k1 public key')
  }
  return normalizeAddress(bytesToHex(keccak256(uncompressed.subarray(1)).subarray(12)))
}
