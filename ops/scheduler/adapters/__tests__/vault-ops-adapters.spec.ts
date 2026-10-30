/**
 * The on-chain ops ports against a scripted vault, a scripted escrow and a
 * real Postgres (pglite, all migrations).
 *
 * The chain fake is a small CoinVault: claim/claimToken move credit from the
 * escrow into the vault and settle it in the same call, emitting the vault's
 * real Claimed and Credited logs (built with the same event definitions the
 * adapters decode with); settle() partitions any unaccounted balance; the
 * views answer from the same state. That is enough to prove what matters
 * here - what lands is read from the receipt, a lost receipt is never counted
 * as money, and the outbox survives a crash - without pretending to be a
 * node.
 */

import type { PGlite } from '@electric-sql/pglite'
import {
  ESCROW_BALANCE_OF_SELECTOR,
  ESCROW_BALANCE_OF_TOKEN_SELECTOR,
  EscrowReadClient,
  NATIVE_ASSET,
  PrivateKeySigner,
  VAULT_CLAIMED,
  VAULT_CREDITED,
  VAULT_VIEW_SELECTORS,
  VAULT_WRITE_SELECTORS,
  VaultOpError,
  VaultOperatorClient,
  VaultReadClient,
  customErrorSelector,
} from '@fee-split-vaults/adapters'
import type { Asset, ScreeningResult } from '@fee-split-vaults/core'
import {
  RpcError,
  addressToTopic,
  bytesToHex,
  hexToBytes,
  keccak256,
  type BlockRef,
  type BlockTag,
  type ChainWriteClient,
  type Hex,
  type PinnedCall,
  type RpcLog,
  type TransactionCall,
  type TransactionReceipt,
} from '@fee-split-vaults/indexer'
import { InMemoryPriceBook } from '@fee-split-vaults/orchestrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FixedClock, MINUTE } from '../../../lib/time.js'
import type { SqlDriver } from '../../../migrations/driver.js'
import { SWEEP } from '../../config.js'
import { FakeAlertSink } from '../../fakes.js'
import type { AssetRegistry } from '../../ports.js'
import { ChainEnforcementActions } from '../enforcement.js'
import { OpsAdapterError } from '../errors.js'
import { ChainEscrowReader } from '../escrow.js'
import { ChainVaultHeartbeat } from '../heartbeat.js'
import { ChainSettlementExecutor } from '../settlement.js'
import { ChainSweepExecutor } from '../sweeper.js'
import { openMigratedDb } from './pglite.js'

const VAULT = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const TOKEN = '0xcccccccccccccccccccccccccccccccccccccccc'
const USDC = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const CHAIN_ID = 4663
const NOW = 1_757_000_000

const word = (n: bigint | number): string => BigInt(n).toString(16).padStart(64, '0')
const argAddress = (data: Hex, index: number): string => `0x${data.slice(10 + 64 * index + 24, 10 + 64 * (index + 1))}`
const argWord = (data: Hex, index: number): bigint => BigInt(`0x${data.slice(10 + 64 * index, 10 + 64 * (index + 1))}`)

interface Legs {
  dev: bigint
  budget: bigint
  operator: bigint
  referrer: bigint
}

/** A CoinVault and its escrow, on a chain that mines what it is sent. */
class ScriptedVaultChain implements ChainWriteClient {
  readonly endpointId = 'scripted'
  height = 100n
  state = 4n // ACTIVE
  lastOperatorActionUnix = NOW - 10
  /** Bps the fake vault splits a settled credit by; the referrer is carved out of the operator's gross, as _splitOf does. */
  operatorBps = 500n
  budgetBps = 2_000n
  referrerBps = 0n
  readonly escrow = new Map<string, bigint>()
  readonly balance = new Map<string, bigint>()
  readonly legs = new Map<string, Legs>()
  /** Whether claim(max) above the credit reverts InsufficientBalance (verified ABI) or caps. */
  escrowRevertsAboveBalance = false
  minePending = true
  statusFor: (index: number) => 0 | 1 = () => 1
  readonly sent: Array<{ hash: Hex; data: Hex }> = []
  readonly receipts = new Map<string, TransactionReceipt>()
  #pendingCall: TransactionCall | null = null

