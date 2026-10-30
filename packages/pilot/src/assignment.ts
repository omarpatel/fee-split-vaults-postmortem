/**
 * Seeded-hash treatment assignment with real balancing.
 *
 * A bare PRNG would leave the design open to the two objections that kill an
 * observational marketing claim: an accidental correlation between coverage and
 * hour-of-day (crypto flow is violently diurnal), and an unverifiable draw. So
 * the arm of every block is a pure function of published inputs, and the split
 * is EXACT within coin and within hour-of-day rather than merely expected.
 *
 * THE UNIT OF THE DRAW IS THE DAY, NOT THE BLOCK. Each randomized day is a
 * matched pair of 12-hour blocks and exactly one of them is staffed; the draw
 * decides which. Three properties follow by construction rather than by luck:
 *
 *   - the desk is never away for more than 24 consecutive hours, because every
 *     day contains a staffed block. Rejection sampling cannot deliver this: at
 *     a 50% unstaffed rate a free block-level draw produces a 36-hour absence
 *     somewhere in 30 days almost every time.
 *   - hour-of-day is balanced EXACTLY, because balancing which half of the day
 *     is staffed is the same thing as balancing hour-of-day.
 *   - the pair also absorbs day-level shocks, which are the largest nuisance in
 *     this data after the coin's own decay curve.
 *
 * Balancing mechanism: within each day-of-week cell the days are ranked by draw
 * key and the lower half staffs its first block. An odd cell hands its
 * median-ranked day up as a PIVOT, and the pivots are ranked and halved at the
 * level above. The split is therefore exact at the coin level and off by at
 * most one inside any single day-of-week cell.
 */

import { drawKey, hashObject, keyRank } from './hash.js'
import type {
  AssignmentBalance,
  BlockAssignment,
  CoinAssignment,
  PilotAssignment,
  PilotCoin,
  PilotConfig,
  StratumBalance,
} from './types.js'

const SECONDS_PER_HOUR = 3_600
const SECONDS_PER_DAY = 86_400
const BLOCKS_PER_DAY = 2

export class PilotConfigError extends Error {
  constructor(message: string) {
    super(`pilot config: ${message}`)
    this.name = 'PilotConfigError'
  }
}

export class AssignmentError extends Error {
  constructor(message: string) {
    super(`pilot assignment: ${message}`)
    this.name = 'AssignmentError'
  }
}

/** The registered Section 9 design. */
export const DEFAULT_PILOT_CONFIG: Omit<PilotConfig, 'pilotId' | 'seed' | 'startUnix'> = {
  totalDays: 60,
  blockHours: 12,
  randomizedDays: 30,
  maxConsecutiveUnstaffedBlocks: 2,
  maxDrawAttempts: 8,
  takeBps: 0,
  budgetBps: 0,
  requiresVault: false,
  requiresContract: false,
}

export function makePilotConfig(
  pilotId: string,
  seed: string,
  startUnix: number,
  overrides: Partial<
    Omit<PilotConfig, 'takeBps' | 'budgetBps' | 'requiresVault' | 'requiresContract'>
  > = {},
): PilotConfig {
  const config: PilotConfig = {
    ...DEFAULT_PILOT_CONFIG,
    ...overrides,
    pilotId,
    seed,
    startUnix,
    takeBps: 0,
    budgetBps: 0,
    requiresVault: false,
    requiresContract: false,
  }
  validatePilotConfig(config)
  return config
}

