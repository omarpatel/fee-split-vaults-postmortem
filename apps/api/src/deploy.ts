/**
 * Vault address prediction and deployment.
 *
 * THE CREATE2 BASE IS THE DEPLOYER, NOT THE FACTORY. VaultFactory embedding
 * CoinVault's init code exceeded EIP-170, so the factory delegates to a
 * VaultDeployer it constructs, and `_predict` in the factory hashes
 * `address(deployer)`. Using the factory address here would silently yield
 * wrong addresses for every vault, and "silently wrong address" means a dev
 * points their fee recipiency at a contract that does not exist.
 * contracts/test/unit/VaultFactory.t.sol::test_predictionIsPureCreate2 shows
 * the exact recomputation this mirrors.
 */

import type { Address, Consent } from '@fee-split-vaults/core'
import { bytesToHex, concatBytes, encodeAddress, hexToBytes, keccakHex, normalizeAddress } from './crypto/address.js'
import { consentSalt } from './eip712.js'

export interface FactoryDescriptor {
  /** The VaultFactory. Used for the EIP-712 domain, NOT for CREATE2. */
  factory: Address
  /** factory.deployer(). This is the CREATE2 base address. */
  deployer: Address
  /** factory.VAULT_INIT_CODE_HASH(). */
  vaultInitCodeHash: string
  chainId: number
}

/** last20(keccak(0xff ++ deployer ++ salt ++ initCodeHash)) */
export function predictVault(consent: Consent, factory: FactoryDescriptor): Address {
  const salt = consentSalt(consent)
  const preimage = concatBytes(
    new Uint8Array([0xff]),
    encodeAddress(factory.deployer).subarray(12),
    hexToBytes(salt),
    hexToBytes(factory.vaultInitCodeHash),
  )
  return normalizeAddress(bytesToHex(hexToBytes(keccakHex(preimage)).subarray(12)))
}

/**
 * Submits a deployment. The service holds no dev key: it takes the dev's own
 * signature rather than producing one. The operator key that pays for the
 * transaction is OPERATOR_SIGNER_KEY, wired in live.ts, and the port refuses
 * when there is none.
 */
export interface VaultDeployer {
  deploy(consent: Consent, devSignature: string): Promise<DeploymentReceipt>
  /** Reads factory.isVault(addr) at a pinned block. Absence is not "not yet". */
  isDeployed(vault: Address): Promise<boolean>
}

export interface DeploymentReceipt {
  vault: Address
  txHash: string
  blockHash?: string
  deployedAtUnix: number
}

export class DeploymentError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(`deploy: ${message}`)
    this.name = 'DeploymentError'
  }
}

/**
 * In-memory deployer.
 *
 * It computes the SAME predicted address the real factory would, so a test that
 * checks the onboarding machine's address handling is checking the real
 * arithmetic rather than a stub's opinion.
 */
export class FakeVaultDeployer implements VaultDeployer {
  readonly deployed = new Map<string, DeploymentReceipt>()
  #seq = 0
  #failNext: string | undefined

  constructor(
    private readonly factory: FactoryDescriptor,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  failNext(reason: string): void {
    this.#failNext = reason
  }

  async deploy(consent: Consent, devSignature: string): Promise<DeploymentReceipt> {
    if (this.#failNext !== undefined) {
      const reason = this.#failNext
      this.#failNext = undefined
      throw new DeploymentError(reason, 'deployment_failed')
    }
    if (devSignature.length < 4) {
      throw new DeploymentError('no signature supplied', 'unsigned')
    }
    const vault = predictVault(consent, this.factory)
    const existing = this.deployed.get(vault)
    // CREATE2 to an occupied address reverts on chain; the same must be true here.
    if (existing !== undefined) throw new DeploymentError('vault already deployed', 'already_deployed')
    this.#seq += 1
    const receipt: DeploymentReceipt = {
      vault,
      txHash: `0x${this.#seq.toString(16).padStart(64, '0')}`,
      deployedAtUnix: this.now(),
    }
    this.deployed.set(vault, receipt)
    return receipt
  }

  async isDeployed(vault: Address): Promise<boolean> {
    return this.deployed.has(normalizeAddress(vault))
  }
}
