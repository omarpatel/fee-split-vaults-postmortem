/**
 * The dead-man clock, read and reset on chain.
 *
 * CoinVault stores lastOperatorActionUnix and resets it in every onlyOperator
 * entry point; heartbeat() is the one that does nothing else. After
 * DEAD_MAN (TERMS.deadManDays) of silence anyone may call emergencyDevRelease
 * and move the vault to PASSTHROUGH. The job reads the clock from the chain
 * - never from a local record of when we last sent something - and sends
 * heartbeat() when silence has reached the configured fraction of the window.
 */

import type { Address, TxHash } from '@fee-split-vaults/core'
import type { VaultOperatorClient, VaultReadClient } from '@fee-split-vaults/adapters'
import type { VaultHeartbeat } from '../ports.js'

export interface ChainVaultHeartbeatDeps {
  operator: VaultOperatorClient
  reads: VaultReadClient
}

export class ChainVaultHeartbeat implements VaultHeartbeat {
  constructor(private readonly deps: ChainVaultHeartbeatDeps) {}

  lastOperatorActionUnix(vault: Address): Promise<number> {
    return this.deps.reads.lastOperatorActionUnix(vault)
  }

  async heartbeat(vault: Address): Promise<{ txHash: TxHash; blockHash: string }> {
    const receipt = await this.deps.operator.heartbeat(vault)
    return { txHash: receipt.txHash, blockHash: receipt.blockHash }
  }
}
