import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryCache } from '../lib/cache.ts'
import { CheckpointStore, deserializeLog, serializeLog } from '../lib/checkpoint.ts'
import {
  BlockTimeResolver,
  formatDuration,
  formatScanProgress,
  scanLogs,
  type ScanProgress,
} from '../lib/logscan.ts'
import { stringifyJson } from '../lib/json.ts'
import {
  BatchUnsupportedError,
  FakeChainReader,
  type BatchOutcome,
  type LogFilter,
  type RawLog,
} from '../lib/rpc.ts'

const ESCROW = '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e'
const TOPIC = '0x5d104c62f50449fadfe6f4013c8f36588d32737f94b5ac9b83ddad33b3e1ffdf'

/** A deterministic synthetic log set spread across a wide block range. */
function makeLogs(count: number, spanBlocks: number): RawLog[] {
  const logs: RawLog[] = []
  for (let i = 0; i < count; i++) {
    const block = BigInt(Math.floor((i * spanBlocks) / count) + 1)
    logs.push({
      address: ESCROW,
      topics: [TOPIC, `0x${i.toString(16).padStart(64, '0')}`],
      data: `0x${(i * 7).toString(16).padStart(64, '0')}`,
      blockNumber: block,
      blockHash: `0x${block.toString(16).padStart(64, '0')}`,
      transactionHash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
      logIndex: i % 5,
      removed: false,
    })
  }
  return logs
}

const LOGS = makeLogs(400, 40_000)

function reader(): FakeChainReader {
  return new FakeChainReader({ chainId: 4663, logs: LOGS, latestBlock: 40_000n })
}

const IDENTITY = {
  chainId: 4663,
  address: ESCROW,
  topics: [TOPIC] as Array<string | string[] | null>,
  fromBlock: 1n,
  toBlock: 40_000n,
  chunkBlocks: 5_000,
}

