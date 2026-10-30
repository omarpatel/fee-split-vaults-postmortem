/**
 * QF and qualification signals, from the fee indexer.
 *
 * The same computation the tick's measure phase runs (`computeQf` over the
 * chain read model's postings, priced by the pinned book) so a tier decision
 * the daily job makes can be replayed against the one the tick made and the
 * two cannot disagree by construction.
 *
 * What refuses, and why:
 *   - a vault with no record, or whose token the indexer has not bound, has no
 *     attributable fees. That is `binding_unknown`, not a measurement of zero.
 *   - a posting in an asset without a pinned price cannot be valued. The
 *     indexer throws MissingPriceError; it is re-raised as `price_missing`.
 *     A week re-rated off a stale number is exactly what the refusal prevents.
 *   - signals need a holder index and a volume source. Without a provider they
 *     are `signals_unavailable`, which blocks an UPGRADE and nothing else -
 *     the tick's own posture.
 */

import type { Address, QfMeasurement, QualificationSignals } from '@fee-split-vaults/core'
import { computeQf, MissingPriceError } from '@fee-split-vaults/indexer'
import type { CoinBinding } from '@fee-split-vaults/indexer'
import { toIndexerOracle } from '@fee-split-vaults/orchestrator'
import type {
  AssetRegistry,
  ChainReadModel,
  SignalsProvider,
  UsdPriceBook,
  VaultRepository,
} from '@fee-split-vaults/orchestrator'
import { DAY } from '../../lib/time.js'
import { TIERS } from '../../lib/protocol.js'
import type { QfSource } from '../ports.js'
import { OpsAdapterError } from './errors.js'

export interface IndexerQfSourceDeps {
  chain: Pick<ChainReadModel, 'binding' | 'postings'>
  vaults: Pick<VaultRepository, 'get'>
  assets: AssetRegistry
  prices: UsdPriceBook
  signals?: SignalsProvider
  /** Same window the tick reads. Defaults to the sustain lookback plus a week. */
  lookbackSeconds?: number
  /** The indexer's default is two days; the tick uses the same figure. */
  maxPriceAgeSeconds?: number
}

const DEFAULT_LOOKBACK_SECONDS = 37 * DAY

export class IndexerQfSource implements QfSource {
  constructor(private readonly deps: IndexerQfSourceDeps) {}

  async measure(vault: Address, asOfUnix: number): Promise<QfMeasurement> {
    const { record, binding } = await this.#binding(vault)
    const lookback = this.deps.lookbackSeconds ?? DEFAULT_LOOKBACK_SECONDS
    const postings = await this.deps.chain.postings(record.address, asOfUnix - lookback, asOfUnix)
    try {
      return computeQf({
        binding,
        postings,
        assets: new Map(this.deps.assets.all().map((a) => [a.address.toLowerCase(), a])),
        prices: toIndexerOracle(this.deps.prices),
        options: {
          nowUnix: asOfUnix,
          gateQfPerDay: TIERS[record.tier].gateQfPerDay,
          ...(this.deps.maxPriceAgeSeconds === undefined ? {} : { maxPriceAgeSeconds: this.deps.maxPriceAgeSeconds }),
        },
      }).measurement
    } catch (error) {
      if (error instanceof MissingPriceError) throw new OpsAdapterError('price_missing', error.message)
      throw error
    }
  }

  async signals(vault: Address, asOfUnix: number): Promise<QualificationSignals> {
    if (this.deps.signals === undefined) {
      throw new OpsAdapterError('signals_unavailable', 'no holder index or volume source is configured')
    }
    const { binding } = await this.#binding(vault)
    return this.deps.signals.compute(binding, asOfUnix)
  }

  async #binding(vault: Address): Promise<{ record: { address: Address; tier: keyof typeof TIERS }; binding: CoinBinding }> {
    const record = await this.deps.vaults.get(vault)
    if (record === undefined) throw new OpsAdapterError('vault_unknown', `no vault_record for ${vault}`)
    const binding = await this.deps.chain.binding(record.token)
    if (binding === undefined) {
      throw new OpsAdapterError('binding_unknown', `the indexer has no CoinBinding for ${record.token}; fees are unattributable`)
    }
    return { record: { address: record.address, tier: record.tier }, binding }
  }
}
