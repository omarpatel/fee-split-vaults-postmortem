/**
 * The real ChainReadModel: the orchestrator's window onto chain state, backed
 * by the indexer's quorum RPC rather than by a map in a test.
 *
 * WHAT IT IS AND IS NOT. It is a READ MODEL over what has already been
 * ingested, exactly as `coin.ts` documents its own expectation: `postings()` is
 * a store read, not a network call, because measuring only on poll ticks would
 * make QF read zero on every other tick and oscillate the tier T1 -> T0 -> T1.
 * The network work happens in `sync()`, which the operator calls on a schedule.
 * A tick that reads is cheap; a sync that scans is not.
 *
 * INCREMENTAL, BECAUSE THE RATE LIMIT IS REAL. This chain answers roughly 0.8
 * requests a second and produces a block every 0.101 seconds, so a re-scan of
 * history is measured in hours. Every stream here has a persisted block cursor
 * and moves forward only. `sync()` scans from the cursor to the finalized head
 * in bounded chunks, halving any chunk a provider refuses, and stops after a
 * budget of ranges so one backfilling vault cannot monopolise a process.
 *
 * FINALIZED, FOR MOVEMENTS. The claim and allocation scan stops at the
 * quorum-agreed FINALIZED head, never at the tip. These observations become
 * ledger entries about money that moved, and a reorg that unwound one would
 * leave a ledger describing a transfer the chain no longer contains. Waiting
 * for finality costs latency; not waiting costs correctness.
 *
 * THE COVERAGE RULE IS THE WHOLE POINT. Every window query is answered only if
 * the relevant cursor's coverage watermark actually reaches the end of the
 * window asked about, within a stated tolerance. Otherwise it throws. A read
 * model that answers "no fees" when what it means is "my scanner has been stuck
 * since Tuesday" is worse than one that is down, because the tick loop believes
 * it. `CoverageGapError` is that distinction made unignorable.
 */

import type { Address } from '@fee-split-vaults/core'
import {
  DEFAULT_QUERY_LIMITS,
  RpcError,
  assertBoundedLogQuery,
  normalizeAddress,
  normalizeHash32,
  type BlockRef,
  type CoinBinding,
  type FeePosting,
  type HaltNotice,
  type IndexerStore,
  type LogQuery,
  type QueryLimits,
  type QuorumRpc,
  type RpcLog,
} from '@fee-split-vaults/indexer'
import type {
  AllocationObservation,
  ChainReadModel,
  ClaimObservation,
  Clock,
} from '@fee-split-vaults/orchestrator'
import { systemClock } from '@fee-split-vaults/orchestrator'
import {
  CoverageGapError,
  SourceUnavailableError,
  UnservableRangeError,
  VaultNotTrackedError,
} from '../errors.js'
import type { ChainCursorStore, ScanCursor, ScanStream } from './cursors.js'
import type { HaltReadModel } from './halts.js'
import type { VaultMovementStore } from './movements.js'
import { VAULT_MOVEMENT_TOPICS, decodeAllocation, decodeClaim, movementId } from './vault-events.js'

/** Scope for the one stream that is not per-vault. */
export const FLEET_SCOPE = 'fleet'

/**
 * The provider-side result cap.
 *
 * Nodes announce it inconsistently - an error, a 413, or worse, a SILENTLY
 * TRUNCATED array of exactly N entries. The last of those is why this is a
 * number here and not just an error string to match on: a full page is treated
 * as suspect and the range is halved, because a truncated page that looks like
 * a complete answer would advance the cursor past logs nobody ever saw.
 */
export const DEFAULT_MAX_LOGS_PER_RANGE = 10_000

export interface TrackedVault {
  readonly vault: Address
  readonly token: Address
  /**
   * The block the vault contract came into existence at.
   *
   * REQUIRED, and there is no default. Starting a scan at 0 would be an
   * multi-hour walk at this chain's rate limit, and starting it at the head
   * would silently skip every settlement that has already happened. The
   * deployment knows this number - the factory emitted it - so it is asked for
   * rather than guessed.
   */
  readonly deployedAtBlock: bigint
}

