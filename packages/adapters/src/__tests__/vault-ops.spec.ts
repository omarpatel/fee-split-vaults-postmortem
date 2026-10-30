import {
  bytesToHex,
  hexToBytes,
  keccak256,
  RpcError,
  type BlockRef,
  type BlockTag,
  type ChainWriteClient,
  type Hex,
  type PinnedCall,
  type RpcLog,
  type TransactionCall,
  type TransactionReceipt,
} from '@fee-split-vaults/indexer'
import { describe, expect, it } from 'vitest'
import {
  AbiEncodeError,
  MAX_SWEEP_ASSETS,
  VAULT_ERROR_SIGNATURES,
  VAULT_VIEW_SELECTORS,
  VAULT_WRITE_SELECTORS,
  customErrorSelector,
  decodeCheckSolvency,
  decodeCustomError,
  decodeLegs,
  decodeVaultState,
  encodeBind,
  encodeBudgetAvailable,
  encodeClaim,
  encodeClaimToken,
  encodeLegOf,
  encodeSettle,
  encodeSweep,
  encodeWithdrawOperator,
} from '../chain/abi-encode.js'
import { BroadcastError, TransactionBroadcaster, revertDataOf } from '../chain/broadcast.js'
import { PrivateKeySigner } from '../chain/signer.js'
import { VaultOpError, VaultOperatorClient, VaultReadClient } from '../chain/vault-ops.js'

const VAULT = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const TOKEN = '0xcccccccccccccccccccccccccccccccccccccccc'
const ASSET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NATIVE = '0x0000000000000000000000000000000000000000'
const CHAIN_ID = 4663
const NOW = 1_757_000_000
const OPERATOR = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'

const word = (n: bigint | number): string => BigInt(n).toString(16).padStart(64, '0')
const addr = (a: string): string => a.slice(2).toLowerCase().padStart(64, '0')

// ---------------------------------------------------------------------------
// Selectors and calldata. The pins below were computed once from the exact
// Solidity signatures; a drift in a signature string changes the selector and
// fails here before it fails on chain.
// ---------------------------------------------------------------------------

describe('CoinVault selectors', () => {
  it('pin keccak of the exact Solidity signatures', () => {
    expect(VAULT_WRITE_SELECTORS).toEqual({
      bind: '0x81bac14f',
      activate: '0x0f15f4c0',
      suspend: '0xe6400bbe',
      resume: '0x046f7da2',
      heartbeat: '0x3defb962',
      withdrawOperator: '0xa5e63668',
      claim: '0x379607f5',
      claimToken: '0x1698755f',
      sweep: '0x780469bb',
      settle: '0x6a256b29',
    })
    expect(VAULT_VIEW_SELECTORS).toEqual({
      state: '0xc19d93fb',
      token: '0xfc0c546a',
      legOf: '0xac7d296e',
      budgetAvailable: '0xb9a70628',
      checkSolvency: '0x784042f0',
      lastOperatorActionUnix: '0x0cd391e9',
    })
  })

  it('custom error selectors: BadState takes the enum as uint8', () => {
    expect(customErrorSelector('BadState')).toBe('0xe7ec536e')
    expect(customErrorSelector('AlreadyBound')).toBe('0x682a9065')
    expect(customErrorSelector('OperatorLegFrozen')).toBe('0x71cddce5')
    expect(customErrorSelector('UseClaimForNative')).toBe('0x983fed01')
    expect(customErrorSelector('TooManyAssets')).toBe('0xdf8153c7')
    expect(customErrorSelector('InsufficientBalance')).toBe('0xcf479181')
    expect(Object.keys(VAULT_ERROR_SIGNATURES)).toHaveLength(31)
  })
})