  legsOf(asset: string): Legs {
    return this.legs.get(asset.toLowerCase()) ?? { dev: 0n, budget: 0n, operator: 0n, referrer: 0n }
  }

  block(number: bigint): BlockRef {
    return {
      number,
      hash: bytesToHex(keccak256(new TextEncoder().encode(`block-${number}`))),
      parentHash: bytesToHex(keccak256(new TextEncoder().encode(`block-${number - 1n}`))),
      timestampUnix: NOW + Number(number - 100n),
    }
  }

  async getChainId(): Promise<number> {
    return CHAIN_ID
  }
  async getBlockByTag(_tag: BlockTag): Promise<BlockRef> {
    return this.block(this.height)
  }
  async getBlockByNumber(number: bigint): Promise<BlockRef | null> {
    return this.block(number)
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
  async getTransactionReceipt(hash: Hex): Promise<TransactionReceipt | null> {
    return this.receipts.get(hash) ?? null
  }

  async call(request: PinnedCall): Promise<Hex> {
    const selector = request.data.slice(0, 10)
    if (request.to === VAULT) {
      if (selector === VAULT_VIEW_SELECTORS.state) return `0x${word(this.state)}`
      if (selector === VAULT_VIEW_SELECTORS.token) return `0x${word(BigInt(TOKEN))}`
      if (selector === VAULT_VIEW_SELECTORS.lastOperatorActionUnix) return `0x${word(this.lastOperatorActionUnix)}`
      if (selector === VAULT_VIEW_SELECTORS.legOf) {
        const l = this.legsOf(argAddress(request.data, 0))
        return `0x${word(l.dev)}${word(l.budget)}${word(l.operator)}${word(l.referrer)}`
      }
      if (selector === VAULT_VIEW_SELECTORS.checkSolvency) {
        const asset = argAddress(request.data, 0)
        const l = this.legsOf(asset)
        const accounted = l.dev + l.budget + l.operator + l.referrer
        const balance = this.balance.get(asset) ?? 0n
        return `0x${word(balance >= accounted ? 1 : 0)}${word(balance)}${word(accounted)}`
      }
    } else {
      if (selector === ESCROW_BALANCE_OF_SELECTOR) return `0x${word(this.escrow.get(NATIVE_ASSET) ?? 0n)}`
      if (selector === ESCROW_BALANCE_OF_TOKEN_SELECTOR) return `0x${word(this.escrow.get(argAddress(request.data, 1)) ?? 0n)}`
    }
    throw new RpcError(`unscripted view ${request.to} ${selector}`, this.endpointId)
  }

  async estimateGas(call: TransactionCall): Promise<bigint> {
    this.#pendingCall = call
    const selector = call.data.slice(0, 10)
    if (selector === VAULT_WRITE_SELECTORS.claim || selector === VAULT_WRITE_SELECTORS.claimToken) {
      const asset = selector === VAULT_WRITE_SELECTORS.claim ? NATIVE_ASSET : argAddress(call.data, 0)
      const max = argWord(call.data, selector === VAULT_WRITE_SELECTORS.claim ? 0 : 1)
      const available = this.escrow.get(asset) ?? 0n
      if (this.escrowRevertsAboveBalance && max > available) {
        const data = `${customErrorSelector('InsufficientBalance')}${word(max)}${word(available)}`
        throw new RpcError(`eth_estimateGas error 3: execution reverted (revert data ${data})`, this.endpointId)
      }
    }
    if (selector === VAULT_WRITE_SELECTORS.suspend && this.state !== 4n) {
      throw new RpcError(
        `eth_estimateGas error 3: execution reverted (revert data ${customErrorSelector('BadState')}${word(this.state)})`,
        this.endpointId,
      )
    }
    return 100_000n
  }

  async sendRawTransaction(raw: Hex): Promise<Hex> {
    const hash = bytesToHex(keccak256(hexToBytes(raw)))
    const call = this.#pendingCall
    if (call === null) throw new Error('broadcast without simulation')
    this.sent.push({ hash, data: call.data })
    if (!this.minePending) return hash
    this.height += 1n
    const block = this.block(this.height)
    const status = this.statusFor(this.sent.length - 1)
    const logs = status === 1 ? this.#execute(call.data, block, hash) : []
    this.receipts.set(hash, {
      transactionHash: hash,
      status,
      blockNumber: this.height,
      blockHash: block.hash,
      gasUsed: 90_000n,
      logs,
    })
    return hash
  }

  /** Mines a pending (unmined) broadcast later, as if the node caught up. */
  mineLast(): void {
    const last = this.sent[this.sent.length - 1]
    if (last === undefined) return
    this.height += 1n
    const block = this.block(this.height)
    this.receipts.set(last.hash, {
      transactionHash: last.hash,
      status: 1,
      blockNumber: this.height,
      blockHash: block.hash,
      gasUsed: 90_000n,
      logs: this.#execute(last.data, block, last.hash),
    })
  }

  #execute(data: Hex, block: BlockRef, txHash: Hex): RpcLog[] {
    const selector = data.slice(0, 10)
    this.lastOperatorActionUnix = block.timestampUnix
    if (selector === VAULT_WRITE_SELECTORS.suspend) {
      this.state = 5n
      return []
    }
    if (selector === VAULT_WRITE_SELECTORS.heartbeat) return []
    if (selector === VAULT_WRITE_SELECTORS.settle) return this.#settle(argAddress(data, 0), block, txHash, [])
    const native = selector === VAULT_WRITE_SELECTORS.claim
    const asset = native ? NATIVE_ASSET : argAddress(data, 0)
    const max = argWord(data, native ? 0 : 1)
    const available = this.escrow.get(asset) ?? 0n
    const received = max < available ? max : available
    this.escrow.set(asset, available - received)
    this.balance.set(asset, (this.balance.get(asset) ?? 0n) + received)
    const logs: RpcLog[] = [
      {
        address: VAULT,
        topics: [VAULT_CLAIMED.topic0, addressToTopic(asset)],
        data: `0x${word(received)}${word(max)}`,
        blockNumber: block.number,
        blockHash: block.hash,
        transactionHash: txHash,
        logIndex: 0,
        removed: false,
      },
    ]
    return this.#settle(asset, block, txHash, logs)
  }

