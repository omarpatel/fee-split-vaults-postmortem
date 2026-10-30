/**
 * Chunked eth_getLogs with automatic range narrowing, plus block-timestamp
 * resolution for day bucketing.
 *
 * Every public RPC caps a getLogs response, and the cap is announced
 * inconsistently (-32005, "query returned more than N results", "block range
 * too large", a 413). So the scanner treats ANY failure on a multi-block range
 * as a signal to halve and retry, and only gives up when a SINGLE block still
 * fails - at which point the range really is unservable and the tool must say
 * so rather than return a short result set that looks like a real answer.
 */

import type { Cache } from './cache.ts'
import { cacheKey } from './cache.ts'
import type { CheckpointStore } from './checkpoint.ts'
import type { ChainReader, LogFilter, RawLog } from './rpc.ts'
import { BatchUnsupportedError, supportsBatch } from './rpc.ts'

const SCAN_SCHEMA_VERSION = 'logscan-1'

/** Measured on this chain: batches of 10 give ~3 effective req/s; 25 gets 429ed. */
export const DEFAULT_SCAN_BATCH_SIZE = 10

export interface ScanProgress {
  /** Chunk just finished. */
  fromBlock: bigint
  toBlock: bigint
  /** Logs in that chunk. */
  logs: number
  blocksDone: number
  blocksTotal: number
  /** Logs found so far across the whole scan, including any resumed ones. */
  logsTotal: number
  chunksDone: number
  chunksTotal: number
  elapsedMs: number
  /** null until at least one chunk has been timed. */
  etaSeconds: number | null
}

export interface ScanOptions {
  address: string | string[]
  topics?: Array<string | string[] | null>
  fromBlock: bigint
  toBlock: bigint
  chunkBlocks: number
  cache?: Cache
  /** Cached chunks below the head are immutable; near-head chunks expire. */
  reorgDepthBlocks?: bigint
  onProgress?: (info: { fromBlock: bigint; toBlock: bigint; logs: number; done: number; total: number }) => void
  /**
   * Persist completed chunks so an interrupted scan resumes where it stopped.
   * Absent means the old behaviour: a failure loses the whole scan.
   */
  checkpoint?: CheckpointStore
  /** eth_getLogs per JSON-RPC batch. 1 disables batching. */
  batchSize?: number
  /** Rich progress, including an ETA. Wired to stderr by the CLIs. */
  onScanProgress?: (progress: ScanProgress) => void
  now?: () => number
}

