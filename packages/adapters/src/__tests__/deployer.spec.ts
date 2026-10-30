/**
 * VaultFactory.deploy through the operator signer against a scripted node.
 *
 * The calldata vector is laid out by hand against the compiled ABI
 * (contracts/out/VaultFactory.sol/VaultFactory.json: deploy = 0x9b41e2f4,
 * isVault = 0x652b9b41). The refusals are the two the factory cannot make for
 * us: a VaultDeployed log naming an address other than the one the consent
 * fixed, and a receipt that reverted.
 */
import type { Consent } from '@fee-split-vaults/core'
import {
  addressToTopic,
  bytesToHex,
  hexToBytes,
  keccak256,
  keccak256Hex,
  RpcError,
  type BlockRef,
  type BlockTag,
  type ChainWriteClient,
  type Hex,
  type LogQuery,
  type PinnedCall,
  type RpcLog,
  type TransactionCall,
  type TransactionReceipt,
} from '@fee-split-vaults/indexer'
import { describe, expect, it } from 'vitest'
import {
  DEPLOY_SELECTOR,
  IS_VAULT_SELECTOR,
  VAULT_DEPLOYED_TOPIC,
  consentSalt,
  encodeConsentWords,
  encodeDeploy,
  encodeIsVault,
} from '../chain/abi-encode.js'
import { ChainVaultDeployer, VaultDeployError, predictVaultAddress, type FactoryAddresses } from '../chain/deployer.js'
import type { PinnedChainReads } from '../chain/recipients.js'
import { PrivateKeySigner } from '../chain/signer.js'

const CHAIN_ID = 4663
const NOW = 1_757_000_000
const FACTORY: FactoryAddresses = {
  factory: '0xfac70000000000000000000000000000000000f1',
  deployer: '0xdeb10000000000000000000000000000000000d2',
  vaultInitCodeHash: keccak256Hex('CoinVault init code'),
}
const CONSENT: Consent = {
  devSigner: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  devPayout: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  token: '0xcccccccccccccccccccccccccccccccccccccccc',
  termsHash: `0x${'11'.repeat(32)}`,
  operatorBps: 1_000,
  budgetBpsMax: 2_000,
  adapter: '0xdddddddddddddddddddddddddddddddddddddddd',
  referrer: `0x${'0'.repeat(40)}`,
  referrerBps: 0,
  expiryUnix: 1_800_000_000,
  nonce: `0x${'22'.repeat(32)}`,
}
const DEV_SIG = `0x${'ab'.repeat(64)}1c`
const SIGNER = new PrivateKeySigner(`0x${'0'.repeat(63)}1`)

// ---------------------------------------------------------------------------
// ABI
// ---------------------------------------------------------------------------

describe('VaultFactory ABI', () => {
  it('selectors and topic agree with the compiled artifact', () => {
    expect(DEPLOY_SELECTOR).toBe('0x9b41e2f4')
    expect(IS_VAULT_SELECTOR).toBe('0x652b9b41')
    expect(VAULT_DEPLOYED_TOPIC).toBe(
      keccak256Hex('VaultDeployed(address,address,bytes32,(address,address,address,bytes32,uint16,uint16,address,address,uint16,uint64,bytes32),bool)'),
    )
  })

  it('encodeDeploy lays out the static tuple inline, the sig offset at 0x180, then length + padded bytes', () => {
    const words =
      `${'0'.repeat(24)}${'aa'.repeat(20)}` +
      `${'0'.repeat(24)}${'bb'.repeat(20)}` +
      `${'0'.repeat(24)}${'cc'.repeat(20)}` +
      '11'.repeat(32) +
      `${'0'.repeat(61)}3e8` + // operatorBps 1000
      `${'0'.repeat(61)}7d0` + // budgetBpsMax 2000
      `${'0'.repeat(24)}${'dd'.repeat(20)}` +
      '0'.repeat(64) + // referrer
      '0'.repeat(64) + // referrerBps
      `${'0'.repeat(56)}6b49d200` + // expiryUnix 1_800_000_000
      '22'.repeat(32)
    expect(encodeConsentWords(CONSENT)).toBe(`0x${words}`)
    const expected =
      DEPLOY_SELECTOR +
      words +
      `${'0'.repeat(61)}180` + // offset: 12 words
      `${'0'.repeat(62)}41` + // 65 bytes
      `${'ab'.repeat(64)}1c${'0'.repeat(62)}` // padded to 96 bytes
    expect(encodeDeploy(CONSENT, DEV_SIG)).toBe(expected)
    expect(encodeDeploy(CONSENT, DEV_SIG).length).toBe(2 + 8 + 64 * 16)
  })

  it('consentSalt is keccak256(abi.encode(consent)) with no typehash prefix', () => {
    expect(consentSalt(CONSENT)).toBe(bytesToHex(keccak256(hexToBytes(encodeConsentWords(CONSENT)))))
  })

  it('refuses a short nonce rather than zero-padding two nonces onto one salt', () => {
    expect(() => encodeConsentWords({ ...CONSENT, nonce: '0x01' })).toThrow(/nonce/)
    expect(() => encodeConsentWords({ ...CONSENT, operatorBps: 70_000 })).toThrow(/operatorBps/)
    expect(() => encodeDeploy(CONSENT, '0x')).toThrow(/devSignature/)
  })

  it('isVault(address) is selector + one padded address word', () => {
    expect(encodeIsVault(CONSENT.devPayout)).toBe(`${IS_VAULT_SELECTOR}${'0'.repeat(24)}${'bb'.repeat(20)}`)
  })

  it('predictVaultAddress reproduces the EIP-1014 vectors', () => {
    const emptyInit = keccak256Hex(new Uint8Array([0x00]))
    expect(
      predictVaultAddress({ factory: FACTORY.factory, deployer: `0x${'0'.repeat(40)}`, vaultInitCodeHash: emptyInit }, `0x${'0'.repeat(64)}`),
    ).toBe('0x4d1a2e2bb4f88f0250f26ffff098b0b30b26bf38')
    expect(
      predictVaultAddress({ factory: FACTORY.factory, deployer: '0xdeadbeef00000000000000000000000000000000', vaultInitCodeHash: emptyInit }, `0x${'0'.repeat(64)}`),
    ).toBe('0xb928f69bb1d91cd65274e3c79d8986362984fda3')
  })
})