  #settle(asset: string, block: BlockRef, txHash: Hex, logs: RpcLog[]): RpcLog[] {
    const l = this.legsOf(asset)
    const accounted = l.dev + l.budget + l.operator + l.referrer
    const balance = this.balance.get(asset) ?? 0n
    if (balance <= accounted) return logs
    const amount = balance - accounted
    const operatorGross = (amount * this.operatorBps) / 10_000n
    const budget = (amount * this.budgetBps) / 10_000n
    const dev = amount - operatorGross - budget
    const referrer = (operatorGross * this.referrerBps) / 10_000n
    const operator = operatorGross - referrer
    this.legs.set(asset, {
      dev: l.dev + dev,
      budget: l.budget + budget,
      operator: l.operator + operator,
      referrer: l.referrer + referrer,
    })
    logs.push({
      address: VAULT,
      topics: [VAULT_CREDITED.topic0, addressToTopic(asset)],
      data: `0x${word(amount)}${word(dev)}${word(budget)}${word(operator)}${word(referrer)}`,
      blockNumber: block.number,
      blockHash: block.hash,
      transactionHash: txHash,
      logIndex: logs.length,
      removed: false,
    })
    return logs
  }
}

const ASSETS: Asset[] = [
  { address: NATIVE_ASSET, symbol: 'ETH', decimals: 18, isPausableProxy: false, enabled: true },
  { address: USDC, symbol: 'USDC', decimals: 6, isPausableProxy: true, enabled: true, maxTransferMinor: 400_000_000n },
]

const assets: AssetRegistry = {
  get: async (address) => ASSETS.find((a) => a.address === address.toLowerCase()),
  list: async () => ASSETS,
}

let db: PGlite
let driver: SqlDriver
let chain: ScriptedVaultChain
let clock: FixedClock
let operator: VaultOperatorClient
let reads: VaultReadClient
let escrow: EscrowReadClient

