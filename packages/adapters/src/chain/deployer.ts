/**
 * VaultFactory.deploy on the Venue chain, signed by the operator key.
 *
 * The factory takes the consent the dev signed and the dev's EIP-712
 * signature over it; anyone may submit the pair, and the operator does. Two
 * things are checked here that the factory cannot check for us:
 *
 *   THE ADDRESS. The consent fixed the vault's CREATE2 address before anything
 *   was signed, and every quote the dev has seen names it. The VaultDeployed
 *   log names the address the factory actually produced, and the two must be
 *   equal - if they are not, our mirror of the factory's arithmetic is wrong
 *   and every address we have ever quoted is suspect, so the deployment is
 *   refused as a mismatch rather than recorded at the address that appeared.
 *
 *   THE RECEIPT. A transaction that reverted deployed nothing; a receipt whose
 *   block was reorged away deployed nothing yet. Both wait or refuse, and
 *   neither is reported as a deployment.
 *
 * Reads go through the quorum. The write goes to one node: a broadcast is
 * idempotent by nonce and needs no second opinion.
 */

import type { Consent } from '@fee-split-vaults/core'
import {
  RpcError,
  addressEquals,
  bytesToHex,
  hexToBytes,
  keccak256,
  normalizeAddress,
  normalizeHash32,
  topicToAddress,
  type BlockRef,
  type ChainWriteClient,
  type Hex,
  type TransactionReceipt,
} from '@fee-split-vaults/indexer'
import { systemClock, type Clock } from '@fee-split-vaults/orchestrator'
import {
  VAULT_DEPLOYED_TOPIC,
  consentSalt,
  decodeBool,
  encodeDeploy,
  encodeIsVault,
} from './abi-encode.js'
import type { PinnedChainReads } from './recipients.js'
import type { TransactionSigner } from './signer.js'
import { signTransaction } from './tx.js'

export type VaultDeployErrorCode =
  | 'chain_mismatch'
  | 'simulation_failed'
  | 'rpc_unavailable'
  | 'broadcast_failed'
  | 'tx_hash_mismatch'
  | 'confirmation_timeout'
  | 'reverted'
  | 'event_missing'
  | 'address_mismatch'

export class VaultDeployError extends Error {
  constructor(
    message: string,
    readonly code: VaultDeployErrorCode,
    /** The broadcast hash, when a transaction left this process. It may still land. */
    readonly txHash: Hex | null = null,
  ) {
    super(`deploy: ${message}`)
    this.name = new.target.name
  }
}

export interface FactoryAddresses {
  /** The VaultFactory: the `to` of deploy and isVault. */
  readonly factory: string
  /** factory.deployer(): the CREATE2 base. NOT the factory. */
  readonly deployer: string
  /** factory.VAULT_INIT_CODE_HASH(). */
  readonly vaultInitCodeHash: string
}

export interface ChainVaultDeployerOptions {
  /** The write path: one node, the operator's. */
  readonly rpc: ChainWriteClient
  /** The read path: the quorum, for isVault at the agreed head (see recipients.ts on why not finalized). */
  readonly reads: PinnedChainReads
  readonly signer: TransactionSigner
  readonly factory: FactoryAddresses
  readonly chainId: number
  /** Blocks a receipt must be buried under `latest` before it counts. >= 1. */
  readonly confirmations: number
  readonly clock?: Clock
  readonly pollIntervalMs?: number
  readonly receiptTimeoutSeconds?: number
  readonly sleep?: (ms: number) => Promise<void>
}

export interface ChainDeploymentReceipt {
  readonly vault: string
  readonly txHash: Hex
  readonly blockHash: Hex
  /** The timestamp of the block the deployment landed in. */
  readonly deployedAtUnix: number
}

/** last20(keccak256(0xff ++ deployer ++ salt ++ initCodeHash)): the factory's `_predict`. */
export function predictVaultAddress(factory: FactoryAddresses, salt: Hex): string {
  const preimage = new Uint8Array(1 + 20 + 32 + 32)
  preimage[0] = 0xff
  preimage.set(hexToBytes(normalizeAddress(factory.deployer) as Hex), 1)
  preimage.set(hexToBytes(normalizeHash32(salt)), 21)
  preimage.set(hexToBytes(normalizeHash32(factory.vaultInitCodeHash)), 53)
  return bytesToHex(keccak256(preimage).subarray(12))
}

export class ChainVaultDeployer {
  readonly #rpc: ChainWriteClient
  readonly #reads: PinnedChainReads
  readonly #signer: TransactionSigner
  readonly #factory: FactoryAddresses
  readonly #factoryAddress: string
  readonly #chainId: number
  readonly #confirmations: bigint
  readonly #clock: Clock
  readonly #pollIntervalMs: number
  readonly #receiptTimeoutSeconds: number
  readonly #sleep: (ms: number) => Promise<void>
  #chainVerified = false