// ---------------------------------------------------------------------------
// Deployment against a scripted node
// ---------------------------------------------------------------------------

class ScriptedNode implements ChainWriteClient, PinnedChainReads {
  readonly endpointId = 'scripted'
  chainId = CHAIN_ID
  height = 100n
  finalizedNumber = 98n
  readonly sent: Array<{ raw: Hex; hash: Hex }> = []
  readonly estimated: TransactionCall[] = []
  readonly pinnedCalls: PinnedCall[] = []
  /** What the receipt for the next send says. */
  status: 0 | 1 = 1
  logsFor: (vault: string, salt: Hex) => RpcLog[] = () => []
  isVaultResult: Hex = `0x${'0'.repeat(63)}1`
  failEstimate: string | null = null

  block(number: bigint): BlockRef {
    return {
      number,
      hash: keccak256Hex(`block-${number}`),
      parentHash: keccak256Hex(`block-${number - 1n}`),
      timestampUnix: NOW + Number(number),
    }
  }

  async assertChain(): Promise<void> {}
  async getChainId(): Promise<number> {
    return this.chainId
  }
  async getBlockByTag(tag: BlockTag): Promise<BlockRef> {
    return this.block(tag === 'finalized' ? this.finalizedNumber : this.height)
  }
  async head(): Promise<BlockRef> {
    return this.block(this.height)
  }
  async blockByNumber(blockNumber: bigint): Promise<BlockRef | null> {
    return this.block(blockNumber)
  }
  async getBlockByNumber(blockNumber: bigint): Promise<BlockRef | null> {
    return this.block(blockNumber)
  }
  async blockByHash(): Promise<BlockRef | null> {
    return null
  }
  async getLogs(_query: LogQuery): Promise<RpcLog[]> {
    return []
  }
  async call(request: PinnedCall): Promise<Hex> {
    this.pinnedCalls.push(request)
    return this.isVaultResult
  }
  async getBaseFeePerGas(): Promise<bigint> {
    return 1_000_000_000n
  }
  async maxPriorityFeePerGas(): Promise<bigint> {
    return 1_000_000n
  }
  async getTransactionCount(): Promise<bigint> {
    return BigInt(this.sent.length)
  }
  async estimateGas(call: TransactionCall): Promise<bigint> {
    this.estimated.push(call)
    if (this.failEstimate !== null) throw new RpcError(this.failEstimate, this.endpointId)
    return 500_000n
  }
  async sendRawTransaction(raw: Hex): Promise<Hex> {
    const hash = bytesToHex(keccak256(hexToBytes(raw)))
    this.sent.push({ raw, hash })
    return hash
  }
  async getTransactionReceipt(hash: Hex): Promise<TransactionReceipt | null> {
    const sent = this.sent.find((s) => s.hash === hash)
    if (sent === undefined) return null
    const number = this.height - 2n
    const salt = consentSalt(CONSENT)
    const vault = predictVaultAddress(FACTORY, salt)
    return {
      transactionHash: hash,
      status: this.status,
      blockNumber: number,
      blockHash: this.block(number).hash,
      gasUsed: 400_000n,
      logs: this.status === 1 ? this.logsFor(vault, salt).map((log) => ({ ...log, blockNumber: number, blockHash: this.block(number).hash, transactionHash: hash })) : [],
    }
  }
}