beforeEach(async () => {
  ;({ db, driver } = await openMigratedDb(NOW))
  chain = new ScriptedVaultChain()
  clock = new FixedClock(NOW)
  operator = new VaultOperatorClient({
    rpc: chain,
    signer: new PrivateKeySigner(`0x${'0'.repeat(63)}1`),
    chainId: CHAIN_ID,
    confirmations: 1,
    clock,
    pollIntervalMs: 1,
    receiptTimeoutSeconds: 2,
    sleep: async () => {
      clock.advance(1)
      chain.height += 1n
    },
  })
  reads = new VaultReadClient({ rpc: chain })
  escrow = new EscrowReadClient({ rpc: chain })
})

afterEach(async () => {
  await db.close()
})

async function refused(promise: Promise<unknown>): Promise<OpsAdapterError | VaultOpError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof OpsAdapterError || error instanceof VaultOpError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

// ---------------------------------------------------------------------------

describe('ChainEscrowReader', () => {
  const prices = new InMemoryPriceBook([
    { asset: NATIVE_ASSET, centsPerWholeUnit: 300_000n, source: 'test', pricedAtUnix: NOW - 60 },
    { asset: USDC, centsPerWholeUnit: 100n, source: 'test', pricedAtUnix: NOW - 60 },
  ])

  it('reads every enabled asset at one pinned head and prices it; zero credits are omitted', async () => {
    chain.escrow.set(USDC, 1_250_000_000n)
    const reader = new ChainEscrowReader({ escrow, reads, assets, prices, clock })
    const credits = await reader.listPending(VAULT)
    expect(credits).toHaveLength(1)
    expect(credits[0]).toMatchObject({
      vault: VAULT,
      asset: USDC,
      creditedMinor: 1_250_000_000n,
      blockHash: chain.block(100n).hash,
    })
    expect(credits[0]?.usd.usd).toBe(1250)
    expect(credits[0]?.usd.priceSource).toBe('test')
  })

  it('refuses a credit it cannot price rather than valuing it at zero', async () => {
    chain.escrow.set(NATIVE_ASSET, 5n)
    const reader = new ChainEscrowReader({ escrow, reads, assets, prices: new InMemoryPriceBook(), clock })
    expect((await refused(reader.listPending(VAULT))).code).toBe('price_missing')
  })
})