/** Fail closed on anything that would make the design unbalanceable or unfree. */
export function validatePilotConfig(config: PilotConfig): void {
  if (!config.pilotId || !config.seed) {
    throw new PilotConfigError('pilotId and seed are required and are published inputs')
  }
  if (!Number.isInteger(config.startUnix) || config.startUnix <= 0) {
    throw new PilotConfigError('startUnix must be a positive integer unix timestamp')
  }
  if (config.blockHours !== 24 / BLOCKS_PER_DAY) {
    throw new PilotConfigError(
      'the balanced within-day pairing is defined for two 12-hour blocks per day; another block length must re-derive the balancing before it is used',
    )
  }
  if (config.startUnix % SECONDS_PER_DAY !== 0) {
    throw new PilotConfigError('startUnix must be UTC midnight so day pairs and hour-of-day align')
  }
  if (!Number.isInteger(config.totalDays) || config.totalDays <= 0) {
    throw new PilotConfigError('totalDays must be a positive integer')
  }
  if (!Number.isInteger(config.randomizedDays) || config.randomizedDays <= 0) {
    throw new PilotConfigError('randomizedDays must be a positive integer')
  }
  if (config.randomizedDays % 2 !== 0) {
    throw new PilotConfigError(
      'randomizedDays must be even so that hour-of-day splits exactly rather than approximately',
    )
  }
  if (config.randomizedDays * 2 > config.totalDays) {
    throw new PilotConfigError(
      'the randomized phase may not exceed the first half of the pilot: every coin receives full coverage for the second half',
    )
  }
  if (config.maxConsecutiveUnstaffedBlocks < 2) {
    throw new PilotConfigError(
      'the within-day pairing produces a two-block absence across a midnight boundary; a cap below 2 is unsatisfiable',
    )
  }
  if (config.maxConsecutiveUnstaffedBlocks * config.blockHours > 24) {
    throw new PilotConfigError('the desk may never be away for more than 24 consecutive hours')
  }
  if (!Number.isInteger(config.maxDrawAttempts) || config.maxDrawAttempts < 1) {
    throw new PilotConfigError('maxDrawAttempts must be a positive integer')
  }
  // Redundant with the literal types, but a config can arrive over a wire.
  if (config.takeBps !== 0 || config.budgetBps !== 0) {
    throw new PilotConfigError('the pilot is free: takeBps and budgetBps must be zero')
  }
  if (config.requiresVault !== false || config.requiresContract !== false) {
    throw new PilotConfigError(
      'the pilot deploys no vault and signs no contract beyond a one-page agreement',
    )
  }
}

interface Rankable {
  id: number
  rank: bigint
  tieBreak: number
}

interface HalveResult<T extends Rankable> {
  lower: Set<number>
  pivot: T | null
}

function byRank(a: Rankable, b: Rankable): number {
  if (a.rank < b.rank) return -1
  if (a.rank > b.rank) return 1
  // Ties on 64 bits are astronomically unlikely; resolved anyway so nothing
  // depends on sort stability.
  return a.tieBreak - b.tieBreak
}

/** Rank, take the lower half, hand the median item up as a pivot if odd. */
function halveByRank<T extends Rankable>(items: readonly T[]): HalveResult<T> {
  const sorted = [...items].sort(byRank)
  const half = Math.floor(sorted.length / 2)
  const lower = new Set<number>()
  for (let i = 0; i < half; i += 1) lower.add(sorted[i]!.id)
  return { lower, pivot: sorted.length % 2 === 1 ? sorted[half]! : null }
}

/**
 * Cascade the halving down a list of stratum keys, resolving each level's odd
 * leftovers at the level above. Exactness is inherited: a level whose item
 * count is even splits exactly, whatever its children did.
 */
function cascadeHalve<T extends Rankable>(
  items: readonly T[],
  keys: ReadonlyArray<(item: T) => string>,
): HalveResult<T> {
  if (keys.length === 0) return halveByRank(items)

  const head = keys[0]!
  const rest = keys.slice(1)
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = head(item)
    const bucket = groups.get(key)
    if (bucket) bucket.push(item)
    else groups.set(key, [item])
  }

  const lower = new Set<number>()
  const pivots: T[] = []
  // Deterministic group order: the stratum key, never insertion order.
  for (const key of [...groups.keys()].sort()) {
    const result = cascadeHalve(groups.get(key)!, rest)
    for (const id of result.lower) lower.add(id)
    if (result.pivot) pivots.push(result.pivot)
  }

  const resolved = halveByRank(pivots)
  for (const id of resolved.lower) lower.add(id)
  return { lower, pivot: resolved.pivot }
}

interface DraftDay extends Rankable {
  /** Day index from the pilot start. */
  id: number
  startUnix: number
  dayOfWeek: number
  key: string
}

function buildDays(config: PilotConfig, coinRef: string, nonce: number): DraftDay[] {
  const days: DraftDay[] = []
  for (let d = 0; d < config.randomizedDays; d += 1) {
    const startUnix = config.startUnix + d * SECONDS_PER_DAY
    const key = drawKey(config.seed, config.pilotId, coinRef, nonce, startUnix)
    days.push({
      id: d,
      startUnix,
      dayOfWeek: new Date(startUnix * 1_000).getUTCDay(),
      key,
      rank: keyRank(key),
      tieBreak: startUnix,
    })
  }
  return days
}

