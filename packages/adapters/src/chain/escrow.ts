/**
 * What the Venue V2 fee escrow says a recipient can claim, read at a pinned
 * block.
 *
 * THE VIEW IS `balanceOf` / `balanceOfToken`, NOT `creditOf`. The repository's
 * IVenueExternal.sol pins a best-known `creditOf(address,address)`; the escrow
 * at VENUE.contracts.v2FeeEscrow, as Sourcify verifies it on chain 4663,
 * exposes `balanceOf(address recipient)` for the native credit and
 * `balanceOfToken(address recipient, address token)` for an ERC-20 credit,
 * and no `creditOf`. This client reads the verified pair. The native asset is
 * the vault's own sentinel, address(0): the escrow keys native credit by
 * recipient alone, so the sentinel selects the view rather than being passed
 * to it.
 *
 * Credits key by (recipient, quoteAsset) and carry NO coin identifier. What
 * this returns is claimable by the recipient, not owed to a coin; per-coin
 * attribution is the indexer's job.
 */

import type { Hex } from '@fee-split-vaults/indexer'
import { normalizeAddress, normalizeHash32 } from '@fee-split-vaults/indexer'
import { VENUE } from '../../../../config/protocol.js'
import { decodeUint256, encodeEscrowBalanceOf, encodeEscrowBalanceOfToken, isNativeAsset } from './abi-encode.js'
import { assertHeadReader, headOf, type VaultReadRpc } from './vault-ops.js'

export interface EscrowReadOptions {
  readonly rpc: VaultReadRpc
  /** Defaults to VENUE.contracts.v2FeeEscrow. Overridable for a test escrow. */
  readonly escrow?: string
}

export class EscrowReadClient {
  readonly #rpc: VaultReadRpc
  readonly #escrow: string

  constructor(options: EscrowReadOptions) {
    assertHeadReader(options.rpc, 'EscrowReadClient')
    this.#rpc = options.rpc
    this.#escrow = normalizeAddress(options.escrow ?? VENUE.contracts.v2FeeEscrow)
  }

  get escrow(): string {
    return this.#escrow
  }

  /** Credited-but-unclaimed balance of `asset` for `recipient`, in minor units, at `blockHash` (default: head). */
  async credits(recipient: string, asset: string, blockHash?: Hex): Promise<bigint> {
    const pin = blockHash === undefined ? (await headOf(this.#rpc)).hash : normalizeHash32(blockHash)
    const data = isNativeAsset(asset) ? encodeEscrowBalanceOf(recipient) : encodeEscrowBalanceOfToken(recipient, asset)
    return decodeUint256(await this.#rpc.call({ to: this.#escrow, data, blockHash: pin }))
  }
}
