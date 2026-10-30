/**
 * watch - re-measure the decision inputs on a schedule and report MOVEMENT.
 *
 * WHY THIS EXISTS. Everything in tools/artifacts/ expires. The whole 36-day
 * measurement was taken inside a gas subsidy that lapses on 2026-09-29, the
 * verdict is STOP at a feasibility ratio of 0.68, and the flip point is 109
 * winnable coins against the 73 the chain showed. OCTOBER-RERUN.md exists
 * because that measurement has to be repeated from scratch. This tool is the
 * cheap daily reading BETWEEN those re-runs: it does not re-derive the verdict
 * from first principles, it tells you which way the two numbers that decide it
 * are travelling and how fast.
 *
 * WHAT IT IS NOT. It is not escrow-index.ts and it does not replace the
 * re-run. It scans FORWARD from its own checkpoint - one day of blocks, not
 * thirty-six - and keeps a rolling window. A run that re-scanned the whole
 * history daily would cost three hours and would not be run.
 *
 * MOVEMENT, NOT A FRESH WALL OF NUMBERS. The state file persists every prior
 * observation, so the deltas below are DIFFERENCES BETWEEN MEASUREMENTS rather
 * than a recomputation dressed up as a trend. That distinction is the whole
 * design: a number recomputed from a re-derived population is not evidence of
 * movement, it is evidence that two runs used different inputs.
 *
 * THE ONE THING IT ALERTS ON. The winnable T1 population crossing the flip
 * point, in either direction. Everything else on the report is context for
 * that sentence. The flip point is DERIVED from the same closed form
 * frontier.ts uses - ceil(break-even / win rate) - rather than hardcoded at
 * 109, so a change to TERMS.operatorBps or to the tier's COGS moves the alarm
 * instead of silently invalidating it.
 *
 * FOUR REFUSALS, all deliberate:
 *   - a standing count taken over a population with any unpriced member is not
 *     a count, so it renders UNKNOWN and the run reports itself incomplete;
 *   - a recipient-day that was never scanned is UNKNOWN, never zero. Only days
 *     whose every block was scanned may be read as measurements;
 *   - a first run with no state refuses to start a 3-hour scan by accident:
 *     you must say --seed or --bootstrap-days;
 *   - the capture read is LIVE and only ever as fresh as the moment it ran. It
 *     is never carried forward from a previous observation.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ParsedValues } from './lib/cli.ts'
import { CliError, getBool, getList, getNumber, getString, isEntrypoint, runCli } from './lib/cli.ts'
import { functionSelector } from './lib/abi.ts'
import { buildCache } from './lib/cache.ts'
import { TOOLS_DIR, describeConfig, loadConfig, rpcUrlsOrPlaceholder } from './lib/env.ts'
import { UNPRICED, banner, heading, num, pct, sparkline, subheading, table, usd } from './lib/format.ts'
import { buildHttpClient } from './lib/http.ts'
import { parseJson, stringifyJson, toMinor } from './lib/json.ts'
import { DEFAULT_SCAN_BATCH_SIZE, findBlockAtOrAfter, formatScanProgress } from './lib/logscan.ts'
import {
  NATIVE_ASSET_ADDRESS,
  PriceBook,
  defaultQuoteAssets,
  parseAssetEntriesFile,
} from './lib/prices.ts'
import { emit, emitDryRun, progress, type Report } from './lib/report.ts'
import { HttpChainReader, type BatchOutcome, type ChainReader } from './lib/rpc.ts'
import { parseEscrowSeriesDocument, type EscrowSeriesDocument } from './lib/series.ts'
import { SECONDS_PER_DAY, dayStartUnix, isoDate, isoDateTime } from './lib/time.ts'
import {
  buildEscrowBackend,
  resolveCreditEvents,
  type EscrowCredit,
  type CreditScanMode,
} from './lib/escrow.ts'
import {
  computeEconomics,
  computeSteadyState,
  stopOrGoVerdict,
  type RepriceInputs,
  type RepriceVerdict,
} from './reprice.ts'
import { VENUE, TERMS, TIERS, TIER_ORDER, type TierId } from '../config/protocol.ts'

const SCHEMA_VERSION = 'watch-1'
export const WATCH_STATE_SCHEMA = 'watch-state-1'

/**
 * The incumbent's distributor beacon, and the 1167 clone prologue.
 *
 * Both are structural fingerprints read off deployed bytecode, not names. See
 * VERDICT.md section 4: the per-coin distributors are beacon proxies over
 * beacon 0xa125492a..., whose implementation contains no exit path, and one
 * whitelisted partner launchpad holds proposer, executor and canceller on the
 * timelock that could add one.
 */
export const INCUMBENT_BEACON = '15efa92a82566a360fdd3b82d81254f57d39db95'
const CLONE_1167_PROLOGUE = '363d3d373d3d3d363d73'
const EIP7702_PREFIX = 'ef0100'

/**
 * The ONLY exit from a contract-routed recipiency.
 *
 * hook.setCreatorFeeRecipient reverts NotFactory() for every sender and
 * factory.setCreatorFeeRecipient is owner-only, so the current recipient must
 * itself call factory.transferCreatorFeeRecipient. A contract that does not
 * carry this selector in its code cannot make that call, and the coin cannot be
 * won at any acquisition rate. Measured coin by coin: 3 of 18 non-incumbent
 * contract-routed T1 coins carry it.
 */
export const TRANSFER_RECIPIENT_SIGNATURE = 'transferCreatorFeeRecipient(address,address)'

const SPEC = {
  name: 'watch',
  summary:
    'Re-measure the decision inputs on a schedule and report how far and how fast they have moved, with an alert on the flip point.',
  detail: `
    Scans forward from its own checkpoint - one day of blocks, not the whole
    history - folds the new credits into a rolling window, re-reads the live
    capture position, and prints the DIFFERENCE against the previous observations
    rather than a fresh wall of numbers. Alerts when the winnable T1 population
    crosses the break-even flip point in either direction.
  `,
  options: [
    {
      name: 'state',
      type: 'string' as const,
      placeholder: '<file>',
      describe: 'Persistent history and rolling window. Movement is read from it, never recomputed.',
    },
    {
      name: 'seed',
      type: 'string' as const,
      placeholder: '<escrow-index.json>',
      describe:
        'Bootstrap the rolling window from an existing escrow-index document instead of scanning history. The cheap way to start.',
    },
    {
      name: 'bootstrap-days',
      type: 'number' as const,
      default: 0,
      describe:
        'Days of history to scan when there is no state and no --seed. Zero refuses to start, because an accidental 36-day scan is hours.',
    },
    {
      name: 'gate',
      type: 'number' as const,
      default: TIERS.T1.gateQfPerDay,
      describe: 'QF/day gate the standing population is counted at.',
    },
    { name: 'tier', type: 'string' as const, default: 'T1', describe: 'Tier supplying COGS for the flip point.' },
    {
      name: 'median-window',
      type: 'number' as const,
      default: TIERS.T1.sustainedDays,
      describe: 'Days in the trailing MEDIAN that defines standing. Must be odd; the protocol says 7.',
    },
    {
      name: 'retain-days',
      type: 'number' as const,
      default: 32,
      describe: 'Days of per-recipient series kept in the state. Older days are dropped.',
    },
    {
      name: 'retain-min-usd',
      type: 'number' as const,
      describe:
        'Recipient-days below this are dropped from the state once their day is complete. Defaults to the gate, which is lossless for the gate count. Never set it above the gate.',
    },
    {
      name: 'escrow',
      type: 'string' as const,
      default: VENUE.contracts.v2FeeEscrow,
      describe: 'Fee escrow to watch.',
    },
    {
      name: 'mode',
      type: 'string' as const,
      default: 'both',
      describe: 'Credit events to scan. "both" is the only mode that cannot undercount.',
    },
    {
      name: 'assets',
      type: 'string' as const,
      placeholder: '<file>',
      describe:
        'Per-address decimals and prices, as produced by token-metadata.ts --out-assets. Without it most ERC-20 credits are UNPRICED and the standing count is refused.',
    },
    {
      name: 'capture-mode',
      type: 'string' as const,
      default: 'live',
      describe:
        'live = classify every standing recipient by eth_getCode now. file = read a recorded classification. none = report capture UNKNOWN.',
    },
    {
      name: 'capture-json',
      type: 'string' as const,
      placeholder: '<file>',
      describe: 'Recorded classification for --capture-mode file.',
    },
    {
      name: 'operator-bps',
      type: 'number' as const,
      default: TERMS.operatorBps,
      describe: 'Operator take used to derive the flip point.',
    },
    {
      name: 'win-rate',
      type: 'number' as const,
      default: 0.1,
      describe: 'Win rate used to derive the flip point. An ASSUMPTION nothing here measures.',
    },
    {
      name: 'fixed-cost-monthly-usd',
      type: 'number' as const,
      default: 12_000,
      describe: 'Operator fixed cost used to derive the flip point. An ASSUMPTION.',
    },
    {
      name: 'flip-point',
      type: 'number' as const,
      describe:
        'Override the derived flip point. Cross-checked against the derivation and a disagreement is reported, not silently resolved.',
    },
    {
      name: 'tenure-days',
      type: 'number' as const,
      describe:
        'Measured mean tenure, for the full reprice verdict line. Absent, the feasibility ratio is still reported: it is invariant in tenure.',
    },
    {
      name: 'max-blocks',
      type: 'number' as const,
      default: 4_000_000,
      describe:
        'Cap on blocks scanned in one run, so a long gap catches up over several runs instead of one unbounded one.',
    },
    {
      name: 'max-observations',
      type: 'number' as const,
      default: 400,
      describe: 'Observations kept in the state. Oldest are dropped.',
    },
    {
      name: 'anchor-spacing',
      type: 'number' as const,
      default: 10_000,
      describe: 'Block-timestamp anchor spacing for the scan. Larger is cheaper and coarser.',
    },
    {
      name: 'rpc-batch',
      type: 'number' as const,
      default: DEFAULT_SCAN_BATCH_SIZE,
      describe: 'JSON-RPC calls per batched request.',
    },
    {
      name: 'no-write',
      type: 'boolean' as const,
      describe: 'Measure and report, but do not persist the observation. For a one-off read.',
    },
  ],
  examples: [
    'node tools/watch.ts --seed tools/artifacts/full/escrow-W6.json --assets tools/artifacts/assets-handpriced.json -v',
    'node tools/watch.ts --assets tools/artifacts/assets-handpriced.json --tenure-days 11.59 --json',
    'node tools/watch.ts --capture-mode none --dry-run',
  ],
}