const SCAN = {
  address: ESCROW,
  topics: [TOPIC] as Array<string | string[] | null>,
  fromBlock: 1n,
  toBlock: 40_000n,
  chunkBlocks: 5_000,
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'venue-ckpt-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/**
 * A reader that dies partway, the way a killed process or an exhausted retry
 * budget does. Nothing here is caught by the halving logic: it is a hard stop.
 */
class DyingReader extends FakeChainReader {
  #batchesLeft: number
  constructor(batchesBeforeDeath: number) {
    super({ chainId: 4663, logs: LOGS, latestBlock: 40_000n })
    this.#batchesLeft = batchesBeforeDeath
  }
  override async getLogsBatch(filters: readonly LogFilter[]): Promise<Array<BatchOutcome<RawLog[]>>> {
    if (this.#batchesLeft-- <= 0) throw new Error('endpoint gave up after 6 attempts (HTTP 429)')
    return super.getLogsBatch(filters)
  }
}

describe('serializeLog', () => {
  it('round-trips a log exactly, including bigint block numbers', () => {
    const log = LOGS[7]!
    expect(deserializeLog(serializeLog(log))).toEqual(log)
  })

  it('emits a stable key order so a resumed log stringifies like a fresh one', () => {
    const fresh = stringifyJson(LOGS[3]!, 'string', 0)
    const resumed = stringifyJson(deserializeLog(serializeLog(LOGS[3]!)), 'string', 0)
    expect(resumed).toBe(fresh)
  })
})

describe('CheckpointStore', () => {
  it('starts clean when there is no checkpoint', async () => {
    const opened = await CheckpointStore.open(dir, IDENTITY)
    expect(opened.resumedFrom).toBeUndefined()
    expect(opened.store.completedThroughBlock).toBeUndefined()
    expect(await opened.store.loadLogs()).toEqual([])
  })

  it('remembers committed chunks across a re-open', async () => {
    const first = (await CheckpointStore.open(dir, IDENTITY)).store
    await first.commit(5_000n, LOGS.slice(0, 10))
    await first.commit(10_000n, LOGS.slice(10, 25))

    const second = await CheckpointStore.open(dir, IDENTITY)
    expect(second.resumedFrom?.chunksCompleted).toBe(2)
    expect(second.store.completedThroughBlock).toBe(10_000n)
    expect(await second.store.loadLogs()).toEqual(LOGS.slice(0, 25))
  })

  it('DISCARDS a checkpoint written for a different scan rather than merging two windows', async () => {
    const first = (await CheckpointStore.open(dir, IDENTITY)).store
    await first.commit(5_000n, LOGS.slice(0, 10))
    const other = await CheckpointStore.open(dir, { ...IDENTITY, toBlock: 50_000n })
    // Different identity -> different scanId -> a fresh directory, not a resume.
    expect(other.resumedFrom).toBeUndefined()
    expect(await other.store.loadLogs()).toEqual([])
  })

  it('truncates a partial append left by a process killed mid-write', async () => {
    // The failure this defends against: a kill between "logs appended" and
    // "state written" leaves a complete-LOOKING line for a chunk the state
    // never accepted, and re-scanning that chunk would duplicate it.
    const first = (await CheckpointStore.open(dir, IDENTITY)).store
    await first.commit(5_000n, LOGS.slice(0, 10))
    const committedBytes = first.state.logBytes
    await writeFile(
      first.logsPath,
      `${await readFile(first.logsPath, 'utf8')}${serializeLog(LOGS[10]!)}\n${serializeLog(LOGS[11]!).slice(0, 30)}`,
      'utf8',
    )

    const reopened = await CheckpointStore.open(dir, IDENTITY)
    expect(reopened.store.state.logBytes).toBe(committedBytes)
    // Both the orphan line and the half-written one are gone.
    expect(await reopened.store.loadLogs()).toEqual(LOGS.slice(0, 10))
  })
})

describe('resumable scanning', () => {
  it('produces BYTE-IDENTICAL output when interrupted and resumed', async () => {
    const uninterrupted = await scanLogs(reader(), SCAN)

    const dying = new DyingReader(3)
    const opened = await CheckpointStore.open(dir, IDENTITY)
    await expect(
      scanLogs(dying, { ...SCAN, checkpoint: opened.store, batchSize: 2 }),
    ).rejects.toThrow(/HTTP 429/)

    const resumedOpen = await CheckpointStore.open(dir, IDENTITY)
    expect(resumedOpen.resumedFrom).toBeDefined()
    expect(resumedOpen.resumedFrom!.chunksCompleted).toBe(6)
    const resumed = await scanLogs(reader(), {
      ...SCAN,
      checkpoint: resumedOpen.store,
      batchSize: 2,
    })

    // The published property: not "same length", not "same set" - the same
    // bytes. Anything weaker would let a duplicated or reordered chunk through.
    expect(stringifyJson(resumed, 'string', 0)).toBe(stringifyJson(uninterrupted, 'string', 0))
  })

  it('stays byte-identical when the kill lands mid-append across a chunk boundary', async () => {
    const uninterrupted = await scanLogs(reader(), SCAN)

    const dying = new DyingReader(2)
    const opened = await CheckpointStore.open(dir, IDENTITY)
    await expect(
      scanLogs(dying, { ...SCAN, checkpoint: opened.store, batchSize: 3 }),
    ).rejects.toThrow()

    // Simulate the crash window: logs for the next chunk on disk, state not
    // yet updated to claim them.
    const store = (await CheckpointStore.open(dir, IDENTITY)).store
    const before = await readFile(store.logsPath, 'utf8')
    await writeFile(store.logsPath, `${before}${serializeLog(LOGS[0]!)}\n`, 'utf8')

    const resumedOpen = await CheckpointStore.open(dir, IDENTITY)
    const resumed = await scanLogs(reader(), { ...SCAN, checkpoint: resumedOpen.store, batchSize: 3 })
    expect(stringifyJson(resumed, 'string', 0)).toBe(stringifyJson(uninterrupted, 'string', 0))
  })

  it('resuming a finished scan re-reads nothing and returns the same answer', async () => {
    const opened = await CheckpointStore.open(dir, IDENTITY)
    const first = await scanLogs(reader(), { ...SCAN, checkpoint: opened.store, batchSize: 4 })

    const again = await CheckpointStore.open(dir, IDENTITY)
    const second = new FakeChainReader({ chainId: 4663, logs: LOGS, latestBlock: 40_000n })
    const resumed = await scanLogs(second, { ...SCAN, checkpoint: again.store, batchSize: 4 })
    expect(second.getLogsCalls).toHaveLength(0)
    expect(stringifyJson(resumed, 'string', 0)).toBe(stringifyJson(first, 'string', 0))
  })
})

describe('batched scanning', () => {
  it('agrees exactly with an unbatched scan', async () => {
    const plain = await scanLogs(reader(), SCAN)
    const batched = await scanLogs(reader(), { ...SCAN, batchSize: 10 })
    expect(stringifyJson(batched, 'string', 0)).toBe(stringifyJson(plain, 'string', 0))
  })

  it('sends one request per group instead of one per chunk', async () => {
    const r = reader()
    await scanLogs(r, { ...SCAN, batchSize: 4 })
    // 8 chunks of 5,000 over 40,000 blocks -> groups of 4 -> 2 batches.
    expect(r.batchCalls).toEqual([4, 4])
  })

  it('falls back to sequential when the endpoint does not speak batch', async () => {
    const r = reader()
    r.batchUnsupported = true
    const batched = await scanLogs(r, { ...SCAN, batchSize: 10 })
    const plain = await scanLogs(reader(), SCAN)
    expect(stringifyJson(batched, 'string', 0)).toBe(stringifyJson(plain, 'string', 0))
    expect(r.getLogsCalls.length).toBeGreaterThan(0)
  })

  it('narrows a single capped chunk without discarding it or failing the batch', async () => {
    class CappedReader extends FakeChainReader {
      override async getLogsBatch(
        filters: readonly LogFilter[],
      ): Promise<Array<BatchOutcome<RawLog[]>>> {
        const outcomes = await super.getLogsBatch(filters)
        // Refuse exactly one slot, the way an endpoint caps one dense chunk.
        return outcomes.map((outcome, i) =>
          i === 1
            ? { ok: false as const, error: 'query returned more than 10000 results', code: -32005, reverted: false }
            : outcome,
        )
      }
    }
    const capped = new CappedReader({ chainId: 4663, logs: LOGS, latestBlock: 40_000n })
    const batched = await scanLogs(capped, { ...SCAN, batchSize: 4 })
    const plain = await scanLogs(reader(), SCAN)
    expect(stringifyJson(batched, 'string', 0)).toBe(stringifyJson(plain, 'string', 0))
  })

  it('serves batched chunks from the cache without re-requesting them', async () => {
    const cache = new MemoryCache()
    const first = reader()
    await scanLogs(first, { ...SCAN, batchSize: 4, cache })
    const second = reader()
    const again = await scanLogs(second, { ...SCAN, batchSize: 4, cache })
    expect(second.batchCalls).toHaveLength(0)
    expect(again).toHaveLength(LOGS.length)
  })

  it('surfaces a non-batch error rather than silently returning a short result', async () => {
    class BrokenReader extends FakeChainReader {
      override async getLogsBatch(): Promise<Array<BatchOutcome<RawLog[]>>> {
        throw new Error('connection reset')
      }
    }
    const broken = new BrokenReader({ chainId: 4663, logs: LOGS, latestBlock: 40_000n })
    await expect(scanLogs(broken, { ...SCAN, batchSize: 4 })).rejects.toThrow(/connection reset/)
    // A BatchUnsupportedError is different and IS recoverable; this one is not.
    expect(new BatchUnsupportedError('x').name).toBe('BatchUnsupportedError')
  })
})

describe('block-time anchor ladder', () => {
  it('batches the ladder, which is the long pole on a 30-day window', async () => {
    // Unbatched, a 30-day run spends ~12,800 requests on timestamps against
    // ~5,100 on the logs they describe.
    const r = reader()
    const resolver = new BlockTimeResolver(r, { exact: false, anchorSpacing: 5_000, batchSize: 10 })
    await resolver.prime(0n, 40_000n)
    // 9 anchors (0, 5k .. 35k) plus the endpoint -> one batch of 9.
    expect(r.batchCalls).toEqual([9])
    expect(resolver.stats.knownBlocks).toBe(9)
  })

  it('interpolates identically whether the ladder was batched or not', async () => {
    const batched = new BlockTimeResolver(reader(), {
      exact: false,
      anchorSpacing: 5_000,
      batchSize: 10,
    })
    const serial = new BlockTimeResolver(reader(), { exact: false, anchorSpacing: 5_000 })
    await batched.prime(0n, 40_000n)
    await serial.prime(0n, 40_000n)
    for (const block of [1n, 7_777n, 22_500n, 39_999n]) {
      expect(await batched.timestampOf(block)).toBe(await serial.timestampOf(block))
    }
  })

  it('reuses cached anchors instead of re-requesting them', async () => {
    const cache = new MemoryCache()
    const first = reader()
    await new BlockTimeResolver(first, {
      exact: false,
      anchorSpacing: 5_000,
      batchSize: 10,
      cache,
    }).prime(0n, 40_000n)
    const second = reader()
    await new BlockTimeResolver(second, {
      exact: false,
      anchorSpacing: 5_000,
      batchSize: 10,
      cache,
    }).prime(0n, 40_000n)
    expect(second.batchCalls).toHaveLength(0)
  })

  it('retries a refused anchor singly rather than leaving a hole in the ladder', async () => {
    // A missing anchor silently widens the interpolation span, which moves
    // credits across a UTC midnight without anyone noticing.
    class PartialReader extends FakeChainReader {
      override async getBlockHeadersBatch(
        blocks: readonly bigint[],
      ): Promise<Array<BatchOutcome<{ number: bigint; hash: string; timestampUnix: number }>>> {
        const outcomes = await super.getBlockHeadersBatch(blocks)
        return outcomes.map((o, i) =>
          i === 2 ? { ok: false as const, error: 'busy', code: 0, reverted: false } : o,
        )
      }
    }
    const r = new PartialReader({ chainId: 4663, logs: LOGS, latestBlock: 40_000n })
    const resolver = new BlockTimeResolver(r, { exact: false, anchorSpacing: 5_000, batchSize: 10 })
    await resolver.prime(0n, 40_000n)
    expect(resolver.stats.knownBlocks).toBe(9)
  })
})

describe('scan progress', () => {
  it('reports blocks, percentage, credits and an ETA', async () => {
    const seen: ScanProgress[] = []
    let clock = 0
    await scanLogs(reader(), {
      ...SCAN,
      batchSize: 2,
      now: () => (clock += 1000),
      onScanProgress: (p) => seen.push(p),
    })
    expect(seen).toHaveLength(8)
    const last = seen[seen.length - 1]!
    expect(last.blocksDone).toBe(40_000)
    expect(last.blocksTotal).toBe(40_000)
    expect(last.logsTotal).toBe(LOGS.length)
    expect(last.chunksDone).toBe(8)
    const line = formatScanProgress(last, 'credits')
    expect(line).toContain('100.0%')
    expect(line).toContain('credits')
    expect(line).toContain('eta')
  })

  it('projects the ETA from THIS run only, not from resumed work', async () => {
    // A resumed scan that divided elapsed time by chunks a previous process
    // did would report a wildly optimistic finish.
    const opened = await CheckpointStore.open(dir, IDENTITY)
    let clock = 0
    await scanLogs(reader(), {
      ...SCAN,
      checkpoint: opened.store,
      batchSize: 4,
      now: () => (clock += 1000),
    })

    const resumedOpen = await CheckpointStore.open(dir, { ...IDENTITY, toBlock: 60_000n })
    const seen: ScanProgress[] = []
    let clock2 = 0
    await scanLogs(new FakeChainReader({ chainId: 4663, logs: LOGS, latestBlock: 60_000n }), {
      ...SCAN,
      toBlock: 60_000n,
      checkpoint: resumedOpen.store,
      batchSize: 4,
      now: () => (clock2 += 1000),
      onScanProgress: (p) => seen.push(p),
    })
    const first = seen[0]!
    expect(first.etaSeconds).not.toBeNull()
    expect(first.etaSeconds!).toBeGreaterThan(0)
  })

  it('formats durations for a run measured in hours', () => {
    expect(formatDuration(45)).toBe('45s')
    expect(formatDuration(125)).toBe('2m05s')
    expect(formatDuration(7_260)).toBe('2h01m')
    expect(formatDuration(Number.NaN)).toBe('--')
  })
})

// ---------------------------------------------------------------------------
// Regression: the resume path must never turn a read failure into zero logs.
// ---------------------------------------------------------------------------

/**
 * THE BUG THIS PINS. A 7-day merged scan of the live fee escrow checkpointed
 * 1,312,335 logs as 808 MB of NDJSON. `loadLogs()` read the whole file into one
 * string, which Node cannot do past MAX_STRING_LENGTH (536,870,888), so the read
 * threw - and a bare `catch { return [] }` turned that into "no logs".
 *
 * `scanLogs` then saw a checkpoint with every chunk complete, queued no work,
 * and returned the empty array as the scan result. escrow-index reported ZERO
 * CREDITS as a SUCCESS: a tidy table of zeros, from a complete and perfectly
 * good checkpoint. That is the unknown-becomes-zero failure the whole toolkit
 * refuses, reintroduced in the resume path, and it only bites at the scale where
 * checkpointing is the reason you turned it on.
 *
 * The 808 MB case cannot be reproduced in a unit test, so these pin the two
 * properties that actually failed: a short or inconsistent read must THROW, and
 * a multi-chunk streamed read must round-trip exactly.
 */
describe('loadLogs fails closed instead of reporting an empty scan', () => {
  it('round-trips every log through a STREAMED read, across stream chunk boundaries', async () => {
    const store = (await CheckpointStore.open(dir, IDENTITY)).store
    // Commit in several chunks so the file is written the way a real scan writes
    // it, and so lines straddle the 64KiB read-stream boundaries.
    for (let i = 0; i < LOGS.length; i += 50) {
      await store.commit(BigInt((i + 50) * 100), LOGS.slice(i, i + 50))
    }
    const reopened = (await CheckpointStore.open(dir, IDENTITY)).store
    const loaded = await reopened.loadLogs()
    expect(loaded).toHaveLength(LOGS.length)
    // Byte-identical, not merely the same length: a resumed scan has to produce
    // the same output as an uninterrupted one.
    expect(loaded.map(serializeLog)).toEqual(LOGS.map(serializeLog))
  })

  it('THROWS rather than returning [] when the committed logs cannot be read back', async () => {
    // The precise shape of the live failure: the state says 100 logs were
    // committed, and reading them back does not work. The old body caught that
    // and returned [], which the scanner then reported as a complete, empty
    // scan. ANY failure here must surface; the one thing it must never do is
    // come back empty and be believed.
    const store = (await CheckpointStore.open(dir, IDENTITY)).store
    await store.commit(10_000n, LOGS.slice(0, 100))
    const logsPath = join(dir, store.state.scanId, 'logs.ndjson')
    const size = (await readFile(logsPath)).length
    // Same byte length, unparseable content - so the byte accounting still
    // reconciles and only the deserialization can catch it.
    await writeFile(logsPath, 'x'.repeat(size), 'utf8')

    const reopened = (await CheckpointStore.open(dir, IDENTITY)).store
    await expect(reopened.loadLogs()).rejects.toThrow()
    // And emphatically not this:
    await expect(reopened.loadLogs()).rejects.not.toEqual([])
  })

  it('THROWS when the log count on disk disagrees with the state', async () => {
    const store = (await CheckpointStore.open(dir, IDENTITY)).store
    await store.commit(10_000n, LOGS.slice(0, 100))
    const statePath = join(dir, store.state.scanId, 'state.json')
    const raw = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>
    raw.logCount = 999
    await writeFile(statePath, stringifyJson(raw, 'string', 2), 'utf8')

    const reopened = (await CheckpointStore.open(dir, IDENTITY)).store
    await expect(reopened.loadLogs()).rejects.toThrow(/Refusing to resume from an inconsistent checkpoint/)
  })

  it('a completed checkpoint resumes to the FULL log set, never to an empty scan', async () => {
    // The end-to-end shape of the live failure: every chunk complete, so the
    // scanner queues no work and the checkpoint IS the entire result.
    const first = (await CheckpointStore.open(dir, IDENTITY)).store
    const complete = await scanLogs(reader(), { ...SCAN, checkpoint: first })
    expect(complete.length).toBeGreaterThan(0)

    const resumed = (await CheckpointStore.open(dir, IDENTITY)).store
    expect(resumed.completedThroughBlock).toBe(40_000n)
    const again = await scanLogs(reader(), { ...SCAN, checkpoint: resumed })
    expect(again).toHaveLength(complete.length)
    expect(again.map(serializeLog)).toEqual(complete.map(serializeLog))
  })
})
