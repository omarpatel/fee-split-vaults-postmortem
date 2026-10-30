import type { ReimbursementPull } from '@fee-split-vaults/broker'
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
  type TransactionCall,
  type TransactionReceipt,
} from '@fee-split-vaults/indexer'
import { describe, expect, it } from 'vitest'
import {
  PULL_BUDGET_SELECTOR,
  USED_INVOICE_SELECTOR,
  decodeBool,
  encodePullBudget,
  encodeUsedInvoice,
} from '../chain/abi-encode.js'
import { ChainSettlementPort, SettlementError, chunkInvoiceHash } from '../chain/settlement.js'
import { PrivateKeySigner } from '../chain/signer.js'

const ASSET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const VAULT = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const TREASURY = '0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc'
const VENDOR = '0xdddddddddddddddddddddddddddddddddddddddd'
const INVOICE = `0x${'11'.repeat(32)}`
const COUNTERSIG: Hex = '0xdeadbeef'
const CHAIN_ID = 4663
const NOW = 1_757_000_000

// ---------------------------------------------------------------------------
// ABI
// ---------------------------------------------------------------------------

describe('encodePullBudget', () => {
  it('matches the hand-laid-out calldata: selector, 4 head words, bytes tail at 0x80', () => {
    const data = encodePullBudget({ asset: ASSET, amount: 1_000_000n, invoiceHash: INVOICE, vendorCountersig: COUNTERSIG })
    const expected =
      PULL_BUDGET_SELECTOR +
      `${'0'.repeat(24)}${ASSET.slice(2)}` + // address, left-padded
      `${'0'.repeat(59)}f4240` + // uint256 1_000_000
      '11'.repeat(32) + // bytes32
      `${'0'.repeat(62)}80` + // offset of the bytes tail
      `${'0'.repeat(63)}4` + // bytes length 4
      `deadbeef${'0'.repeat(56)}` // right-padded content
    expect(data).toBe(expected)
    expect(data.length).toBe(2 + 8 + 64 * 6)
  })

  it('there is no treasury or vendor address anywhere in the calldata (rule 3)', () => {
    const data = encodePullBudget({ asset: ASSET, amount: 5n, invoiceHash: INVOICE, vendorCountersig: COUNTERSIG })
    expect(data).not.toContain(TREASURY.slice(2).toLowerCase())
    expect(data).not.toContain(VENDOR.slice(2))
  })

  it('refuses an empty countersig rather than sending a call the vault reverts', () => {
    expect(() => encodePullBudget({ asset: ASSET, amount: 5n, invoiceHash: INVOICE, vendorCountersig: '0x' })).toThrow()
  })

  it('usedInvoice(bytes32) is selector + one word, and its bool result decodes strictly', () => {
    expect(encodeUsedInvoice(INVOICE)).toBe(`${USED_INVOICE_SELECTOR}${'11'.repeat(32)}`)
    expect(decodeBool(`0x${'0'.repeat(63)}1`)).toBe(true)
    expect(decodeBool(`0x${'0'.repeat(64)}`)).toBe(false)
    expect(() => decodeBool(`0x${'0'.repeat(63)}2`)).toThrow()
    expect(() => decodeBool('0x')).toThrow()
  })
})

describe('chunkInvoiceHash', () => {
  it('is the invoice hash verbatim for chunk 0 and keccak(hash || index) afterwards', () => {
    expect(chunkInvoiceHash(INVOICE, 0)).toBe(INVOICE)
    const input = new Uint8Array(64)
    input.set(hexToBytes(INVOICE as Hex))
    input[63] = 2
    expect(chunkInvoiceHash(INVOICE, 2)).toBe(bytesToHex(keccak256(input)))
    expect(chunkInvoiceHash(INVOICE, 1)).not.toBe(chunkInvoiceHash(INVOICE, 2))
  })
})

// ---------------------------------------------------------------------------
// Settlement against a scripted chain
// ---------------------------------------------------------------------------