function maxConsecutiveUnstaffed(blocks: readonly BlockAssignment[]): number {
  let best = 0
  let run = 0
  for (const block of blocks) {
    if (block.arm === 'UNSTAFFED') {
      run += 1
      if (run > best) best = run
    } else {
      run = 0
    }
  }
  return best
}

function summarize(blocks: readonly BlockAssignment[]): AssignmentBalance {
  const randomized = blocks.filter((b) => b.phase === 'RANDOMIZED')
  const hourBuckets = new Map<number, { staffed: number; unstaffed: number }>()
  const cellBuckets = new Map<string, StratumBalance>()

  for (const block of randomized) {
    const hour = hourBuckets.get(block.hourOfDay) ?? { staffed: 0, unstaffed: 0 }
    if (block.arm === 'STAFFED') hour.staffed += 1
    else hour.unstaffed += 1
    hourBuckets.set(block.hourOfDay, hour)

    const cellKey = `${block.dayOfWeek}:${block.hourOfDay}`
    const cell = cellBuckets.get(cellKey) ?? {
      dayOfWeek: block.dayOfWeek,
      hourOfDay: block.hourOfDay,
      staffed: 0,
      unstaffed: 0,
    }
    if (block.arm === 'STAFFED') cell.staffed += 1
    else cell.unstaffed += 1
    cellBuckets.set(cellKey, cell)
  }

  return {
    randomizedBlocks: randomized.length,
    staffedRandomized: randomized.filter((b) => b.arm === 'STAFFED').length,
    unstaffedRandomized: randomized.filter((b) => b.arm === 'UNSTAFFED').length,
    byHourOfDay: [...hourBuckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([hourOfDay, counts]) => ({ hourOfDay, ...counts })),
    byHourAndDay: [...cellBuckets.values()].sort(
      (a, b) => a.dayOfWeek - b.dayOfWeek || a.hourOfDay - b.hourOfDay,
    ),
    maxConsecutiveUnstaffed: maxConsecutiveUnstaffed(randomized),
    fullCoverageBlocks: blocks.filter((b) => b.phase === 'FULL_COVERAGE').length,
  }
}

function buildBlocks(
  config: PilotConfig,
  coinRef: string,
  nonce: number,
  firstBlockStaffedDays: ReadonlySet<number>,
): BlockAssignment[] {
  const blockSeconds = config.blockHours * SECONDS_PER_HOUR
  const totalBlocks = config.totalDays * BLOCKS_PER_DAY
  const randomizedBlocks = config.randomizedDays * BLOCKS_PER_DAY
  const blocks: BlockAssignment[] = []

  for (let i = 0; i < totalBlocks; i += 1) {
    const startUnix = config.startUnix + i * blockSeconds
    const date = new Date(startUnix * 1_000)
    const dayIndex = Math.floor(i / BLOCKS_PER_DAY)
    const slot = i % BLOCKS_PER_DAY
    const randomized = i < randomizedBlocks
    const staffed = randomized
      ? firstBlockStaffedDays.has(dayIndex)
        ? slot === 0
        : slot === 1
      : true

    blocks.push({
      coinRef,
      blockIndex: i,
      startUnix,
      endUnixExclusive: startUnix + blockSeconds,
      hourOfDay: date.getUTCHours(),
      dayOfWeek: date.getUTCDay(),
      phase: randomized ? 'RANDOMIZED' : 'FULL_COVERAGE',
      arm: staffed ? 'STAFFED' : 'UNSTAFFED',
      drawKey: drawKey(config.seed, config.pilotId, coinRef, nonce, dayIndex * SECONDS_PER_DAY + config.startUnix),
    })
  }
  return blocks
}

/**
 * Assign one coin.
 *
 * The nonce loop is a safety net, not a search: the construction satisfies the
 * absence cap by itself, so nonce 0 is always accepted unless someone changes
 * the construction. If it ever advances, the accepted nonce is published with
 * the assignment and the draw stays reproducible.
 */
export function assignCoin(config: PilotConfig, coin: PilotCoin): CoinAssignment {
  validatePilotConfig(config)

  for (let nonce = 0; nonce < config.maxDrawAttempts; nonce += 1) {
    const days = buildDays(config, coin.coinRef, nonce)
    const { lower, pivot } = cascadeHalve(days, [(d) => String(d.dayOfWeek)])
    if (pivot !== null) {
      throw new AssignmentError('an unresolved pivot survived the cascade; day count is not even')
    }

    const blocks = buildBlocks(config, coin.coinRef, nonce, lower)
    const balance = summarize(blocks)
    if (balance.maxConsecutiveUnstaffed <= config.maxConsecutiveUnstaffedBlocks) {
      assertEthicalCoverage(config, blocks, balance)
      return { coinRef: coin.coinRef, drawNonce: nonce, blocks, balance }
    }
  }

  throw new AssignmentError(
    `no draw within ${config.maxDrawAttempts} attempts satisfied the maximum-absence constraint for ${coin.coinRef}`,
  )
}