describe('CoinVault calldata', () => {
  it('bind(address): selector + left-padded address', () => {
    expect(encodeBind(TOKEN)).toBe(`0x81bac14f${addr(TOKEN)}`)
  })

  it('withdrawOperator(address,uint256) and claimToken(address,uint256): two head words, no destination', () => {
    expect(encodeWithdrawOperator(ASSET, 1_000_000n)).toBe(`0xa5e63668${addr(ASSET)}${word(1_000_000)}`)
    expect(encodeClaimToken(ASSET, 5n)).toBe(`0x1698755f${addr(ASSET)}${word(5)}`)
    expect(encodeClaim(7n)).toBe(`0x379607f5${word(7)}`)
    expect(encodeSettle(ASSET)).toBe(`0x6a256b29${addr(ASSET)}`)
    expect(encodeLegOf(ASSET)).toBe(`0xac7d296e${addr(ASSET)}`)
    expect(encodeBudgetAvailable(ASSET)).toBe(`0xb9a70628${addr(ASSET)}`)
  })

  it('sweep(address[]): dynamic array head offset 0x20, then length, then one word per address', () => {
    expect(encodeSweep([ASSET, TOKEN])).toBe(`0x780469bb${word(0x20)}${word(2)}${addr(ASSET)}${addr(TOKEN)}`)
    expect(() => encodeSweep([])).toThrow(AbiEncodeError)
    expect(() => encodeSweep(new Array<string>(MAX_SWEEP_ASSETS + 1).fill(ASSET))).toThrow(AbiEncodeError)
  })

  it('claimToken on the native sentinel is refused before the contract reverts UseClaimForNative', () => {
    expect(() => encodeClaimToken(NATIVE, 1n)).toThrow(AbiEncodeError)
  })
})

// ---------------------------------------------------------------------------
// Return decoding
// ---------------------------------------------------------------------------