  constructor(options: ChainVaultDeployerOptions) {
    if (!Number.isInteger(options.confirmations) || options.confirmations < 1) {
      throw new RangeError('confirmations must be an integer >= 1')
    }
    if (!Number.isInteger(options.chainId) || options.chainId <= 0) {
      throw new RangeError('chainId must be a positive integer')
    }
    this.#rpc = options.rpc
    this.#reads = options.reads
    this.#signer = options.signer
    this.#factory = options.factory
    this.#factoryAddress = normalizeAddress(options.factory.factory)
    this.#chainId = options.chainId
    this.#confirmations = BigInt(options.confirmations)
    this.#clock = options.clock ?? systemClock
    this.#pollIntervalMs = options.pollIntervalMs ?? 2_000
    this.#receiptTimeoutSeconds = options.receiptTimeoutSeconds ?? 180
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  async deploy(consent: Consent, devSignature: string): Promise<ChainDeploymentReceipt> {
    // The address the consent fixed, computed BEFORE anything is sent, so a
    // mismatch below is a comparison with a number we committed to first.
    const salt = consentSalt(consent)
    const expected = predictVaultAddress(this.#factory, salt)
    const data = encodeDeploy(consent, devSignature)

    await this.#assertChain()

    const rpcFail = (error: unknown, code: VaultDeployErrorCode, pending: Hex | null = null): unknown =>
      error instanceof RpcError ? new VaultDeployError(error.message, code, pending) : error

    // Simulate and price. estimateGas executes against pending state, so an
    // expired consent, a bad signature or an occupied address refuses here
    // with the factory's own error and no gas spent.
    let gasLimit: bigint
    try {
      const estimate = await this.#rpc.estimateGas({ from: this.#signer.address, to: this.#factoryAddress, data })
      gasLimit = (estimate * 12n) / 10n
    } catch (error) {
      throw rpcFail(error, 'simulation_failed')
    }
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
      throw rpcFail(error, 'rpc_unavailable')
    }

    const signed = await signTransaction(
      {
        chainId: BigInt(this.#chainId),
        nonce,
        maxPriorityFeePerGas,
        maxFeePerGas,
        gasLimit,
        to: this.#factoryAddress,
        value: 0n,
        data,
      },
      this.#signer,
    )
    let reported: Hex
    try {
      reported = await this.#rpc.sendRawTransaction(signed.raw)
    } catch (error) {
      throw rpcFail(error, 'broadcast_failed')
    }
    if (reported !== signed.hash) {
      throw new VaultDeployError(`node reported tx ${reported}, expected ${signed.hash}`, 'tx_hash_mismatch', signed.hash)
    }

    let confirmed: { receipt: TransactionReceipt; block: BlockRef } | null
    try {
      confirmed = await this.#awaitConfirmed(signed.hash)
    } catch (error) {
      throw rpcFail(error, 'rpc_unavailable', signed.hash)
    }
    if (confirmed === null) {
      throw new VaultDeployError(`no confirmed receipt for ${signed.hash} within the deadline`, 'confirmation_timeout', signed.hash)
    }
    const { receipt, block } = confirmed
    if (receipt.status !== 1) {
      throw new VaultDeployError(`tx ${signed.hash} reverted in block ${receipt.blockNumber}`, 'reverted', signed.hash)
    }

    // The factory says what it deployed, in the one log it emits for it.
    const events = receipt.logs.filter(
      (log) => !log.removed && addressEquals(log.address, this.#factoryAddress) && log.topics[0] === VAULT_DEPLOYED_TOPIC,
    )
    const event = events[0]
    if (event === undefined || events.length !== 1 || event.topics.length !== 4) {
      throw new VaultDeployError(
        `tx ${signed.hash} succeeded but carries ${events.length} VaultDeployed log(s) from the factory`,
        'event_missing',
        signed.hash,
      )
    }
    const vault = topicToAddress(event.topics[1] as Hex)
    const emittedSalt = normalizeHash32(event.topics[3] as Hex)
    if (!addressEquals(vault, expected) || emittedSalt !== salt) {
      throw new VaultDeployError(
        `factory deployed ${vault} for salt ${emittedSalt}; the consent predicts ${expected} for salt ${salt}`,
        'address_mismatch',
        signed.hash,
      )
    }

    return { vault, txHash: signed.hash, blockHash: receipt.blockHash, deployedAtUnix: block.timestampUnix }
  }

  /** factory.isVault(vault) pinned to the head both providers agree on. */
  async isDeployed(vault: string): Promise<boolean> {
    await this.#reads.assertChain()
    const head = await this.#reads.head()
    return decodeBool(
      await this.#reads.call({ to: this.#factoryAddress, data: encodeIsVault(vault), blockHash: head.hash }),
    )
  }

  async #assertChain(): Promise<void> {
    if (this.#chainVerified) return
    let actual: number
    try {
      actual = await this.#rpc.getChainId()
    } catch (error) {
      throw error instanceof RpcError ? new VaultDeployError(error.message, 'rpc_unavailable') : error
    }
    if (actual !== this.#chainId) {
      throw new VaultDeployError(`rpc is chain ${actual}, configured for ${this.#chainId}`, 'chain_mismatch')
    }
    this.#chainVerified = true
  }

  /**
   * Null means the deadline passed without a confirmed receipt. A receipt whose
   * block is no longer canonical is discarded and re-fetched; the canonical
   * block is returned with the receipt because its timestamp is the deploy time.
   */
  async #awaitConfirmed(hash: Hex): Promise<{ receipt: TransactionReceipt; block: BlockRef } | null> {
    const deadline = this.#clock.nowUnix() + this.#receiptTimeoutSeconds
    for (;;) {
      const receipt = await this.#rpc.getTransactionReceipt(hash)
      if (receipt !== null) {
        const latest = await this.#rpc.getBlockByTag('latest')
        if (latest.number - receipt.blockNumber + 1n >= this.#confirmations) {
          const canonical = await this.#rpc.getBlockByNumber(receipt.blockNumber)
          if (canonical !== null && canonical.hash === receipt.blockHash) return { receipt, block: canonical }
        }
      }
      if (this.#clock.nowUnix() >= deadline) return null
      await this.#sleep(this.#pollIntervalMs)
    }
  }
}