interface Sent {
  raw: Hex
  hash: Hex
  data: Hex
}

/** A one-node chain that mines whatever it is sent, on a script the test controls. */
class ScriptedChain implements ChainWriteClient {
  readonly endpointId = 'scripted'
  chainId = CHAIN_ID
  height = 100n
  usedInvoices = new Set<string>()
  /** Receipt status per send index; default 1. */
  statusFor: (sendIndex: number) => 0 | 1 = () => 1
  /** Blocks it takes the node to show a receipt after broadcast. */
  minePending = true
  reportedHash: ((hash: Hex) => Hex) | null = null
  forkedReceiptBlock = false
  readonly sent: Sent[] = []
  readonly calls: TransactionCall[] = []
  readonly receipts = new Map<string, TransactionReceipt>()
  failEstimate: string | null = null

  private block(number: bigint): BlockRef {
    return {
      number,
      hash: bytesToHex(keccak256(new TextEncoder().encode(`block-${number}`))),
      parentHash: bytesToHex(keccak256(new TextEncoder().encode(`block-${number - 1n}`))),
      timestampUnix: NOW,
    }
  }

  async getChainId(): Promise<number> {
    return this.chainId
  }
  async getBlockByTag(_tag: BlockTag): Promise<BlockRef> {
    return this.block(this.height)
  }
  async getBlockByNumber(number: bigint): Promise<BlockRef | null> {
    if (this.forkedReceiptBlock) return { ...this.block(number), hash: `0x${'ff'.repeat(32)}` }
    return this.block(number)
  }
  async call(request: PinnedCall): Promise<Hex> {
    expect(request.blockHash).toBe(this.block(this.height).hash)
    const hash = `0x${request.data.slice(10)}`
    return `0x${'0'.repeat(63)}${this.usedInvoices.has(hash) ? '1' : '0'}`
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
    this.calls.push(call)
    if (this.failEstimate !== null) throw new RpcError(this.failEstimate, this.endpointId)
    return 100_000n
  }
  async sendRawTransaction(raw: Hex): Promise<Hex> {
    const hash = bytesToHex(keccak256(hexToBytes(raw)))
    const data = this.calls[this.calls.length - 1]?.data ?? '0x'
    const index = this.sent.length
    this.sent.push({ raw, hash, data })
    if (this.minePending) {
      this.height += 1n
      const status = this.statusFor(index)
      if (status === 1) this.usedInvoices.add(`0x${data.slice(10 + 64 * 2, 10 + 64 * 3)}`)
      this.receipts.set(hash, {
        transactionHash: hash,
        status,
        blockNumber: this.height,
        blockHash: this.block(this.height).hash,
        gasUsed: 90_000n,
        logs: [],
      })
    }
    return this.reportedHash === null ? hash : this.reportedHash(hash)
  }
  async getTransactionReceipt(hash: Hex): Promise<TransactionReceipt | null> {
    return this.receipts.get(hash) ?? null
  }
}

function pullOf(overrides: Partial<ReimbursementPull> = {}): ReimbursementPull {
  return {
    vault: VAULT,
    destination: TREASURY,
    asset: ASSET,
    amountMinor: 1_000_000n,
    transfers: [1_000_000n],
    amountUsdCents: 100_00n,
    invoiceHash: INVOICE,
    vendorCountersig: COUNTERSIG,
    memo: 'reimbursement',
    ...overrides,
  }
}

function harness(opts: { confirmations?: number; timeoutSeconds?: number } = {}) {
  const chain = new ScriptedChain()
  let now = NOW
  const port = new ChainSettlementPort({
    rpc: chain,
    signer: new PrivateKeySigner(`0x${'0'.repeat(63)}1`),
    treasury: { address: TREASURY, label: 'ops treasury' },
    chainId: CHAIN_ID,
    confirmations: opts.confirmations ?? 1,
    clock: { nowUnix: () => now },
    pollIntervalMs: 1,
    receiptTimeoutSeconds: opts.timeoutSeconds ?? 30,
    // Each poll costs a second of wall time and mines a block, so depth-based
    // confirmation and the receipt deadline are both driven by the test.
    sleep: async () => {
      now += 1
      chain.height += 1n
    },
  })
  return { chain, port }
}

