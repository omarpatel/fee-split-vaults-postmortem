/**
 * The real SettlementPort: CoinVault.pullBudget on the Venue chain.
 *
 * RULE 3 IS RE-ASSERTED HERE. The port takes one ReimbursementPull and nothing
 * else; the pull's destination is compared with the operator treasury this
 * port was constructed with, and the calldata built from it has no address
 * argument for money to go to (see abi-encode.ts). The vault pays its own
 * immutable OPERATOR_TREASURY; a pull naming anything else is refused before
 * an RPC is made.
 *
 * MONEY NEVER OVER-RECORDED. A pull is a list of bounded transfer chunks. Each
 * chunk is its own transaction, confirmed to depth before the next is sent. A
 * failure after k chunks landed throws a SettlementError whose settledMinor
 * and txHashes describe exactly those k chunks, so the caller's ledger can
 * record what moved and only what moved. A chunk whose fate is unknown
 * (broadcast, then no receipt inside the deadline) is reported as pending, not
 * as settled.
 *
 * IDEMPOTENCY. The vault marks every invoiceHash used and reverts on reuse.
 * Chunk 0 uses the pull's invoiceHash verbatim; chunk i>0 uses
 * keccak256(invoiceHash || uint256 i) so a split pull does not trip its own
 * guard. Before sending any chunk, usedInvoice(hash) is read at the latest
 * block: a hit means an earlier run already landed it and this is a retry,
 * which surfaces as `already_settled` rather than as a revert.
 */

import type { OperatorTreasury, ReimbursementPull } from '@fee-split-vaults/broker'
import {
  addressEquals,
  bytesToHex,
  hexToBytes,
  keccak256,
  normalizeAddress,
  normalizeHash32,
  RpcError,
  type ChainWriteClient,
  type Hex,
} from '@fee-split-vaults/indexer'
import { systemClock, type Clock, type SettlementPort, type SettlementReceipt } from '@fee-split-vaults/orchestrator'
import { decodeBool, encodePullBudget, encodeUsedInvoice } from './abi-encode.js'
import { BroadcastError, TransactionBroadcaster } from './broadcast.js'
import type { TransactionSigner } from './signer.js'

export type SettlementErrorCode =
  | 'destination_not_treasury'
  | 'invoice_hash_malformed'
  | 'countersig_malformed'
  | 'transfers_malformed'
  | 'chain_mismatch'
  | 'already_settled'
  | 'simulation_failed'
  | 'broadcast_failed'
  | 'tx_hash_mismatch'
  | 'reverted'
  | 'confirmation_timeout'
  | 'rpc_unavailable'

/**
 * Every refusal carries the partial-settlement facts: how much landed before
 * this chunk, under which hashes, and whether a chunk is still in flight.
 * `settledMinor > 0n` is a PARTIAL settlement and must be ledgered as such.
 */
export class SettlementError extends Error {
  constructor(
    message: string,
    readonly code: SettlementErrorCode,
    readonly chunkIndex: number | null,
    readonly settledMinor: bigint,
    readonly txHashes: readonly Hex[],
    /** A broadcast chunk whose receipt never arrived. It may still land. */
    readonly pendingTxHash: Hex | null = null,
  ) {
    super(message)
    this.name = new.target.name
  }

  get partial(): boolean {
    return this.settledMinor > 0n
  }
}

export interface ChainSettlementReceipt extends SettlementReceipt {
  readonly blockHash: string
  /** One per chunk, in send order. txHash is the last of them. */
  readonly txHashes: readonly Hex[]
}

export interface ChainSettlementOptions {
  readonly rpc: ChainWriteClient
  readonly signer: TransactionSigner
  readonly treasury: OperatorTreasury
  readonly chainId: number
  /** Blocks a receipt must be buried under `latest` before a chunk counts. >= 1. */
  readonly confirmations: number
  readonly clock?: Clock
  readonly pollIntervalMs?: number
  /** Per chunk, from broadcast to confirmed receipt. */
  readonly receiptTimeoutSeconds?: number
  readonly sleep?: (ms: number) => Promise<void>
}

const HASH32 = /^0x[0-9a-fA-F]{64}$/
const COUNTERSIG = /^0x(?:[0-9a-fA-F]{2})+$/
const ZERO_HASH = `0x${'0'.repeat(64)}`

