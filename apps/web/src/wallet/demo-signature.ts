/**
 * The demo wallet's signature scheme.
 *
 * THIS IS NOT A SIGNATURE. It is a keyed hash of (address, message) that the
 * fixture backend can recompute, so the offline demo can exercise the real
 * sign-in flow without shipping a secp256k1 implementation and a private key
 * into a browser bundle.
 *
 * It lives in its own module so that exactly two things import it - the fake
 * wallet and the fixture backend - and so that a reviewer looking for "does
 * anything here pretend to verify a real signature" finds this file and its
 * two importers rather than a scheme buried in a fixture. The real backend
 * verifies ECDSA and ERC-1271; nothing in this file reaches it.
 */

import { bytesToHex, utf8ToBytes, concatBytes, type Hex } from '../crypto/hex.js'
import { keccak256 } from '../crypto/keccak.js'

const DOMAIN_TAG = 'fee-split-vaults/demo-wallet/v1'

export function demoSignature(address: string, message: string): Hex {
  const digest = keccak256(
    concatBytes(utf8ToBytes(DOMAIN_TAG), utf8ToBytes(address.toLowerCase()), utf8ToBytes(message)),
  )
  // 65 bytes so it is the shape a wallet would return: r || s || v.
  const second = keccak256(digest)
  return `${bytesToHex(concatBytes(digest, second)).slice(0, 130)}1b` as Hex
}

export function isDemoSignature(address: string, message: string, signature: string): boolean {
  return signature.toLowerCase() === demoSignature(address, message).toLowerCase()
}
