/**
 * Scan checkpointing: a 30-day escrow scan is ~25.7M blocks, thousands of
 * queries and well over an hour. A run that dies at 90% must not lose 90%.
 *
 * THE CORRECTNESS PROPERTY, which is the whole point of the file: a resumed
 * scan must produce BYTE-IDENTICAL output to an uninterrupted one. Two things
 * make that true and both are load-bearing.
 *
 *   1. A chunk is committed only after its logs are on disk. The state file is
 *      written second, so a crash between the two loses the chunk rather than
 *      recording it as done.
 *   2. The state file records the log file's BYTE LENGTH at the moment of the
 *      commit, and resuming truncates the log file back to it. A partial line
 *      from a process killed mid-write is therefore removed, not parsed. Just
 *      trusting "the file ends with a newline" is not enough: a kill during an
 *      append can leave a complete-looking line for a chunk the state file
 *      never accepted, and that chunk would then be scanned twice.
 *
 * The identity of a scan (address, topics, range, chunk size, chain) is hashed
 * into the directory name AND stored in the state, so resuming a scan whose
 * parameters changed starts over instead of silently merging two windows.
 */

import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { cacheKey } from './cache.ts'
import { parseJson, stringifyJson } from './json.ts'
import type { LogFilter, RawLog } from './rpc.ts'

export const CHECKPOINT_SCHEMA = 'logscan-checkpoint-1'

export interface ScanIdentity {
  chainId: number
  address: string | string[]
  topics?: Array<string | string[] | null> | undefined
  fromBlock: bigint
  toBlock: bigint
  chunkBlocks: number
}

export interface CheckpointState {
  schema: typeof CHECKPOINT_SCHEMA
  scanId: string
  identity: {
    chainId: number
    address: string | string[]
    topics: Array<string | string[] | null> | null
    fromBlock: string
    toBlock: string
    chunkBlocks: number
  }
  /** Every chunk ending at or below this block is committed. */
  completedThroughBlock: string
  chunksCompleted: number
  logCount: number
  /** Byte length of logs.ndjson as of this commit. Resume truncates to it. */
  logBytes: number
  startedAtUnix: number
  updatedAtUnix: number
}

function serializeIdentity(identity: ScanIdentity): CheckpointState['identity'] {
  return {
    chainId: identity.chainId,
    address: identity.address,
    topics: identity.topics ?? null,
    fromBlock: identity.fromBlock.toString(),
    toBlock: identity.toBlock.toString(),
    chunkBlocks: identity.chunkBlocks,
  }
}

export function scanIdOf(identity: ScanIdentity): string {
  return cacheKey({ kind: 'logscan', ...serializeIdentity(identity) })
}

/**
 * Serialise one log to a single NDJSON line.
 *
 * Field order is FIXED and matches what the RPC reader constructs, so a log
 * that came back from a checkpoint stringifies identically to one that came
 * back from the endpoint. The resumed-equals-uninterrupted test compares
 * serialised output, and key order would break it.
 */
export function serializeLog(log: RawLog): string {
  return JSON.stringify({
    address: log.address,
    topics: log.topics,
    data: log.data,
    blockNumber: log.blockNumber.toString(),
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    removed: log.removed,
  })
}

export function deserializeLog(line: string): RawLog {
  const raw = JSON.parse(line) as {
    address: string
    topics: string[]
    data: string
    blockNumber: string
    blockHash: string
    transactionHash: string
    logIndex: number
    removed: boolean
  }
  return {
    address: raw.address,
    topics: raw.topics,
    data: raw.data,
    blockNumber: BigInt(raw.blockNumber),
    blockHash: raw.blockHash,
    transactionHash: raw.transactionHash,
    logIndex: raw.logIndex,
    removed: raw.removed,
  }
}

export interface CheckpointOpenResult {
  store: CheckpointStore
  /** Populated when a usable checkpoint was found. */
  resumedFrom?: CheckpointState
  /** Set when a checkpoint existed but did not match this scan. */
  discardedReason?: string
}

