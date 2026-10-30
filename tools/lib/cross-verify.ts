/**
 * Cross-endpoint integrity: does a SECOND chain-4663 node serve the same logs
 * and the same blocks as the one every measurement in this repo was taken from?
 *
 * Why this exists
 * ---------------
 * Every other integrity control in this project is INTERNAL. The merged scan is
 * reconciled against the native scan; streamed totals against declared totals;
 * sweep transactions against hook transactions. All of them would pass,
 * identically and silently, if the single RPC node were systematically dropping
 * logs. `escrow-index`'s own method limit says so in as many words:
 *
 *   "A node with a truncated log index, or one pruned below the requested
 *    range, produces a SHORT series that looks complete. Cross-check the first
 *    and last block of the window against a second endpoint before publishing."
 *
 * This module is the machinery for that cross-check, and for a wider sampled
 * one, so the October re-measurement runs it as a matter of course.
 *
 * What it can and cannot establish
 * --------------------------------
 * Agreement between two independent nodes is evidence against a defect specific
 * to ONE of them. It is not evidence against a defect COMMON to both - same
 * client, same indexing bug, same upstream sequencer feed. A zero-mismatch
 * sample bounds the disagreement rate; it never proves identity. Every function
 * that reports agreement here therefore returns the BOUND its sample size
 * actually supports (`agreementBound`), and the CLI prints the client versions
 * of both endpoints so the reader can judge how independent they really are.
 *
 * The one rule this module must never break: NOTHING here may read a cached
 * value. The scan cache in `logscan.ts` keys on (address, topics, range) and NOT
 * on the endpoint, so handing it a cache would serve the primary's own logs back
 * as the secondary's answer and turn the whole exercise into a tautology that
 * always passes. See `assertNoSharedCache`.
 */

import { hexToBytes, keccak256Bytes } from './keccak.ts'
import type { RawLog } from './rpc.ts'

// ---------------------------------------------------------------------------
// Deterministic sampling
//
// A sample nobody can reproduce is an anecdote. Everything below is driven by a
// seed and by explicit inputs; the CLI records the resolved plan in its artifact
// so the exact same windows can be re-fetched later.
// ---------------------------------------------------------------------------

