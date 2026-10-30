/**
 * Simulate, sign, broadcast, confirm: the one path every operator transaction
 * takes to the Venue chain.
 *
 * SIMULATION IS THE GATE. estimateGas executes the call against pending state
 * from the operator's own address, so a call the contract would revert -
 * wrong state, frozen leg, unauthorised sender - refuses here with the
 * contract's own revert data and nothing is ever signed. The revert data is
 * carried on the error verbatim for the caller to decode into a typed
 * outcome; this module does not know what a CoinVault is.
 *
 * WHAT CONFIRMED MEANS. A receipt whose block is `confirmations` deep under
 * `latest` AND still canonical when re-fetched by number. A receipt in a block
 * that has since been reorged away is discarded and polled again: the
 * transaction may land in the replacement block, or never. A broadcast whose
 * receipt does not arrive inside the deadline is reported as PENDING with its
 * hash - it may still land, and the caller must treat it as unknown, not as
 * failed.
 *
 * THE NODE'S HASH MUST BE OURS. A node that reports a different hash for the
 * raw bytes we sent broadcast something we did not sign; that is refused, and
 * the hash we computed is reported as pending because the node may have
 * broadcast that too.
 */

import {
  RpcError,
  isHex,
  type BlockRef,
  type ChainWriteClient,
  type Hex,
  type TransactionReceipt,
} from '@fee-split-vaults/indexer'
import { systemClock, type Clock } from '@fee-split-vaults/orchestrator'
import type { TransactionSigner } from './signer.js'
import { signTransaction } from './tx.js'

export type BroadcastErrorCode =
  | 'chain_mismatch'
  | 'simulation_failed'
  | 'rpc_unavailable'
  | 'broadcast_failed'
  | 'tx_hash_mismatch'
  | 'confirmation_timeout'
  | 'reverted'

export class BroadcastError extends Error {
  constructor(
    message: string,
    readonly code: BroadcastErrorCode,
    /** A broadcast transaction whose fate is unknown. It may still land. */
    readonly pendingTxHash: Hex | null = null,
    /** selector + abi-encoded args from a simulation revert, when the node supplied them. */
    readonly revertData: Hex | null = null,
  ) {
    super(message)
    this.name = new.target.name
  }
}

export interface BroadcasterOptions {
  readonly rpc: ChainWriteClient
  readonly signer: TransactionSigner
  readonly chainId: number
  /** Blocks a receipt must be buried under `latest` before it counts. >= 1. */
  readonly confirmations: number
  readonly clock?: Clock
  readonly pollIntervalMs?: number
  /** From broadcast to confirmed receipt. */
  readonly receiptTimeoutSeconds?: number
  readonly sleep?: (ms: number) => Promise<void>
}

export interface TransactionRequest {
  readonly to: string
  readonly data: Hex
  /** Skips simulation when supplied: the caller already priced this exact call. */
  readonly gasLimit?: bigint
}

export interface ConfirmedTransaction {
  readonly txHash: Hex
  readonly receipt: TransactionReceipt
  /** The canonical block the receipt sits in; its timestamp is when the call happened. */
  readonly block: BlockRef
}

/** JsonRpcClient appends `(revert data 0x…)` to a node error that carried revert bytes. */
const REVERT_DATA_PREFIX = '(revert data '

export function revertDataOf(error: RpcError): Hex | null {
  const start = error.message.indexOf(REVERT_DATA_PREFIX)
  if (start === -1) return null
  const from = start + REVERT_DATA_PREFIX.length
  const end = error.message.indexOf(')', from)
  if (end === -1) return null
  const candidate = error.message.slice(from, end)
  return isHex(candidate) ? candidate : null
}

export class TransactionBroadcaster {
  readonly #rpc: ChainWriteClient
  readonly #signer: TransactionSigner
  readonly #chainId: number
  readonly #confirmations: bigint
  readonly #clock: Clock
  readonly #pollIntervalMs: number
  readonly #receiptTimeoutSeconds: number
  readonly #sleep: (ms: number) => Promise<void>
  #chainVerified = false

