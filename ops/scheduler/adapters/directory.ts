/**
 * The vault directory, over the orchestrator's vault repository.
 *
 * `vault_record` (0011) is the one row the tick loop and the API both write,
 * and it already carries everything the operations plane may see: the state
 * and tier the tick maintains, the dev's dial, the two per-token chain facts,
 * and the signed consent from which the operator share and the dev payout are
 * read. Nothing is synthesised here. A vault with no row is not a vault, and
 * get() says so with `undefined` - the jobs turn that into `unknown_vault`.
 *
 * The consent signature never leaves the repository row: VaultRef has no field
 * for it, so this projection cannot leak one into a log line.
 */

import type { Address, Vault, VaultState } from '@fee-split-vaults/core'
import type { VaultRepository } from '@fee-split-vaults/orchestrator'
import type { VaultDirectory, VaultRef } from '../ports.js'

export function toVaultRef(vault: Vault): VaultRef {
  const ref: VaultRef = {
    address: vault.address,
    token: vault.token,
    state: vault.state,
    tier: vault.tier,
    budgetBps: vault.budgetBps,
    operatorBps: vault.consent.operatorBps,
    buybackEnabled: vault.buybackEnabled,
    creatorTaxBps: vault.creatorTaxBps,
    devPayout: vault.consent.devPayout,
  }
  if (vault.activatedAtUnix !== undefined) ref.activatedAtUnix = vault.activatedAtUnix
  return ref
}

export class PgVaultDirectory implements VaultDirectory {
  constructor(private readonly vaults: VaultRepository) {}

  async listByState(states: readonly VaultState[]): Promise<VaultRef[]> {
    const wanted = new Set<VaultState>(states)
    const all = await this.vaults.list()
    return all
      .filter((vault) => wanted.has(vault.state))
      .map(toVaultRef)
      .sort((a, b) => a.address.localeCompare(b.address))
  }

  async get(vault: Address): Promise<VaultRef | undefined> {
    const found = await this.vaults.get(vault)
    return found === undefined ? undefined : toVaultRef(found)
  }
}
