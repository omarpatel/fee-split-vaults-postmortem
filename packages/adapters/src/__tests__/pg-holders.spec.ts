/**
 * The holder ledger against a real Postgres (pglite) with the real 0016 DDL:
 * exact uint256 arithmetic, one transaction per range, zero rows dropped, a
 * monotonic cursor - and the quote-asset reader that joins a contract's own
 * decimals to the operator's quote_asset row.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { selector, type BlockRef, type Hex, type LogQuery, type PinnedCall, type RpcLog } from '@fee-split-vaults/indexer'
import { AssetReadError, ChainAssetReader, PgAssetPolicy, loadAssetRegistry } from '../chain/assets.js'
import type { PinnedChainReads } from '../chain/recipients.js'
import { PgHolderBalanceStore } from '../pg/holders.js'
import { migratedPglite, type MigratedPglite } from './pglite.js'

const TOKEN = '0xAAAA000000000000000000000000000000000001'
const OTHER = '0xaaaa000000000000000000000000000000000002'
const ALICE = '0x000000000000000000000000000000000000000a'
const BOB = '0x000000000000000000000000000000000000000b'
const UINT256_MAX = (1n << 256n) - 1n

let pg: MigratedPglite

beforeAll(async () => {
  pg = await migratedPglite()
}, 120_000)

afterAll(async () => {
  await pg.close()
})

function cursor(blockNumber: bigint, hash = `0x${blockNumber.toString(16).padStart(64, '0')}` as Hex) {
  return { token: TOKEN.toLowerCase(), blockNumber, blockHash: hash, blockTimestampUnix: 1_700_000_000 + Number(blockNumber), updatedAtUnix: 1_700_000_500 }
}

describe('PgHolderBalanceStore', () => {
  it('applies deltas exactly at uint256 scale, drops zero rows, and ranks by balance then address', async () => {
    const store = new PgHolderBalanceStore(pg.driver)
    expect(await store.cursor(TOKEN)).toBeUndefined()

    await store.apply(TOKEN, new Map([[ALICE, UINT256_MAX], [BOB, 5n]]), cursor(10n))
    expect(await store.balance(TOKEN, ALICE)).toBe(UINT256_MAX)
    expect(await store.cursor(TOKEN)).toEqual(cursor(10n))

    await store.apply(TOKEN, new Map([[ALICE, -(UINT256_MAX - 5n)], [BOB, -5n], [OTHER, 7n]]), cursor(11n))
    expect(await store.balance(TOKEN, ALICE)).toBe(5n)
    // Bob reached zero and is no longer a holder: not in the table, not in the ranking.
    expect(await store.balance(TOKEN, BOB)).toBe(0n)
    expect(await store.top(TOKEN, 10)).toEqual([
      { holder: OTHER, balanceMinor: 7n },
      { holder: ALICE.toLowerCase(), balanceMinor: 5n },
    ])
    // Ties rank by address so the order is stable across reads.
    await store.apply(TOKEN, new Map([[BOB, 7n]]), cursor(12n))
    expect((await store.top(TOKEN, 2)).map((b) => b.holder)).toEqual([BOB, OTHER])
    // Another token's rows are another token's.
    expect(await store.top(OTHER, 10)).toEqual([])
  })

  it('lands a range and its cursor together, or neither', async () => {
    const store = new PgHolderBalanceStore(pg.driver)
    const before = await store.cursor(TOKEN)
    // The table's CHECK refuses a negative; the transaction rolls the whole
    // range back, so the earlier credit in the same batch does not survive.
    await expect(
      store.apply(TOKEN, new Map([['0x00000000000000000000000000000000000000cc', 1n], [ALICE, -1_000n]]), cursor(20n)),
    ).rejects.toThrow()
    expect(await store.balance(TOKEN, '0x00000000000000000000000000000000000000cc')).toBe(0n)
    expect(await store.cursor(TOKEN)).toEqual(before)
  })

  it('never moves the cursor backwards', async () => {
    const store = new PgHolderBalanceStore(pg.driver)
    const held = await store.cursor(TOKEN)
    await store.apply(TOKEN, new Map(), cursor(3n))
    expect(await store.cursor(TOKEN)).toEqual(held)
  })
})

// ---------------------------------------------------------------------------

/** A node that answers decimals()/symbol() for two assets at one pinned head. */
class ScriptedReads implements PinnedChainReads {
  readonly head_: BlockRef = { number: 100n, hash: `0x${'1'.repeat(64)}`, parentHash: `0x${'0'.repeat(64)}`, timestampUnix: 1_700_000_000 }
  readonly answers = new Map<string, Hex>()
  asserted = 0