describe('ChainSweepExecutor', () => {
  const RUN = 'escrow.sweep:0xbbbb#0xaaaa:v1'

  it('claims in capped chunks, reads what landed from the Claimed logs, and reports every tx', async () => {
    chain.escrow.set(USDC, 1_000_000_000n)
    const sweeper = new ChainSweepExecutor({ rpc: chain, operator, driver, clock })
    const receipt = await sweeper.sweep({ vault: VAULT, asset: USDC, expectedMinor: 1_000_000_000n, maxChunkMinor: 400_000_000n, runKey: RUN })

    expect(receipt.chunks).toBe(3)
    expect(receipt.claimedMinor).toBe(1_000_000_000n)
    expect(receipt.txHashes).toEqual(chain.sent.map((s) => s.hash))
    expect(receipt.blockHash).toBe(chain.receipts.get(receipt.txHashes[2] ?? '')?.blockHash)
    expect(chain.sent.map((s) => argWord(s.data, 1))).toEqual([400_000_000n, 400_000_000n, 200_000_000n])
    expect(chain.escrow.get(USDC)).toBe(0n)
    // claim settles in the same transaction: the vault's legs already carry it.
    expect(chain.legsOf(USDC).dev + chain.legsOf(USDC).budget + chain.legsOf(USDC).operator).toBe(1_000_000_000n)
    expect(await sweeper.findByRunKey(RUN)).toEqual(receipt)
    expect((await sweeper.unrecorded(10)).map((r) => r.sweepId)).toEqual([receipt.sweepId])
    await sweeper.confirmRecorded(receipt.sweepId)
    expect(await sweeper.unrecorded(10)).toEqual([])
  })

  it('a repeat of the run key returns the prior receipt and claims nothing again', async () => {
    chain.escrow.set(NATIVE_ASSET, 7n)
    const sweeper = new ChainSweepExecutor({ rpc: chain, operator, driver, clock })
    const first = await sweeper.sweep({ vault: VAULT, asset: NATIVE_ASSET, expectedMinor: 7n, runKey: RUN })
    chain.escrow.set(NATIVE_ASSET, 7n)
    const again = await sweeper.sweep({ vault: VAULT, asset: NATIVE_ASSET, expectedMinor: 7n, runKey: RUN })
    expect(again).toEqual(first)
    expect(chain.sent).toHaveLength(1)
    expect(chain.escrow.get(NATIVE_ASSET)).toBe(7n)
  })

  it('a short claim reports what landed, not what was expected', async () => {
    chain.escrow.set(USDC, 300n)
    const sweeper = new ChainSweepExecutor({ rpc: chain, operator, driver, clock })
    const receipt = await sweeper.sweep({ vault: VAULT, asset: USDC, expectedMinor: 1_000n, runKey: RUN })
    expect(receipt.claimedMinor).toBe(300n)
    expect(receipt.chunks).toBe(1)
  })

  it('an escrow that reverts InsufficientBalance is re-asked for exactly what it holds', async () => {
    chain.escrow.set(USDC, 250n)
    chain.escrowRevertsAboveBalance = true
    const sweeper = new ChainSweepExecutor({ rpc: chain, operator, driver, clock })
    const receipt = await sweeper.sweep({ vault: VAULT, asset: USDC, expectedMinor: 1_000n, runKey: RUN })
    expect(receipt.claimedMinor).toBe(250n)
    expect(chain.sent).toHaveLength(1)
    expect(argWord(chain.sent[0]?.data ?? '0x', 1)).toBe(250n)
  })

  it('nothing in escrow is a typed refusal with no receipt, and the row does not linger in the outbox', async () => {
    const sweeper = new ChainSweepExecutor({ rpc: chain, operator, driver, clock })
    chain.escrowRevertsAboveBalance = true
    expect((await refused(sweeper.sweep({ vault: VAULT, asset: USDC, expectedMinor: 5n, runKey: RUN }))).code).toBe('nothing_claimed')
    expect(chain.sent).toHaveLength(0)
    expect(await sweeper.unrecorded(10)).toEqual([])
    expect(await sweeper.findByRunKey(RUN)).toBeUndefined()
  })

  it('a chunk with no receipt is PENDING: not counted, resolved from the chain on the next attempt', async () => {
    chain.escrow.set(USDC, 800_000_000n)
    chain.minePending = false
    const sweeper = new ChainSweepExecutor({ rpc: chain, operator, driver, clock })
    const lost = await refused(sweeper.sweep({ vault: VAULT, asset: USDC, expectedMinor: 800_000_000n, maxChunkMinor: 400_000_000n, runKey: RUN }))
    expect(lost).toBeInstanceOf(VaultOpError)
    expect((lost as VaultOpError).code).toBe('confirmation_timeout')
    expect(chain.sent).toHaveLength(1)

    // Still unknown: the retry refuses to claim on top of it, and the outbox
    // does not offer it to the ledger.
    expect((await refused(sweeper.sweep({ vault: VAULT, asset: USDC, expectedMinor: 800_000_000n, maxChunkMinor: 400_000_000n, runKey: RUN }))).code).toBe(
      'claim_pending_unresolved',
    )
    expect((await refused(sweeper.findByRunKey(RUN))).code).toBe('claim_pending_unresolved')
    expect(await sweeper.unrecorded(10)).toEqual([])
    expect(chain.sent).toHaveLength(1)

    // The node catches up: the chunk landed. It is folded in from its log and
    // the run continues with the remaining chunk.
    chain.mineLast()
    chain.minePending = true
    const receipt = await sweeper.sweep({ vault: VAULT, asset: USDC, expectedMinor: 800_000_000n, maxChunkMinor: 400_000_000n, runKey: RUN })
    expect(receipt.chunks).toBe(2)
    expect(receipt.claimedMinor).toBe(800_000_000n)
    expect(chain.sent).toHaveLength(2)
  })

  it('a dead attempt with landed chunks surfaces through the outbox once the lease has passed', async () => {
    chain.escrow.set(USDC, 800_000_000n)
    chain.statusFor = (index) => (index === 1 ? 0 : 1)
    const sweeper = new ChainSweepExecutor({ rpc: chain, operator, driver, clock })
    const failed = await refused(sweeper.sweep({ vault: VAULT, asset: USDC, expectedMinor: 800_000_000n, maxChunkMinor: 400_000_000n, runKey: RUN }))
    expect((failed as VaultOpError).code).toBe('reverted')

    // Inside the lease the row belongs to a live attempt.
    expect(await sweeper.findByRunKey(RUN)).toBeUndefined()
    expect(await sweeper.unrecorded(10)).toEqual([])

    clock.advance(SWEEP.outboxStaleSeconds + MINUTE)
    const [orphan] = await sweeper.unrecorded(10)
    expect(orphan?.claimedMinor).toBe(400_000_000n)
    expect(orphan?.chunks).toBe(1)
    expect(await sweeper.findByRunKey(RUN)).toEqual(orphan)
  })
})

