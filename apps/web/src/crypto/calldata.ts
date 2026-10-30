/**
 * Calldata for the handful of transactions this app hands to a wallet.
 *
 * Encoded client-side ON PURPOSE, even though the API also returns calldata.
 * Every one of these transactions moves or redirects the dev's own money, and
 * "paste this hex the operator gave you" is exactly the instruction a
 * compromised operator would want a dev to follow. The dev dashboard and the
 * onboarding flow build the calldata locally, compare it byte-for-byte with
 * what the API returned, and refuse to present a mismatch as a normal button.
 */

import { encodeStaticWords, wordFromAddress, wordFromUint } from './abi.js'
import { bytesToHex, utf8ToBytes, type Hex } from './hex.js'
import { keccak256 } from './keccak.js'

export function selector(signature: string): Hex {
  return bytesToHex(keccak256(utf8ToBytes(signature)).subarray(0, 4))
}

function call(signature: string, words: Uint8Array[]): Hex {
  return `${selector(signature)}${bytesToHex(encodeStaticWords(words)).slice(2)}` as Hex
}

/** CoinVault.setDial(uint16). Raising is immediate; lowering gives notice. */
export function encodeSetDial(budgetBps: number): Hex {
  return call('setDial(uint16)', [wordFromUint(BigInt(budgetBps), 16)])
}

/** CoinVault.applyDial(). Permissionless once the notice has elapsed. */
export function encodeApplyDial(): Hex {
  return selector('applyDial()')
}

/** CoinVault.terminate(). onlyDev. Always succeeds; see the dashboard copy. */
export function encodeTerminate(): Hex {
  return selector('terminate()')
}

/**
 * The Venue creator-fee registry's recipiency transfer. Self-service by the
 * CURRENT recipient, which is why the dev sends it and nobody can send it for
 * them - and why the sweep-and-claim step has to happen first.
 */
export function encodeTransferCreatorFeeRecipient(token: string, newRecipient: string): Hex {
  return call('transferCreatorFeeRecipient(address,address)', [
    wordFromAddress(token),
    wordFromAddress(newRecipient),
  ])
}

/** Venue V2 fee escrow claim. msg.sender-ONLY: there is no claim-on-behalf. */
export function encodeEscrowClaim(quoteAsset: string, maxAmount: bigint): Hex {
  return call('claim(address,uint256)', [
    wordFromAddress(quoteAsset),
    wordFromUint(maxAmount, 256),
  ])
}

/** Equality that ignores case and is safe against a short or malformed value. */
export function calldataEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  return a.toLowerCase() === b.toLowerCase()
}
