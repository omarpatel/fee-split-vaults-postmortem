/**
 * Who holds each memecoin, from its own Transfer log.
 *
 * The concentration signals (top-10 share, deployer share) need a holder
 * table, and there is no chain API for "the holders of a token": there is only
 * `Transfer(address indexed from, address indexed to, uint256 value)`, replayed
 * from the launch block. This module replays it into a balance store, one
 * cursor per token, in bounded ranges, and hands `computeQualificationSignals`
 * a hash-pinned snapshot of the result.
 *
 * FINALITY, BY CONSTRUCTION RATHER THAN BY REPAIR. The fee indexer scans to
 * the head and rolls unfinalised postings back on a reorg, because a fee that
 * lands is worth reporting a few blocks early. A holder balance is not: nothing
 * downstream is owed a reading a minute fresher than finality, and a balance
 * table that has to be un-applied is a table whose every row is suspect while
 * the rewind runs. So this scanner stops at the FINALIZED block, and the only
 * reorg it can meet is one that violates finality - which is refused, exactly
 * as the fee indexer refuses it, because then no balance can be vouched for.
 *
 * SUPPLY IS CONSERVED OR THE LEDGER IS WRONG. Every credit has a debit, the
 * mint source and the burn sink are address(0), and a debit that would take a
 * holder below zero is a proof that the scan missed something - a launch block
 * later than the true one, a transfer the provider dropped. It is refused
 * rather than clamped, because a clamped zero is a wrong top-10.
 *
 * WHAT COUNTS AS A HOLDER. The snapshot carries raw balances; the signal
 * module removes the structural custodians - the zero and dead addresses, the
 * curve, the vault, the locker, the buyback vault - and, from here, the
 * PoolKey's hook and the PoolManager the hook reports. The PoolManager is the
 * Uniswap V4 singleton that actually custodies pool liquidity, and it is read
 * from the hook's own `poolManager()` at the snapshot block rather than pinned
 * in config, so a hook redeploy cannot leave the pool counted as a whale.
 */

import type { Address } from '@fee-split-vaults/core'
import { decodeEventLog, defineEvent, requireAddress, requireBigInt, selector } from './abi.js'
import { HolderLedgerError, DecodeError } from './errors.js'
import { addressEquals, hexToBigInt, normalizeAddress, normalizeHash32, type Hex } from './hex.js'
import { VENUE } from './protocol.js'
import { DEFAULT_QUERY_LIMITS, type BlockRef, type LogQuery, type PinnedCall, type QueryLimits, type RpcLog } from './rpc.js'
import type { HolderBalance, HolderSnapshot, HolderSource } from './signals.js'

export const ERC20_TRANSFER = defineEvent('Transfer', [
  { name: 'from', type: 'address', indexed: true },
  { name: 'to', type: 'address', indexed: true },
  { name: 'value', type: 'uint256', indexed: false },
])

export const TOTAL_SUPPLY_SELECTOR = selector('totalSupply()')
/** `IPoolManager public immutable poolManager` on a Uniswap V4 BaseHook. */
export const POOL_MANAGER_SELECTOR = selector('poolManager()')

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** The reads this scanner makes. Structurally QuorumRpc; nothing here can write. */
export interface HolderRpc {
  readonly isChainVerified: boolean
  assertChain(): Promise<void>
  finalized(): Promise<BlockRef>
  blockByNumber(blockNumber: bigint): Promise<BlockRef | null>
  blockByHash(blockHash: Hex): Promise<BlockRef | null>
  getLogs(query: LogQuery): Promise<RpcLog[]>
  call(request: PinnedCall): Promise<Hex>
}

/** Where a token's replay has reached. The hash is what makes the balances a reading of something. */
export interface HolderCursor {
  readonly token: Address
  readonly blockNumber: bigint
  readonly blockHash: Hex
  readonly blockTimestampUnix: number
  readonly updatedAtUnix: number
}