describe('ChainSettlementExecutor', () => {
  const RUN = 'escrow.settle:0xbbbb#0xaaaa:e1'

  it('reports balance minus accounted per asset, settles it, and reads the split from the Credited log', async () => {
    chain.balance.set(USDC, 1_000_000n)
    const settlement = new ChainSettlementExecutor({ rpc: chain, operator, assets, driver, clock })
    expect(await settlement.unsettled(VAULT)).toEqual([{ asset: USDC, amountMinor: 1_000_000n }])

    const receipt = await settlement.settle({ vault: VAULT, asset: USDC, amountMinor: 1_000_000n, operatorBps: 500, budgetBps: 2_000, runKey: RUN })
    expect(receipt).toMatchObject({ vault: VAULT, asset: USDC, devLegMinor: 750_000n, budgetMinor: 200_000n, operatorMinor: 50_000n, referrerMinor: 0n })
    expect(receipt.txHash).toBe(chain.sent[0]?.hash)
    expect(receipt.settledAtUnix).toBe(chain.block(101n).timestampUnix)
    expect(await settlement.unsettled(VAULT)).toEqual([])
    expect(await settlement.findByRunKey(RUN)).toEqual(receipt)

    // A repeat under the same key is the same receipt, with no second call.
    chain.balance.set(USDC, 2_000_000n)
    expect(await settlement.settle({ vault: VAULT, asset: USDC, amountMinor: 1n, operatorBps: 500, budgetBps: 2_000, runKey: RUN })).toEqual(receipt)
    expect(chain.sent).toHaveLength(1)
  })

  it('carries the referrer leg the Credited log reports instead of folding it into the operator', async () => {
    chain.referrerBps = 2_000n
    chain.balance.set(USDC, 1_000_000n)
    const settlement = new ChainSettlementExecutor({ rpc: chain, operator, assets, driver, clock })
    const receipt = await settlement.settle({ vault: VAULT, asset: USDC, amountMinor: 1_000_000n, operatorBps: 500, budgetBps: 2_000, runKey: RUN })
    expect(receipt).toMatchObject({ devLegMinor: 750_000n, budgetMinor: 200_000n, operatorMinor: 40_000n, referrerMinor: 10_000n })
    expect(await settlement.findByRunKey(RUN)).toEqual(receipt)
    const rows = await driver.query<{ operator_minor: string; referrer_minor: string }>(
      'SELECT operator_minor, referrer_minor FROM ops_settlement_outbox WHERE run_key = $1',
      [RUN],
    )
    expect(rows).toEqual([{ operator_minor: '40000', referrer_minor: '10000' }])
  })

  it('refuses to settle an asset with nothing unaccounted rather than sending a no-op transaction', async () => {
    const settlement = new ChainSettlementExecutor({ rpc: chain, operator, assets, driver, clock })
    const error = await refused(settlement.settle({ vault: VAULT, asset: USDC, amountMinor: 1n, operatorBps: 500, budgetBps: 0, runKey: RUN }))
    expect(error.code).toBe('nothing_to_settle')
    expect(chain.sent).toHaveLength(0)
    expect(await settlement.findByRunKey(RUN)).toBeUndefined()
  })

  it('a lost settle receipt is resolved from the chain before anything else happens under the key', async () => {
    chain.balance.set(NATIVE_ASSET, 10_000n)
    chain.minePending = false
    const settlement = new ChainSettlementExecutor({ rpc: chain, operator, assets, driver, clock })
    const request = { vault: VAULT, asset: NATIVE_ASSET, amountMinor: 10_000n, operatorBps: 500, budgetBps: 2_000, runKey: RUN }
    expect((await refused(settlement.settle(request)) as VaultOpError).code).toBe('confirmation_timeout')
    expect((await refused(settlement.findByRunKey(RUN))).code).toBe('claim_pending_unresolved')

    chain.mineLast()
    const receipt = await settlement.findByRunKey(RUN)
    expect(receipt?.devLegMinor).toBe(7_500n)
    expect(receipt?.txHash).toBe(chain.sent[0]?.hash)
    expect(chain.sent).toHaveLength(1)
  })
})