  constructor(options: BroadcasterOptions) {
    if (!Number.isInteger(options.confirmations) || options.confirmations < 1) {
      throw new RangeError('confirmations must be an integer >= 1')
    }
    if (!Number.isInteger(options.chainId) || options.chainId <= 0) {
      throw new RangeError('chainId must be a positive integer')
    }
    this.#rpc = options.rpc
    this.#signer = options.signer
    this.#chainId = options.chainId
    this.#confirmations = BigInt(options.confirmations)
    this.#clock = options.clock ?? systemClock
    this.#pollIntervalMs = options.pollIntervalMs ?? 2_000
    this.#receiptTimeoutSeconds = options.receiptTimeoutSeconds ?? 180
    // lib is ES2023: Promise.withResolvers is not available to this build.
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** The address every transaction is sent from; what the contract sees as msg.sender. */
  get sender(): string {
    return this.#signer.address
  }

  get clock(): Clock {
    return this.#clock
  }

  /** Verified once per instance: the node answers for the configured chain. */
  async assertChain(): Promise<void> {
    if (this.#chainVerified) return
    let actual: number
    try {
      actual = await this.#rpc.getChainId()
    } catch (error) {
      throw error instanceof RpcError ? new BroadcastError(error.message, 'rpc_unavailable') : error
    }
    if (actual !== this.#chainId) {
      throw new BroadcastError(`rpc is chain ${actual}, configured for ${this.#chainId}`, 'chain_mismatch')
    }
    this.#chainVerified = true
  }

  /**
   * Executes the call against pending state from the operator's address and
   * returns a gas limit with 20% headroom. A revert refuses with the node's
   * revert data attached; nothing is signed.
   */
  async simulate(request: Pick<TransactionRequest, 'to' | 'data'>): Promise<bigint> {
    await this.assertChain()
    try {
      const estimate = await this.#rpc.estimateGas({ from: this.#signer.address, to: request.to, data: request.data })
      return (estimate * 12n) / 10n
    } catch (error) {
      if (error instanceof RpcError) throw new BroadcastError(error.message, 'simulation_failed', null, revertDataOf(error))
      throw error
    }
  }

  async send(request: TransactionRequest): Promise<ConfirmedTransaction> {
    const gasLimit = request.gasLimit ?? (await this.simulate(request))
    await this.assertChain()

    let nonce: bigint
    let maxFeePerGas: bigint
    let maxPriorityFeePerGas: bigint
    try {
      const [baseFee, priority, count] = await Promise.all([
        this.#rpc.getBaseFeePerGas('latest'),
        this.#rpc.maxPriorityFeePerGas(),
        this.#rpc.getTransactionCount(this.#signer.address, 'pending'),
      ])
      maxPriorityFeePerGas = priority
      maxFeePerGas = baseFee * 2n + priority
      nonce = count
    } catch (error) {
      if (error instanceof RpcError) throw new BroadcastError(error.message, 'rpc_unavailable')
      throw error
    }

    const signed = await signTransaction(
      {
        chainId: BigInt(this.#chainId),
        nonce,
        maxPriorityFeePerGas,
        maxFeePerGas,
        gasLimit,
        to: request.to,
        value: 0n,
        data: request.data,
      },
      this.#signer,
    )
    let reported: Hex
    try {
      reported = await this.#rpc.sendRawTransaction(signed.raw)
    } catch (error) {
      if (error instanceof RpcError) throw new BroadcastError(error.message, 'broadcast_failed')
      throw error
    }
    if (reported !== signed.hash) {
      throw new BroadcastError(`node reported tx ${reported}, expected ${signed.hash}`, 'tx_hash_mismatch', signed.hash)
    }

    let confirmed: ConfirmedTransaction | null
    try {
      confirmed = await this.#awaitConfirmed(signed.hash)
    } catch (error) {
      if (error instanceof RpcError) throw new BroadcastError(error.message, 'rpc_unavailable', signed.hash)
      throw error
    }
    if (confirmed === null) {
      throw new BroadcastError(
        `no confirmed receipt for ${signed.hash} within the deadline`,
        'confirmation_timeout',
        signed.hash,
      )
    }
    if (confirmed.receipt.status !== 1) {
      throw new BroadcastError(`tx ${signed.hash} reverted in block ${confirmed.receipt.blockNumber}`, 'reverted')
    }
    return confirmed
  }

  /**
   * Null means the deadline passed without a confirmed receipt. A receipt whose
   * block is no longer canonical is discarded and re-fetched.
   */
  async #awaitConfirmed(hash: Hex): Promise<ConfirmedTransaction | null> {
    const deadline = this.#clock.nowUnix() + this.#receiptTimeoutSeconds
    for (;;) {
      const receipt = await this.#rpc.getTransactionReceipt(hash)
      if (receipt !== null) {
        const latest = await this.#rpc.getBlockByTag('latest')
        if (latest.number - receipt.blockNumber + 1n >= this.#confirmations) {
          const canonical = await this.#rpc.getBlockByNumber(receipt.blockNumber)
          if (canonical !== null && canonical.hash === receipt.blockHash) return { txHash: hash, receipt, block: canonical }
        }
      }
      if (this.#clock.nowUnix() >= deadline) return null
      await this.#sleep(this.#pollIntervalMs)
    }
  }
}