describe('return decoding', () => {
  it('VaultState by Solidity ordinal; anything past TERMINATED is refused', () => {
    expect(decodeVaultState(`0x${word(0)}`)).toBe('UNBOUND')
    expect(decodeVaultState(`0x${word(4)}`)).toBe('ACTIVE')
    expect(decodeVaultState(`0x${word(7)}`)).toBe('TERMINATED')
    expect(() => decodeVaultState(`0x${word(8)}`)).toThrow(AbiEncodeError)
    expect(() => decodeVaultState('0x')).toThrow(AbiEncodeError)
  })

  it('Legs is four words in struct order: dev, budget, operator_, referrer', () => {
    expect(decodeLegs(`0x${word(10)}${word(20)}${word(30)}${word(4)}`)).toEqual({
      dev: 10n,
      budget: 20n,
      operator: 30n,
      referrer: 4n,
    })
    expect(() => decodeLegs(`0x${word(1)}${word(2)}${word(3)}`)).toThrow(AbiEncodeError)
  })

  it('checkSolvency is (bool, balance, accounted) and a non-boolean word is refused', () => {
    expect(decodeCheckSolvency(`0x${word(1)}${word(500)}${word(300)}`)).toEqual({
      solvent: true,
      balance: 500n,
      accounted: 300n,
    })
    expect(() => decodeCheckSolvency(`0x${word(2)}${word(0)}${word(0)}`)).toThrow(AbiEncodeError)
  })

  it('custom errors decode by selector with their static args; unknown selectors and wrong arity are undefined', () => {
    expect(decodeCustomError(`0xe7ec536e${word(4)}`)).toEqual({
      source: 'vault',
      name: 'BadState',
      selector: '0xe7ec536e',
      args: [4n],
    })
    expect(decodeCustomError(`0xcf479181${word(9)}${word(3)}`)).toEqual({
      source: 'escrow',
      name: 'InsufficientBalance',
      selector: '0xcf479181',
      args: [9n, 3n],
    })
    expect(decodeCustomError('0x682a9065')?.name).toBe('AlreadyBound')
    expect(decodeCustomError('0xe7ec536e')).toBeUndefined()
    expect(decodeCustomError('0x08c379a0')).toBeUndefined()
    expect(decodeCustomError('0x')).toBeUndefined()
  })

  it('revertDataOf lifts the bytes JsonRpcClient appends to a node error', () => {
    expect(revertDataOf(new RpcError('eth_estimateGas error 3: execution reverted (revert data 0xe7ec536e)', 'x'))).toBe(
      '0xe7ec536e',
    )
    expect(revertDataOf(new RpcError('eth_estimateGas transport failure', 'x'))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// A scripted vault
// ---------------------------------------------------------------------------

interface Sent {
  raw: Hex
  hash: Hex
  data: Hex
}

class ScriptedChain implements ChainWriteClient {
  readonly endpointId = 'scripted'
  chainId = CHAIN_ID
  height = 100n
  /** Revert data the simulation returns for a given calldata selector. */
  revertFor = new Map<string, Hex | 'opaque'>()
  /** eth_call answers by selector. */
  views = new Map<string, Hex>()
  statusFor: (sendIndex: number) => 0 | 1 = () => 1
  minePending = true
  logsFor: (sendIndex: number, blockHash: Hex) => RpcLog[] = () => []
  readonly sent: Sent[] = []
  readonly estimates: TransactionCall[] = []
  readonly calls: PinnedCall[] = []
  readonly receipts = new Map<string, TransactionReceipt>()

  block(number: bigint): BlockRef {
    return {
      number,
      hash: bytesToHex(keccak256(new TextEncoder().encode(`block-${number}`))),
      parentHash: bytesToHex(keccak256(new TextEncoder().encode(`block-${number - 1n}`))),
      timestampUnix: NOW + Number(number - 100n),
    }
  }

  async getChainId(): Promise<number> {
    return this.chainId
  }
  async getBlockByTag(_tag: BlockTag): Promise<BlockRef> {
    return this.block(this.height)
  }
  async getBlockByNumber(number: bigint): Promise<BlockRef | null> {
    return this.block(number)
  }
  async call(request: PinnedCall): Promise<Hex> {
    this.calls.push(request)
    const answer = this.views.get(request.data.slice(0, 10))
    if (answer === undefined) throw new RpcError(`unscripted view ${request.data}`, this.endpointId)
    return answer
  }
  async getBaseFeePerGas(): Promise<bigint> {
    return 10n
  }
  async maxPriorityFeePerGas(): Promise<bigint> {
    return 1n
  }
  async getTransactionCount(): Promise<bigint> {
    return BigInt(this.sent.length)
  }
  async estimateGas(call: TransactionCall): Promise<bigint> {
    this.estimates.push(call)
    const revert = this.revertFor.get(call.data.slice(0, 10))
    if (revert === 'opaque') throw new RpcError('eth_estimateGas error 3: execution reverted', this.endpointId)
    if (revert !== undefined) {
      throw new RpcError(`eth_estimateGas error 3: execution reverted (revert data ${revert})`, this.endpointId)
    }
    return 100_000n
  }
  async sendRawTransaction(raw: Hex): Promise<Hex> {
    const hash = bytesToHex(keccak256(hexToBytes(raw)))
    const data = this.estimates[this.estimates.length - 1]?.data ?? '0x'
    const index = this.sent.length
    this.sent.push({ raw, hash, data })
    if (this.minePending) {
      this.height += 1n
      const block = this.block(this.height)
      this.receipts.set(hash, {
        transactionHash: hash,
        status: this.statusFor(index),
        blockNumber: this.height,
        blockHash: block.hash,
        gasUsed: 90_000n,
        logs: this.logsFor(index, block.hash),
      })
    }
    return hash
  }
  async getTransactionReceipt(hash: Hex): Promise<TransactionReceipt | null> {
    return this.receipts.get(hash) ?? null
  }
}

function harness() {
  const chain = new ScriptedChain()
  let now = NOW
  const options = {
    rpc: chain,
    signer: new PrivateKeySigner(`0x${'0'.repeat(63)}1`),
    chainId: CHAIN_ID,
    confirmations: 1,
    clock: { nowUnix: () => now },
    pollIntervalMs: 1,
    receiptTimeoutSeconds: 5,
    sleep: async () => {
      now += 1
      chain.height += 1n
    },
  }
  return { chain, ops: new VaultOperatorClient(options), reads: new VaultReadClient({ rpc: chain }) }
}

async function refusal(promise: Promise<unknown>): Promise<VaultOpError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof VaultOpError) return error
    throw error
  }
  throw new Error('expected a VaultOpError')
}

describe('VaultOperatorClient', () => {
  it('activate(): simulates from the operator address, signs, and reports the confirmed receipt', async () => {
    const { chain, ops } = harness()
    const receipt = await ops.activate(VAULT)
    expect(chain.estimates[0]).toEqual({ from: OPERATOR, to: VAULT, data: '0x0f15f4c0' })
    expect(chain.sent).toHaveLength(1)
    expect(receipt.txHash).toBe(chain.sent[0]?.hash)
    expect(receipt.blockNumber).toBe(101n)
    expect(receipt.blockHash).toBe(chain.block(101n).hash)
    expect(receipt.gasUsed).toBe(90_000n)
    expect(receipt.block.timestampUnix).toBe(NOW + 1)
  })

  it('a simulated BadState(current) refuses as bad_state with the vault state named, and nothing is broadcast', async () => {
    const { chain, ops } = harness()
    chain.revertFor.set(VAULT_WRITE_SELECTORS.activate, `0xe7ec536e${word(2)}`)
    const error = await refusal(ops.activate(VAULT))
    expect(error.code).toBe('bad_state')
    expect(error.currentState).toBe('BOUND')
    expect(error.contractError?.args).toEqual([2n])
    expect(error.pendingTxHash).toBeNull()
    expect(chain.sent).toHaveLength(0)
  })

  it('maps every declared custom error to its typed code; an escrow error bubbled through claim is named too', async () => {
    const { chain, ops } = harness()
    chain.revertFor.set(VAULT_WRITE_SELECTORS.bind, '0x682a9065')
    expect((await refusal(ops.bind(VAULT, TOKEN))).code).toBe('already_bound')
    chain.revertFor.set(VAULT_WRITE_SELECTORS.withdrawOperator, '0x71cddce5')
    expect((await refusal(ops.withdrawOperator(VAULT, ASSET, 1n))).code).toBe('operator_leg_frozen')
    chain.revertFor.set(VAULT_WRITE_SELECTORS.claim, `0xcf479181${word(9)}${word(3)}`)
    const escrow = await refusal(ops.claim(VAULT, 9n))
    expect(escrow.code).toBe('escrow_insufficient_balance')
    expect(escrow.contractError?.source).toBe('escrow')
    chain.revertFor.set(VAULT_WRITE_SELECTORS.settle, '0xdeadbeef')
    expect((await refusal(ops.settle(VAULT, ASSET))).code).toBe('unknown_revert')
    chain.revertFor.set(VAULT_WRITE_SELECTORS.suspend, 'opaque')
    expect((await refusal(ops.suspend(VAULT))).code).toBe('simulation_failed')
    expect(chain.sent).toHaveLength(0)
  })

  it('refuses claimToken on the native asset and an oversized sweep without touching the chain', async () => {
    const { chain, ops } = harness()
    expect((await refusal(ops.claimToken(VAULT, NATIVE, 1n))).code).toBe('use_claim_for_native')
    expect((await refusal(ops.sweep(VAULT, new Array<string>(33).fill(ASSET)))).code).toBe('too_many_assets')
    expect((await refusal(ops.sweep(VAULT, []))).code).toBe('nothing_to_do')
    expect(chain.estimates).toHaveLength(0)
  })

  it('a tx that reverts on chain after passing simulation is `reverted`; a lost receipt is pending', async () => {
    const { chain, ops } = harness()
    chain.statusFor = () => 0
    expect((await refusal(ops.heartbeat(VAULT))).code).toBe('reverted')
    chain.statusFor = () => 1
    chain.minePending = false
    const pending = await refusal(ops.heartbeat(VAULT))
    expect(pending.code).toBe('confirmation_timeout')
    expect(pending.pendingTxHash).toBe(chain.sent[1]?.hash)
  })

  it('refuses to sign against a node on the wrong chain', async () => {
    const { chain, ops } = harness()
    chain.chainId = 1
    expect((await refusal(ops.resume(VAULT))).code).toBe('chain_mismatch')
    expect(chain.sent).toHaveLength(0)
  })

  it('hands back the receipt logs so a caller can read the Claimed event', async () => {
    const { chain, ops } = harness()
    chain.logsFor = (_i, blockHash) => [
      {
        address: VAULT,
        topics: [`0x${'11'.repeat(32)}`],
        data: '0x',
        blockNumber: 101n,
        blockHash,
        transactionHash: `0x${'22'.repeat(32)}`,
        logIndex: 0,
        removed: false,
      },
    ]
    const receipt = await ops.claimToken(VAULT, ASSET, 10n)
    expect(receipt.logs).toHaveLength(1)
  })
})

describe('VaultReadClient', () => {
  it('pins every view to the head block unless a hash is supplied, and decodes each strictly', async () => {
    const { chain, reads } = harness()
    chain.views.set(VAULT_VIEW_SELECTORS.state, `0x${word(4)}`)
    chain.views.set(VAULT_VIEW_SELECTORS.legOf, `0x${word(1)}${word(2)}${word(3)}${word(4)}`)
    chain.views.set(VAULT_VIEW_SELECTORS.budgetAvailable, `0x${word(2)}`)
    chain.views.set(VAULT_VIEW_SELECTORS.checkSolvency, `0x${word(1)}${word(15)}${word(10)}`)
    chain.views.set(VAULT_VIEW_SELECTORS.lastOperatorActionUnix, `0x${word(NOW)}`)
    chain.views.set(VAULT_VIEW_SELECTORS.token, `0x${addr(TOKEN)}`)

    expect(await reads.state(VAULT)).toBe('ACTIVE')
    expect(await reads.legOf(VAULT, ASSET)).toEqual({ dev: 1n, budget: 2n, operator: 3n, referrer: 4n })
    expect(await reads.budgetAvailable(VAULT, ASSET)).toBe(2n)
    expect(await reads.checkSolvency(VAULT, ASSET)).toEqual({ solvent: true, balance: 15n, accounted: 10n })
    expect(await reads.lastOperatorActionUnix(VAULT)).toBe(NOW)
    expect(await reads.token(VAULT)).toBe(TOKEN)
    for (const call of chain.calls) expect(call.blockHash).toBe(chain.block(100n).hash)

    const pinned = chain.block(42n).hash
    await reads.state(VAULT, pinned)
    expect(chain.calls[chain.calls.length - 1]?.blockHash).toBe(pinned)
  })

  it('refuses a state ordinal the enum does not have rather than defaulting', async () => {
    const { chain, reads } = harness()
    chain.views.set(VAULT_VIEW_SELECTORS.state, `0x${word(9)}`)
    await expect(reads.state(VAULT)).rejects.toThrow(AbiEncodeError)
  })

  it('accepts the quorum shape (head) as well as a write client (getBlockByTag)', async () => {
    const { chain } = harness()
    chain.views.set(VAULT_VIEW_SELECTORS.state, `0x${word(5)}`)
    const quorum = new VaultReadClient({ rpc: { call: (r) => chain.call(r), head: async () => chain.block(7n) } })
    expect(await quorum.state(VAULT)).toBe('SUSPENDED')
    expect(chain.calls[0]?.blockHash).toBe(chain.block(7n).hash)
    expect(() => new VaultReadClient({ rpc: { call: (r) => chain.call(r) } })).toThrow(RangeError)
  })
})

describe('TransactionBroadcaster', () => {
  it('rejects a confirmations setting that would count an unmined tx', () => {
    expect(
      () =>
        new TransactionBroadcaster({
          rpc: new ScriptedChain(),
          signer: new PrivateKeySigner(`0x${'0'.repeat(63)}1`),
          chainId: CHAIN_ID,
          confirmations: 0,
        }),
    ).toThrow(RangeError)
  })

  it('carries revert data on a simulation failure', async () => {
    const { chain } = harness()
    chain.revertFor.set('0x12345678', '0xabcdef01')
    const tx = new TransactionBroadcaster({
      rpc: chain,
      signer: new PrivateKeySigner(`0x${'0'.repeat(63)}1`),
      chainId: CHAIN_ID,
      confirmations: 1,
    })
    await expect(tx.send({ to: VAULT, data: '0x12345678' })).rejects.toMatchObject({
      code: 'simulation_failed',
      revertData: '0xabcdef01',
    } satisfies Partial<BroadcastError>)
  })
})