// ---------------------------------------------------------------------------
// Persistent state
// ---------------------------------------------------------------------------

/** One recipient on one UTC day. Minor units are the primitive; USD is derived. */
export interface WatchDayRow {
  /** Minor units per asset address, decimal strings. Native is address(0). */
  byAssetMinor: Record<string, string>
  credits: number
}

export interface WatchDayTotal {
  dayUnix: number
  byAssetMinor: Record<string, string>
  credits: number
  /** Distinct recipients credited on this day, BEFORE pruning. */
  recipients: number
  /** Recipient-days dropped because they were measured below the retention floor. */
  prunedRows: number
}

export interface WatchObservation {
  atUnix: number
  headBlock: string
  headBlockUnix: number
  /** UTC days whose every block has been scanned, inclusive. */
  scannedFromDayUnix: number | null
  scannedThroughDayUnix: number | null
  gateQfPerDay: number
  medianWindowDays: number
  /** Recipients whose trailing median clears the gate. null when refused. */
  standingT1: number | null
  /** The count over the priced subset. A LOWER BOUND whenever refused. */
  standingT1Floor: number
  standingRefused: boolean
  standingRefusedReason: string | null
  capture: CaptureSummary | null
  /** standingT1 x winnable share, measured directly rather than scaled. */
  winnableT1: number | null
  /** Escrow-wide USD credited on the most recent complete day. */
  escrowDailyTotalUsd: number | null
  escrowDailyTotalDayUnix: number | null
  ethPriceUsd: number | null
  priceSource: string
  flipPointPopulation: number | null
  feasibilityRatio: number | null
  verdict: RepriceVerdict | 'UNKNOWN'
  verdictHeadline: string
}

export interface WatchState {
  schema: typeof WATCH_STATE_SCHEMA
  chainId: number
  escrow: string
  mode: CreditScanMode
  gateQfPerDay: number
  retainMinUsd: number
  retainDays: number
  /** First UTC day whose every block has been scanned. */
  scannedFromDayUnix: number | null
  lastScannedBlock: string
  lastScannedBlockUnix: number
  /** recipient -> dayUnix -> row. Only rows at or above the retention floor. */
  recipients: Record<string, Record<string, WatchDayRow>>
  dayTotals: Record<string, WatchDayTotal>
  observations: WatchObservation[]
}

export class WatchStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WatchStateError'
  }
}

export function emptyState(init: {
  chainId: number
  escrow: string
  mode: CreditScanMode
  gateQfPerDay: number
  retainMinUsd: number
  retainDays: number
}): WatchState {
  return {
    schema: WATCH_STATE_SCHEMA,
    chainId: init.chainId,
    escrow: init.escrow.toLowerCase(),
    mode: init.mode,
    gateQfPerDay: init.gateQfPerDay,
    retainMinUsd: init.retainMinUsd,
    retainDays: init.retainDays,
    scannedFromDayUnix: null,
    lastScannedBlock: '0',
    lastScannedBlockUnix: 0,
    recipients: {},
    dayTotals: {},
    observations: [],
  }
}

/**
 * Load a state file, refusing one written for a different measurement.
 *
 * A state whose escrow, chain, mode or retention floor changed cannot be
 * continued: the rolling window would then be a mixture of two definitions and
 * the movement it reports would be an artefact of the change. Deleting and
 * re-seeding is the correct response, and the message says so.
 */
export function parseWatchState(value: unknown, expected: Pick<WatchState, 'chainId' | 'escrow' | 'mode' | 'gateQfPerDay' | 'retainMinUsd'>): WatchState {
  if (typeof value !== 'object' || value === null) {
    throw new WatchStateError('watch state is not an object')
  }
  const state = value as WatchState
  if (state.schema !== WATCH_STATE_SCHEMA) {
    throw new WatchStateError(
      `watch state schema "${String(state.schema)}" != "${WATCH_STATE_SCHEMA}". Delete the state file and re-seed.`,
    )
  }
  const mismatches: string[] = []
  if (state.chainId !== expected.chainId) mismatches.push(`chainId ${state.chainId} != ${expected.chainId}`)
  if (state.escrow !== expected.escrow.toLowerCase()) mismatches.push(`escrow ${state.escrow} != ${expected.escrow}`)
  if (state.mode !== expected.mode) mismatches.push(`mode ${state.mode} != ${expected.mode}`)
  if (state.gateQfPerDay !== expected.gateQfPerDay) {
    mismatches.push(`gate ${state.gateQfPerDay} != ${expected.gateQfPerDay}`)
  }
  if (state.retainMinUsd !== expected.retainMinUsd) {
    mismatches.push(`retain-min-usd ${state.retainMinUsd} != ${expected.retainMinUsd}`)
  }
  if (mismatches.length > 0) {
    throw new WatchStateError(
      `watch state was written for a different measurement (${mismatches.join('; ')}). ` +
        'Continuing would mix two definitions into one trend. Delete the state file and re-seed, or restore the original flags.',
    )
  }
  return state
}

/** Last UTC day every block of which has been scanned. */
export function scannedThroughDayUnix(state: WatchState): number | null {
  if (state.scannedFromDayUnix === null || state.lastScannedBlockUnix === 0) return null
  const through = dayStartUnix(state.lastScannedBlockUnix) - SECONDS_PER_DAY
  return through < state.scannedFromDayUnix ? null : through
}

// ---------------------------------------------------------------------------
// Folding credits into the rolling window
// ---------------------------------------------------------------------------

function addMinor(target: Record<string, string>, asset: string, amount: bigint): void {
  const key = asset.toLowerCase()
  const current = target[key]
  target[key] = ((current === undefined ? 0n : toMinor(current, 'byAssetMinor')) + amount).toString()
}

/**
 * Fold a batch of credits into the state's rolling window.
 *
 * ACCUMULATIVE and therefore safe across a day boundary: a day scanned in two
 * runs ends up with the sum, because the scan ranges are disjoint by
 * construction (each run starts at lastScannedBlock + 1). USD is never stored -
 * it is derived from the minor units at read time, so a later price correction
 * fixes the history instead of leaving two vintages in one series.
 */
export function foldCredits(state: WatchState, credits: readonly EscrowCredit[]): void {
  const recipientsByDay = new Map<number, Set<string>>()
  for (const credit of credits) {
    const dayUnix = dayStartUnix(credit.timestampUnix)
    const dayKey = String(dayUnix)
    const recipient = credit.recipient.toLowerCase()

    const perRecipient = (state.recipients[recipient] ??= {})
    const row = (perRecipient[dayKey] ??= { byAssetMinor: {}, credits: 0 })
    addMinor(row.byAssetMinor, credit.asset, credit.amountMinor)
    row.credits++

    const total = (state.dayTotals[dayKey] ??= {
      dayUnix,
      byAssetMinor: {},
      credits: 0,
      recipients: 0,
      prunedRows: 0,
    })
    addMinor(total.byAssetMinor, credit.asset, credit.amountMinor)
    total.credits++

    let seen = recipientsByDay.get(dayUnix)
    if (seen === undefined) {
      seen = new Set<string>()
      recipientsByDay.set(dayUnix, seen)
    }
    seen.add(recipient)
  }
  // Distinct-recipient counts are per RUN, so they are unioned rather than
  // summed: the same recipient credited on both sides of a run boundary is one
  // recipient, not two. The union is approximated by taking the max, which is
  // exact whenever a day is scanned in a single run and a lower bound otherwise.
  for (const [dayUnix, seen] of recipientsByDay) {
    const total = state.dayTotals[String(dayUnix)]
    if (total !== undefined) total.recipients = Math.max(total.recipients, seen.size)
  }
}