export interface RpcChainReadModelConfig {
  /**
   * How far behind the end of a requested window the coverage watermark may sit
   * before a read refuses. Not a fudge factor: the finalized head genuinely lags
   * the wall clock, and a tick asking about "up to now" would otherwise never be
   * answerable. Set it to something a person would recognise as "current", and
   * treat crossing it as an outage rather than as noise.
   */
  readonly maxCoverageLagSeconds?: number
  readonly queryLimits?: QueryLimits
  /** Blocks per log query. Capped by queryLimits.maxBlockSpan. */
  readonly chunkBlocks?: bigint
  /** Chunks per vault per sync. Bounds backfill work without stalling it. */
  readonly maxRangesPerSync?: number
  readonly maxLogsPerRange?: number
}

export interface RpcChainReadModelDeps {
  readonly rpc: QuorumRpc
  /** Owns bindings and fee postings. Written by the indexer, read here. */
  readonly indexerStore: IndexerStore
  readonly cursors: ChainCursorStore
  readonly movements: VaultMovementStore
  readonly halts: HaltReadModel
  readonly clock?: Clock
  /**
   * The fee poller, if this process owns it.
   *
   * Structurally `VaultIndexer`. Optional because a real deployment often runs
   * the poller as its own scheduled job in another process; in that case the
   * job calls `recordFeeCoverage()` after a caught-up tick and this model still
   * knows how far the fee streams reach. If neither happens, `postings()`
   * refuses - which is correct, because then nothing is scanning.
   */
  readonly feeIndexer?: FeeIndexerLike
}

export interface FeeIndexerLike {
  tick(nowUnix: number): Promise<{ readonly head: BlockRef; readonly caughtUp: boolean }>
}

export interface SyncResult {
  readonly atUnix: number
  readonly finalized: BlockRef
  /** Per vault: how far it got and what it found. */
  readonly vaults: readonly VaultSyncResult[]
  readonly feeCoverageThroughUnix?: number
  /** Vaults still behind the finalized head after spending their range budget. */
  readonly stillBehind: readonly Address[]
}

export interface VaultSyncResult {
  readonly vault: Address
  readonly fromBlock: bigint
  readonly toBlock: bigint
  readonly rangesScanned: number
  readonly newClaims: number
  readonly newAllocations: number
  readonly caughtUp: boolean
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}

export class RpcChainReadModel implements ChainReadModel {
  readonly #deps: RpcChainReadModelDeps
  readonly #clock: Clock
  readonly #limits: QueryLimits
  readonly #chunkBlocks: bigint
  readonly #maxRangesPerSync: number
  readonly #maxLogsPerRange: number
  readonly #maxCoverageLagSeconds: number
  readonly #tracked = new Map<string, TrackedVault>()

