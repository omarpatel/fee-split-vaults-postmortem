/**
 * CoinVault as the onboarding machine drives it and reads it.
 *
 * Two ports, because they have two trust levels. The reader needs nothing but
 * an RPC quorum and answers "what state is this vault in on chain"; the
 * operator port holds OPERATOR_SIGNER_KEY and performs the two writes the
 * design reserves for the operator on this path: `bind(token)` after the
 * factory deploys (a vault leaves the factory UNBOUND; the factory does not
 * bind) and `activate()` once the dev's own `acceptService()` is visible.
 *
 * The machine never trusts a request body about either. It reads the state
 * back, and refuses when the chain disagrees with the record.
 */

import type { Address, VaultState } from '@fee-split-vaults/core'
import { normalizeAddress } from './crypto/address.js'

export interface OperatorTxReceipt {
  txHash: string
  blockHash: string
  blockNumber: bigint
}

/** The operator's writes. Simulation precedes every broadcast; a revert never reaches the chain. */
export interface VaultOperatorPort {
  bind(vault: Address, token: Address): Promise<OperatorTxReceipt>
  activate(vault: Address): Promise<OperatorTxReceipt>
}

/** Read-only. A read failure THROWS; there is no "probably PENDING". */
export interface VaultStateReader {
  state(vault: Address): Promise<VaultState>
}

export class VaultChainError extends Error {
  constructor(
    message: string,
    readonly code: 'bad_state' | 'already_bound' | 'unknown_vault' | 'rpc_unavailable',
    readonly currentState?: VaultState,
  ) {
    super(`vault chain: ${message}`)
    this.name = 'VaultChainError'
  }
}

/**
 * An in-memory CoinVault that enforces the contract's transitions, so a test
 * of the machine exercises the same refusals the real vault would give:
 * bind only from UNBOUND, acceptService only from BOUND, activate only from
 * PENDING. `acceptService` is the dev's act and is called by the test to
 * stand in for the dev's transaction.
 */
export class FakeVaultChain implements VaultOperatorPort, VaultStateReader {
  readonly #states = new Map<string, VaultState>()
  readonly #tokens = new Map<string, Address>()
  readonly calls: Array<{ op: 'bind' | 'activate'; vault: Address }> = []
  #seq = 0
  #unreachable: string | undefined

  /** The factory's deployment: the vault exists, UNBOUND. */
  deploy(vault: Address): void {
    this.#states.set(normalizeAddress(vault), 'UNBOUND')
  }

  /** The dev's acceptService(): BOUND -> PENDING. */
  acceptService(vault: Address): void {
    this.#transition(vault, 'BOUND', 'PENDING')
  }

  /** Force a state, for tests of disagreement between record and chain. */
  set(vault: Address, state: VaultState): void {
    this.#states.set(normalizeAddress(vault), state)
  }

  failReads(reason: string | undefined): void {
    this.#unreachable = reason
  }

  async state(vault: Address): Promise<VaultState> {
    if (this.#unreachable !== undefined) throw new VaultChainError(this.#unreachable, 'rpc_unavailable')
    const state = this.#states.get(normalizeAddress(vault))
    if (state === undefined) throw new VaultChainError(`no vault at ${vault}`, 'unknown_vault')
    return state
  }

  async bind(vault: Address, token: Address): Promise<OperatorTxReceipt> {
    const current = await this.state(vault)
    if (current !== 'UNBOUND') throw new VaultChainError('AlreadyBound()', 'already_bound', current)
    this.#tokens.set(normalizeAddress(vault), normalizeAddress(token))
    this.#states.set(normalizeAddress(vault), 'BOUND')
    this.calls.push({ op: 'bind', vault: normalizeAddress(vault) })
    return this.#receipt()
  }

  async activate(vault: Address): Promise<OperatorTxReceipt> {
    this.#transition(vault, 'PENDING', 'ACTIVE')
    this.calls.push({ op: 'activate', vault: normalizeAddress(vault) })
    return this.#receipt()
  }

  tokenOf(vault: Address): Address | undefined {
    return this.#tokens.get(normalizeAddress(vault))
  }

  #transition(vault: Address, from: VaultState, to: VaultState): void {
    const key = normalizeAddress(vault)
    const current = this.#states.get(key)
    if (current === undefined) throw new VaultChainError(`no vault at ${vault}`, 'unknown_vault')
    if (current !== from) throw new VaultChainError(`BadState(${current})`, 'bad_state', current)
    this.#states.set(key, to)
  }

  #receipt(): OperatorTxReceipt {
    this.#seq += 1
    return {
      txHash: `0x${this.#seq.toString(16).padStart(64, 'a')}`,
      blockHash: `0x${this.#seq.toString(16).padStart(64, 'b')}`,
      blockNumber: BigInt(this.#seq),
    }
  }
}
