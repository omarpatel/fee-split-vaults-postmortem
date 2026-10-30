/**
 * The asset registry, from the chain and the kill-switch table.
 *
 * Two sources, deliberately: the CONTRACT says what an asset is (symbol,
 * decimals - the number a report divides by), and the `quote_asset` table
 * (0002, written by the status CLI's enable/disable) says whether we will
 * touch it and in what chunk size. `ChainAssetReader.read` cross-checks the
 * two and refuses a contradiction; this registry only decides what "unknown"
 * means at the port boundary:
 *
 *   - an address with NO policy row is `undefined`. The jobs turn that into
 *     `unknown_asset` and claim nothing in it.
 *   - an address WITH a row whose chain read fails is a thrown refusal. An
 *     unreachable node is not "no such asset"; treating it as one would make
 *     the sweep job skip an approved asset in silence every time the RPC
 *     blinked.
 *
 * Nothing is cached. `enabled` is the response to a paused proxy and it has
 * to take effect on the next read, not the next restart.
 */

import type { Asset, AssetAddress } from '@fee-split-vaults/core'
import type { BlockRef } from '@fee-split-vaults/indexer'
import type { AssetRegistry } from '../ports.js'
import { OpsAdapterError } from './errors.js'

export interface AssetReads {
  read(address: string, at: BlockRef): Promise<Asset>
}

export interface AssetPolicyReads {
  /** Lowercase addresses with a policy row, approved or not. */
  approved(): Promise<string[]>
}

export interface ChainAssetRegistryDeps {
  reader: AssetReads
  policy: AssetPolicyReads
  /** The block every read in one call is pinned to. */
  head(): Promise<BlockRef>
}

export class ChainAssetRegistry implements AssetRegistry {
  constructor(private readonly deps: ChainAssetRegistryDeps) {}

  async get(asset: AssetAddress): Promise<Asset | undefined> {
    const key = asset.toLowerCase()
    const approved = await this.deps.policy.approved()
    if (!approved.some((address) => address.toLowerCase() === key)) return undefined
    return this.#read(key, await this.deps.head())
  }

  async list(): Promise<Asset[]> {
    const approved = await this.deps.policy.approved()
    const at = await this.deps.head()
    const out: Asset[] = []
    for (const address of [...approved].map((a) => a.toLowerCase()).sort()) {
      out.push(await this.#read(address, at))
    }
    return out
  }

  async #read(address: string, at: BlockRef): Promise<Asset> {
    try {
      return await this.deps.reader.read(address, at)
    } catch (error) {
      throw new OpsAdapterError(
        'asset_read_failed',
        `${address} at block ${at.hash}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