export class CheckpointStore {
  readonly dir: string
  readonly scanId: string
  readonly #identity: ScanIdentity
  readonly #now: () => number
  #state: CheckpointState

  private constructor(dir: string, identity: ScanIdentity, state: CheckpointState, now: () => number) {
    this.dir = dir
    this.scanId = state.scanId
    this.#identity = identity
    this.#state = state
    this.#now = now
  }

  get state(): CheckpointState {
    return this.#state
  }

  get statePath(): string {
    return join(this.dir, 'state.json')
  }

  get logsPath(): string {
    return join(this.dir, 'logs.ndjson')
  }

  /** Block at or below which every chunk is already done. */
  get completedThroughBlock(): bigint | undefined {
    return this.#state.chunksCompleted === 0 ? undefined : BigInt(this.#state.completedThroughBlock)
  }

  /**
   * Open (or create) the checkpoint for this scan.
   *
   * A checkpoint whose identity does not match is DISCARDED, loudly, rather
   * than resumed: half a scan of one block range merged into another is a wrong
   * answer that looks like a complete one.
   */
  static async open(
    rootDir: string,
    identity: ScanIdentity,
    options: { now?: () => number } = {},
  ): Promise<CheckpointOpenResult> {
    const now = options.now ?? (() => Math.floor(Date.now() / 1000))
    const scanId = scanIdOf(identity)
    const dir = join(rootDir, scanId)
    await mkdir(dir, { recursive: true })

    const fresh = (): CheckpointState => ({
      schema: CHECKPOINT_SCHEMA,
      scanId,
      identity: serializeIdentity(identity),
      completedThroughBlock: (identity.fromBlock - 1n).toString(),
      chunksCompleted: 0,
      logCount: 0,
      logBytes: 0,
      startedAtUnix: now(),
      updatedAtUnix: now(),
    })

    let existing: CheckpointState | undefined
    let discardedReason: string | undefined
    try {
      const raw = await readFile(join(dir, 'state.json'), 'utf8')
      const parsed = parseJson<CheckpointState>(raw)
      if (parsed.schema !== CHECKPOINT_SCHEMA) {
        discardedReason = `checkpoint schema "${String(parsed.schema)}" != "${CHECKPOINT_SCHEMA}"`
      } else if (stringifyJson(parsed.identity, 'string', 0) !== stringifyJson(serializeIdentity(identity), 'string', 0)) {
        discardedReason = 'checkpoint was written for a different scan (address/topics/range/chunk changed)'
      } else {
        existing = parsed
      }
    } catch {
      // No checkpoint yet, or an unreadable one. Either way: start clean.
    }

    const state = existing ?? fresh()
    const store = new CheckpointStore(dir, identity, state, now)

    if (existing !== undefined) {
      // Discard anything appended after the last accepted commit.
      await store.#truncateLogsTo(existing.logBytes)
    } else {
      await writeFile(store.logsPath, '', 'utf8')
      await store.#writeState()
    }

    return {
      store,
      ...(existing !== undefined ? { resumedFrom: existing } : {}),
      ...(discardedReason !== undefined ? { discardedReason } : {}),
    }
  }