export function usdOfRow(row: WatchDayRow, prices: PriceBook): number | null {
  let sum = 0
  for (const [asset, minor] of Object.entries(row.byAssetMinor)) {
    const priced = prices.toUsd(asset, toMinor(minor, 'byAssetMinor'))
    if (priced === undefined) return null
    sum += priced.usd
  }
  return sum
}

export function usdOfDayTotal(total: WatchDayTotal, prices: PriceBook): number | null {
  let sum = 0
  for (const [asset, minor] of Object.entries(total.byAssetMinor)) {
    const priced = prices.toUsd(asset, toMinor(minor, 'byAssetMinor'))
    if (priced === undefined) return null
    sum += priced.usd
  }
  return sum
}

/**
 * Drop what the state does not need to keep, and record what was dropped.
 *
 * THE PRUNING RULE IS LOSSLESS FOR THE GATE COUNT, and that is the only reason
 * it is allowed. A trailing median over an odd window clears a gate only if
 * MORE THAN HALF its days are at or above the gate, so a day measured strictly
 * below the retention floor can never contribute to clearing a gate at or above
 * that floor. Dropping such a day loses no information the count uses.
 *
 * Two conditions make that argument hold and both are enforced:
 *   - only COMPLETE days are pruned. A partial day may still grow past the
 *     floor before its blocks are all scanned;
 *   - only PRICED days are pruned. An unpriced day is not known to be below
 *     anything, and dropping it would turn "no price" into "no activity".
 */
export function pruneState(state: WatchState, prices: PriceBook): void {
  const through = scannedThroughDayUnix(state)
  const oldestRetained =
    through === null ? null : through - (state.retainDays - 1) * SECONDS_PER_DAY

  for (const [dayKey, total] of Object.entries(state.dayTotals)) {
    if (oldestRetained !== null && total.dayUnix < oldestRetained) delete state.dayTotals[dayKey]
  }
  for (const [recipient, days] of Object.entries(state.recipients)) {
    for (const [dayKey, row] of Object.entries(days)) {
      const dayUnix = Number(dayKey)
      if (oldestRetained !== null && dayUnix < oldestRetained) {
        delete days[dayKey]
        continue
      }
      const complete = through !== null && dayUnix <= through
      if (!complete) continue
      const value = usdOfRow(row, prices)
      if (value === null || value >= state.retainMinUsd) continue
      delete days[dayKey]
      const total = state.dayTotals[dayKey]
      if (total !== undefined) total.prunedRows++
    }
    if (Object.keys(days).length === 0) delete state.recipients[recipient]
  }
  if (oldestRetained !== null && state.scannedFromDayUnix !== null) {
    state.scannedFromDayUnix = Math.max(state.scannedFromDayUnix, oldestRetained)
  }
}

// ---------------------------------------------------------------------------
// The standing population
// ---------------------------------------------------------------------------

export interface StandingCount {
  /** Recipients clearing the gate. undefined when the count is refused. */
  count: number | undefined
  /** Count over the fully priced subset. A LOWER BOUND when refused. */
  floor: number
  refused: boolean
  refusedReason: string | undefined
  /** Recipients excluded because a day in the window had no price. */
  unpricedRecipients: number
  windowDays: number[]
  /** The recipients themselves, for the live capture read. */
  recipients: string[]
}

/**
 * Recipients whose trailing median clears the gate.
 *
 * A recipient with no retained row on a COMPLETE day was measured below the
 * retention floor that day, so it counts as a day below the gate - that is what
 * the pruning rule buys. A day that is not complete, or that is not in the
 * state at all, is UNKNOWN and refuses the whole count rather than being read
 * as a quiet day.
 */
export function standingAtGate(
  state: WatchState,
  prices: PriceBook,
  options: { gate: number; windowDays: number },
): StandingCount {
  const through = scannedThroughDayUnix(state)
  const empty: StandingCount = {
    count: undefined,
    floor: 0,
    refused: true,
    refusedReason: undefined,
    unpricedRecipients: 0,
    windowDays: [],
    recipients: [],
  }
  if (through === null || state.scannedFromDayUnix === null) {
    return { ...empty, refusedReason: 'no complete UTC day has been scanned yet' }
  }
  if (options.windowDays % 2 === 0) {
    return {
      ...empty,
      refusedReason: `median window ${options.windowDays} is even; a median over an even window cannot be decided from a pruned series`,
    }
  }
  const days: number[] = []
  for (let i = options.windowDays - 1; i >= 0; i--) days.push(through - i * SECONDS_PER_DAY)
  const first = days[0]
  if (first === undefined || first < state.scannedFromDayUnix) {
    return {
      ...empty,
      refusedReason: `only ${
        through === null ? 0 : Math.floor((through - state.scannedFromDayUnix) / SECONDS_PER_DAY) + 1
      } complete day(s) are in the window; the ${options.windowDays}-day trailing median needs ${options.windowDays}`,
      windowDays: days,
    }
  }
  if (options.gate < state.retainMinUsd) {
    return {
      ...empty,
      refusedReason: `gate ${options.gate} is below the state's retention floor ${state.retainMinUsd}, so days pruned as "below floor" are not known to be below the gate`,
      windowDays: days,
    }
  }

  const needed = (options.windowDays + 1) / 2
  let count = 0
  let unpriced = 0
  const recipients: string[] = []
  for (const [recipient, rows] of Object.entries(state.recipients)) {
    let atOrAbove = 0
    let hasUnpriced = false
    for (const dayUnix of days) {
      const row = rows[String(dayUnix)]
      if (row === undefined) continue // measured below the retention floor
      const value = usdOfRow(row, prices)
      if (value === null) {
        hasUnpriced = true
        break
      }
      if (value >= options.gate) atOrAbove++
    }
    if (hasUnpriced) {
      unpriced++
      continue
    }
    if (atOrAbove >= needed) {
      count++
      recipients.push(recipient)
    }
  }
  return {
    count: unpriced > 0 ? undefined : count,
    floor: count,
    refused: unpriced > 0,
    refusedReason:
      unpriced > 0
        ? `${unpriced} recipient(s) have a day in the window whose assets have no USD price, so this is a lower bound rather than a count`
        : undefined,
    unpricedRecipients: unpriced,
    windowDays: days,
    recipients,
  }
}

// ---------------------------------------------------------------------------
// The live capture read
// ---------------------------------------------------------------------------

export type RecipientClass =
  | 'EOA'
  | 'EOA_7702'
  | 'INCUMBENT_DISTRIBUTOR'
  | 'CLONE_1167'
  | 'OTHER_CONTRACT'

export interface RecipientClassification {
  recipient: string
  cls: RecipientClass
  /** Implementation behind a clone, when one was resolved. */
  implementation: string | undefined
  /** True when this recipiency can still be moved to a vault we control. */
  winnable: boolean
  /** Why, in one phrase. Printed, because "44% captured" is not self-evident. */
  reason: string
}

export interface CaptureSummary {
  readAtUnix: number
  source: 'live' | 'file'
  classified: number
  byClass: Record<string, number>
  winnable: number
  /** winnable / classified. Measured at this gate, never carried from another. */
  winnableShare: number
  /** Recipients whose code could not be read. Never counted either way. */
  unreadable: number
  /**
   * True when the set classified was the REFUSED standing count's lower-bound
   * subset rather than the standing population. The share is then a real
   * measurement of a set that is not the one the decision is about.
   */
  overRefusedStanding: boolean
}

/** Reads deployed bytecode. Narrow on purpose, so tests can supply a map. */
export interface CodeReader {
  getCode(addresses: readonly string[]): Promise<Map<string, string>>
}