export interface HolderBalanceStore {
  cursor(token: Address): Promise<HolderCursor | undefined>
  /**
   * Add `deltas` to the stored balances and advance the cursor, ATOMICALLY.
   * A cursor that moved without its balances, or balances without their
   * cursor, is a ledger that will double-apply or skip a range on restart.
   */
  apply(token: Address, deltas: ReadonlyMap<string, bigint>, cursor: HolderCursor): Promise<void>
  /** The `limit` largest positive balances, descending, ties by address. */
  top(token: Address, limit: number): Promise<HolderBalance[]>
  /** One holder's balance. Zero when no transfer ever reached it. */
  balance(token: Address, holder: Address): Promise<bigint>
}

export class InMemoryHolderBalanceStore implements HolderBalanceStore {
  readonly #balances = new Map<string, Map<string, bigint>>()
  readonly #cursors = new Map<string, HolderCursor>()

  async cursor(token: Address): Promise<HolderCursor | undefined> {
    return this.#cursors.get(normalizeAddress(token))
  }

  async apply(token: Address, deltas: ReadonlyMap<string, bigint>, cursor: HolderCursor): Promise<void> {
    const key = normalizeAddress(token)
    let table = this.#balances.get(key)
    if (table === undefined) {
      table = new Map()
      this.#balances.set(key, table)
    }
    for (const [holder, delta] of deltas) {
      const next = (table.get(holder) ?? 0n) + delta
      if (next === 0n) table.delete(holder)
      else table.set(holder, next)
    }
    this.#cursors.set(key, cursor)
  }

  async top(token: Address, limit: number): Promise<HolderBalance[]> {
    const table = this.#balances.get(normalizeAddress(token))
    if (table === undefined) return []
    return [...table.entries()]
      .filter(([, balanceMinor]) => balanceMinor > 0n)
      .map(([holder, balanceMinor]) => ({ holder, balanceMinor }))
      .sort((a, b) => (a.balanceMinor === b.balanceMinor ? (a.holder < b.holder ? -1 : 1) : a.balanceMinor > b.balanceMinor ? -1 : 1))
      .slice(0, limit)
  }

  async balance(token: Address, holder: Address): Promise<bigint> {
    return this.#balances.get(normalizeAddress(token))?.get(normalizeAddress(holder)) ?? 0n
  }
}

/** A token the scanner replays. The launch block is where its supply came into being. */
export interface IndexedToken {
  readonly token: Address
  readonly launchBlockNumber: bigint
  readonly deployer: Address
}

export interface HolderIndexerConfig {
  /** Blocks per Transfer query. Capped by queryLimits.maxBlockSpan. */
  readonly chunkBlocks?: bigint
  /** Ranges per token per tick. Bounds backfill work without stalling it. */
  readonly maxRangesPerTick?: number
  readonly queryLimits?: QueryLimits
  /** Balances carried in a snapshot beyond the deployer's. Ten plus room for custodians. */
  readonly snapshotHolders?: number
  /** The PoolKey's hook. Defaults to VENUE.contracts.v2MemeHook. */
  readonly hookContract?: Address
}

export interface HolderIndexerDeps {
  readonly rpc: HolderRpc
  readonly store: HolderBalanceStore
  readonly tokens: () => Promise<readonly IndexedToken[]>
  readonly config?: HolderIndexerConfig
}

export interface HolderTokenScan {
  readonly token: Address
  readonly fromBlock: bigint
  readonly toBlock: bigint
  readonly rangesScanned: number
  readonly transfers: number
  readonly caughtUp: boolean
}

export interface HolderTickResult {
  readonly finalized: BlockRef
  readonly tokens: readonly HolderTokenScan[]
  /** Tokens still short of the finalized head after spending their range budget. */
  readonly stillBehind: readonly Address[]
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}

/** Decode `address` from a one-word return: the last 20 bytes of the word. */
function decodeAddressWord(raw: Hex, what: string): string {
  if (raw.length !== 66) throw new DecodeError(`${what} did not return one word`)
  return normalizeAddress(`0x${raw.slice(26)}`)
}

export class HolderIndexer implements HolderSource {
  readonly #rpc: HolderRpc
  readonly #store: HolderBalanceStore
  readonly #tokens: () => Promise<readonly IndexedToken[]>
  readonly #limits: QueryLimits
  readonly #chunkBlocks: bigint
  readonly #maxRangesPerTick: number
  readonly #snapshotHolders: number
  readonly #hook: string
  /** Resolved once per cursor block hash: the hook's pool manager is immutable, but the read is still pinned. */
  #poolManager: { at: Hex; address: string } | undefined

