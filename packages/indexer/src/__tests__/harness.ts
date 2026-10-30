/** Wiring for the end-to-end indexer specs. Not a spec file itself. */

import { FakeChain, FakeRpcClient } from '../fake-rpc.js'
import { InMemoryVaultRegistry, VaultIndexer, type IndexerConfig } from '../indexer.js'
import type { IssuedVault } from '../model.js'
import { QuorumRpc } from '../quorum.js'
import { InMemoryIndexerStore } from '../store.js'
import { InMemoryHaltSink } from '../watchers.js'

export interface Harness {
  readonly chain: FakeChain
  readonly primary: FakeRpcClient
  readonly secondary: FakeRpcClient
  readonly rpc: QuorumRpc
  readonly store: InMemoryIndexerStore
  readonly registry: InMemoryVaultRegistry
  readonly sink: InMemoryHaltSink
  readonly indexer: VaultIndexer
}

/**
 * Both providers read the SAME fake chain, which is what a healthy quorum looks
 * like. Divergence tests build a second chain and point one provider at it.
 *
 * The chain must already answer getLaunchedToken() for every coin the indexer
 * will bind (see helpers.launchCoin / pinLaunchedToken); a chain that cannot is
 * the model of an unreadable node.
 */
export interface HarnessOptions {
  readonly secondaryChain?: FakeChain
}

export function harness(
  chain: FakeChain,
  vaults: readonly IssuedVault[],
  config: Partial<IndexerConfig> = {},
  options: HarnessOptions = {},
): Harness {
  const primary = new FakeRpcClient(chain, 'primary')
  const secondary = new FakeRpcClient(options.secondaryChain ?? chain, 'secondary')
  const rpc = new QuorumRpc(primary, secondary)
  const store = new InMemoryIndexerStore()
  const registry = new InMemoryVaultRegistry()
  const sink = new InMemoryHaltSink()

  for (const vault of vaults) registry.put(vault)

  const indexer = new VaultIndexer({
    rpc,
    store,
    registry,
    haltSink: sink,
    config: { startBlock: 0n, sweepIntervalSeconds: 3_600, ...config },
  })

  return { chain, primary, secondary, rpc, store, registry, sink, indexer }
}
