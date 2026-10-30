/**
 * CoinVault, as the operator reaches it: the views the ops plane reads and the
 * operator-only writes the design requires an operator to make.
 *
 * WHAT THE WRITES CANNOT DO. Not one of them takes an address for money to go
 * to (see abi-encode.ts). bind/activate/suspend/resume/heartbeat move state;
 * claim/claimToken pull the vault's own escrow credit INTO the vault; settle
 * partitions what is already there; withdrawOperator pays the vault's
 * immutable OPERATOR_TREASURY. Rules 2 and 3 hold by the shape of the ABI.
 *
 * NEVER A CALL THAT WOULD REVERT. Every write is simulated from the signer's
 * address first. The contract's custom errors come back as revert data and
 * are decoded into a `VaultOpError` whose `code` is the Solidity error name,
 * so a caller can branch on `bad_state` or `already_bound` without parsing a
 * message - and so the failure is a typed refusal before any gas is spent.
 * An unrecognised selector is `unknown_revert`, never a guess.
 *
 * READS ARE PINNED. Every view is read at one block hash, by default the head
 * the rpc reports when the read is made, and the hash is available to the
 * caller so a set of reads can share a pin. A malformed return - wrong width,
 * enum out of range - throws; it is the wrong contract at that address, not a
 * value.
 */

import type { VaultState } from '@fee-split-vaults/core'
import type { BlockRef, BlockTag, Hex, PinnedCall, RpcLog } from '@fee-split-vaults/indexer'
import { normalizeAddress, normalizeHash32 } from '@fee-split-vaults/indexer'
import {
  MAX_SWEEP_ASSETS,
  decodeAddress,
  decodeCheckSolvency,
  decodeCustomError,
  decodeLegs,
  decodeUint256,
  decodeUint64,
  decodeVaultState,
  encodeActivate,
  encodeBind,
  encodeBudgetAvailable,
  encodeCheckSolvency,
  encodeClaim,
  encodeClaimToken,
  encodeHeartbeat,
  encodeLastOperatorActionUnix,
  encodeLegOf,
  encodeResume,
  encodeSettle,
  encodeState,
  encodeSuspend,
  encodeSweep,
  encodeToken,
  encodeWithdrawOperator,
  isNativeAsset,
  vaultStateFromOrdinal,
  type DecodedCustomError,
  type EscrowErrorName,
  type VaultErrorName,
  type VaultLegs,
  type VaultSolvency,
} from './abi-encode.js'
import { BroadcastError, TransactionBroadcaster, type BroadcastErrorCode, type BroadcasterOptions } from './broadcast.js'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** One code per custom error the vault declares, in CoinVault.sol order. */
export const VAULT_ERROR_CODES = {
  OnlyOperator: 'only_operator',
  OnlyDev: 'only_dev',
  OnlyDevPayout: 'only_dev_payout',
  OnlyReferrer: 'only_referrer',
  Reentrancy: 'reentrancy',
  BadState: 'bad_state',
  AlreadyBound: 'already_bound',
  TokenRequired: 'token_required',
  TokenMismatch: 'token_mismatch',
  SignatureExpired: 'signature_expired',
  AmountExceedsLeg: 'amount_exceeds_leg',
  OperatorLegFrozen: 'operator_leg_frozen',
  BudgetIsFrozen: 'budget_is_frozen',
  InvoiceRequired: 'invoice_required',
  InvoiceAlreadyUsed: 'invoice_already_used',
  CountersigRequired: 'countersig_required',
  NothingToDo: 'nothing_to_do',
  ProofWindowOpen: 'proof_window_open',
  AboveDialCeiling: 'above_dial_ceiling',
  BpsOverflow: 'bps_overflow',
  NoPendingDial: 'no_pending_dial',
  TimelockPending: 'timelock_pending',
  AdapterNotContract: 'adapter_not_contract',
  AdapterNotProposed: 'adapter_not_proposed',
  AdapterCallRejected: 'adapter_call_rejected',
  AdapterCallFailed: 'adapter_call_failed',
  NoNotice: 'no_notice',
  UseClaimForNative: 'use_claim_for_native',
  Insolvent: 'insolvent',
  TooManyAssets: 'too_many_assets',
  OnlySelf: 'only_self',
} as const satisfies Record<VaultErrorName, string>

/** The escrow's own errors, bubbled through claim/claimToken. */
export const ESCROW_ERROR_CODES = {
  InsufficientBalance: 'escrow_insufficient_balance',
  NoBalance: 'escrow_no_balance',
  ReentrancyGuardReentrantCall: 'escrow_reentrancy',
  SafeERC20FailedOperation: 'escrow_erc20_failed',
  TransferFailed: 'escrow_transfer_failed',
  ZeroAddress: 'escrow_zero_address',
} as const satisfies Record<EscrowErrorName, string>