/**
 * The ethics and balance invariants, asserted at generation time rather than
 * reviewed at write-up time: we randomize WHEN a free service is provided,
 * never WHETHER.
 */
export function assertEthicalCoverage(
  config: PilotConfig,
  blocks: readonly BlockAssignment[],
  balance: AssignmentBalance,
): void {
  const randomizedBlocks = config.randomizedDays * BLOCKS_PER_DAY
  const totalBlocks = config.totalDays * BLOCKS_PER_DAY

  for (const block of blocks) {
    if (block.blockIndex >= randomizedBlocks && block.arm !== 'STAFFED') {
      throw new AssignmentError(
        `block ${block.blockIndex} falls outside the randomized phase and must be STAFFED`,
      )
    }
  }
  if (balance.fullCoverageBlocks !== totalBlocks - randomizedBlocks) {
    throw new AssignmentError('full-coverage block count does not cover the remainder of the pilot')
  }
  if (balance.fullCoverageBlocks < randomizedBlocks) {
    throw new AssignmentError(
      'the full-coverage phase must be at least as long as the randomized phase',
    )
  }
  if (balance.staffedRandomized !== balance.unstaffedRandomized) {
    throw new AssignmentError(
      `within-coin split is not exact: ${balance.staffedRandomized} staffed vs ${balance.unstaffedRandomized} unstaffed`,
    )
  }
  for (const hour of balance.byHourOfDay) {
    if (hour.staffed !== hour.unstaffed) {
      throw new AssignmentError(
        `hour-of-day ${hour.hourOfDay} is not balanced: ${hour.staffed} staffed vs ${hour.unstaffed} unstaffed`,
      )
    }
  }
  for (const cell of balance.byHourAndDay) {
    if (Math.abs(cell.staffed - cell.unstaffed) > 1) {
      throw new AssignmentError(
        `day-of-week ${cell.dayOfWeek} hour ${cell.hourOfDay} is off by more than one`,
      )
    }
  }
  if (balance.maxConsecutiveUnstaffed > config.maxConsecutiveUnstaffedBlocks) {
    throw new AssignmentError('the desk would be away for longer than the configured maximum')
  }
}

export function generateAssignment(
  config: PilotConfig,
  coins: readonly PilotCoin[],
  generatedAtUnix: number,
): PilotAssignment {
  validatePilotConfig(config)
  if (coins.length === 0) throw new AssignmentError('no coins enrolled')

  const seen = new Set<string>()
  for (const coin of coins) {
    if (seen.has(coin.coinRef)) throw new AssignmentError(`duplicate coinRef ${coin.coinRef}`)
    seen.add(coin.coinRef)
  }

  const assigned = coins
    .map((coin) => assignCoin(config, coin))
    .sort((a, b) => (a.coinRef < b.coinRef ? -1 : a.coinRef > b.coinRef ? 1 : 0))

  const configHash = hashObject(config)
  const assignmentHash = hashObject({
    v: 'vault-pilot-assignment/v1',
    pilotId: config.pilotId,
    seed: config.seed,
    configHash,
    coins: assigned.map((c) => ({
      coinRef: c.coinRef,
      drawNonce: c.drawNonce,
      arms: c.blocks.map((b) => (b.arm === 'STAFFED' ? 'S' : 'U')).join(''),
    })),
  })

  return {
    pilotId: config.pilotId,
    seed: config.seed,
    configHash,
    coins: assigned,
    assignmentHash,
    generatedAtUnix,
  }
}

/** Look up a coin's block schedule. Used by the away-notice scheduler. */
export function blocksForCoin(assignment: PilotAssignment, coinRef: string): BlockAssignment[] {
  const found = assignment.coins.find((c) => c.coinRef === coinRef)
  if (!found) throw new AssignmentError(`coin ${coinRef} is not enrolled in ${assignment.pilotId}`)
  return found.blocks
}

export const PILOT_TIME = {
  hour: SECONDS_PER_HOUR,
  day: SECONDS_PER_DAY,
  blocksPerDay: BLOCKS_PER_DAY,
} as const