  async #truncateLogsTo(bytes: number): Promise<void> {
    let size: number
    try {
      size = (await stat(this.logsPath)).size
    } catch {
      await writeFile(this.logsPath, '', 'utf8')
      return
    }
    if (size === bytes) return
    const handle = await open(this.logsPath, 'r+')
    try {
      await handle.truncate(bytes)
    } finally {
      await handle.close()
    }
  }

  async #writeState(): Promise<void> {
    const temp = `${this.statePath}.${process.pid}.tmp`
    await writeFile(temp, stringifyJson(this.#state, 'string', 2), 'utf8')
    await rename(temp, this.statePath)
  }

  /**
   * Every log committed so far, in commit order.
   *
   * STREAMED, NOT SLURPED, and this is not a micro-optimisation. A 7-day merged
   * scan of the fee escrow checkpoints 1,312,335 logs as 808 MB of NDJSON, and
   * Node cannot hold that in one string: `MAX_STRING_LENGTH` is 536,870,888, so
   * `readFile(path, 'utf8')` throws ERR_STRING_TOO_LONG. This method used to
   * catch that and `return []`.
   *
   * The consequence was the worst kind. `scanLogs` sees a checkpoint whose every
   * chunk is complete, so it queues no work, takes the empty array as the scan
   * result, and the run reports ZERO CREDITS as a success - a tidy table of
   * zeros that reads as "there is no market", produced from a complete and
   * perfectly good 808 MB checkpoint. That is precisely the unknown-becomes-zero
   * failure the rest of this toolkit refuses, reintroduced in the resume path,
   * and it only appears at the scale where checkpointing actually matters.
   *
   * So: read line by line, bound the read by the byte length the state file
   * accepted, and let a genuine read failure THROW. Only a missing file means
   * "nothing committed yet".
   */
  async loadLogs(): Promise<RawLog[]> {
    let handle: FileHandle
    try {
      handle = await open(this.logsPath, 'r')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    try {
      const out: RawLog[] = []
      // Only bytes the state file claims are readable; anything past that is an
      // unclaimed partial append, exactly as #truncateLogsTo would have removed.
      const limit = this.#state.logBytes
      let consumed = 0
      let pending = ''
      const decoder = new TextDecoder('utf8')
      for await (const chunk of handle.createReadStream({ start: 0, end: Math.max(0, limit - 1) })) {
        consumed += (chunk as Buffer).length
        pending += decoder.decode(chunk as Buffer, { stream: true })
        let newline = pending.indexOf('\n')
        while (newline !== -1) {
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          if (line.length > 0) out.push(deserializeLog(line))
          newline = pending.indexOf('\n')
        }
      }
      pending += decoder.decode()
      if (pending.length > 0) out.push(deserializeLog(pending))

      if (limit > 0 && consumed !== limit) {
        // The state says N bytes were accepted and the file did not yield them.
        // Returning what we got would silently shorten a measurement.
        throw new Error(
          `checkpoint ${this.logsPath} yielded ${consumed} bytes but its state claims ${limit}. ` +
            `Refusing to resume from a short read; delete the checkpoint directory to rescan.`,
        )
      }
      if (out.length !== this.#state.logCount) {
        throw new Error(
          `checkpoint ${this.logsPath} deserialized ${out.length} log(s) but its state claims ` +
            `${this.#state.logCount}. Refusing to resume from an inconsistent checkpoint; delete ` +
            `the checkpoint directory to rescan.`,
        )
      }
      return out
    } finally {
      await handle.close()
    }
  }

  /**
   * Record one completed chunk.
   *
   * Logs land before the state does. That ordering is the crash-safety
   * argument: the worst outcome is a chunk on disk that the state does not
   * claim, and the truncate on resume removes exactly that.
   */
  async commit(chunkEndBlock: bigint, logs: readonly RawLog[]): Promise<void> {
    const payload = logs.map((log) => `${serializeLog(log)}\n`).join('')
    const handle = await open(this.logsPath, 'a')
    try {
      if (payload.length > 0) await handle.writeFile(payload, 'utf8')
      await handle.sync().catch(() => undefined)
    } finally {
      await handle.close()
    }
    this.#state = {
      ...this.#state,
      completedThroughBlock: chunkEndBlock.toString(),
      chunksCompleted: this.#state.chunksCompleted + 1,
      logCount: this.#state.logCount + logs.length,
      logBytes: this.#state.logBytes + Buffer.byteLength(payload, 'utf8'),
      updatedAtUnix: this.#now(),
    }
    await this.#writeState()
  }

  /** Delete the checkpoint. Called only once the scan finished successfully. */
  async discard(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true })
  }

  /** For diagnostics: the filter this checkpoint belongs to. */
  describe(): LogFilter & { chainId: number; chunkBlocks: number } {
    return {
      chainId: this.#identity.chainId,
      address: this.#identity.address,
      ...(this.#identity.topics ? { topics: this.#identity.topics } : {}),
      fromBlock: this.#identity.fromBlock,
      toBlock: this.#identity.toBlock,
      chunkBlocks: this.#identity.chunkBlocks,
    }
  }
}