/** FNV-1a. Turns a human-readable --seed into a 32-bit PRNG seed, stably. */
export function seedFromString(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * mulberry32. Small, fast, and - the only property that matters here -
 * identical on every machine and every Node version, unlike Math.random.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A contiguous span of blocks, inclusive at both ends. */
export interface BlockWindow {
  fromBlock: bigint
  toBlock: bigint
}

/**
 * One slice of the observation period that the sample must cover - in practice
 * one UTC day, so a defect confined to a single day cannot hide in a sample
 * that happened to draw all its windows from the other six.
 */
export interface Stratum {
  label: string
  fromBlock: bigint
  toBlock: bigint
  /**
   * Relative activity, e.g. measured logs per block. Drives how many windows
   * beyond the guaranteed floor this stratum gets. Non-negative.
   */
  weight: number
}

export type AllocationMode = 'uniform' | 'sqrt' | 'proportional'

export interface SampledWindow extends BlockWindow {
  stratum: string
  /** Index within the stratum's own draw, for stable ordering. */
  ordinal: number
}

export interface StratumAllocation {
  label: string
  fromBlock: bigint
  toBlock: bigint
  weight: number
  /** Windows that fit end-to-end inside this stratum. */
  capacityWindows: number
  windowsAllocated: number
  blocksCovered: number
  /** Blocks in the stratum. Coverage is blocksCovered / blocksInStratum. */
  blocksInStratum: number
}

export interface SamplePlan {
  seed: string
  seedNumeric: number
  windowBlocks: number
  allocation: AllocationMode
  minPerStratum: number
  requestedWindows: number
  windows: SampledWindow[]
  strata: StratumAllocation[]
  /** Non-fatal notes: a stratum too small for its floor, a shortfall, etc. */
  notes: string[]
}

/**
 * Largest-remainder (Hamilton) apportionment.
 *
 * Deterministic down to the tie-break, which is by index, so the same weights
 * always produce the same allocation. `capacities` caps each seat count at what
 * the stratum can physically hold.
 */
export function apportion(
  total: number,
  weights: readonly number[],
  options: { minPer?: number; capacities?: readonly number[] } = {},
): number[] {
  const n = weights.length
  if (n === 0) return []
  const minPer = Math.max(0, Math.floor(options.minPer ?? 0))
  const capacities = options.capacities ?? weights.map(() => Number.POSITIVE_INFINITY)

  const seats = weights.map((_, i) => Math.min(minPer, Math.floor(capacities[i] ?? 0)))
  let remaining = total - seats.reduce((a, b) => a + b, 0)
  if (remaining <= 0) return seats

  const headroom = (i: number): number => Math.max(0, (capacities[i] ?? 0) - seats[i]!)
  const eligible = (): number[] => seats.map((_, i) => i).filter((i) => headroom(i) > 0)

  // Weights that are all zero degrade to an even spread rather than to "give
  // everything to stratum 0", which would silently defeat the stratification.
  const positive = weights.some((w) => w > 0)
  const effective = positive ? weights.map((w) => Math.max(0, w)) : weights.map(() => 1)

  while (remaining > 0) {
    const pool = eligible()
    if (pool.length === 0) break
    const sum = pool.reduce((a, i) => a + effective[i]!, 0)
    if (sum <= 0) {
      // All remaining eligible strata have zero weight: distribute round-robin.
      for (const i of pool) {
        if (remaining === 0) break
        seats[i]!++
        remaining--
      }
      continue
    }
    const exact = pool.map((i) => ({ i, share: (effective[i]! / sum) * remaining }))
    const floors = exact.map((e) => ({ ...e, whole: Math.min(Math.floor(e.share), headroom(e.i)) }))
    let assigned = 0
    for (const f of floors) {
      seats[f.i]! += f.whole
      assigned += f.whole
    }
    remaining -= assigned
    if (assigned === 0) {
      // Every share was below 1: hand out the last few seats by remainder,
      // largest first, index ascending on a tie.
      const order = [...floors].sort((a, b) => b.share - a.share || a.i - b.i)
      for (const o of order) {
        if (remaining === 0) break
        if (headroom(o.i) === 0) continue
        seats[o.i]!++
        remaining--
      }
      if (remaining > 0 && eligible().length === 0) break
      if (order.every((o) => headroom(o.i) === 0)) break
    }
  }
  return seats
}

function weightFor(mode: AllocationMode, weight: number): number {
  if (mode === 'uniform') return 1
  if (mode === 'sqrt') return Math.sqrt(Math.max(0, weight))
  return Math.max(0, weight)
}

/**
 * Draw non-overlapping windows inside each stratum.
 *
 * Windows are aligned to a grid of `windowBlocks` inside the stratum and drawn
 * WITHOUT replacement, so two windows can never overlap and inflate the
 * apparent coverage. A partial trailing slot is dropped rather than shortened:
 * comparing windows of unequal length would make the per-window bound mean two
 * different things at once.
 */
export function planSampleWindows(options: {
  strata: readonly Stratum[]
  windowBlocks: number
  windowCount: number
  seed: string
  allocation?: AllocationMode
  minPerStratum?: number
}): SamplePlan {
  const { strata, windowBlocks, windowCount, seed } = options
  const allocation = options.allocation ?? 'sqrt'
  const minPerStratum = options.minPerStratum ?? 1
  const notes: string[] = []

  if (windowBlocks <= 0) throw new Error('windowBlocks must be positive')
  if (strata.length === 0) throw new Error('planSampleWindows needs at least one stratum')

  const span = BigInt(windowBlocks)
  const capacities = strata.map((s) => {
    const blocks = s.toBlock - s.fromBlock + 1n
    return blocks <= 0n ? 0 : Number(blocks / span)
  })
  for (const [i, capacity] of capacities.entries()) {
    if (capacity < minPerStratum) {
      notes.push(
        `stratum "${strata[i]!.label}" holds only ${capacity} whole ${windowBlocks}-block window(s); ` +
          `its floor of ${minPerStratum} was capped to ${capacity}.`,
      )
    }
  }

  const seedNumeric = seedFromString(seed)
  const allocated = apportion(
    windowCount,
    strata.map((s) => weightFor(allocation, s.weight)),
    { minPer: minPerStratum, capacities },
  )

  const windows: SampledWindow[] = []
  const stratumRows: StratumAllocation[] = []

  for (const [i, stratum] of strata.entries()) {
    const capacity = capacities[i]!
    const want = Math.min(allocated[i]!, capacity)
    // Each stratum gets its OWN PRNG stream, derived from the seed and the
    // stratum label. Otherwise adding a day would reshuffle every other day's
    // draw and a "reproducible" sample would silently stop being one.
    const rand = mulberry32((seedNumeric ^ seedFromString(stratum.label)) >>> 0)
    const chosen = sampleWithoutReplacement(capacity, want, rand)
    for (const [ordinal, slot] of chosen.entries()) {
      const from = stratum.fromBlock + BigInt(slot) * span
      windows.push({
        stratum: stratum.label,
        ordinal,
        fromBlock: from,
        toBlock: from + span - 1n,
      })
    }
    stratumRows.push({
      label: stratum.label,
      fromBlock: stratum.fromBlock,
      toBlock: stratum.toBlock,
      weight: stratum.weight,
      capacityWindows: capacity,
      windowsAllocated: chosen.length,
      blocksCovered: chosen.length * windowBlocks,
      blocksInStratum: Number(stratum.toBlock - stratum.fromBlock + 1n),
    })
  }

  const got = windows.length
  if (got < windowCount) {
    notes.push(
      `asked for ${windowCount} windows, could place ${got}: the strata do not hold more ` +
        `non-overlapping ${windowBlocks}-block windows at this floor.`,
    )
  }

  windows.sort((a, b) => (a.fromBlock === b.fromBlock ? 0 : a.fromBlock < b.fromBlock ? -1 : 1))

  return {
    seed,
    seedNumeric,
    windowBlocks,
    allocation,
    minPerStratum,
    requestedWindows: windowCount,
    windows,
    strata: stratumRows,
    notes,
  }
}

/** k distinct integers from [0, n), drawn with a partial Fisher-Yates. */
export function sampleWithoutReplacement(n: number, k: number, rand: () => number): number[] {
  const want = Math.max(0, Math.min(k, n))
  if (want === 0) return []
  const pool = new Map<number, number>()
  const at = (i: number): number => pool.get(i) ?? i
  const out: number[] = []
  for (let i = 0; i < want; i++) {
    const j = i + Math.floor(rand() * (n - i))
    out.push(at(j))
    pool.set(j, at(i))
  }
  return out.sort((a, b) => a - b)
}

/**
 * Cut a block range into per-day strata using UTC-midnight block boundaries,
 * clipped to the range. Boundaries are the ones `day-boundaries.json` records.
 */
export function strataFromDayBoundaries(
  boundaries: ReadonlyArray<{ iso: string; block: string | bigint }>,
  window: BlockWindow,
  weights: ReadonlyMap<string, number> = new Map(),
): Stratum[] {
  const points = boundaries
    .map((b) => ({ iso: b.iso, block: BigInt(b.block) }))
    .sort((a, b) => (a.block === b.block ? 0 : a.block < b.block ? -1 : 1))
  const out: Stratum[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]!
    const end = points[i + 1]!
    const from = start.block > window.fromBlock ? start.block : window.fromBlock
    const to = end.block - 1n < window.toBlock ? end.block - 1n : window.toBlock
    if (to < from) continue
    const label = start.iso.slice(0, 10)
    out.push({ label, fromBlock: from, toBlock: to, weight: weights.get(label) ?? 0 })
  }
  return out
}

