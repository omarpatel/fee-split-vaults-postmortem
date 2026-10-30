/**
 * Scope encoding.
 *
 * A scope is the thing a run operates on, and it is also half of the idempotency
 * key, so it has to be unambiguous. Jobs that work per (vault, asset) encode both
 * with a separator that cannot appear in an address.
 */

import type { Address, AssetAddress } from '@fee-split-vaults/core'

export const FLEET_SCOPE = 'fleet'

const SEP = '#'

export function assetScope(vault: Address, asset: AssetAddress): string {
  if (vault.includes(SEP) || asset.includes(SEP)) {
    throw new Error('assetScope: separator present in an address; refusing an ambiguous scope')
  }
  return `${vault}${SEP}${asset}`
}

export function parseAssetScope(scope: string): { vault: Address; asset: AssetAddress } {
  const index = scope.indexOf(SEP)
  if (index <= 0 || index === scope.length - 1) {
    throw new Error(`parseAssetScope: malformed scope "${scope}"`)
  }
  return { vault: scope.slice(0, index), asset: scope.slice(index + 1) }
}