  constructor(deps: RpcChainReadModelDeps, config: RpcChainReadModelConfig = {}) {
    this.#deps = deps
    this.#clock = deps.clock ?? systemClock
    this.#limits = config.queryLimits ?? DEFAULT_QUERY_LIMITS
    const requestedChunk = config.chunkBlocks ?? this.#limits.maxBlockSpan
    this.#chunkBlocks = min(requestedChunk, this.#limits.maxBlockSpan)
    if (this.#chunkBlocks < 1n) throw new RangeError('chunkBlocks must be at least 1')
    this.#maxRangesPerSync = config.maxRangesPerSync ?? 8
    this.#maxLogsPerRange = config.maxLogsPerRange ?? DEFAULT_MAX_LOGS_PER_RANGE
    this.#maxCoverageLagSeconds = config.maxCoverageLagSeconds ?? 300
  }

  // -------------------------------------------------------------- watch set --

  /**
   * Bring a vault into the movement scan.
   *
   * Registration is explicit and carries the deployment block, which is what
   * lets `claims()` distinguish "this vault has never settled" from "nobody
   * ever scanned this vault". An unregistered vault does not answer; it throws.
   */
  track(vault: TrackedVault): void {
    this.#tracked.set(normalizeAddress(vault.vault), {
      vault: normalizeAddress(vault.vault),
      token: normalizeAddress(vault.token),
      deployedAtBlock: vault.deployedAtBlock,
    })
  }

  untrack(vault: Address): boolean {
    return this.#tracked.delete(normalizeAddress(vault))
  }

  tracked(): readonly TrackedVault[] {
    return [...this.#tracked.values()]
  }

  // ------------------------------------------------------------ ChainReadModel --

  async binding(token: Address): Promise<CoinBinding | undefined> {
    try {
      return await this.#deps.indexerStore.bindingByToken(token)
    } catch (error) {
      // A store outage is NOT "this coin has no binding". The latter is a real
      // state the tick loop refuses on with `binding_unresolved`; the former is
      // an outage, and collapsing them would make an outage look like a coin
      // that never launched.
      throw new SourceUnavailableError('binding store', String(error), error)
    }
  }

  async postings(vault: Address, fromUnix: number, toUnix: number): Promise<readonly FeePosting[]> {
    await this.#assertCoverage('fees', FLEET_SCOPE, toUnix)
    try {
      return await this.#deps.indexerStore.postings({ vault, fromUnix, toUnix })
    } catch (error) {
      throw new SourceUnavailableError('posting store', String(error), error)
    }
  }

  async halts(token: Address): Promise<readonly HaltNotice[]> {
    // No coverage gate here on purpose. A halt store that answers is
    // authoritative about what is open, and gating it behind the chain scan
    // would mean a stalled scanner ALSO stopped reporting the halt that the
    // stall itself should raise. An unreadable store still throws.
    return this.#deps.halts.open(token)
  }

  async claims(vault: Address, fromUnix: number, toUnix: number): Promise<readonly ClaimObservation[]> {
    this.#requireTracked(vault)
    await this.#assertCoverage('vault_movements', normalizeAddress(vault), toUnix)
    return this.#deps.movements.claims(vault, fromUnix, toUnix)
  }

  async allocations(
    vault: Address,
    fromUnix: number,
    toUnix: number,
  ): Promise<readonly AllocationObservation[]> {
    this.#requireTracked(vault)
    await this.#assertCoverage('vault_movements', normalizeAddress(vault), toUnix)
    return this.#deps.movements.allocations(vault, fromUnix, toUnix)
  }

  // -------------------------------------------------------------------- sync --

  /**
   * Move every cursor forward.
   *
   * Sequential across vaults, deliberately. The rate limit is per process, not
   * per vault, so scanning two vaults in parallel does not halve the wall time -
   * it just makes the 429s arrive in pairs.
   */
  async sync(nowUnix: number = this.#clock.nowUnix()): Promise<SyncResult> {
    if (!this.#deps.rpc.isChainVerified) await this.#deps.rpc.assertChain()

    let feeCoverageThroughUnix: number | undefined
    if (this.#deps.feeIndexer !== undefined) {
      const tick = await this.#deps.feeIndexer.tick(nowUnix)
      // Only a CAUGHT-UP tick advances the fee watermark. A tick that ran out
      // of range budget scanned real blocks but did not reach the head, and
      // claiming coverage to the head after it would be a lie of exactly the
      // kind this class exists to prevent.
      if (tick.caughtUp) {
        await this.recordFeeCoverage(tick.head, nowUnix)
        feeCoverageThroughUnix = tick.head.timestampUnix
      }
    }

    const finalized = await this.#deps.rpc.finalized()

    const vaults: VaultSyncResult[] = []
    const stillBehind: Address[] = []
    for (const tracked of this.#tracked.values()) {
      const result = await this.#syncVault(tracked, finalized, nowUnix)
      vaults.push(result)
      if (!result.caughtUp) stillBehind.push(tracked.vault)
    }

    return {
      atUnix: nowUnix,
      finalized,
      vaults,
      ...(feeCoverageThroughUnix === undefined ? {} : { feeCoverageThroughUnix }),
      stillBehind,
    }
  }

  /**
   * Record how far the FEE streams reach, for a deployment whose poller lives
   * in another process. Call it only after a tick that actually caught up.
   */
  async recordFeeCoverage(head: BlockRef, atUnix: number): Promise<void> {
    await this.#deps.cursors.put({
      stream: 'fees',
      scope: FLEET_SCOPE,
      blockNumber: head.number,
      blockTimestampUnix: head.timestampUnix,
      updatedAtUnix: atUnix,
    })
  }

  async #syncVault(
    tracked: TrackedVault,
    finalized: BlockRef,
    nowUnix: number,
  ): Promise<VaultSyncResult> {
    const cursor = await this.#deps.cursors.get('vault_movements', tracked.vault)
    // A cold vault starts one block below its deployment so the deployment
    // block itself is inside the first range.
    const startAfter =
      cursor?.blockNumber ??
      (tracked.deployedAtBlock > 0n ? tracked.deployedAtBlock - 1n : 0n)

    let fromBlock = startAfter + 1n
    const target = finalized.number
    let rangesScanned = 0
    let newClaims = 0
    let newAllocations = 0

    if (fromBlock > target) {
      // Already at or beyond the finalized head. Still refresh the watermark:
      // the scan is current, and saying so is what keeps reads answerable.
      await this.#advanceCursor(tracked.vault, startAfter, finalized, nowUnix, true)
      return {
        vault: tracked.vault,
        fromBlock,
        toBlock: startAfter,
        rangesScanned: 0,
        newClaims: 0,
        newAllocations: 0,
        caughtUp: true,
      }
    }

    const blockCache = new Map<string, BlockRef>([[normalizeHash32(finalized.hash), finalized]])
    let lastScanned = startAfter

    while (fromBlock <= target && rangesScanned < this.#maxRangesPerSync) {
      const toBlock = min(fromBlock + this.#chunkBlocks - 1n, target)
      const logs = await this.#scanRange(tracked.vault, fromBlock, toBlock)
      rangesScanned++

      const { claims, allocations } = await this.#decode(logs, blockCache)
      newClaims += await this.#deps.movements.putClaims(claims)
      newAllocations += await this.#deps.movements.putAllocations(allocations)

      lastScanned = toBlock
      // The cursor advances only after the range is fully processed, which is
      // what makes a crash mid-range replay the range rather than skip it.
      // Posting ids are pure functions of chain position, so the replay is a
      // no-op rather than a double count.
      await this.#advanceCursor(tracked.vault, toBlock, finalized, nowUnix, toBlock === target)
      fromBlock = toBlock + 1n
    }

    return {
      vault: tracked.vault,
      fromBlock: startAfter + 1n,
      toBlock: lastScanned,
      rangesScanned,
      newClaims,
      newAllocations,
      caughtUp: lastScanned >= target,
    }
  }

  async #advanceCursor(
    vault: Address,
    blockNumber: bigint,
    finalized: BlockRef,
    nowUnix: number,
    reachedTarget: boolean,
  ): Promise<void> {
    const cursor: ScanCursor = {
      stream: 'vault_movements',
      scope: vault,
      blockNumber,
      // Coverage is claimed ONLY when the scan reached the finalized head we
      // agreed on this pass, because that is the only block whose timestamp we
      // actually hold. A mid-backfill chunk advances the block number and says
      // nothing about coverage, so reads keep refusing until the backfill lands.
      ...(reachedTarget ? { blockTimestampUnix: finalized.timestampUnix } : {}),
      updatedAtUnix: nowUnix,
    }
    await this.#deps.cursors.put(cursor)
  }

  async #decode(
    logs: readonly RpcLog[],
    blockCache: Map<string, BlockRef>,
  ): Promise<{
    claims: Array<ClaimObservation & { id: string; blockNumber: bigint }>
    allocations: Array<AllocationObservation & { id: string; blockNumber: bigint }>
  }> {
    const claims: Array<ClaimObservation & { id: string; blockNumber: bigint }> = []
    const allocations: Array<AllocationObservation & { id: string; blockNumber: bigint }> = []

    for (const log of logs) {
      if (log.removed) continue
      const block = await this.#blockFor(log, blockCache)
      const topic0 = log.topics[0]
      if (topic0 === undefined) continue
      const topic = normalizeHash32(topic0)

      if (topic === VAULT_MOVEMENT_TOPICS[0]) {
        claims.push({ ...decodeClaim(log, block), id: movementId(log), blockNumber: log.blockNumber })
        continue
      }
      if (topic === VAULT_MOVEMENT_TOPICS[1]) {
        allocations.push({
          ...decodeAllocation(log, block),
          id: movementId(log),
          blockNumber: log.blockNumber,
        })
        continue
      }
      // The query named exactly two topic0 values, so anything else means the
      // node answered a question we did not ask. Dropping it silently is how a
      // decoder learns to ignore money.
      throw new SourceUnavailableError(
        'vault movement scan',
        `log ${movementId(log)} has topic0 ${topic}, which was not in the filter`,
      )
    }

    return { claims, allocations }
  }

  async #blockFor(log: RpcLog, cache: Map<string, BlockRef>): Promise<BlockRef> {
    const hash = normalizeHash32(log.blockHash)
    const cached = cache.get(hash)
    if (cached !== undefined) return cached

    const block = await this.#deps.rpc.blockByNumber(log.blockNumber)
    if (block === null || normalizeHash32(block.hash) !== hash) {
      // The block the log claimed to be in is not the block at that height any
      // more, or is not there at all. That is a reorg under a scan in flight;
      // refusing means the cursor does not advance and the next sync redoes it.
      throw new SourceUnavailableError(
        'vault movement scan',
        `log ${movementId(log)} claims block ${log.blockNumber}/${hash}, which is not canonical now`,
      )
    }
    cache.set(hash, block)
    return block
  }

  /**
   * One bounded log query, halved on refusal.
   *
   * ONLY an RpcError halves. A quorum disagreement is two providers on
   * different forks and must reach the caller as a halt, not be narrowed until
   * the disagreeing block falls out of the range; an unbounded-query refusal is
   * this code asking for something it is not allowed to ask for, and retrying
   * it smaller would just be finding a way around our own firehose rule.
   */
  async #scanRange(vault: Address, fromBlock: bigint, toBlock: bigint): Promise<RpcLog[]> {
    const query: LogQuery = {
      fromBlock,
      toBlock,
      address: [vault],
      topics: [[...VAULT_MOVEMENT_TOPICS]],
    }
    assertBoundedLogQuery(query, this.#limits)

    let logs: RpcLog[]
    try {
      logs = await this.#deps.rpc.getLogs(query)
    } catch (error) {
      if (!(error instanceof RpcError)) throw error
      if (fromBlock === toBlock) {
        throw new UnservableRangeError(fromBlock, error.message)
      }
      const mid = fromBlock + (toBlock - fromBlock) / 2n
      return [
        ...(await this.#scanRange(vault, fromBlock, mid)),
        ...(await this.#scanRange(vault, mid + 1n, toBlock)),
      ]
    }

    if (logs.length >= this.#maxLogsPerRange) {
      // A full page is indistinguishable from a truncated one, and some nodes
      // truncate without saying so. Treat it as suspect.
      if (fromBlock === toBlock) {
        throw new UnservableRangeError(
          fromBlock,
          `a single block returned ${logs.length} logs, at or above the ${this.#maxLogsPerRange} page cap; ` +
            `the result may be truncated and cannot be trusted as complete`,
        )
      }
      const mid = fromBlock + (toBlock - fromBlock) / 2n
      return [
        ...(await this.#scanRange(vault, fromBlock, mid)),
        ...(await this.#scanRange(vault, mid + 1n, toBlock)),
      ]
    }

    return logs
  }

  // ---------------------------------------------------------------- coverage --

  #requireTracked(vault: Address): TrackedVault {
    const tracked = this.#tracked.get(normalizeAddress(vault))
    if (tracked === undefined) throw new VaultNotTrackedError(vault)
    return tracked
  }

  async #assertCoverage(stream: ScanStream, scope: string, toUnix: number): Promise<void> {
    const cursor = await this.#deps.cursors.get(stream, scope)
    const covered = cursor?.blockTimestampUnix
    if (covered === undefined || toUnix - covered > this.#maxCoverageLagSeconds) {
      throw new CoverageGapError(stream, scope, covered, toUnix)
    }
  }
}