function vaultDeployedLog(vault: string, salt: Hex): RpcLog {
  return {
    address: FACTORY.factory,
    topics: [VAULT_DEPLOYED_TOPIC, addressToTopic(vault), addressToTopic(CONSENT.devPayout), salt],
    data: '0x',
    blockNumber: 0n,
    blockHash: `0x${'0'.repeat(64)}`,
    transactionHash: `0x${'0'.repeat(64)}`,
    logIndex: 0,
    removed: false,
  }
}

function deployer(node: ScriptedNode): ChainVaultDeployer {
  return new ChainVaultDeployer({
    rpc: node,
    reads: node,
    signer: SIGNER,
    factory: FACTORY,
    chainId: CHAIN_ID,
    confirmations: 2,
    clock: { nowUnix: () => NOW },
    receiptTimeoutSeconds: 60,
    sleep: async () => undefined,
  })
}

describe('ChainVaultDeployer.deploy', () => {
  it('sends deploy(consent, devSig) to the factory and reports the vault the VaultDeployed log names', async () => {
    const node = new ScriptedNode()
    node.logsFor = (vault, salt) => [vaultDeployedLog(vault, salt)]

    const receipt = await deployer(node).deploy(CONSENT, DEV_SIG)

    expect(receipt.vault).toBe(predictVaultAddress(FACTORY, consentSalt(CONSENT)))
    expect(receipt.txHash).toBe(node.sent[0]?.hash)
    expect(receipt.deployedAtUnix).toBe(NOW + Number(node.height - 2n))
    expect(node.estimated[0]).toMatchObject({ from: SIGNER.address, to: FACTORY.factory, data: encodeDeploy(CONSENT, DEV_SIG) })
    // The signed bytes carry the calldata verbatim.
    expect(node.sent[0]?.raw.includes(encodeDeploy(CONSENT, DEV_SIG).slice(2))).toBe(true)
  })

  it('refuses when the factory deployed somewhere other than the address the consent fixed', async () => {
    const node = new ScriptedNode()
    node.logsFor = (_vault, salt) => [vaultDeployedLog('0x9999999999999999999999999999999999999999', salt)]

    const error = await deployer(node)
      .deploy(CONSENT, DEV_SIG)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(VaultDeployError)
    expect((error as VaultDeployError).code).toBe('address_mismatch')
    expect((error as VaultDeployError).txHash).toBe(node.sent[0]?.hash)
  })

  it('refuses a receipt that reverted; nothing was deployed', async () => {
    const node = new ScriptedNode()
    node.status = 0
    node.logsFor = (vault, salt) => [vaultDeployedLog(vault, salt)]

    await expect(deployer(node).deploy(CONSENT, DEV_SIG)).rejects.toMatchObject({ code: 'reverted' })
  })

  it('refuses a successful receipt with no VaultDeployed log from the factory', async () => {
    const node = new ScriptedNode()
    await expect(deployer(node).deploy(CONSENT, DEV_SIG)).rejects.toMatchObject({ code: 'event_missing' })
  })

  it('surfaces the factory revert from simulation before any gas is spent', async () => {
    const node = new ScriptedNode()
    node.failEstimate = 'execution reverted (revert data 0x8d4f5f9e)'
    await expect(deployer(node).deploy(CONSENT, DEV_SIG)).rejects.toMatchObject({ code: 'simulation_failed' })
    expect(node.sent).toHaveLength(0)
  })

  it('refuses a node on the wrong chain before signing anything', async () => {
    const node = new ScriptedNode()
    node.chainId = 1
    await expect(deployer(node).deploy(CONSENT, DEV_SIG)).rejects.toMatchObject({ code: 'chain_mismatch' })
    expect(node.estimated).toHaveLength(0)
  })
})

describe('ChainVaultDeployer.isDeployed', () => {
  it('calls factory.isVault(vault) pinned to the agreed head block hash and decodes the bool strictly', async () => {
    const node = new ScriptedNode()
    const vault = predictVaultAddress(FACTORY, consentSalt(CONSENT))
    await expect(deployer(node).isDeployed(vault)).resolves.toBe(true)
    expect(node.pinnedCalls[0]).toEqual({ to: FACTORY.factory, data: encodeIsVault(vault), blockHash: node.block(node.height).hash })

    node.isVaultResult = `0x${'0'.repeat(64)}`
    await expect(deployer(node).isDeployed(vault)).resolves.toBe(false)
    node.isVaultResult = `0x${'0'.repeat(63)}2`
    await expect(deployer(node).isDeployed(vault)).rejects.toThrow(/bool/)
  })
})