describe('ChainEnforcementActions', () => {
  const screening = new Map<string, ScreeningResult>()
  const alerts = new FakeAlertSink()
  const enforcement = () =>
    new ChainEnforcementActions({ operator, reads, screening: { latest: async (t) => screening.get(t) }, alerts, clock })

  it('suspendVault is the on-chain suspend(); already SUSPENDED is left alone; other states are not possible on chain', async () => {
    await enforcement().suspendVault({ vault: VAULT, reason: 'screening BLOCKED' })
    expect(chain.state).toBe(5n)
    expect(chain.sent.map((s) => s.data)).toEqual([VAULT_WRITE_SELECTORS.suspend])

    await enforcement().suspendVault({ vault: VAULT, reason: 'again' })
    expect(chain.sent).toHaveLength(1)

    chain.state = 3n // PENDING
    expect((await refused(enforcement().suspendVault({ vault: VAULT, reason: 'x' }))).code).toBe('not_possible_on_chain')
    expect(chain.sent).toHaveLength(1)
  })

  it('suspendPaidMedia verifies the recorded verdict denies paid media and refuses when it does not', async () => {
    screening.delete(TOKEN)
    expect((await refused(enforcement().suspendPaidMedia({ vault: VAULT, reason: 'RESTRICTED' }))).code).toBe('paid_media_not_recorded')
    screening.set(TOKEN, { token: TOKEN, verdict: 'RESTRICTED', flags: ['x'], stagesRun: ['lexicon'], screenedAtUnix: NOW, paidMediaPermitted: true })
    expect((await refused(enforcement().suspendPaidMedia({ vault: VAULT, reason: 'RESTRICTED' }))).code).toBe('paid_media_not_recorded')
    screening.set(TOKEN, { token: TOKEN, verdict: 'RESTRICTED', flags: ['x'], stagesRun: ['lexicon'], screenedAtUnix: NOW, paidMediaPermitted: false })
    await enforcement().suspendPaidMedia({ vault: VAULT, reason: 'RESTRICTED' })
    expect(chain.sent).toHaveLength(0)
  })

  it('escalateToHuman pages on critical and tickets on high', async () => {
    await enforcement().escalateToHuman({ vault: VAULT, reason: 'blocked', severity: 'critical' })
    await enforcement().escalateToHuman({ vault: VAULT, reason: 'restricted', severity: 'high' })
    expect(alerts.raised.map((a) => [a.alertId, a.severity, a.scope])).toEqual([
      ['screening_blocked_after_metadata_change', 'page', VAULT],
      ['screening_restricted_after_metadata_change', 'ticket', VAULT],
    ])
  })
})

describe('ChainVaultHeartbeat', () => {
  it('reads the dead-man clock from the vault and heartbeat() resets it', async () => {
    const heartbeat = new ChainVaultHeartbeat({ operator, reads })
    expect(await heartbeat.lastOperatorActionUnix(VAULT)).toBe(NOW - 10)
    const sent = await heartbeat.heartbeat(VAULT)
    expect(sent.txHash).toBe(chain.sent[0]?.hash)
    expect(chain.sent[0]?.data).toBe(VAULT_WRITE_SELECTORS.heartbeat)
    expect(await heartbeat.lastOperatorActionUnix(VAULT)).toBe(chain.block(101n).timestampUnix)
  })
})