export function chainCodeReader(reader: ChainReader, batchSize: number): CodeReader {
  return {
    async getCode(addresses: readonly string[]): Promise<Map<string, string>> {
      const out = new Map<string, string>()
      const batched = reader as ChainReader & {
        rpcBatch?: (
          requests: ReadonlyArray<{ method: string; params: unknown[] }>,
        ) => Promise<Array<BatchOutcome<unknown>>>
      }
      for (let i = 0; i < addresses.length; i += batchSize) {
        const slice = addresses.slice(i, i + batchSize)
        if (typeof batched.rpcBatch === 'function') {
          const outcomes = await batched.rpcBatch(
            slice.map((address) => ({ method: 'eth_getCode', params: [address, 'latest'] })),
          )
          for (const [index, outcome] of outcomes.entries()) {
            const address = slice[index]
            if (address === undefined) continue
            // A failed slot is LEFT OUT, not recorded as '0x'. '0x' means "read
            // it, there is no code, this is an EOA", which is the winnable
            // class - so a transport error must never produce one.
            if (outcome.ok && typeof outcome.value === 'string') out.set(address, outcome.value)
          }
        } else {
          for (const address of slice) {
            const code = await reader.call(address, '0x').catch(() => undefined)
            if (code !== undefined) out.set(address, code)
          }
        }
      }
      return out
    },
  }
}

/**
 * Classify one recipient from its deployed bytecode.
 *
 * `implementationCode` is the code behind a 1167 clone, when it was fetched.
 * Without it a clone is classified but NOT declared winnable: the exit selector
 * lives in the implementation, not in the 45-byte stub, so judging the stub
 * alone would mark every clone unwinnable on the strength of a delegation
 * prologue.
 */
export function classifyRecipient(
  recipient: string,
  code: string,
  implementationCode?: string | undefined,
): RecipientClassification {
  const exitSelector = functionSelector(TRANSFER_RECIPIENT_SIGNATURE).slice(2).toLowerCase()
  const hex = code.startsWith('0x') ? code.slice(2).toLowerCase() : code.toLowerCase()

  if (hex.length === 0) {
    return {
      recipient,
      cls: 'EOA',
      implementation: undefined,
      winnable: true,
      reason: 'no code: a signable key can call factory.transferCreatorFeeRecipient',
    }
  }
  if (hex.startsWith(EIP7702_PREFIX) && hex.length === 46) {
    return {
      recipient,
      cls: 'EOA_7702',
      implementation: `0x${hex.slice(6, 46)}`,
      winnable: true,
      // A 7702 designator does not remove the key; the account is still an EOA
      // that can sign. Counting these as captured understates the market.
      reason: 'EIP-7702 delegation over an account that is still signable',
    }
  }
  if (hex.includes(INCUMBENT_BEACON)) {
    return {
      recipient,
      cls: 'INCUMBENT_DISTRIBUTOR',
      implementation: undefined,
      winnable: false,
      reason: 'beacon proxy over the incumbent distributor, whose implementation has no exit path',
    }
  }
  if (hex.startsWith(CLONE_1167_PROLOGUE)) {
    const implementation = `0x${hex.slice(20, 60)}`
    const implHex = (implementationCode ?? '').replace(/^0x/, '').toLowerCase()
    const carriesExit = implHex.includes(exitSelector)
    return {
      recipient,
      cls: 'CLONE_1167',
      implementation,
      winnable: carriesExit,
      reason:
        implementationCode === undefined
          ? 'EIP-1167 clone whose implementation code was not read; treated as unwinnable rather than guessed'
          : carriesExit
            ? 'EIP-1167 clone whose implementation carries transferCreatorFeeRecipient'
            : 'EIP-1167 clone whose implementation has no code path out',
    }
  }
  const carriesExit = hex.includes(exitSelector)
  return {
    recipient,
    cls: 'OTHER_CONTRACT',
    implementation: undefined,
    winnable: carriesExit,
    reason: carriesExit
      ? 'contract carrying transferCreatorFeeRecipient'
      : 'contract with no code path out',
  }
}

export function summarizeCapture(
  classifications: readonly RecipientClassification[],
  options: {
    readAtUnix: number
    source: 'live' | 'file'
    unreadable: number
    overRefusedStanding?: boolean
  },
): CaptureSummary {
  const byClass: Record<string, number> = {}
  let winnable = 0
  for (const entry of classifications) {
    byClass[entry.cls] = (byClass[entry.cls] ?? 0) + 1
    if (entry.winnable) winnable++
  }
  return {
    readAtUnix: options.readAtUnix,
    source: options.source,
    classified: classifications.length,
    byClass,
    winnable,
    winnableShare: classifications.length > 0 ? winnable / classifications.length : 0,
    unreadable: options.unreadable,
    overRefusedStanding: options.overRefusedStanding ?? false,
  }
}

/** One live capture read over a standing set. Two round trips at most. */
export async function readCapture(
  reader: CodeReader,
  recipients: readonly string[],
  nowUnix: number,
  options: { overRefusedStanding?: boolean } = {},
): Promise<{ summary: CaptureSummary; rows: RecipientClassification[] }> {
  const code = await reader.getCode(recipients)
  const firstPass = recipients
    .filter((r) => code.has(r))
    .map((r) => classifyRecipient(r, code.get(r) ?? '0x'))
  const implementations = [
    ...new Set(
      firstPass
        .filter((c) => c.cls === 'CLONE_1167' && c.implementation !== undefined)
        .map((c) => c.implementation!),
    ),
  ]
  const implCode = implementations.length > 0 ? await reader.getCode(implementations) : new Map()
  const rows = firstPass.map((entry) =>
    entry.cls === 'CLONE_1167' && entry.implementation !== undefined
      ? classifyRecipient(entry.recipient, code.get(entry.recipient) ?? '0x', implCode.get(entry.implementation))
      : entry,
  )
  return {
    summary: summarizeCapture(rows, {
      readAtUnix: nowUnix,
      source: 'live',
      unreadable: recipients.length - rows.length,
      overRefusedStanding: options.overRefusedStanding ?? false,
    }),
    rows,
  }
}

// ---------------------------------------------------------------------------
// The flip point, derived rather than hardcoded
// ---------------------------------------------------------------------------

export interface FlipPoint {
  breakEvenConcurrentClients: number
  contributionPerClientDayUsd: number
  /** Winnable population at which the feasibility ratio reaches 1.0. */
  population: number | null
}

/**
 * The population at which the feasibility ratio crosses 1.
 *
 * ratio = winRate x P / breakEven, so the crossing is at P = breakEven/winRate.
 * TENURE IS ABSENT because it cancels: the required signing rate is L/W and the
 * available crossing rate is P/W. Hardcoding 109 would have quietly detached
 * this alarm from TERMS.operatorBps the first time anyone repriced.
 */
export function deriveFlipPoint(input: {
  gateQfPerDay: number
  operatorBps: number
  cogsPerDayUsd: number
  fixedCostMonthlyUsd: number
  winRate: number
}): FlipPoint {
  const contribution = (input.gateQfPerDay * input.operatorBps) / 10_000 - input.cogsPerDayUsd
  if (contribution <= 0) {
    return {
      breakEvenConcurrentClients: Number.POSITIVE_INFINITY,
      contributionPerClientDayUsd: contribution,
      population: null,
    }
  }
  const breakEven = input.fixedCostMonthlyUsd / 30 / contribution
  return {
    breakEvenConcurrentClients: breakEven,
    contributionPerClientDayUsd: contribution,
    population: Math.ceil(breakEven / input.winRate),
  }
}

export interface VerdictLine {
  verdict: RepriceVerdict | 'UNKNOWN'
  headline: string
  feasibilityRatio: number | null
}

/**
 * What reprice.ts returns on today's inputs - or a refusal.
 *
 * THE REFUSAL IS THE POINT. reprice.ts runs its acquisition-feasibility check
 * only when --clients-above-gate is supplied, and its own warnings say a GO
 * without it "says the economics work, not that the clients exist". Passing an
 * unmeasured population through as `undefined` therefore skips the ONE check
 * the real verdict failed, and the monitor would print GO on the morning its
 * inputs went missing. So an unmeasured population returns UNKNOWN, always.
 */
