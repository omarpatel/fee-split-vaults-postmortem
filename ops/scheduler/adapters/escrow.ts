/**
 * What a vault can claim out of the Venue V2 fee escrow, read on chain.
 *
 * ONE PIN PER CALL. The escrow is read for every enabled quote asset at one
 * block hash, and that hash rides on every credit, so the sweep job's "what
 * did we see" is reproducible and the three-way match can ask the same
 * question of the same block later.
 *
 * THE USD FIGURE IS FOR THE THRESHOLD ONLY, and it is never invented. A
 * credit whose asset has no pinned price is a refusal (rule 8), not a zero:
 * a zero would make the value trigger silently blind to that asset, and the
 * forced interval would then be the only thing standing between a growing
 * balance in a pausable proxy and a stranding. The sweep job logs the
 * refusal per vault and moves on; nobody sees a false "nothing here".
 *
 * Credits carry NO coin identifier - the escrow keys by (recipient, asset) -
 * so a credit here is what the vault address can claim, not what one coin is
 * owed.
 */

import type { Address, Asset } from '@fee-split-vaults/core'
import type { EscrowReadClient, VaultReadClient } from '@fee-split-vaults/adapters'
import { toUsdValue, type UsdPriceBook } from '@fee-split-vaults/orchestrator'
import type { Clock } from '../../lib/time.js'
import type { AssetRegistry, EscrowCredit, EscrowReader } from '../ports.js'
import { OpsAdapterError } from './errors.js'

export interface ChainEscrowReaderDeps {
  escrow: EscrowReadClient
  /** Only for its head(): the block every read in one call is pinned to. */
  reads: Pick<VaultReadClient, 'head'>
  assets: AssetRegistry
  prices: UsdPriceBook
  clock: Clock
}

export class ChainEscrowReader implements EscrowReader {
  constructor(private readonly deps: ChainEscrowReaderDeps) {}

  async listPending(vault: Address): Promise<EscrowCredit[]> {
    const head = await this.deps.reads.head()
    const nowUnix = this.deps.clock.nowUnix()
    const out: EscrowCredit[] = []
    for (const asset of await this.deps.assets.list()) {
      if (!asset.enabled) continue
      const creditedMinor = await this.deps.escrow.credits(vault, asset.address, head.hash)
      if (creditedMinor === 0n) continue
      out.push({
        vault,
        asset: asset.address,
        creditedMinor,
        usd: this.#usd(asset, creditedMinor, nowUnix, head.hash),
        blockHash: head.hash,
      })
    }
    return out
  }

  #usd(asset: Asset, amountMinor: bigint, nowUnix: number, blockHash: string): EscrowCredit['usd'] {
    const price = this.deps.prices.priceAt(asset.address, nowUnix)
    if (price === undefined) {
      throw new OpsAdapterError('price_missing', `no pinned USD price for ${asset.symbol} (${asset.address}) at ${nowUnix}`)
    }
    return { ...toUsdValue(amountMinor, asset, price), blockHash }
  }
}