/** Chunk 0 is the invoice hash verbatim; later chunks are keccak256(hash || uint256 index). */
export function chunkInvoiceHash(invoiceHash: string, index: number): Hex {
  const base = normalizeHash32(invoiceHash)
  if (index === 0) return base
  const input = new Uint8Array(64)
  input.set(hexToBytes(base))
  input.set(hexToBytes(`0x${BigInt(index).toString(16).padStart(64, '0')}`), 32)
  return bytesToHex(keccak256(input))
}

export class ChainSettlementPort implements SettlementPort {
  readonly #rpc: ChainWriteClient
  readonly #tx: TransactionBroadcaster
  readonly #treasury: string
  readonly #clock: Clock

  constructor(options: ChainSettlementOptions) {
    this.#tx = new TransactionBroadcaster(options)
    this.#rpc = options.rpc
    this.#treasury = normalizeAddress(options.treasury.address)
    this.#clock = options.clock ?? systemClock
  }

  async submit(pull: ReimbursementPull): Promise<ChainSettlementReceipt> {
    // Refusals that need no chain. Nothing below is reached with a pull that
    // could pay anyone but the treasury or that the vault would reject on shape.
    if (!addressEquals(pull.destination, this.#treasury)) {
      throw new SettlementError(
        `pull destination ${pull.destination} is not the operator treasury ${this.#treasury}`,
        'destination_not_treasury',
        null,
        0n,
        [],
      )
    }
    if (!HASH32.test(pull.invoiceHash) || pull.invoiceHash.toLowerCase() === ZERO_HASH) {
      throw new SettlementError('invoiceHash must be a non-zero bytes32 hex', 'invoice_hash_malformed', null, 0n, [])
    }
    if (!COUNTERSIG.test(pull.vendorCountersig)) {
      throw new SettlementError('vendorCountersig must be non-empty 0x-hex bytes', 'countersig_malformed', null, 0n, [])
    }
    if (pull.transfers.length === 0 || pull.transfers.some((chunk) => chunk <= 0n)) {
      throw new SettlementError('transfers must be one or more positive chunks', 'transfers_malformed', null, 0n, [])
    }
    if (pull.transfers.reduce((sum, chunk) => sum + chunk, 0n) !== pull.amountMinor) {
      throw new SettlementError('transfers do not sum to amountMinor', 'transfers_malformed', null, 0n, [])
    }

    try {
      await this.#tx.assertChain()
    } catch (error) {
      if (error instanceof BroadcastError) throw new SettlementError(error.message, error.code, null, 0n, [])
      throw error
    }

    const vault = normalizeAddress(pull.vault)
    const countersig = pull.vendorCountersig as Hex
    const txHashes: Hex[] = []
    let settledMinor = 0n
    let lastBlockHash: Hex = ZERO_HASH as Hex

    for (let index = 0; index < pull.transfers.length; index++) {
      const amount = pull.transfers[index] ?? 0n
      const invoiceHash = chunkInvoiceHash(pull.invoiceHash, index)
      const fail = (message: string, code: SettlementErrorCode, pending: Hex | null = null) =>
        new SettlementError(`chunk ${index}: ${message}`, code, index, settledMinor, txHashes, pending)

      // 1. Retry detection. A used hash means this chunk already landed.
      let used: boolean
      try {
        const latest = await this.#rpc.getBlockByTag('latest')
        used = decodeBool(await this.#rpc.call({ to: vault, data: encodeUsedInvoice(invoiceHash), blockHash: latest.hash }))
      } catch (error) {
        throw error instanceof RpcError ? fail(error.message, 'rpc_unavailable') : error
      }
      if (used) throw fail(`invoice ${invoiceHash} is already used on the vault`, 'already_settled')

      // 2. Simulate, price, sign, broadcast, confirm. A vault that would revert
      //    (frozen, wrong state, budget short) refuses in simulation without
      //    spending gas; a chunk whose receipt never arrives is pending.
      const data = encodePullBudget({ asset: pull.asset, amount, invoiceHash, vendorCountersig: countersig })
      let confirmed
      try {
        confirmed = await this.#tx.send({ to: vault, data })
      } catch (error) {
        throw error instanceof BroadcastError ? fail(error.message, error.code, error.pendingTxHash) : error
      }

      txHashes.push(confirmed.txHash)
      settledMinor += amount
      lastBlockHash = confirmed.receipt.blockHash
    }

    const txHash = txHashes[txHashes.length - 1] ?? (ZERO_HASH as Hex)
    return { txHash, blockHash: lastBlockHash, settledMinor, settledAtUnix: this.#clock.nowUnix(), txHashes }
  }
}