  script(asset: string, symbol: string, decimals: number): void {
    const key = asset.toLowerCase()
    this.answers.set(`${key}|${selector('decimals()')}`, `0x${decimals.toString(16).padStart(64, '0')}`)
    const hex = Buffer.from(symbol, 'utf8').toString('hex')
    this.answers.set(
      `${key}|${selector('symbol()')}`,
      `0x${'20'.padStart(64, '0')}${symbol.length.toString(16).padStart(64, '0')}${hex.padEnd(64, '0')}`,
    )
  }
  async assertChain(): Promise<void> {
    this.asserted += 1
  }
  async head(): Promise<BlockRef> {
    return this.head_
  }
  async blockByNumber(): Promise<BlockRef | null> {
    return this.head_
  }
  async blockByHash(): Promise<BlockRef | null> {
    return this.head_
  }
  async getLogs(_query: LogQuery): Promise<RpcLog[]> {
    return []
  }
  async call(request: PinnedCall): Promise<Hex> {
    if (request.blockHash !== this.head_.hash) throw new Error('not pinned to the agreed head')
    const answer = this.answers.get(`${request.to.toLowerCase()}|${request.data}`)
    if (answer === undefined) throw new Error(`no script for ${request.to} ${request.data}`)
    return answer
  }
}

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
const UNAPPROVED = '0x00000000000000000000000000000000000000ee'

describe('ChainAssetReader over quote_asset', () => {
  it('joins the contract facts to the policy row, refuses an unapproved asset and a contradicted row', async () => {
    await pg.driver.execute(
      `INSERT INTO quote_asset (address, symbol, decimals, is_pausable_proxy, enabled, max_transfer_minor, updated_at_unix)
       VALUES ($1, 'USDG', 6, TRUE, TRUE, '500000000', 1), ($2, 'WETH', 18, FALSE, FALSE, NULL, 1)`,
      [USDG, WETH],
    )
    const node = new ScriptedReads()
    node.script(USDG, 'USDG', 6)
    node.script(WETH, 'WETH', 6) // the contract disagrees with the row
    node.script(UNAPPROVED, 'EVIL', 18)
    const reader = new ChainAssetReader(node, new PgAssetPolicy(pg.driver))

    expect(await reader.read(USDG, node.head_)).toEqual({
      address: USDG,
      symbol: 'USDG',
      decimals: 6,
      isPausableProxy: true,
      enabled: true,
      maxTransferMinor: 500_000_000n,
    })
    await expect(reader.read(UNAPPROVED, node.head_)).rejects.toMatchObject({ code: 'not_approved' })
    await expect(reader.read(WETH, node.head_)).rejects.toMatchObject({ code: 'contradiction' })
    // Without a policy source, `read` cannot answer enabled/cap and says so;
    // `describe` still reads the contract, at the agreed head, once.
    const bare = new ChainAssetReader(node)
    await expect(bare.read(USDG, node.head_)).rejects.toMatchObject({ code: 'no_policy' })
    expect(await bare.describe(USDG)).toMatchObject({ symbol: 'USDG', decimals: 6, blockHash: node.head_.hash })
    await bare.describe(USDG)
    expect(node.asserted).toBe(1)
    expect((await new PgAssetPolicy(pg.driver).approved()).sort()).toEqual([WETH, USDG].sort())
  })

  it('loads a registry the orchestrator can read synchronously, and refuses the load on any bad asset', async () => {
    const node = new ScriptedReads()
    node.script(USDG, 'USDG', 6)
    node.script(UNAPPROVED, 'EVIL', 18)
    const reader = new ChainAssetReader(node, new PgAssetPolicy(pg.driver))
    const registry = await loadAssetRegistry({ reader, addresses: [USDG, USDG.toUpperCase().replace('0X', '0x')], at: node.head_ })
    expect(registry.all()).toHaveLength(1)
    expect(registry.get(USDG.toUpperCase().replace('0X', '0x'))?.decimals).toBe(6)
    expect(registry.at).toBe(node.head_)
    await expect(loadAssetRegistry({ reader, addresses: [USDG, UNAPPROVED], at: node.head_ })).rejects.toBeInstanceOf(AssetReadError)
  })
})