async function refusal(promise: Promise<unknown>): Promise<SettlementError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof SettlementError) return error
    throw error
  }
  throw new Error('expected a SettlementError')
}

describe('ChainSettlementPort', () => {
  it('refuses a destination that is not the operator treasury before touching the chain', async () => {
    const { chain, port } = harness()
    const error = await refusal(port.submit(pullOf({ destination: VENDOR })))
    expect(error.code).toBe('destination_not_treasury')
    expect(chain.calls).toHaveLength(0)
    expect(chain.sent).toHaveLength(0)
  })

  it('refuses malformed invoice hashes, countersigs and transfer lists (rule 8)', async () => {
    const { port } = harness()
    expect((await refusal(port.submit(pullOf({ invoiceHash: '0x1234' })))).code).toBe('invoice_hash_malformed')
    expect((await refusal(port.submit(pullOf({ invoiceHash: `0x${'0'.repeat(64)}` })))).code).toBe(
      'invoice_hash_malformed',
    )
    expect((await refusal(port.submit(pullOf({ vendorCountersig: 'signed-by-vendor' })))).code).toBe(
      'countersig_malformed',
    )
    expect((await refusal(port.submit(pullOf({ vendorCountersig: '0x' })))).code).toBe('countersig_malformed')
    expect((await refusal(port.submit(pullOf({ transfers: [] })))).code).toBe('transfers_malformed')
    expect((await refusal(port.submit(pullOf({ transfers: [600_000n, 300_000n] })))).code).toBe(
      'transfers_malformed',
    )
  })

  it('refuses to sign against a node on the wrong chain', async () => {
    const { chain, port } = harness()
    chain.chainId = 1
    expect((await refusal(port.submit(pullOf()))).code).toBe('chain_mismatch')
    expect(chain.sent).toHaveLength(0)
  })

  it('settles one chunk: pullBudget calldata, own tx hash, receipt block, and the pull amount', async () => {
    const { chain, port } = harness()
    const receipt = await port.submit(pullOf())

    expect(chain.sent).toHaveLength(1)
    expect(chain.calls[0]?.to).toBe(VAULT)
    expect(chain.calls[0]?.from).toBe('0x7e5f4552091a69125d5dfcb7b8c2659029395bdf')
    expect(chain.calls[0]?.data).toBe(
      encodePullBudget({ asset: ASSET, amount: 1_000_000n, invoiceHash: INVOICE, vendorCountersig: COUNTERSIG }),
    )
    expect(receipt.txHash).toBe(chain.sent[0]?.hash)
    expect(receipt.txHashes).toEqual([chain.sent[0]?.hash])
    expect(receipt.blockHash).toBe(chain.receipts.get(receipt.txHash)?.blockHash)
    expect(receipt.settledMinor).toBe(1_000_000n)
    expect(receipt.settledAtUnix).toBe(NOW)
    // The raw tx carries the vault as `to` and nothing that could be a payee.
    expect(chain.sent[0]?.raw).toContain(VAULT.slice(2))
    expect(chain.sent[0]?.raw).not.toContain(TREASURY.slice(2).toLowerCase())
  })

  it('reports a retry of a landed pull as already_settled, without sending', async () => {
    const { chain, port } = harness()
    await port.submit(pullOf())
    const error = await refusal(port.submit(pullOf()))
    expect(error.code).toBe('already_settled')
    expect(error.chunkIndex).toBe(0)
    expect(error.settledMinor).toBe(0n)
    expect(chain.sent).toHaveLength(1)
  })

  it('a chunk that reverts after earlier chunks landed is PARTIAL: settled amount and hashes so far', async () => {
    const { chain, port } = harness()
    chain.statusFor = (index) => (index === 1 ? 0 : 1)
    const error = await refusal(port.submit(pullOf({ transfers: [600_000n, 300_000n, 100_000n] })))

    expect(error.code).toBe('reverted')
    expect(error.chunkIndex).toBe(1)
    expect(error.partial).toBe(true)
    expect(error.settledMinor).toBe(600_000n)
    expect(error.txHashes).toEqual([chain.sent[0]?.hash])
    expect(error.pendingTxHash).toBeNull()
    // The third chunk was never attempted.
    expect(chain.sent).toHaveLength(2)
  })

  it('uses distinct invoice hashes per chunk so a split pull clears the vault reuse guard', async () => {
    const { chain, port } = harness()
    const receipt = await port.submit(pullOf({ transfers: [600_000n, 400_000n] }))
    expect(receipt.settledMinor).toBe(1_000_000n)
    expect(receipt.txHashes).toHaveLength(2)
    expect(chain.calls[0]?.data).toContain(INVOICE.slice(2))
    expect(chain.calls[1]?.data).toContain(chunkInvoiceHash(INVOICE, 1).slice(2))
  })

  it('a simulation revert refuses before broadcast and carries the node message', async () => {
    const { chain, port } = harness()
    chain.failEstimate = 'eth_estimateGas error 3: execution reverted (revert data 0x1a2b3c4d)'
    const error = await refusal(port.submit(pullOf()))
    expect(error.code).toBe('simulation_failed')
    expect(error.message).toContain('0x1a2b3c4d')
    expect(chain.sent).toHaveLength(0)
  })

  it('waits until the receipt is `confirmations` deep before counting the chunk', async () => {
    const { chain, port } = harness({ confirmations: 3 })
    const receipt = await port.submit(pullOf())
    const mined = chain.receipts.get(receipt.txHash)?.blockNumber ?? 0n
    expect(chain.height - mined + 1n).toBeGreaterThanOrEqual(3n)
  })

  it('does not count a receipt whose block left the canonical chain', async () => {
    const { chain, port } = harness({ timeoutSeconds: 3 })
    chain.forkedReceiptBlock = true
    const error = await refusal(port.submit(pullOf()))
    expect(error.code).toBe('confirmation_timeout')
    expect(error.settledMinor).toBe(0n)
    expect(error.pendingTxHash).toBe(chain.sent[0]?.hash)
  })

  it('a broadcast chunk with no receipt by the deadline is pending, never settled', async () => {
    const { chain, port } = harness({ timeoutSeconds: 2 })
    chain.minePending = false
    const error = await refusal(port.submit(pullOf({ transfers: [600_000n, 400_000n] })))
    expect(error.code).toBe('confirmation_timeout')
    expect(error.chunkIndex).toBe(0)
    expect(error.settledMinor).toBe(0n)
    expect(error.pendingTxHash).toBe(chain.sent[0]?.hash)
    expect(chain.sent).toHaveLength(1)
  })

  it('refuses when the node reports a hash for something other than what was signed', async () => {
    const { chain, port } = harness()
    chain.reportedHash = () => `0x${'ee'.repeat(32)}`
    const error = await refusal(port.submit(pullOf()))
    expect(error.code).toBe('tx_hash_mismatch')
    expect(error.pendingTxHash).toBe(chain.sent[0]?.hash)
  })

  it('rejects a confirmations setting that would count an unmined tx', () => {
    expect(
      () =>
        new ChainSettlementPort({
          rpc: new ScriptedChain(),
          signer: new PrivateKeySigner(`0x${'0'.repeat(63)}1`),
          treasury: { address: TREASURY, label: 't' },
          chainId: CHAIN_ID,
          confirmations: 0,
        }),
    ).toThrow(RangeError)
  })
})