// ---------------------------------------------------------------------------
// Log comparison
// ---------------------------------------------------------------------------

/**
 * The comparable identity of a log.
 *
 * The brief asks for (blockNumber, logIndex, topic0, data). This carries the
 * full topic array, the emitting address and the transaction hash as well,
 * because they cost nothing to compare and a node that agreed on topic0 while
 * disagreeing on topic1 - the indexed recipient, which is the entire per-coin
 * join - would otherwise pass.
 */
export interface LogTuple {
  blockNumber: bigint
  logIndex: number
  address: string
  topics: string[]
  data: string
  transactionHash: string
}

export function toLogTuple(log: RawLog): LogTuple {
  return {
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
    address: log.address.toLowerCase(),
    topics: log.topics.map((t) => t.toLowerCase()),
    data: (log.data ?? '0x').toLowerCase(),
    transactionHash: log.transactionHash.toLowerCase(),
  }
}

/** Position of a log in the chain. Unique within a block range. */
export function logTupleKey(tuple: Pick<LogTuple, 'blockNumber' | 'logIndex'>): string {
  return `${tuple.blockNumber.toString()}:${tuple.logIndex}`
}

/** Every compared field, flattened. Equal digests mean byte-identical logs. */
export function logTupleDigest(tuple: LogTuple): string {
  return [
    tuple.blockNumber.toString(),
    String(tuple.logIndex),
    tuple.address,
    tuple.topics.join(','),
    tuple.data,
    tuple.transactionHash,
  ].join('|')
}

export const COMPARED_LOG_FIELDS = [
  'address',
  'topics',
  'data',
  'transactionHash',
] as const
export type ComparedLogField = (typeof COMPARED_LOG_FIELDS)[number]

export interface LogFieldDivergence {
  key: string
  field: ComparedLogField
  primary: string
  secondary: string
}

export interface LogSetDiff {
  countPrimary: number
  countSecondary: number
  /** Positions present on both sides with every compared field equal. */
  matched: number
  /**
   * Full counts, NOT capped by `maxReported`.
   *
   * The tuple lists below are truncated so a catastrophic divergence does not
   * produce a gigabyte of JSON, but the counts drive the statistical bounds and
   * a truncated count would silently understate a defect. They are separate
   * fields for exactly that reason.
   */
  onlyInPrimaryCount: number
  onlyInSecondaryCount: number
  fieldDivergenceCount: number
  /** Logs involved in any divergence: present on one side only, or differing. */
  mismatchedLogCount: number
  /** Distinct block numbers touched by any divergence. */
  mismatchedBlockCount: number
  /** True when the two sides are byte-identical as SETS. */
  identical: boolean
  /**
   * True when the two arrays are identical IN THE ORDER GIVEN. Tracked
   * separately from `identical` because an ordering difference is a
   * serving-layer quirk and a content difference is a data defect; conflating
   * them would raise a false alarm on the first.
   *
   * NOTE for callers: this is only a statement about ENDPOINT serving order if
   * you pass the arrays as served. `scanLogs` sorts its result by
   * (blockNumber, logIndex) before returning, so a caller feeding it scanned
   * output is comparing two already-canonicalised sequences and this flag will
   * track `identical` rather than saying anything new. The CLI does exactly
   * that, and says so in its method limits.
   */
  orderIdentical: boolean
  onlyInPrimary: LogTuple[]
  onlyInSecondary: LogTuple[]
  fieldDivergences: LogFieldDivergence[]
  /** Lowest (block, logIndex) at which the two sides disagree at all. */
  firstDivergenceKey: string | null
  /** Positions seen twice on one side. A node should never do this. */
  duplicateKeysPrimary: string[]
  duplicateKeysSecondary: string[]
}

function sortTuples(tuples: readonly LogTuple[]): LogTuple[] {
  return [...tuples].sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  )
}

function indexByKey(tuples: readonly LogTuple[]): {
  map: Map<string, LogTuple>
  duplicates: string[]
} {
  const map = new Map<string, LogTuple>()
  const duplicates: string[] = []
  for (const tuple of tuples) {
    const key = logTupleKey(tuple)
    if (map.has(key)) duplicates.push(key)
    else map.set(key, tuple)
  }
  return { map, duplicates }
}

/**
 * Compare two servings of the same filter over the same block range.
 *
 * Both sides are compared as SETS keyed by (blockNumber, logIndex) - the only
 * identity the chain guarantees - and the as-served order is checked separately.
 * Divergences are reported precisely: which position, which field, both values.
 */