export type VaultContractErrorCode = (typeof VAULT_ERROR_CODES)[VaultErrorName]
export type EscrowContractErrorCode = (typeof ESCROW_ERROR_CODES)[EscrowErrorName]

export type VaultOpErrorCode =
  | VaultContractErrorCode
  | EscrowContractErrorCode
  /** The simulation reverted with a selector neither contract declares. */
  | 'unknown_revert'
  | BroadcastErrorCode

export class VaultOpError extends Error {
  constructor(
    message: string,
    readonly code: VaultOpErrorCode,
    /** The decoded custom error, when the revert data named one. */
    readonly contractError: DecodedCustomError | null = null,
    /** A broadcast transaction whose fate is unknown. It may still land. */
    readonly pendingTxHash: Hex | null = null,
  ) {
    super(message)
    this.name = new.target.name
  }

  /** For `bad_state`: the state the vault reported itself in. */
  get currentState(): VaultState | undefined {
    if (this.contractError?.name !== 'BadState') return undefined
    const ordinal = this.contractError.args[0]
    if (ordinal === undefined) return undefined
    try {
      return vaultStateFromOrdinal(ordinal)
    } catch {
      return undefined
    }
  }

  static fromBroadcast(error: BroadcastError, what: string): VaultOpError {
    if (error.revertData !== null) {
      const decoded = decodeCustomError(error.revertData)
      if (decoded === undefined) {
        return new VaultOpError(`${what}: simulation reverted with unrecognised data ${error.revertData}`, 'unknown_revert')
      }
      const code = decoded.source === 'vault'
        ? VAULT_ERROR_CODES[decoded.name as VaultErrorName]
        : ESCROW_ERROR_CODES[decoded.name as EscrowErrorName]
      const args = decoded.args.length === 0 ? '' : `(${decoded.args.map((a) => a.toString(10)).join(', ')})`
      return new VaultOpError(`${what}: ${decoded.name}${args}`, code, decoded)
    }
    return new VaultOpError(`${what}: ${error.message}`, error.code, null, error.pendingTxHash)
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Either surface that can answer a pinned eth_call: a ChainWriteClient
 * (`getBlockByTag`) or the quorum's PinnedChainReads (`head`). One of the two
 * head readers must be present; asserted at construction.
 */
export interface VaultReadRpc {
  call(request: PinnedCall): Promise<Hex>
  head?(): Promise<BlockRef>
  getBlockByTag?(tag: BlockTag): Promise<BlockRef>
}

/** Refuses at construction an rpc that can pin nothing. */
export function assertHeadReader(rpc: VaultReadRpc, who: string): void {
  if (typeof rpc.head !== 'function' && typeof rpc.getBlockByTag !== 'function') {
    throw new RangeError(`${who} needs an rpc with head() or getBlockByTag()`)
  }
}

/** The block a read pins to when the caller supplies no hash. */
export async function headOf(rpc: VaultReadRpc): Promise<BlockRef> {
  if (typeof rpc.head === 'function') return rpc.head()
  if (typeof rpc.getBlockByTag === 'function') return rpc.getBlockByTag('latest')
  throw new RangeError('rpc has no head reader')
}

export interface VaultReadOptions {
  readonly rpc: VaultReadRpc
}

export class VaultReadClient {
  readonly #rpc: VaultReadRpc

  constructor(options: VaultReadOptions) {
    assertHeadReader(options.rpc, 'VaultReadClient')
    this.#rpc = options.rpc
  }

  head(): Promise<BlockRef> {
    return headOf(this.#rpc)
  }

  async #call(vault: string, data: Hex, blockHash: Hex | undefined): Promise<Hex> {
    const pin = blockHash === undefined ? (await this.head()).hash : normalizeHash32(blockHash)
    return this.#rpc.call({ to: normalizeAddress(vault), data, blockHash: pin })
  }

  async state(vault: string, blockHash?: Hex): Promise<VaultState> {
    return decodeVaultState(await this.#call(vault, encodeState(), blockHash))
  }

  async token(vault: string, blockHash?: Hex): Promise<string> {
    return decodeAddress(await this.#call(vault, encodeToken(), blockHash))
  }

  /** ICoinVault `Legs`: the settled partition of one asset. */
  async legOf(vault: string, asset: string, blockHash?: Hex): Promise<VaultLegs> {
    return decodeLegs(await this.#call(vault, encodeLegOf(asset), blockHash))
  }

  /** Settled budget plus this asset's projected share of anything unsettled. */
  async budgetAvailable(vault: string, asset: string, blockHash?: Hex): Promise<bigint> {
    return decodeUint256(await this.#call(vault, encodeBudgetAvailable(asset), blockHash))
  }

  /** Invariant I1 for one asset: balance vs the four legs. `balance - accounted` is what settle() would credit. */
  async checkSolvency(vault: string, asset: string, blockHash?: Hex): Promise<VaultSolvency> {
    return decodeCheckSolvency(await this.#call(vault, encodeCheckSolvency(asset), blockHash))
  }

  /** The dead-man clock: reset by every onlyOperator entry point. */
  async lastOperatorActionUnix(vault: string, blockHash?: Hex): Promise<number> {
    return Number(decodeUint64(await this.#call(vault, encodeLastOperatorActionUnix(), blockHash)))
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface VaultTxReceipt {
  readonly txHash: Hex
  readonly blockHash: Hex
  readonly blockNumber: bigint
  readonly gasUsed: bigint
  /** The receipt's logs, so a caller can decode the vault's own events (Claimed, Credited). */
  readonly logs: readonly RpcLog[]
  /** The canonical block the receipt sits in; its timestamp is when the call happened. */
  readonly block: BlockRef
}

export type VaultOperatorOptions = BroadcasterOptions

export class VaultOperatorClient {
  readonly #tx: TransactionBroadcaster

  constructor(options: VaultOperatorOptions) {
    this.#tx = new TransactionBroadcaster(options)
  }

  /** The operator address every write is sent from. Must equal the vault's OPERATOR_TREASURY. */
  get sender(): string {
    return this.#tx.sender
  }

  async #write(vault: string, data: Hex, what: string): Promise<VaultTxReceipt> {
    let confirmed
    try {
      confirmed = await this.#tx.send({ to: normalizeAddress(vault), data })
    } catch (error) {
      if (error instanceof BroadcastError) throw VaultOpError.fromBroadcast(error, what)
      throw error
    }
    const { receipt, block } = confirmed
    return {
      txHash: confirmed.txHash,
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      logs: receipt.logs,
      block,
    }
  }

  /** UNBOUND -> BOUND. Confirms the vault is the token's fee recipient. */
  bind(vault: string, token: string): Promise<VaultTxReceipt> {
    return this.#write(vault, encodeBind(token), `bind(${token})`)
  }

  /** PENDING -> ACTIVE. The only transition after which any fee is charged. */
  activate(vault: string): Promise<VaultTxReceipt> {
    return this.#write(vault, encodeActivate(), 'activate()')
  }

  /** ACTIVE -> SUSPENDED. Reversible. */
  suspend(vault: string): Promise<VaultTxReceipt> {
    return this.#write(vault, encodeSuspend(), 'suspend()')
  }

  /** SUSPENDED -> ACTIVE. */
  resume(vault: string): Promise<VaultTxReceipt> {
    return this.#write(vault, encodeResume(), 'resume()')
  }

  /** A no-op operator transaction that resets the dead-man clock. */
  heartbeat(vault: string): Promise<VaultTxReceipt> {
    return this.#write(vault, encodeHeartbeat(), 'heartbeat()')
  }

  /** Pays the operator leg to the vault's immutable OPERATOR_TREASURY. uint256.max means the whole leg. */
  withdrawOperator(vault: string, asset: string, amountMinor: bigint): Promise<VaultTxReceipt> {
    return this.#write(vault, encodeWithdrawOperator(asset, amountMinor), `withdrawOperator(${asset}, ${amountMinor})`)
  }

  /** Native claim from the escrow into the vault, bounded by maxAmountMinor. Settles the asset in the same call. */
  claim(vault: string, maxAmountMinor: bigint): Promise<VaultTxReceipt> {
    return this.#write(vault, encodeClaim(maxAmountMinor), `claim(${maxAmountMinor})`)
  }

  /** ERC-20 claim, bounded. The native sentinel is refused here, as the contract would. */
  async claimToken(vault: string, asset: string, maxAmountMinor: bigint): Promise<VaultTxReceipt> {
    if (isNativeAsset(asset)) {
      throw new VaultOpError(`claimToken(${asset}): the native asset is claimed with claim()`, 'use_claim_for_native')
    }
    return this.#write(vault, encodeClaimToken(asset, maxAmountMinor), `claimToken(${asset}, ${maxAmountMinor})`)
  }

  /**
   * Unbounded claim + settle for each asset, each step isolated on chain.
   * UNBOUNDED: a capped quote asset must go through claim/claimToken in chunks.
   */
  async sweep(vault: string, assets: readonly string[]): Promise<VaultTxReceipt> {
    if (assets.length === 0) throw new VaultOpError('sweep([]) claims nothing', 'nothing_to_do')
    if (assets.length > MAX_SWEEP_ASSETS) {
      throw new VaultOpError(`sweep of ${assets.length} assets exceeds MAX_SWEEP ${MAX_SWEEP_ASSETS}`, 'too_many_assets')
    }
    return this.#write(vault, encodeSweep(assets), `sweep([${assets.length} assets])`)
  }

  /** Partitions any unaccounted balance of `asset` across the four legs. No transfer. */
  settle(vault: string, asset: string): Promise<VaultTxReceipt> {
    return this.#write(vault, encodeSettle(asset), `settle(${asset})`)
  }
}
