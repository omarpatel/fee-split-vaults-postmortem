/**
 * Calldata for the transactions the dev's OWN wallet sends.
 *
 * NO ROUTE EVER SIGNS OR SENDS. Every function here returns bytes for an
 * UnsignedTxWire; the web client re-encodes the same call locally and refuses
 * to present a mismatch as a normal button (apps/web/src/crypto/calldata.ts),
 * so the selectors and word layouts below must match that file exactly.
 *
 * The escrow claim is the exception the web does not compare: the verified
 * escrow on chain 4663 exposes `claim(uint256)` for the native credit and
 * `claimToken(address,uint256)` per ERC-20 (packages/adapters/src/chain/escrow.ts
 * explains the ABI), and those are what a claim-to-zero has to call.
 */

import type { Consent } from '@fee-split-vaults/core'
import { encodeDeploy } from '@fee-split-vaults/adapters'

import { bytesToHex, concatBytes, encodeAddress, encodeUint, keccakHex, utf8 } from '../crypto/address.js'

const NATIVE_ASSET = '0x0000000000000000000000000000000000000000'

function selector(signature: string): string {
  return keccakHex(utf8(signature)).slice(0, 10)
}

function call(signature: string, ...words: readonly Uint8Array[]): string {
  return `${selector(signature)}${bytesToHex(concatBytes(...words)).slice(2)}`
}

/** CoinVault.setDial(uint16). Raising is immediate; lowering gives notice. */
export function encodeSetDial(budgetBps: number): string {
  return call('setDial(uint16)', encodeUint(budgetBps))
}

/** CoinVault.applyDial(). Permissionless once the notice has elapsed. */
export function encodeApplyDial(): string {
  return selector('applyDial()')
}

/** CoinVault.terminate(). onlyDev. */
export function encodeTerminate(): string {
  return selector('terminate()')
}

/** The Venue registry's recipiency transfer. Self-service by the CURRENT recipient. */
export function encodeTransferCreatorFeeRecipient(token: string, newRecipient: string): string {
  return call('transferCreatorFeeRecipient(address,address)', encodeAddress(token), encodeAddress(newRecipient))
}

/** The escrow's claim for one asset, bounded. Native and ERC-20 are two entry points. */
export function encodeEscrowClaim(asset: string, maxAmount: bigint): string {
  return asset.toLowerCase() === NATIVE_ASSET
    ? call('claim(uint256)', encodeUint(maxAmount))
    : call('claimToken(address,uint256)', encodeAddress(asset), encodeUint(maxAmount))
}

/** VaultFactory.deploy(Consent, bytes). Anyone may submit a consent the dev signed. */
export function encodeFactoryDeploy(consent: Consent, devSignature: string): string {
  return encodeDeploy(consent, devSignature)
}