export function compareLogSets(
  primary: readonly RawLog[],
  secondary: readonly RawLog[],
  options: { maxReported?: number } = {},
): LogSetDiff {
  const cap = options.maxReported ?? 50
  const a = primary.map(toLogTuple)
  const b = secondary.map(toLogTuple)

  const { map: mapA, duplicates: dupA } = indexByKey(a)
  const { map: mapB, duplicates: dupB } = indexByKey(b)

  const onlyInPrimary: LogTuple[] = []
  const onlyInSecondary: LogTuple[] = []
  const fieldDivergences: LogFieldDivergence[] = []
  let matched = 0

  for (const [key, tupleA] of mapA) {
    const tupleB = mapB.get(key)
    if (tupleB === undefined) {
      onlyInPrimary.push(tupleA)
      continue
    }
    let equal = true
    if (tupleA.address !== tupleB.address) {
      equal = false
      fieldDivergences.push({
        key,
        field: 'address',
        primary: tupleA.address,
        secondary: tupleB.address,
      })
    }
    if (tupleA.topics.join(',') !== tupleB.topics.join(',')) {
      equal = false
      fieldDivergences.push({
        key,
        field: 'topics',
        primary: tupleA.topics.join(','),
        secondary: tupleB.topics.join(','),
      })
    }
    if (tupleA.data !== tupleB.data) {
      equal = false
      fieldDivergences.push({ key, field: 'data', primary: tupleA.data, secondary: tupleB.data })
    }
    if (tupleA.transactionHash !== tupleB.transactionHash) {
      equal = false
      fieldDivergences.push({
        key,
        field: 'transactionHash',
        primary: tupleA.transactionHash,
        secondary: tupleB.transactionHash,
      })
    }
    if (equal) matched++
  }
  for (const [key, tupleB] of mapB) {
    if (!mapA.has(key)) onlyInSecondary.push(tupleB)
  }

  const divergentKeys = [
    ...onlyInPrimary.map(logTupleKey),
    ...onlyInSecondary.map(logTupleKey),
    ...fieldDivergences.map((d) => d.key),
  ]
  let firstDivergenceKey: string | null = null
  for (const key of divergentKeys) {
    if (firstDivergenceKey === null || compareKeys(key, firstDivergenceKey) < 0) {
      firstDivergenceKey = key
    }
  }

  const identical =
    onlyInPrimary.length === 0 &&
    onlyInSecondary.length === 0 &&
    fieldDivergences.length === 0 &&
    dupA.length === 0 &&
    dupB.length === 0

  const orderIdentical =
    a.length === b.length && a.every((t, i) => logTupleDigest(t) === logTupleDigest(b[i]!))

  // A position that differs in three fields is ONE mismatched log, not three,
  // so divergent positions are de-duplicated before they are counted.
  const divergentPositions = new Set<string>(divergentKeys)
  const divergentBlocks = new Set<string>()
  for (const key of divergentPositions) divergentBlocks.add(key.split(':')[0] ?? key)

  return {
    countPrimary: primary.length,
    countSecondary: secondary.length,
    matched,
    onlyInPrimaryCount: onlyInPrimary.length,
    onlyInSecondaryCount: onlyInSecondary.length,
    fieldDivergenceCount: fieldDivergences.length,
    mismatchedLogCount: divergentPositions.size,
    mismatchedBlockCount: divergentBlocks.size,
    identical,
    orderIdentical,
    onlyInPrimary: sortTuples(onlyInPrimary).slice(0, cap),
    onlyInSecondary: sortTuples(onlyInSecondary).slice(0, cap),
    fieldDivergences: fieldDivergences.slice(0, cap),
    firstDivergenceKey,
    duplicateKeysPrimary: dupA.slice(0, cap),
    duplicateKeysSecondary: dupB.slice(0, cap),
  }
}

function compareKeys(a: string, b: string): number {
  const [ab, ai] = a.split(':')
  const [bb, bi] = b.split(':')
  const blockA = BigInt(ab ?? '0')
  const blockB = BigInt(bb ?? '0')
  if (blockA !== blockB) return blockA < blockB ? -1 : 1
  return Number(ai ?? 0) - Number(bi ?? 0)
}

// ---------------------------------------------------------------------------
// Block header comparison
// ---------------------------------------------------------------------------

/**
 * Header fields compared on the exhaustive first/last-block check.
 *
 * `receiptsRoot` and `logsBloom` are the load-bearing two and are the reason
 * this list is not just (hash, parentHash, timestamp). Both are cryptographic
 * commitments to the COMPLETE receipt set of the block, logs included. If two
 * nodes agree on the receiptsRoot of a block, they hold the same logs for that
 * block as a matter of arithmetic - so any getLogs disagreement between them
 * would have to be a defect in the query layer, not in the data. That is a much
 * sharper statement than "the hashes matched", and it is free.
 */
export const COMPARED_HEADER_FIELDS = [
  'number',
  'hash',
  'parentHash',
  'timestamp',
  'stateRoot',
  'transactionsRoot',
  'receiptsRoot',
  'logsBloom',
  'gasUsed',
] as const
export type ComparedHeaderField = (typeof COMPARED_HEADER_FIELDS)[number]

export type RawBlock = Record<string, unknown>

export interface HeaderFieldComparison {
  field: ComparedHeaderField
  primary: string | null
  secondary: string | null
  equal: boolean
}

export interface HeaderDiff {
  blockNumber: bigint
  identical: boolean
  /** Set when a side did not return the block at all - a pruned node, say. */
  missingPrimary: boolean
  missingSecondary: boolean
  fields: HeaderFieldComparison[]
  /** Transaction count, compared when both sides return the tx list. */
  transactionCountPrimary: number | null
  transactionCountSecondary: number | null
}

function headerField(block: RawBlock | null, field: ComparedHeaderField): string | null {
  if (block === null) return null
  const value = block[field]
  if (value === undefined || value === null) return null
  // Quantities are hex and may be zero-padded differently by different clients.
  // Normalising them means a cosmetic "0x0a" vs "0x0A" never reads as a defect,
  // while a real difference still does.
  const text = String(value).toLowerCase()
  if (field === 'number' || field === 'timestamp' || field === 'gasUsed') {
    try {
      return BigInt(text).toString()
    } catch {
      return text
    }
  }
  return text
}