/** One line of human progress. Kept here so every tool prints the same shape. */
export function formatScanProgress(progress: ScanProgress, unit = 'logs'): string {
  const pct = progress.blocksTotal === 0 ? 100 : (progress.blocksDone / progress.blocksTotal) * 100
  const eta =
    progress.etaSeconds === null
      ? 'eta --'
      : `eta ${formatDuration(progress.etaSeconds)}`
  return (
    `${progress.blocksDone.toLocaleString()}/${progress.blocksTotal.toLocaleString()} blocks ` +
    `(${pct.toFixed(1)}%)  chunk ${progress.chunksDone}/${progress.chunksTotal}  ` +
    `${progress.logsTotal.toLocaleString()} ${unit}  ` +
    `elapsed ${formatDuration(progress.elapsedMs / 1000)}  ${eta}`
  )
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`
  return `${s}s`
}

export class UnservableRangeError extends Error {
  readonly block: bigint

  constructor(block: bigint, cause: string) {
    super(
      `single block ${block} could not be scanned: ${cause}. The range is unservable by this endpoint.`,
    )
    this.name = 'UnservableRangeError'
    this.block = block
  }
}

/**
 * Scan a block range, yielding logs in ascending (block, logIndex) order.
 * Removed logs (reorged out) are dropped: a fee credit that no longer exists
 * must not enter a measurement.
 */
export async function scanLogs(reader: ChainReader, options: ScanOptions): Promise<RawLog[]> {
  const now = options.now ?? (() => Date.now())
  const startedAt = now()
  const total = Number(options.toBlock - options.fromBlock + 1n)

  const chunks: Array<{ from: bigint; to: bigint }> = []
  for (
    let start = options.fromBlock;
    start <= options.toBlock;
    start += BigInt(options.chunkBlocks)
  ) {
    chunks.push({ from: start, to: min(start + BigInt(options.chunkBlocks) - 1n, options.toBlock) })
  }

  // Resume: everything at or below completedThroughBlock is already on disk.
  const resumeThrough = options.checkpoint?.completedThroughBlock
  const results: RawLog[] = options.checkpoint ? await options.checkpoint.loadLogs() : []
  let done = 0
  let chunksDone = 0
  let pending = chunks
  if (resumeThrough !== undefined) {
    pending = chunks.filter((chunk) => chunk.to > resumeThrough)
    const skipped = chunks.length - pending.length
    chunksDone = skipped
    done = skipped === 0 ? 0 : Number(min(resumeThrough, options.toBlock) - options.fromBlock + 1n)
  }

  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 1))
  let batchUsable = batchSize > 1 && supportsBatch(reader)

  for (let i = 0; i < pending.length; i += batchSize) {
    const group = pending.slice(i, i + batchSize)
    const fetched = batchUsable
      ? await fetchGroup(reader, options, group, () => {
          batchUsable = false
        })
      : await fetchGroupSequential(reader, options, group)

    for (const [j, chunk] of group.entries()) {
      const logs = fetched[j]!
      results.push(...logs)
      done += Number(chunk.to - chunk.from + 1n)
      chunksDone++
      // Commit in ascending block order so completedThroughBlock always means
      // "and everything before it", which is what resume relies on.
      await options.checkpoint?.commit(chunk.to, logs)
      options.onProgress?.({
        fromBlock: chunk.from,
        toBlock: chunk.to,
        logs: logs.length,
        done,
        total,
      })
      if (options.onScanProgress) {
        const elapsedMs = now() - startedAt
        // The ETA is projected from chunks scanned IN THIS PROCESS only.
        // Including resumed chunks would divide this run's elapsed time by work
        // a previous run did and report a wildly optimistic finish.
        const scannedNow = chunksDone - (chunks.length - pending.length)
        const etaSeconds =
          scannedNow > 0 && elapsedMs > 0
            ? ((elapsedMs / scannedNow) * (pending.length - scannedNow)) / 1000
            : null
        options.onScanProgress({
          fromBlock: chunk.from,
          toBlock: chunk.to,
          logs: logs.length,
          blocksDone: done,
          blocksTotal: total,
          logsTotal: results.length,
          chunksDone,
          chunksTotal: chunks.length,
          elapsedMs,
          etaSeconds,
        })
      }
    }
  }

  results.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  )
  return results
}

/**
 * Fetch a group of chunks in ONE JSON-RPC batch, with two escape hatches:
 * a cached chunk is never requested, and a chunk the endpoint refuses falls
 * back to the halving scanner rather than being dropped.
 */
async function fetchGroup(
  reader: ChainReader,
  options: ScanOptions,
  group: ReadonlyArray<{ from: bigint; to: bigint }>,
  onBatchUnsupported: () => void,
): Promise<RawLog[][]> {
  const out: RawLog[][] = new Array<RawLog[]>(group.length)
  const needed: Array<{ index: number; filter: LogFilter; from: bigint; to: bigint }> = []

  for (const [index, chunk] of group.entries()) {
    const cached = await options.cache?.get<RawLog[]>(
      chunkCacheKey(options, chunk.from, chunk.to),
      SCAN_SCHEMA_VERSION,
    )
    if (cached !== undefined) {
      out[index] = cached
      continue
    }
    needed.push({ index, filter: filterFor(options, chunk.from, chunk.to), from: chunk.from, to: chunk.to })
  }

  if (needed.length > 0 && supportsBatch(reader)) {
    try {
      const outcomes = await reader.getLogsBatch(needed.map((n) => n.filter))
      for (const [k, outcome] of outcomes.entries()) {
        const slot = needed[k]!
        if (outcome.ok) {
          const kept = outcome.value.filter((log) => !log.removed)
          await options.cache?.set(chunkCacheKey(options, slot.from, slot.to), SCAN_SCHEMA_VERSION, kept)
          out[slot.index] = kept
        } else {
          // The endpoint capped or refused this one. Narrow it the usual way
          // rather than returning a short result set that looks complete.
          out[slot.index] = await scanRange(reader, options, slot.from, slot.to)
        }
      }
      return out
    } catch (error) {
      if (!(error instanceof BatchUnsupportedError)) throw error
      onBatchUnsupported()
    }
  }

  for (const slot of needed) {
    out[slot.index] = await scanRange(reader, options, slot.from, slot.to)
  }
  return out
}

async function fetchGroupSequential(
  reader: ChainReader,
  options: ScanOptions,
  group: ReadonlyArray<{ from: bigint; to: bigint }>,
): Promise<RawLog[][]> {
  const out: RawLog[][] = []
  for (const chunk of group) {
    out.push(await scanRange(reader, options, chunk.from, chunk.to))
  }
  return out
}

function filterFor(options: ScanOptions, fromBlock: bigint, toBlock: bigint): LogFilter {
  return {
    address: options.address,
    fromBlock,
    toBlock,
    ...(options.topics ? { topics: options.topics } : {}),
  }
}

function chunkCacheKey(options: ScanOptions, fromBlock: bigint, toBlock: bigint): string {
  return cacheKey({
    kind: 'logs',
    address: options.address,
    topics: options.topics ?? null,
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
  })
}

async function scanRange(
  reader: ChainReader,
  options: ScanOptions,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<RawLog[]> {
  const filter = filterFor(options, fromBlock, toBlock)
  const key = chunkCacheKey(options, fromBlock, toBlock)
  const cached = await options.cache?.get<RawLog[]>(key, SCAN_SCHEMA_VERSION)
  if (cached !== undefined) return cached

  let logs: RawLog[]
  try {
    logs = await reader.getLogs(filter)
  } catch (error) {
    if (fromBlock === toBlock) {
      throw new UnservableRangeError(fromBlock, error instanceof Error ? error.message : String(error))
    }
    const mid = fromBlock + (toBlock - fromBlock) / 2n
    const left = await scanRange(reader, options, fromBlock, mid)
    const right = await scanRange(reader, options, mid + 1n, toBlock)
    return [...left, ...right]
  }

  const kept = logs.filter((log) => !log.removed)
  await options.cache?.set(key, SCAN_SCHEMA_VERSION, kept)
  return kept
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}

// ---------------------------------------------------------------------------
// Block timestamps
// ---------------------------------------------------------------------------

/**
 * Resolves block number -> unix timestamp.
 *
 * Exact mode fetches every distinct block, which is correct and slow. Anchored
 * mode samples a ladder of headers and linearly interpolates between the two
 * bracketing anchors. Interpolation error is bounded by the anchor spacing
 * times the block-time variance, and since every consumer here buckets into
 * UTC DAYS, an error of a few seconds only matters for logs within seconds of
 * midnight. The mode used is recorded in the report meta either way.
 */
export class BlockTimeResolver {
  readonly #known = new Map<string, number>()
  #exactFetches = 0
  #anchorFetches = 0
  readonly #reader: ChainReader
  readonly #options: {
    exact: boolean
    anchorSpacing: number
    cache?: Cache
    /** Headers per JSON-RPC batch when priming the ladder. 1 disables batching. */
    batchSize?: number
    onProgress?: (done: number, total: number) => void
  }

  constructor(
    reader: ChainReader,
    options: {
      exact: boolean
      anchorSpacing: number
      cache?: Cache
      batchSize?: number
      onProgress?: (done: number, total: number) => void
    },
  ) {
    this.#reader = reader
    this.#options = options
  }

  get stats(): { exactFetches: number; anchorFetches: number; knownBlocks: number } {
    return {
      exactFetches: this.#exactFetches,
      anchorFetches: this.#anchorFetches,
      knownBlocks: this.#known.size,
    }
  }

  async #header(block: bigint): Promise<number> {
    const key = block.toString()
    const memo = this.#known.get(key)
    if (memo !== undefined) return memo
    const cacheId = cacheKey({ kind: 'blockTime', block: key })
    const cached = await this.#options.cache?.get<number>(cacheId, SCAN_SCHEMA_VERSION)
    if (cached !== undefined) {
      this.#known.set(key, cached)
      return cached
    }
    const header = await this.#reader.getBlockHeader(block)
    this.#known.set(key, header.timestampUnix)
    await this.#options.cache?.set(cacheId, SCAN_SCHEMA_VERSION, header.timestampUnix)
    return header.timestampUnix
  }

  /**
   * Pre-fetch the anchor ladder for a range. Call once before resolving.
   *
   * BATCHED, because on a 30-day window the ladder is ~12,800 headers against
   * the log scan's ~5,100 chunks: unbatched, fetching timestamps costs more
   * than reading the logs they describe.
   */
  async prime(fromBlock: bigint, toBlock: bigint): Promise<void> {
    if (this.#options.exact) return
    const spacing = BigInt(Math.max(1, this.#options.anchorSpacing))
    const wanted: bigint[] = []
    for (let block = fromBlock; block < toBlock; block += spacing) wanted.push(block)
    wanted.push(toBlock)

    const batchSize = Math.max(1, Math.floor(this.#options.batchSize ?? 1))
    let done = 0
    for (let i = 0; i < wanted.length; i += batchSize) {
      const group = wanted.slice(i, i + batchSize)
      // Anything already memoised or on disk is free; only ask for the rest.
      const missing: bigint[] = []
      for (const block of group) {
        const key = block.toString()
        if (this.#known.has(key)) continue
        const cached = await this.#options.cache?.get<number>(
          cacheKey({ kind: 'blockTime', block: key }),
          SCAN_SCHEMA_VERSION,
        )
        if (cached !== undefined) this.#known.set(key, cached)
        else missing.push(block)
      }
      if (missing.length > 0) {
        await this.#fetchHeaders(missing, batchSize > 1)
      }
      this.#anchorFetches += group.length
      done += group.length
      this.#options.onProgress?.(done, wanted.length)
    }
  }

  async #fetchHeaders(blocks: readonly bigint[], allowBatch: boolean): Promise<void> {
    if (allowBatch && blocks.length > 1 && supportsBatch(this.#reader)) {
      try {
        const outcomes = await this.#reader.getBlockHeadersBatch(blocks)
        const failed: bigint[] = []
        for (const [i, outcome] of outcomes.entries()) {
          if (outcome.ok) await this.#remember(blocks[i]!, outcome.value.timestampUnix)
          else failed.push(blocks[i]!)
        }
        // A slot the endpoint refused is retried singly, not dropped: a missing
        // anchor silently widens the interpolation span.
        for (const block of failed) await this.#header(block)
        return
      } catch (error) {
        if (!(error instanceof BatchUnsupportedError)) throw error
      }
    }
    for (const block of blocks) await this.#header(block)
  }

  async #remember(block: bigint, timestampUnix: number): Promise<void> {
    const key = block.toString()
    this.#known.set(key, timestampUnix)
    await this.#options.cache?.set(
      cacheKey({ kind: 'blockTime', block: key }),
      SCAN_SCHEMA_VERSION,
      timestampUnix,
    )
  }

  async timestampOf(block: bigint): Promise<number> {
    const memo = this.#known.get(block.toString())
    if (memo !== undefined) return memo
    if (this.#options.exact) {
      this.#exactFetches++
      return this.#header(block)
    }

    const anchors = [...this.#known.entries()]
      .map(([k, v]) => ({ block: BigInt(k), time: v }))
      .sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0))
    if (anchors.length === 0) {
      this.#exactFetches++
      return this.#header(block)
    }

    let lower = anchors[0]!
    let upper = anchors[anchors.length - 1]!
    for (const anchor of anchors) {
      if (anchor.block <= block) lower = anchor
      if (anchor.block >= block) {
        upper = anchor
        break
      }
    }
    if (lower.block === upper.block) return lower.time
    if (block < lower.block || block > upper.block) {
      // Outside the primed ladder: fetch exactly rather than extrapolate.
      this.#exactFetches++
      return this.#header(block)
    }
    const span = Number(upper.block - lower.block)
    const offset = Number(block - lower.block)
    return Math.round(lower.time + ((upper.time - lower.time) * offset) / span)
  }
}

/**
 * Binary search for the first block at or after a target timestamp.
 * Used to turn "last 30 days" into a block range without trusting an assumed
 * block time - on an L2 with a variable batch cadence that assumption drifts.
 */
export async function findBlockAtOrAfter(
  reader: ChainReader,
  targetUnix: number,
  bounds: { low: bigint; high: bigint },
): Promise<bigint> {
  let low = bounds.low
  let high = bounds.high
  const highHeader = await reader.getBlockHeader(high)
  if (highHeader.timestampUnix < targetUnix) return high
  const lowHeader = await reader.getBlockHeader(low)
  if (lowHeader.timestampUnix >= targetUnix) return low

  while (low + 1n < high) {
    const mid = low + (high - low) / 2n
    const header = await reader.getBlockHeader(mid)
    if (header.timestampUnix < targetUnix) {
      low = mid
    } else {
      high = mid
    }
  }
  return high
}