  constructor(deps: HolderIndexerDeps) {
    this.#rpc = deps.rpc
    this.#store = deps.store
    this.#tokens = deps.tokens
    const config = deps.config ?? {}
    this.#limits = config.queryLimits ?? DEFAULT_QUERY_LIMITS
    this.#chunkBlocks = min(config.chunkBlocks ?? this.#limits.maxBlockSpan, this.#limits.maxBlockSpan)
    if (this.#chunkBlocks < 1n) throw new RangeError('chunkBlocks must be at least 1')
    this.#maxRangesPerTick = config.maxRangesPerTick ?? 8
    this.#snapshotHolders = config.snapshotHolders ?? 32
    this.#hook = normalizeAddress(config.hookContract ?? VENUE.contracts.v2MemeHook)
  }

  /**
   * Replay every token forward to the finalized head, sequentially: the rate
   * limit is per process, so parallel tokens would only pair up the 429s.
   */
  async tick(nowUnix: number): Promise<HolderTickResult> {
    if (!this.#rpc.isChainVerified) await this.#rpc.assertChain()
    const finalized = await this.#rpc.finalized()
    const tokens: HolderTokenScan[] = []
    const stillBehind: Address[] = []
    for (const token of await this.#tokens()) {
      const scan = await this.#scanToken(token, finalized, nowUnix)
      tokens.push(scan)
      if (!scan.caughtUp) stillBehind.push(scan.token)
    }
    return { finalized, tokens, stillBehind }
  }

  async #scanToken(indexed: IndexedToken, finalized: BlockRef, nowUnix: number): Promise<HolderTokenScan> {
    const token = normalizeAddress(indexed.token)
    const cursor = await this.#store.cursor(token)

    if (cursor !== undefined) {
      // The cursor's block must still be canonical. A finalized block that is
      // not is a finality violation, and the balances behind it are void.
      const held = await this.#rpc.blockByHash(cursor.blockHash)
      if (held === null || held.number !== cursor.blockNumber) {
        throw new HolderLedgerError(
          token,
          `cursor block ${String(cursor.blockNumber)} (${cursor.blockHash}) is no longer canonical; ` +
            'a finalized block was reorged and no balance below it can be vouched for',
        )
      }
    }

    // A cold token starts one block below its launch so the launch block's
    // mint is inside the first range.
    const startAfter =
      cursor?.blockNumber ?? (indexed.launchBlockNumber > 0n ? indexed.launchBlockNumber - 1n : 0n)
    let fromBlock = startAfter + 1n
    const target = finalized.number
    let rangesScanned = 0
    let transfers = 0
    let lastScanned = startAfter

    if (fromBlock > target) {
      return { token, fromBlock, toBlock: startAfter, rangesScanned: 0, transfers: 0, caughtUp: true }
    }

    while (fromBlock <= target && rangesScanned < this.#maxRangesPerTick) {
      const toBlock = min(fromBlock + this.#chunkBlocks - 1n, target)
      const logs = await this.#rpc.getLogs({
        fromBlock,
        toBlock,
        address: [token],
        topics: [ERC20_TRANSFER.topic0],
      })
      rangesScanned++

      const deltas = new Map<string, bigint>()
      for (const log of logs) {
        if (log.removed) continue
        const decoded = decodeEventLog(ERC20_TRANSFER, log)
        const from = requireAddress(decoded, 'from')
        const to = requireAddress(decoded, 'to')
        const value = requireBigInt(decoded, 'value')
        transfers++
        if (value === 0n) continue
        // address(0) is the mint source and the burn sink, never a holder.
        if (from !== ZERO_ADDRESS) deltas.set(from, (deltas.get(from) ?? 0n) - value)
        if (to !== ZERO_ADDRESS) deltas.set(to, (deltas.get(to) ?? 0n) + value)
      }

      // Conservation, checked BEFORE the write so a bad range never lands.
      for (const [holder, delta] of deltas) {
        if (delta >= 0n) continue
        const held = await this.#store.balance(token, holder)
        if (held + delta < 0n) {
          throw new HolderLedgerError(
            token,
            `blocks ${String(fromBlock)}..${String(toBlock)} debit ${holder} by ${String(-delta)} against a ` +
              `balance of ${String(held)}; the replay missed a credit (launch block ${String(indexed.launchBlockNumber)} ` +
              'may be too late) and no concentration figure can be built on it',
          )
        }
      }

      // The cursor's own block ref: `finalized` when the range reached it,
      // otherwise the last block of the range, fetched so the cursor carries a
      // hash it can be checked against next tick.
      const at = toBlock === target ? finalized : await this.#blockAt(token, toBlock)
      await this.#store.apply(token, deltas, {
        token,
        blockNumber: toBlock,
        blockHash: at.hash,
        blockTimestampUnix: at.timestampUnix,
        updatedAtUnix: nowUnix,
      })
      lastScanned = toBlock
      fromBlock = toBlock + 1n
    }

    return {
      token,
      fromBlock: startAfter + 1n,
      toBlock: lastScanned,
      rangesScanned,
      transfers,
      caughtUp: lastScanned >= target,
    }
  }

  /**
   * A mid-backfill cursor's block, by number and then confirmed by hash. The
   * number alone is not a pin; the quorum's blockByNumber makes both providers
   * agree on the hash at that height, and it is below finalized, so the hash
   * is the one the chain will keep.
   */
  async #blockAt(token: string, blockNumber: bigint): Promise<BlockRef> {
    const ref = await this.#rpc.blockByNumber(blockNumber)
    if (ref === null) throw new HolderLedgerError(token, `finalized block ${String(blockNumber)} is missing from both providers`)
    return ref
  }

  // ------------------------------------------------------------ HolderSource --

  /**
   * The snapshot at the token's cursor: total supply and the largest balances,
   * all pinned to the cursor's block hash. Undefined until a first replay has
   * landed, which the signal module turns into a refusal.
   */
  async snapshot(token: Address): Promise<HolderSnapshot | undefined> {
    const key = normalizeAddress(token)
    const cursor = await this.#store.cursor(key)
    if (cursor === undefined) return undefined
    const indexed = (await this.#tokens()).find((t) => addressEquals(t.token, key))
    if (indexed === undefined) return undefined

    const totalSupplyRaw = await this.#rpc.call({ to: key, data: TOTAL_SUPPLY_SELECTOR, blockHash: cursor.blockHash })
    if (totalSupplyRaw.length !== 66) throw new DecodeError(`totalSupply() on ${key} did not return one word`)
    const totalSupplyMinor = hexToBigInt(totalSupplyRaw)

    const poolManager = await this.#poolManagerAt(cursor.blockHash)
    const balances: HolderBalance[] = await this.#store.top(key, this.#snapshotHolders)
    const deployer = normalizeAddress(indexed.deployer)
    if (!balances.some((b) => addressEquals(b.holder, deployer))) {
      balances.push({ holder: deployer, balanceMinor: await this.#store.balance(key, deployer) })
    }

    return {
      token: key,
      blockHash: cursor.blockHash,
      blockNumber: cursor.blockNumber,
      takenAtUnix: cursor.blockTimestampUnix,
      totalSupplyMinor,
      deployer,
      balances,
      structural: [this.#hook, poolManager],
    }
  }

  async #poolManagerAt(blockHash: Hex): Promise<string> {
    const at = normalizeHash32(blockHash)
    if (this.#poolManager?.at === at) return this.#poolManager.address
    let raw: Hex
    try {
      raw = await this.#rpc.call({ to: this.#hook, data: POOL_MANAGER_SELECTOR, blockHash: at })
    } catch (error) {
      throw new HolderLedgerError(
        this.#hook,
        `poolManager() on the hook could not be read at ${at}: ${error instanceof Error ? error.message : String(error)}; ` +
          'without the pool custodian the pool would be counted as a holder',
      )
    }
    const address = decodeAddressWord(raw, 'poolManager()')
    if (address === ZERO_ADDRESS) {
      throw new HolderLedgerError(this.#hook, `poolManager() on the hook is the zero address at ${at}`)
    }
    this.#poolManager = { at, address }
    return address
  }
}