export function compareHeaders(
  blockNumber: bigint,
  primary: RawBlock | null,
  secondary: RawBlock | null,
  fields: readonly ComparedHeaderField[] = COMPARED_HEADER_FIELDS,
): HeaderDiff {
  const rows: HeaderFieldComparison[] = fields.map((field) => {
    const a = headerField(primary, field)
    const b = headerField(secondary, field)
    // A field neither node reports is not a disagreement. A field only ONE node
    // reports is: it means the two are not answering the same question.
    const equal = a === b
    return { field, primary: a, secondary: b, equal }
  })
  const txs = (block: RawBlock | null): number | null =>
    block !== null && Array.isArray(block.transactions) ? block.transactions.length : null
  return {
    blockNumber,
    identical: primary !== null && secondary !== null && rows.every((r) => r.equal),
    missingPrimary: primary === null,
    missingSecondary: secondary === null,
    fields: rows,
    transactionCountPrimary: txs(primary),
    transactionCountSecondary: txs(secondary),
  }
}

// ---------------------------------------------------------------------------
// What a clean sample actually proves
//
// This section is the point of the exercise. A sample that finds zero
// mismatches DOES NOT prove the two endpoints agree; it bounds how far they
// could disagree and still have produced a clean sample. The bound depends
// entirely on the unit you assume the defect operates in, so all three are
// reported and none is allowed to stand alone.
// ---------------------------------------------------------------------------

function lnGamma(x: number): number {
  // Lanczos, g=7, n=9. Good to ~15 significant digits over the range used here.
  const g = 7
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ]
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x)
  const z = x - 1
  let a = c[0]!
  const t = z + g + 0.5
  for (let i = 1; i < g + 2; i++) a += c[i]! / (z + i)
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a)
}

function lnBinomialCoefficient(n: number, k: number): number {
  return lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1)
}

/** P(X <= k) for X ~ Binomial(n, p), computed in log space. */
export function binomialCdf(k: number, n: number, p: number): number {
  if (p <= 0) return 1
  if (p >= 1) return k >= n ? 1 : 0
  let total = 0
  const lnP = Math.log(p)
  const ln1mP = Math.log1p(-p)
  for (let i = 0; i <= k; i++) {
    total += Math.exp(lnBinomialCoefficient(n, i) + i * lnP + (n - i) * ln1mP)
  }
  return Math.min(1, total)
}

/**
 * Clopper-Pearson one-sided upper confidence bound on the failure rate.
 *
 * With zero failures this is the exact closed form `1 - alpha^(1/n)`, which at
 * 95% is the familiar rule of three, ~3/n. With failures it is found by
 * bisection on the binomial CDF. Exact rather than normal-approximate on
 * purpose: the normal approximation is worst exactly where this tool lives,
 * at k = 0.
 */