export function decideVerdict(
  inputs: RepriceInputs,
  flip: FlipPoint,
  winnablePopulation: number | null,
): VerdictLine {
  if (winnablePopulation === null) {
    return {
      verdict: 'UNKNOWN',
      headline:
        'REFUSED: the winnable population could not be measured this run, and it is the input that decides this. ' +
        'Running the verdict without it would silently skip the feasibility check - the only check the measured verdict FAILED.',
      feasibilityRatio: null,
    }
  }
  if (!Number.isFinite(inputs.tenureDays) || inputs.tenureDays <= 0) {
    return {
      verdict: 'UNKNOWN',
      headline:
        '--tenure-days was not supplied, so the full stop/go verdict was not computed. The feasibility ratio below IS computed: it is invariant in tenure.',
      feasibilityRatio: Number.isFinite(flip.breakEvenConcurrentClients)
        ? (inputs.winRate * winnablePopulation) / flip.breakEvenConcurrentClients
        : null,
    }
  }
  const economics = computeEconomics(inputs)
  const steady = computeSteadyState(inputs, economics)
  const decided = stopOrGoVerdict(inputs, economics, steady)
  return {
    verdict: decided.verdict,
    headline: decided.headline,
    feasibilityRatio: steady.acquisitionFeasibilityRatio ?? null,
  }
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

export type Direction = 'rising' | 'falling' | 'flat' | 'unknown'

export interface Movement {
  metric: string
  /** How the value should be read. A count is not a price and neither is a ratio. */
  unit: 'count' | 'ratio' | 'usd'
  current: number | null
  previous: number | null
  previousAtUnix: number | null
  delta: number | null
  /** Change per day between the two observations. */
  perDay: number | null
  direction: Direction
  /** Days between the two observations. */
  spanDays: number | null
}

export function movementOf(
  metric: string,
  unit: Movement['unit'],
  current: WatchObservation,
  previous: WatchObservation | undefined,
  pick: (o: WatchObservation) => number | null,
): Movement {
  const now = pick(current)
  const before = previous === undefined ? null : pick(previous)
  if (now === null || before === null || previous === undefined) {
    return {
      metric,
      unit,
      current: now,
      previous: before,
      previousAtUnix: previous?.atUnix ?? null,
      delta: null,
      perDay: null,
      // Unknown, not flat. A metric that could not be measured has not "not
      // moved" - that reading is exactly how a broken input looks like calm.
      direction: 'unknown',
      spanDays: null,
    }
  }
  const spanSeconds = current.atUnix - previous.atUnix
  const spanDays = spanSeconds / SECONDS_PER_DAY
  const delta = now - before
  return {
    metric,
    unit,
    current: now,
    previous: before,
    previousAtUnix: previous.atUnix,
    delta,
    perDay: spanDays > 0 ? delta / spanDays : null,
    direction: delta > 0 ? 'rising' : delta < 0 ? 'falling' : 'flat',
    spanDays,
  }
}

export type CrossingDirection = 'UPWARD' | 'DOWNWARD'

export interface FlipPointCrossing {
  crossed: CrossingDirection | null
  flipPoint: number
  from: number | null
  to: number | null
  /** Set when the crossing could not be evaluated. Never treated as "no alert". */
  undecidedReason: string | null
}

/**
 * Did the winnable population cross the flip point since the last observation?
 *
 * An UNDECIDED crossing is reported as such and is NOT silence. A monitor whose
 * alarm cannot fire because an input went missing has failed in the direction
 * that looks like good news.
 */
export function flipPointCrossing(
  current: WatchObservation,
  previous: WatchObservation | undefined,
  flipPoint: number | null,
): FlipPointCrossing {
  const to = current.winnableT1
  const from = previous?.winnableT1 ?? null
  if (flipPoint === null) {
    return { crossed: null, flipPoint: Number.NaN, from, to, undecidedReason: 'the flip point could not be derived: contribution per client is not positive at this gate and take' }
  }
  if (to === null) {
    return { crossed: null, flipPoint, from, to, undecidedReason: 'the winnable population could not be measured on this run' }
  }
  if (previous === undefined || from === null) {
    return { crossed: null, flipPoint, from, to, undecidedReason: 'no previous observation with a measured winnable population' }
  }
  if (from < flipPoint && to >= flipPoint) {
    return { crossed: 'UPWARD', flipPoint, from, to, undecidedReason: null }
  }
  if (from >= flipPoint && to < flipPoint) {
    return { crossed: 'DOWNWARD', flipPoint, from, to, undecidedReason: null }
  }
  return { crossed: null, flipPoint, from, to, undecidedReason: null }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface WatchResult {
  observation: WatchObservation
  previousObservation: WatchObservation | undefined
  observationsHeld: number
  movements: Movement[]
  crossing: FlipPointCrossing
  flipPoint: FlipPoint
  /** Set when --flip-point disagrees with the derivation. */
  flipPointOverrideDisagreement: string | null
  scan: {
    fromBlock: string
    toBlock: string
    blocksScanned: number
    creditsFound: number
    caughtUp: boolean
    seeded: boolean
  }
  capture: { rows: RecipientClassification[] } | null
  /** Escrow-wide USD by day over the retained window. Nulls are unpriced days. */
  dailyTotals: Array<{ dayUnix: number; usd: number | null; credits: number; complete: boolean }>
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function defaultStatePath(): string {
  return join(TOOLS_DIR, '.watch', 'state.json')
}

async function loadState(
  path: string,
  expected: Parameters<typeof parseWatchState>[1],
): Promise<WatchState | undefined> {
  try {
    return parseWatchState(parseJson(await readFile(path, 'utf8')), expected)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Seed the rolling window from an escrow-index document.
 *
 * The document's LAST day is deliberately treated as incomplete: its window
 * ends at a block, not at midnight, so reading it as a full day would publish a
 * part-day total as a daily one. The forward scan resumes at the document's
 * toBlock and finishes that day itself.
 */
export function seedFromEscrowDocument(state: WatchState, document: EscrowSeriesDocument): void {
  if (document.escrow.toLowerCase() !== state.escrow) {
    throw new WatchStateError(
      `--seed document is for escrow ${document.escrow}, not ${state.escrow}. Refusing to mix two escrows into one series.`,
    )
  }
  if (document.chainId !== state.chainId) {
    throw new WatchStateError(`--seed document is for chain ${document.chainId}, not ${state.chainId}.`)
  }
  // A document that does not record the block it was scanned to cannot be
  // resumed from: the forward scan would have no checkpoint and would silently
  // restart from a bootstrap, re-counting every day the seed already loaded.
  let toBlock: bigint
  try {
    toBlock = BigInt(document.toBlock)
  } catch {
    toBlock = 0n
  }
  if (toBlock <= 0n) {
    throw new WatchStateError(
      `--seed document records toBlock "${String(document.toBlock)}", so there is no checkpoint to scan forward from. ` +
        'A seed whose end block is unknown would be re-scanned from scratch and double-counted. Use a document written by escrow-index.ts.',
    )
  }
  for (const recipient of document.recipients) {
    for (const day of recipient.days) {
      // A zero-filled day carries no credits AND no amounts. Keying only on
      // creditCount would drop every day of a document that recorded amounts
      // without per-day counts, and the recipient would look dormant.
      if (day.creditCount === 0 && Object.keys(day.byAssetMinor).length === 0) continue
      const perRecipient = (state.recipients[recipient.recipient.toLowerCase()] ??= {})
      const row = (perRecipient[String(day.dayUnix)] ??= { byAssetMinor: {}, credits: 0 })
      for (const [asset, minor] of Object.entries(day.byAssetMinor)) {
        addMinor(row.byAssetMinor, asset, toMinor(minor, 'byAssetMinor'))
      }
      row.credits += day.creditCount

      const total = (state.dayTotals[String(day.dayUnix)] ??= {
        dayUnix: day.dayUnix,
        byAssetMinor: {},
        credits: 0,
        recipients: 0,
        prunedRows: 0,
      })
      for (const [asset, minor] of Object.entries(day.byAssetMinor)) {
        addMinor(total.byAssetMinor, asset, toMinor(minor, 'byAssetMinor'))
      }
      total.credits += day.creditCount
      total.recipients++
    }
  }
  state.scannedFromDayUnix = document.windowStartDayUnix
  state.lastScannedBlock = toBlock.toString()
  // The document's own last day is partial, so the checkpoint's clock is set to
  // that day's START. scannedThroughDayUnix() then stops one day earlier, which
  // is exactly the last day the document covers in full.
  state.lastScannedBlockUnix = document.windowEndDayUnix
}

async function main(values: ParsedValues): Promise<void> {
  const config = loadConfig()
  const json = getBool(values, 'json')
  const dryRun = getBool(values, 'dry-run')
  const verbose = getBool(values, 'verbose')
  const outPath = getString(values, 'out')

  const escrow = (getString(values, 'escrow') ?? VENUE.contracts.v2FeeEscrow).toLowerCase()
  const modeRaw = (getString(values, 'mode') ?? 'both').toLowerCase()
  if (modeRaw !== 'native' && modeRaw !== 'token' && modeRaw !== 'both') {
    throw new CliError('--mode must be native, token or both.')
  }
  const mode: CreditScanMode = modeRaw
  const tierRaw = getString(values, 'tier') ?? 'T1'
  if (!(TIER_ORDER as string[]).includes(tierRaw)) {
    throw new CliError(`--tier must be one of ${TIER_ORDER.join(', ')}`)
  }
  const tier = tierRaw as TierId
  const gate = getNumber(values, 'gate', TIERS[tier].gateQfPerDay)
  const medianWindow = Math.floor(getNumber(values, 'median-window', TIERS.T1.sustainedDays))
  if (medianWindow < 1 || medianWindow % 2 === 0) {
    throw new CliError(
      `--median-window must be a positive ODD number of days. A median over an even window cannot be decided from a series that prunes below-floor days, and the protocol's own definition is a ${TIERS.T1.sustainedDays}-day median.`,
    )
  }
  const retainDays = Math.floor(getNumber(values, 'retain-days', 32))
  if (retainDays < medianWindow) {
    throw new CliError(`--retain-days (${retainDays}) must be at least --median-window (${medianWindow}).`)
  }
  const retainMinRaw = values['retain-min-usd']
  const retainMinUsd = typeof retainMinRaw === 'number' ? retainMinRaw : gate
  if (retainMinUsd > gate) {
    throw new CliError(
      `--retain-min-usd ${retainMinUsd} is above the gate ${gate}. Pruning above the gate would drop days the gate count needs, and the count would silently become a lower bound.`,
    )
  }
  const winRate = getNumber(values, 'win-rate', 0.1)
  if (winRate <= 0 || winRate > 1) throw new CliError('--win-rate must be in (0, 1]')
  const captureModeRaw = (getString(values, 'capture-mode') ?? 'live').toLowerCase()
  if (captureModeRaw !== 'live' && captureModeRaw !== 'file' && captureModeRaw !== 'none') {
    throw new CliError('--capture-mode must be live, file or none.')
  }
  const captureMode = captureModeRaw
  const capturePath = getString(values, 'capture-json')
  if (captureMode === 'file' && capturePath === undefined) {
    throw new CliError('--capture-mode file needs --capture-json <file>.')
  }

  const statePath = getString(values, 'state') ?? defaultStatePath()
  const seedPath = getString(values, 'seed')
  const bootstrapDays = getNumber(values, 'bootstrap-days', 0)
  const maxBlocks = Math.max(1, Math.floor(getNumber(values, 'max-blocks', 4_000_000)))

  const flipPoint = deriveFlipPoint({
    gateQfPerDay: gate,
    operatorBps: getNumber(values, 'operator-bps', TERMS.operatorBps),
    cogsPerDayUsd: TIERS[tier].cogsPerDay,
    fixedCostMonthlyUsd: getNumber(values, 'fixed-cost-monthly-usd', 12_000),
    winRate,
  })
  const flipOverrideRaw = values['flip-point']
  const flipOverride = typeof flipOverrideRaw === 'number' ? flipOverrideRaw : undefined
  const effectiveFlipPoint = flipOverride ?? flipPoint.population
  const flipPointOverrideDisagreement =
    flipOverride !== undefined && flipPoint.population !== null && flipOverride !== flipPoint.population
      ? `--flip-point ${flipOverride} disagrees with the derived ${flipPoint.population} at ${gate}/day, ${getNumber(values, 'operator-bps', TERMS.operatorBps)}bps, ${usd(TIERS[tier].cogsPerDay)}/day COGS and a ${pct(winRate)} win rate. The override is being used; one of the two inputs is stale.`
      : null

  if (dryRun) {
    emitDryRun(
      {
        tool: SPEC.name,
        config: { ...describeConfig(config), escrow, mode, gate, medianWindow, retainDays, retainMinUsd, statePath },
        steps: [
          { description: `read the persisted state at ${statePath}`, estimatedRequests: 0 },
          { description: 'resolve the chain head', estimatedRequests: 2 },
          {
            description: seedPath
              ? `seed the rolling window from ${seedPath}, then scan forward from its toBlock`
              : `scan forward from the state's checkpoint to head, capped at ${maxBlocks} blocks`,
            estimatedRequests: Math.ceil(maxBlocks / config.logChunkBlocks) * 2,
          },
          {
            description:
              captureMode === 'live'
                ? 'classify every standing recipient by a live eth_getCode, then resolve clone implementations'
                : `capture read: ${captureMode}`,
            estimatedRequests: captureMode === 'live' ? 20 : 0,
          },
          { description: 'derive the flip point, diff against the previous observation, and persist' },
        ],
        estimatedRequestsTotal: 2 + Math.ceil(maxBlocks / config.logChunkBlocks) * 2 + (captureMode === 'live' ? 20 : 0),
        notes: [
          'watch.ts scans FORWARD from its checkpoint. The request budget above is the CAP, not the expected cost: a daily run covers about one day of blocks.',
          `Flip point derived at ${String(flipPoint.population)} winnable coins from a ${usd(flipPoint.contributionPerClientDayUsd)}/day contribution.`,
        ],
      },
      json,
    )
    return
  }

  const expected = { chainId: config.chainId, escrow, mode, gateQfPerDay: gate, retainMinUsd }
  let state = await loadState(statePath, expected)
  const fresh = state === undefined
  state ??= emptyState({ chainId: config.chainId, escrow, mode, gateQfPerDay: gate, retainMinUsd, retainDays })
  state.retainDays = retainDays

  let seeded = false
  if (fresh && seedPath !== undefined) {
    progress(verbose, `seeding from ${seedPath}`)
    seedFromEscrowDocument(state, parseEscrowSeriesDocument(parseJson(await readFile(seedPath, 'utf8'))))
    seeded = true
    progress(
      verbose,
      `seeded ${Object.keys(state.recipients).length} recipients over ${Object.keys(state.dayTotals).length} days, resuming at block ${state.lastScannedBlock}`,
    )
  }
  if (fresh && !seeded && bootstrapDays <= 0) {
    throw new CliError(
      `no state at ${statePath} and neither --seed nor --bootstrap-days was given. ` +
        'Refusing to guess: --seed <escrow-index.json> costs nothing and reuses a scan you already paid for; ' +
        `--bootstrap-days ${retainDays} scans that many days of blocks and takes hours. Pick one deliberately.`,
    )
  }

  // --- price book --------------------------------------------------------
  const prices = PriceBook.fromConfig(config, defaultQuoteAssets(VENUE.contracts.weth))
  const assetsPath = getString(values, 'assets')
  if (assetsPath !== undefined) {
    for (const entry of parseAssetEntriesFile(parseJson(await readFile(assetsPath, 'utf8')))) {
      if (entry.decimals === undefined) continue
      prices.registerAsset(
        {
          address: entry.address,
          symbol: entry.symbol ?? `UNRESOLVED_${entry.address.slice(2, 10)}`,
          decimals: entry.decimals,
        },
        entry.priceUsd,
      )
    }
  }

  // --- the forward scan ---------------------------------------------------
  const http = buildHttpClient({
    requestsPerSecond: config.requestsPerSecond,
    maxRetries: config.maxRetries,
    timeoutMs: config.requestTimeoutMs,
    onRetry: (attempt, delay, reason) => progress(verbose, `retry ${attempt} in ${delay}ms: ${reason}`),
    adaptive: {
      minRequestsPerSecond: Math.max(0.1, config.requestsPerSecond / 8),
      onRateChange: (rps, reason) => progress(verbose, `rate -> ${rps.toFixed(3)}/s (${reason})`),
    },
  })
  const cache = buildCache(config.cacheDir, getBool(values, 'no-cache'))
  const reader = new HttpChainReader(http, rpcUrlsOrPlaceholder(config, false))
  const chain = await reader.chainId()
  if (chain !== VENUE.chainId) {
    throw new CliError(
      `RPC endpoint reports chain ${chain}, protocol config pins ${VENUE.chainId}. Refusing to measure the wrong chain.`,
    )
  }
  const head = await reader.getBlockHeader('latest')

  let fromBlock: bigint
  if (state.lastScannedBlock === '0') {
    const fromUnix = head.timestampUnix - bootstrapDays * SECONDS_PER_DAY
    fromBlock = await findBlockAtOrAfter(reader, fromUnix, { low: 1n, high: head.number })
    state.scannedFromDayUnix = dayStartUnix(fromUnix) + SECONDS_PER_DAY
  } else {
    fromBlock = BigInt(state.lastScannedBlock) + 1n
  }
  const uncapped = head.number
  const toBlock = uncapped - fromBlock + 1n > BigInt(maxBlocks) ? fromBlock + BigInt(maxBlocks) - 1n : uncapped
  const caughtUp = toBlock >= uncapped

  let credits: EscrowCredit[] = []
  if (toBlock >= fromBlock) {
    const backend = buildEscrowBackend(config, {
      reader,
      http,
      cache,
      exactTimestamps: false,
      anchorSpacing: Math.floor(getNumber(values, 'anchor-spacing', 10_000)),
      onProgress: (message) => progress(verbose, message),
      checkpointDir: join(TOOLS_DIR, '.checkpoints'),
      batchSize: Math.max(1, Math.floor(getNumber(values, 'rpc-batch', DEFAULT_SCAN_BATCH_SIZE))),
      ...(verbose ? { onScanProgress: (p) => process.stderr.write(`${formatScanProgress(p, 'credits')}\n`) } : {}),
    })
    progress(verbose, `scanning blocks ${fromBlock}..${toBlock} (${toBlock - fromBlock + 1n} blocks)`)
    credits = await backend.fetch({
      escrow,
      events: resolveCreditEvents(mode, {}),
      fromBlock,
      toBlock,
      fromUnix: state.lastScannedBlockUnix,
      toUnix: head.timestampUnix,
    })
    foldCredits(state, credits)
    const endHeader = toBlock === head.number ? head : await reader.getBlockHeader(toBlock)
    state.lastScannedBlock = toBlock.toString()
    state.lastScannedBlockUnix = endHeader.timestampUnix
  }
  pruneState(state, prices)

  // --- the reading --------------------------------------------------------
  const nowUnix = Math.floor(Date.now() / 1000)
  const standing = standingAtGate(state, prices, { gate, windowDays: medianWindow })
  progress(verbose, `standing at gate: ${standing.count ?? `>=${standing.floor} (refused)`}`)

  let capture: CaptureSummary | null = null
  let captureRows: RecipientClassification[] = []
  if (captureMode === 'live' && standing.recipients.length > 0) {
    const read = await readCapture(
      chainCodeReader(reader, Math.max(1, Math.floor(getNumber(values, 'rpc-batch', DEFAULT_SCAN_BATCH_SIZE)))),
      standing.recipients,
      nowUnix,
      { overRefusedStanding: standing.refused },
    )
    capture = read.summary
    captureRows = read.rows
  } else if (captureMode === 'file' && capturePath !== undefined) {
    const recorded = parseJson<{ rows?: RecipientClassification[] }>(await readFile(capturePath, 'utf8'))
    captureRows = recorded.rows ?? []
    capture = summarizeCapture(captureRows, {
      readAtUnix: nowUnix,
      source: 'file',
      unreadable: 0,
      overRefusedStanding: standing.refused,
    })
  }

  const winnableT1 =
    standing.count === undefined || capture === null
      ? null
      : Math.round(standing.count * capture.winnableShare)

  const dailyTotals = buildDailyTotals(state, prices)
  const lastComplete = [...dailyTotals].reverse().find((d) => d.complete)

  const economicsInputs: RepriceInputs = {
    tenureDays: getNumber(values, 'tenure-days', Number.NaN),
    buybackOnRate: 0,
    operatorBps: getNumber(values, 'operator-bps', TERMS.operatorBps),
    qfPerDayUsd: gate,
    tier,
    cogsPerDayUsd: TIERS[tier].cogsPerDay,
    budgetBps: TERMS.budgetBpsDefault,
    fixedCostMonthlyUsd: getNumber(values, 'fixed-cost-monthly-usd', 12_000),
    cacUsd: 0,
    onboardingCostUsd: 0,
    clientsAboveGate: winnableT1 ?? undefined,
    winRate,
    goThreshold: 20,
    stopThreshold: 40,
  }
  const { verdict, headline: verdictHeadline, feasibilityRatio } = decideVerdict(
    economicsInputs,
    flipPoint,
    winnableT1,
  )

  const nativePrice = prices.priceOf(NATIVE_ASSET_ADDRESS) ?? null
  const observation: WatchObservation = {
    atUnix: nowUnix,
    headBlock: head.number.toString(),
    headBlockUnix: head.timestampUnix,
    scannedFromDayUnix: state.scannedFromDayUnix,
    scannedThroughDayUnix: scannedThroughDayUnix(state),
    gateQfPerDay: gate,
    medianWindowDays: medianWindow,
    standingT1: standing.count ?? null,
    standingT1Floor: standing.floor,
    standingRefused: standing.refused,
    standingRefusedReason: standing.refusedReason ?? null,
    capture,
    winnableT1,
    escrowDailyTotalUsd: lastComplete?.usd ?? null,
    escrowDailyTotalDayUnix: lastComplete?.dayUnix ?? null,
    ethPriceUsd: nativePrice,
    priceSource: prices.source,
    flipPointPopulation: effectiveFlipPoint,
    feasibilityRatio,
    verdict,
    verdictHeadline,
  }

  const previous = state.observations[state.observations.length - 1]
  const movements: Movement[] = [
    movementOf('winnable T1 population', 'count', observation, previous, (o) => o.winnableT1),
    movementOf('standing T1 population', 'count', observation, previous, (o) => o.standingT1),
    movementOf('winnable share', 'ratio', observation, previous, (o) => o.capture?.winnableShare ?? null),
    movementOf('escrow daily credits', 'usd', observation, previous, (o) => o.escrowDailyTotalUsd),
    movementOf('ETH price', 'usd', observation, previous, (o) => o.ethPriceUsd),
    movementOf('feasibility ratio', 'ratio', observation, previous, (o) => o.feasibilityRatio),
  ]
  const crossing = flipPointCrossing(observation, previous, effectiveFlipPoint)

  if (!getBool(values, 'no-write')) {
    const maxObservations = Math.max(1, Math.floor(getNumber(values, 'max-observations', 400)))
    state.observations = [...state.observations, observation].slice(-maxObservations)
    await mkdir(dirname(statePath), { recursive: true })
    await writeFile(statePath, `${stringifyJson(state, 'string', 1)}\n`, 'utf8')
    progress(verbose, `state written to ${statePath}`)
  }

  const result: WatchResult = {
    observation,
    previousObservation: previous,
    observationsHeld: state.observations.length,
    movements,
    crossing,
    flipPoint,
    flipPointOverrideDisagreement,
    scan: {
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
      blocksScanned: toBlock >= fromBlock ? Number(toBlock - fromBlock + 1n) : 0,
      creditsFound: credits.length,
      caughtUp,
      seeded,
    },
    capture: captureRows.length > 0 ? { rows: captureRows } : null,
    dailyTotals,
  }

  const warnings: string[] = [
    'This is a MONITOR, not a re-measurement. It re-reads the inputs that decide the verdict; it does not re-derive tenure, the QF distribution or the cross-endpoint verification. tools/artifacts/OCTOBER-RERUN.md is the re-run and this does not replace it.',
    'The gas subsidy expires 2026-09-29. Movement measured before that date says nothing about the market after it, and the two series most likely to be subsidy artefacts are exactly the two on this report.',
  ]
  if (previous === undefined) {
    warnings.push(
      'This is the FIRST observation in this state, so every movement below is UNKNOWN rather than flat. There is nothing to diff against yet.',
    )
  }
  if (standing.refused) {
    warnings.push(
      `The standing count is REFUSED: ${standing.refusedReason}. The figure carried forward is a LOWER BOUND of ${standing.floor}, and the winnable population is UNKNOWN, which means the flip-point alarm cannot fire on this run.` +
        (assetsPath === undefined
          ? ' Pass --assets with a priced asset file (tools/token-metadata.ts --out-assets) to fix this.'
          : ''),
    )
  }
  if (capture === null) {
    warnings.push(
      `No capture read (--capture-mode ${captureMode}), so the winnable population is UNKNOWN. 44% of the gate-clearing population was contract-routed at the last measurement and 95% of those had no code path out; assuming the standing count is winnable overstates the market by that much.`,
    )
  } else if (capture.unreadable > 0) {
    warnings.push(
      `${capture.unreadable} standing recipient(s) had unreadable code and were left out of the capture classification entirely - neither winnable nor captured. The winnable share is computed over the ${capture.classified} that were read.`,
    )
  }
  if (!caughtUp) {
    warnings.push(
      `--max-blocks capped this run at block ${toBlock} against a head of ${uncapped}. The reading is BEHIND THE CHAIN by ${uncapped - toBlock} blocks; run again to catch up before quoting it.`,
    )
  }
  if (flipPointOverrideDisagreement !== null) warnings.push(flipPointOverrideDisagreement)

  const incompleteReasons: string[] = []
  if (standing.refused) incompleteReasons.push(`standing population refused: ${standing.refusedReason}`)
  if (winnableT1 === null) {
    incompleteReasons.push(
      'the winnable population - the one number this monitor exists to track - could not be measured, so the flip-point alarm did not run.',
    )
  }

  const report: Report<WatchResult> = {
    meta: {
      tool: SPEC.name,
      schemaVersion: SCHEMA_VERSION,
      generatedAtUnix: nowUnix,
      config: { ...describeConfig(config), escrow, mode, gate, medianWindow, retainDays, retainMinUsd, statePath, captureMode },
      io: { httpRequests: http.requestCount, cacheHits: cache.hits, cacheMisses: cache.misses },
      warnings,
      methodLimits: [
        'The standing population is counted over the recipients in the escrow credit stream, not over coins. VERDICT.md measured 146 recipients against ~125 true creator-leg coins: recipients include the protocol fee leg and some recipients serve several coins.',
        'A day is only read as a measurement once every block in it has been scanned. The current UTC day is always excluded, so the freshest complete reading is up to 24h behind the head.',
        'Recipient-days measured below the retention floor are DROPPED from the state. That is lossless for a gate at or above the floor and for an odd-length median window, and the tool refuses to answer for any gate below the floor rather than answering approximately.',
        'The capture read classifies the CREDIT RECIPIENT, not the hook’s launches() record. The two agreed for 115 of 125 coins at the last full reconciliation; this is the cheap daily proxy for it, not a replacement.',
        'A win rate is an assumption, not a measurement. It sets the flip point directly, so the alarm threshold inherits whatever the operator supplied.',
      ],
      measurementComplete: incompleteReasons.length === 0,
      ...(incompleteReasons.length > 0 ? { incompleteReasons } : {}),
    },
    result,
  }

  await emit(report, { json, outPath, human: (r) => renderHuman(r.result) })
}

function buildDailyTotals(
  state: WatchState,
  prices: PriceBook,
): Array<{ dayUnix: number; usd: number | null; credits: number; complete: boolean }> {
  const through = scannedThroughDayUnix(state)
  return Object.values(state.dayTotals)
    .sort((a, b) => a.dayUnix - b.dayUnix)
    .map((total) => ({
      dayUnix: total.dayUnix,
      usd: usdOfDayTotal(total, prices),
      credits: total.credits,
      complete: through !== null && total.dayUnix <= through,
    }))
}

/**
 * A movement value in the units it is actually in.
 *
 * A refused COUNT is UNKNOWN, not UNPRICED: format.ts reserves UNPRICED for an
 * amount that exists and could not be valued, and printing it against a
 * population count says the wrong thing about why the number is missing.
 */
function renderMetric(movement: Movement, value: number | null): string {
  if (value === null) return movement.unit === 'usd' ? UNPRICED : 'UNKNOWN'
  switch (movement.unit) {
    case 'usd':
      return usd(value)
    case 'ratio':
      return num(value, 3)
    default:
      return num(value, Number.isInteger(value) ? 0 : 2)
  }
}

function renderDirection(movement: Movement): string {
  switch (movement.direction) {
    case 'rising':
      return 'up'
    case 'falling':
      return 'down'
    case 'flat':
      return 'flat'
    default:
      return 'UNKNOWN'
  }
}

function renderHuman(result: WatchResult): string {
  const o = result.observation
  const lines: string[] = []
  lines.push(heading(`Market watch - ${isoDateTime(o.atUnix)}`))
  lines.push(
    `  head block ${o.headBlock} at ${isoDateTime(o.headBlockUnix)}; scanned ${result.scan.blocksScanned} block(s) this run` +
      `${result.scan.seeded ? ' after seeding' : ''}, ${result.scan.creditsFound} credit(s) found.`,
  )
  lines.push(
    `  complete UTC days in the window: ${
      o.scannedFromDayUnix === null || o.scannedThroughDayUnix === null
        ? 'none yet'
        : `${isoDate(o.scannedFromDayUnix)} .. ${isoDate(o.scannedThroughDayUnix)}`
    }.  observations held: ${result.observationsHeld}.`,
  )

  // The alert comes first. A monitor whose alarm is below the fold is a report.
  if (result.crossing.crossed !== null) {
    lines.push('')
    lines.push(
      banner([
        `ALERT: THE WINNABLE POPULATION CROSSED THE FLIP POINT ${result.crossing.crossed}.`,
        '',
        `${num(result.crossing.from, 0)} -> ${num(result.crossing.to, 0)} winnable coins against a flip point of ${num(result.crossing.flipPoint, 0)}.`,
        '',
        result.crossing.crossed === 'UPWARD'
          ? 'The market now supplies enough winnable coins to hold the book at these terms. That is a'
          : 'The market no longer supplies enough winnable coins to hold the book at these terms. That is a',
        result.crossing.crossed === 'UPWARD'
          ? 'necessary condition, not a GO: the other four gates in VERDICT.md are untouched by this,'
          : 'change in the binding constraint, and the book cannot be held at the size the fixed costs',
        result.crossing.crossed === 'UPWARD'
          ? 'and one crossing inside a gas subsidy is not a market.'
          : 'require. Stop acquiring before re-reading anything else.',
      ]),
    )
  } else if (result.crossing.undecidedReason !== null) {
    lines.push('')
    lines.push(
      banner([
        'THE FLIP-POINT ALARM DID NOT RUN.',
        '',
        result.crossing.undecidedReason,
        '',
        'This is not "no crossing". It is "the alarm could not be evaluated", which is the',
        'failure mode that looks exactly like good news.',
      ]),
    )
  }

  lines.push(subheading('Movement'))
  lines.push(
    table(result.movements, [
      { header: 'metric', value: (m) => m.metric },
      { header: 'now', align: 'right', value: (m) => renderMetric(m, m.current) },
      { header: 'prev', align: 'right', value: (m) => (m.previous === null ? 'n/a' : renderMetric(m, m.previous)) },
      { header: 'delta', align: 'right', value: (m) => (m.delta === null ? 'n/a' : renderMetric(m, m.delta)) },
      { header: 'per day', align: 'right', value: (m) => (m.perDay === null ? 'n/a' : renderMetric(m, m.perDay)) },
      { header: 'direction', value: renderDirection },
      { header: 'span (d)', align: 'right', value: (m) => (m.spanDays === null ? 'n/a' : num(m.spanDays, 2)) },
    ]),
  )
  lines.push('')
  lines.push(
    `  UNKNOWN in "now" means the metric could not be measured this run - it is not zero and it is not unchanged. ` +
      `${UNPRICED} means an amount exists and had no USD price. "n/a" means there was nothing to compare against.`,
  )

  lines.push(subheading('Against the flip point'))
  lines.push(
    `  winnable T1 population : ${o.winnableT1 === null ? 'UNKNOWN' : String(o.winnableT1)}` +
      `   flip point: ${o.flipPointPopulation === null ? 'n/a' : String(o.flipPointPopulation)}`,
  )
  lines.push(
    `  derived from ${usd(result.flipPoint.contributionPerClientDayUsd)}/day of contribution and ` +
      `${num(result.flipPoint.breakEvenConcurrentClients, 2)} concurrent clients at break-even.`,
  )
  if (o.winnableT1 !== null && o.flipPointPopulation !== null) {
    const shortfall = o.flipPointPopulation - o.winnableT1
    lines.push(
      shortfall > 0
        ? `  SHORT BY ${shortfall} coin(s).`
        : `  ABOVE the flip point by ${-shortfall} coin(s).`,
    )
    const rate = result.movements[0]?.perDay ?? null
    if (rate !== null && rate !== 0 && shortfall !== 0 && Math.sign(rate) === Math.sign(shortfall)) {
      lines.push(
        `  At the measured ${num(rate, 2)} coin(s)/day, that gap closes in ${num(Math.abs(shortfall / rate), 1)} day(s) - ` +
          'a straight-line extrapolation of two points, which is the weakest claim in this report.',
      )
    }
  }
  lines.push(
    `  standing at the gate   : ${o.standingT1 === null ? `UNKNOWN (lower bound ${o.standingT1Floor})` : String(o.standingT1)}`,
  )
  if (o.capture !== null) {
    lines.push(
      `  winnable share         : ${pct(o.capture.winnableShare)} over ${o.capture.classified} classified recipient(s), read ${isoDateTime(o.capture.readAtUnix)} (${o.capture.source}).` +
        (o.capture.overRefusedStanding
          ? ' MEASURED OVER THE LOWER-BOUND SUBSET, because the standing count was refused: it is a real share of a set that is not the population the decision is about.'
          : ''),
    )
    lines.push(
      `  by class               : ${Object.entries(o.capture.byClass)
        .sort((a, b) => b[1] - a[1])
        .map(([cls, n]) => `${cls} ${n}`)
        .join(', ')}`,
    )
  } else {
    lines.push('  winnable share         : UNKNOWN - no capture read on this run.')
  }

  lines.push(subheading('Escrow-wide daily credits'))
  const complete = result.dailyTotals.filter((d) => d.complete)
  lines.push(
    `  ${o.escrowDailyTotalDayUnix === null ? 'no complete day' : isoDate(o.escrowDailyTotalDayUnix)}: ${usd(o.escrowDailyTotalUsd)} across the whole escrow.`,
  )
  lines.push(`  ETH price ${usd(o.ethPriceUsd)} from ${o.priceSource}. Every USD figure above rests on it.`)
  if (complete.length > 0) {
    lines.push('')
    lines.push(`  ${sparkline(complete.map((d) => d.usd))}  (${complete.length} complete day(s), '?' = unpriced)`)
  }

  lines.push(subheading('Verdict on today’s inputs'))
  lines.push(`  ${o.verdict}: ${o.verdictHeadline}`)
  lines.push(
    `  feasibility ratio ${o.feasibilityRatio === null ? 'n/a' : num(o.feasibilityRatio, 3)}` +
      ' (winRate x winnable / break-even; invariant in tenure, which is why it can be reported without one).',
  )
  return lines.join('\n')
}

if (isEntrypoint(import.meta.url)) {
  await runCli(SPEC, process.argv.slice(2), main)
}

export { SPEC as WATCH_SPEC }