export function binomialUpperBound(trials: number, failures: number, confidence = 0.95): number {
  if (trials <= 0) return 1
  if (failures >= trials) return 1
  const alpha = 1 - confidence
  if (failures === 0) return 1 - Math.pow(alpha, 1 / trials)
  let lo = 0
  let hi = 1
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (binomialCdf(failures, trials, mid) > alpha) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

export interface AgreementBound {
  /** What one trial is: a window, a block, or a log. */
  unit: string
  trials: number
  mismatches: number
  confidence: number
  /** Upper bound on the per-unit disagreement rate. */
  upperBoundRate: number
  /** The same bound expressed against the whole population, when known. */
  populationSize: number | null
  impliedMaxAffected: number | null
  /** Fraction of the population actually compared. */
  coverage: number | null
}

export function agreementBound(options: {
  unit: string
  trials: number
  mismatches: number
  confidence?: number
  populationSize?: number | null
}): AgreementBound {
  const confidence = options.confidence ?? 0.95
  const rate = binomialUpperBound(options.trials, options.mismatches, confidence)
  const population = options.populationSize ?? null
  return {
    unit: options.unit,
    trials: options.trials,
    mismatches: options.mismatches,
    confidence,
    upperBoundRate: rate,
    populationSize: population,
    impliedMaxAffected: population === null ? null : Math.ceil(population * rate),
    coverage: population === null || population === 0 ? null : options.trials / population,
  }
}

/**
 * The honest reading of a clean sample, in prose, keyed to the failure mode.
 *
 * Three bounds are produced because there are three shapes a log defect can
 * take, and they are orders of magnitude apart:
 *
 *   - INDEPENDENT PER LOG (a hash-bucket collision, a race on insert). The
 *     log-level bound applies and is the tightest.
 *   - CLUSTERED BY RANGE (a re-sync gap, a corrupted index segment, a pruned
 *     span). Only the WINDOW-level bound applies, and it is much weaker - a
 *     defect confined to one 5,000-block stretch is invisible to a sample that
 *     did not draw that stretch.
 *   - COMMON TO BOTH NODES (same client, same bug). NO sample size detects
 *     this, at any coverage short of 100%, because both sides are wrong the
 *     same way. Only a second CLIENT IMPLEMENTATION addresses it.
 *
 * Quoting the log-level bound alone would be the same error as quoting a
 * feasibility ratio without its assumptions.
 */
export function interpretBounds(options: {
  perLog: AgreementBound
  perBlock: AgreementBound
  perWindow: AgreementBound
  /** Blocks per sampled window. Converts the window bound into blocks. */
  windowBlocks: number
  clientPrimary: string | null
  clientSecondary: string | null
}): string[] {
  const { perLog, perBlock, perWindow, windowBlocks } = options
  const pct = (x: number): string => `${(x * 100).toPrecision(3)}%`
  const lines: string[] = []
  const clean = perLog.mismatches === 0 && perBlock.mismatches === 0 && perWindow.mismatches === 0

  lines.push(
    clean
      ? `Zero mismatches over ${perLog.trials.toLocaleString()} logs across ${perBlock.trials.toLocaleString()} ` +
        `blocks in ${perWindow.trials} windows. This BOUNDS the disagreement rate; it does not prove the ` +
        `two endpoints are identical, and the three bounds below are orders of magnitude apart because ` +
        `they assume different SHAPES of defect.`
      : `${perLog.mismatches.toLocaleString()} log-level mismatch(es) over ${perLog.trials.toLocaleString()} logs, ` +
        `in ${perWindow.mismatches} of ${perWindow.trials} windows. The endpoints DISAGREE. Nothing measured ` +
        `from a single endpoint may be published until this is explained.`,
  )
  lines.push(
    `SHAPE 1, INDEPENDENT PER LOG (an insert race, a hash-bucket collision): at ${pct(perLog.confidence)} ` +
      `confidence at most ${pct(perLog.upperBoundRate)} of logs are affected` +
      (perLog.impliedMaxAffected !== null
        ? ` - up to ~${perLog.impliedMaxAffected.toLocaleString()} of the window's ~${perLog.populationSize!.toLocaleString()} logs (estimated).`
        : '.') +
      ' This is the TIGHTEST bound and the least likely shape.',
  )
  lines.push(
    `SHAPE 2, INDEPENDENT PER BLOCK (a block missed during indexing): at most ${pct(perBlock.upperBoundRate)} ` +
      `of blocks` +
      (perBlock.impliedMaxAffected !== null
        ? ` - up to ~${perBlock.impliedMaxAffected.toLocaleString()} of the window's ${perBlock.populationSize!.toLocaleString()} blocks.`
        : '.'),
  )
  // The clustered bound must be expressed in the unit it was MEASURED in -
  // whole sampled windows - and converted to blocks by multiplying by the
  // window size. Converting it via the per-block bound instead understates it
  // by the sampling ratio, which is the one arithmetic error that would make
  // this report say something materially false.
  const clusteredWindows = perWindow.impliedMaxAffected
  const clusteredBlocks = clusteredWindows === null ? null : clusteredWindows * windowBlocks
  lines.push(
    `SHAPE 3, CLUSTERED BY BLOCK RANGE (a re-sync gap, a corrupt index segment, a pruned span): a ` +
      `contiguous defect is only detectable if the sample happened to DRAW it, so the bound is the ` +
      `window one and it is far weaker - at most ${pct(perWindow.upperBoundRate)} of ` +
      `${perWindow.populationSize !== null ? perWindow.populationSize.toLocaleString() : 'the'} ` +
      `${windowBlocks.toLocaleString()}-block slots in the period` +
      (clusteredBlocks === null
        ? '.'
        : `, i.e. a defect spanning as much as ~${clusteredBlocks.toLocaleString()} blocks could still have escaped this sample.`) +
      ' THIS IS THE BOUND TO QUOTE. The other two are strictly more optimistic assumptions about a ' +
      'defect nobody has characterised.',
  )
  const sameClient =
    options.clientPrimary !== null &&
    options.clientSecondary !== null &&
    clientFamily(options.clientPrimary) === clientFamily(options.clientSecondary)
  lines.push(
    sameClient
      ? `Both endpoints run the SAME CLIENT FAMILY (${clientFamily(options.clientPrimary!)}: ` +
        `primary "${options.clientPrimary!}", secondary "${options.clientSecondary!}"). A defect in that client's ` +
        `log index is COMMON MODE: it would be present on both sides and NO sample size here can detect it. ` +
        `This residual is not reduced by sampling more; it is reduced only by a second client implementation.`
      : `Endpoints report different client families (primary "${options.clientPrimary ?? 'unknown'}", ` +
        `secondary "${options.clientSecondary ?? 'unknown'}"), which is the strongest form of this check.`,
  )
  return lines
}

/** "nitro/v3.11.4-rc.3-.../linux-arm64/go1.25.14" -> "nitro". */
export function clientFamily(version: string): string {
  const head = version.split('/')[0] ?? version
  return head.replace(/[-_]?v?\d.*$/, '').toLowerCase() || head.toLowerCase()
}

/** The build identity of a version string, with the platform tuple dropped. */
export function clientBuild(version: string): string {
  const parts = version.split('/')
  if (parts.length < 2) return version
  return `${parts[0]}/${parts[1]}`
}

export interface FleetSummary {
  /** Every distinct version string observed, sorted. */
  versions: string[]
  /** Distinct client families across the pool. */
  families: string[]
  /** Distinct name/version builds, ignoring the platform tuple. */
  builds: string[]
  samples: number
  /** More than one machine answered - the host is a load-balanced pool. */
  heterogeneous: boolean
  /** The pool differs only by platform: same build, different arch/OS. */
  sameBuildDifferentPlatform: boolean
}

/**
 * What a repeated web3_clientVersion probe reveals about ONE hostname.
 *
 * A single probe is a single draw from whatever sits behind the load balancer,
 * and reporting it as "the endpoint's version" overstates what was learned.
 * The measured reality on chain 4663 is that the primary hostname fronts a
 * POOL: the same nitro build on both linux-amd64 and linux-arm64. That matters
 * in two opposite directions and the caller is expected to say both:
 *
 *   - It WEAKENS the "single node" worry. A defect confined to one machine
 *     would corrupt only the fraction of requests routed to it, and would show
 *     up as self-inconsistency across a long scan rather than a clean short
 *     series.
 *   - It does NOT weaken the common-mode worry at all when the pool runs one
 *     build. Different silicon running identical code fails identically.
 */
export function summarizeFleet(observed: readonly string[]): FleetSummary {
  const clean = observed.filter((v): v is string => typeof v === 'string' && v.length > 0)
  const versions = [...new Set(clean)].sort()
  const families = [...new Set(versions.map(clientFamily))].sort()
  const builds = [...new Set(versions.map(clientBuild))].sort()
  return {
    versions,
    families,
    builds,
    samples: clean.length,
    heterogeneous: versions.length > 1,
    sameBuildDifferentPlatform: versions.length > 1 && builds.length === 1,
  }
}

/**
 * The residual-risk sentence a fleet observation earns, or none.
 *
 * Returns null when a single probe saw a single version: that is the absence of
 * evidence for a pool, not evidence of a single node, and inventing a sentence
 * about it would be worse than silence.
 */
export function describeFleet(label: string, host: string, fleet: FleetSummary): string | null {
  if (!fleet.heterogeneous) return null
  const list = fleet.versions.map((v) => `"${v}"`).join(', ')
  if (fleet.sameBuildDifferentPlatform) {
    return (
      `THE ${label.toUpperCase()} HOSTNAME (${host}) IS A LOAD-BALANCED POOL, NOT ONE NODE. ` +
      `${fleet.samples} probes drew ${fleet.versions.length} distinct builds: ${list}. They differ only ` +
      `by platform - the build is identical (${fleet.builds[0]}). This cuts both ways and both halves ` +
      'matter: a defect confined to ONE machine would affect only the share of requests routed to it ' +
      'and would surface as self-inconsistency across a long scan, so the "single node" framing ' +
      'overstates that risk; but identical code on different silicon fails identically, so pool ' +
      'breadth buys NOTHING against a defect in the build itself.'
    )
  }
  return (
    `THE ${label.toUpperCase()} HOSTNAME (${host}) IS A LOAD-BALANCED POOL, NOT ONE NODE. ` +
    `${fleet.samples} probes drew ${fleet.versions.length} distinct versions: ${list}. Requests in any ` +
    'scan were therefore spread across several machines, and a version reported as "the endpoint\'s" ' +
    'is one draw from that pool.'
  )
}

// ---------------------------------------------------------------------------
// logsBloom verification - the ONLY control here that reaches common mode
//
// Everything else in this module compares one node against another, and so is
// blind by construction to a defect both share. A block's `logsBloom` is
// different in kind: it is committed inside the block hash, which comes from
// consensus. Recomputing the bloom from the logs a node SERVES and comparing it
// to the header therefore tests that node's log set against the CHAIN's own
// commitment, with no second node involved.
//
// It is a superset filter, so it bounds rather than proves, and its power
// depends entirely on the SHAPE of the omission. Measured on chain 4663
// (blocks 50419076, 55532250, 56389048; 85-188 logs each):
//
//   one random log dropped .............. 22.9% - 34.1% caught   (WEAK)
//   a contiguous run of 5 dropped ....... 70.1% - 88.2% caught
//   every log of one contract dropped ... caught in every case tested
//
// The weak figure is the one to quote if the feared defect is a lone lost log;
// the strong ones apply to the defect this project actually fears, a log index
// systematically short for a contract or a range. Bits set by a dropped log are
// often set again by a surviving one, and that redundancy - hence the miss rate
// - RISES with the number of logs in the block.
// ---------------------------------------------------------------------------

/** A 2048-bit filter as 256 bytes. */
export type Bloom = Uint8Array

/**
 * Fold one item (an address or a topic) into a bloom, per the yellow paper's
 * M3:2048 - the low 11 bits of each of the first three byte-pairs of its
 * keccak256 select three bits of the 2048.
 */
export function addToBloom(bloom: Bloom, itemHex: string): void {
  const hash = keccak256Bytes(hexToBytes(itemHex))
  for (let i = 0; i < 3; i++) {
    const bit = (((hash[i * 2] ?? 0) << 8) | (hash[i * 2 + 1] ?? 0)) & 0x7ff
    // Bit 0 is the most significant bit of the LAST byte of the filter.
    const byteIndex = 255 - (bit >> 3)
    bloom[byteIndex] = (bloom[byteIndex] ?? 0) | (1 << (bit & 7))
  }
}

/**
 * The bloom implied by a set of logs.
 *
 * The caller must pass EVERY log in the block, from every contract: a header's
 * bloom covers the whole block, so a contract-filtered set will never reproduce
 * it and comparing one to the header is a guaranteed false alarm.
 */
export function bloomFromLogs(logs: readonly Pick<RawLog, 'address' | 'topics'>[]): string {
  const bloom = new Uint8Array(256)
  for (const log of logs) {
    addToBloom(bloom, log.address)
    for (const topic of log.topics) addToBloom(bloom, topic)
  }
  return `0x${Buffer.from(bloom).toString('hex')}`
}

export interface BloomCheck {
  blockNumber: string
  /** Logs the node served for this block, across all contracts. */
  logCount: number
  headerBloom: string | null
  computedBloom: string
  /** The served logs reproduce the consensus-committed bloom. */
  matches: boolean
  /** Set when the header could not be read; `matches` is then false, never true. */
  error?: string
}

/**
 * Check a node's served logs for one block against that block's header bloom.
 *
 * A missing header is reported as a FAILED check rather than a passing one:
 * this function must never return `matches: true` for a block it could not
 * actually verify.
 */
export function checkBlockBloom(
  blockNumber: bigint,
  headerBloom: string | null | undefined,
  allLogsInBlock: readonly Pick<RawLog, 'address' | 'topics'>[],
): BloomCheck {
  const computed = bloomFromLogs(allLogsInBlock)
  if (typeof headerBloom !== 'string' || headerBloom.length === 0) {
    return {
      blockNumber: blockNumber.toString(),
      logCount: allLogsInBlock.length,
      headerBloom: null,
      computedBloom: computed,
      matches: false,
      error: 'header carried no logsBloom, so the served logs could not be verified against consensus',
    }
  }
  return {
    blockNumber: blockNumber.toString(),
    logCount: allLogsInBlock.length,
    headerBloom: headerBloom.toLowerCase(),
    computedBloom: computed,
    matches: headerBloom.toLowerCase() === computed.toLowerCase(),
  }
}

/** The honest reading of a set of bloom checks. */
export function summarizeBloomChecks(checks: readonly BloomCheck[]): {
  checked: number
  matched: number
  failed: number
  notes: string[]
} {
  const checked = checks.length
  const matched = checks.filter((c) => c.matches).length
  const failed = checked - matched
  const notes: string[] = []
  if (checked === 0) return { checked, matched, failed, notes }
  if (failed > 0) {
    notes.push(
      `${failed} of ${checked} block(s) served a log set that does NOT reproduce the block's own ` +
        'consensus-committed logsBloom. That is a defect in the served logs of THAT endpoint, ' +
        'independent of any second node, and it should be treated as disqualifying until explained.',
    )
  } else {
    notes.push(
      `All ${checked} block(s) served a log set that reproduces the block's own consensus-committed ` +
        'logsBloom. Unlike every two-node comparison here, this holds against a COMMON-MODE defect: ' +
        'the bloom comes from the header, not from another node.',
    )
  }
  notes.push(
    'A bloom is a superset filter, so it BOUNDS completeness rather than proving it, and its power ' +
      'depends on the shape of an omission. Measured on chain 4663: one dropped log is caught only ' +
      '22.9%-34.1% of the time, a dropped run of five 70.1%-88.2%, and every log of a single contract ' +
      'in every case tested. Quote the weak figure for a lone lost log and the strong ones for a ' +
      'systematically short index.',
  )
  return { checked, matched, failed, notes }
}

// ---------------------------------------------------------------------------
// Guardrail
// ---------------------------------------------------------------------------

/**
 * The scan cache keys on (address, topics, fromBlock, toBlock) and NOT on the
 * endpoint that answered. Sharing it across two endpoints would serve the
 * primary's logs as the secondary's answer, and the cross-check would pass
 * unconditionally - the exact failure this whole module exists to detect,
 * reproduced inside the detector.
 *
 * Called by the CLI on every scan option object it builds.
 */
export function assertNoSharedCache<T extends object>(options: T): T {
  if ((options as { cache?: unknown }).cache !== undefined) {
    throw new Error(
      'cross-verify refuses a scan cache: logscan cache keys omit the endpoint, so a cached ' +
        'primary result would be returned as the secondary answer and the comparison would ' +
        'always pass. Every fetch here must go to the wire.',
    )
  }
  return options
}

/**
 * Split a window into sub-chunks the secondary can actually serve.
 *
 * The secondary measured here answers 2,000-block escrow spans and refuses
 * 5,000 with a -32005 "network is busy" that is a query-time budget, not a
 * result cap. The tiling must be exact - no gap, no overlap - or the merged
 * result would be compared against a range it does not cover.
 */
export function tileWindow(window: BlockWindow, chunkBlocks: number): BlockWindow[] {
  if (chunkBlocks <= 0) throw new Error('chunkBlocks must be positive')
  const span = BigInt(chunkBlocks)
  const out: BlockWindow[] = []
  for (let from = window.fromBlock; from <= window.toBlock; from += span) {
    const to = from + span - 1n
    out.push({ fromBlock: from, toBlock: to > window.toBlock ? window.toBlock : to })
  }
  return out
}

/**
 * The head and tail regions the method limit asks to check exhaustively.
 *
 * Returns one region when the window is short enough that head and tail meet or
 * overlap - counting the same blocks twice would report agreement it did not
 * independently observe, and on a narrow window that is exactly what would
 * happen.
 */
export function boundaryRegions(
  window: BlockWindow,
  boundaryBlocks: number,
): Array<{ region: 'head' | 'tail'; window: BlockWindow }> {
  if (boundaryBlocks <= 0) return []
  const span = BigInt(boundaryBlocks)
  const total = window.toBlock - window.fromBlock + 1n
  if (total <= 0n) return []
  if (total <= span * 2n) {
    // Head and tail would meet or overlap: report the whole window once.
    return [{ region: 'head', window: { ...window } }]
  }
  return [
    { region: 'head', window: { fromBlock: window.fromBlock, toBlock: window.fromBlock + span - 1n } },
    { region: 'tail', window: { fromBlock: window.toBlock - span + 1n, toBlock: window.toBlock } },
  ]
}

/** Every block in the head and tail regions, de-duplicated and ascending. */
export function boundaryBlockList(window: BlockWindow, boundaryBlocks: number): bigint[] {
  const seen = new Set<string>()
  const out: bigint[] = []
  for (const { window: region } of boundaryRegions(window, boundaryBlocks)) {
    for (let b = region.fromBlock; b <= region.toBlock; b++) {
      const key = b.toString()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(b)
    }
  }
  return out.sort((a, b) => (a === b ? 0 : a < b ? -1 : 1))
}

/** Total blocks in a set of windows. Overlaps are NOT deduplicated; callers draw without replacement. */
export function totalBlocks(windows: readonly BlockWindow[]): number {
  return windows.reduce((sum, w) => sum + Number(w.toBlock - w.fromBlock + 1n), 0)
}
