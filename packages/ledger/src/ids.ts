/**
 * Deterministic identity.
 *
 * Every id in this package is a pure function of the observation it describes.
 * Nothing derives from wall-clock time, insertion order, a counter, or a random
 * source, which is what makes replay a no-op: re-feeding the same chain logs
 * regenerates byte-identical ids and the store dedupes them.
 *
 * The canonical encoding joins fields with U+001F and REFUSES any field that
 * contains U+001F, so no two distinct field vectors can share an encoding. That
 * refusal is the whole reason the separator is not a comma.
 */

import { createHash } from 'node:crypto'
import type { LedgerAccount, LedgerEntry } from '@fee-split-vaults/core'
import { InvalidInputError } from './errors.js'

const SEP = '\u001f'
const ABSENT = '\u0000'

export type IdField = string | number | bigint | undefined | null

function encodeField(value: IdField, index: number): string {
  if (value === undefined || value === null) return ABSENT
  const s = typeof value === 'bigint' ? value.toString(10) : String(value)
  if (s.includes(SEP) || s.includes(ABSENT)) {
    throw new InvalidInputError(
      'id field contains a reserved separator character',
      `field[${index}]`,
    )
  }
  return s
}

/** sha256 over the canonical encoding, lowercase hex. */
export function canonicalDigest(fields: readonly IdField[]): string {
  const encoded = fields.map(encodeField).join(SEP)
  return createHash('sha256').update(encoded, 'utf8').digest('hex')
}

export interface EntryIdInput {
  /**
   * Identity of the thing being recorded: an observation id, a chain log
   * coordinate, or an operator-supplied key. Two writes that describe the same
   * event MUST pass the same batchKey or the ledger will double-post.
   */
  batchKey: string
  /** Position within the batch. Batches are constructed deterministically. */
  index: number
  vault: string
  asset: string
  debit: LedgerAccount
  credit: LedgerAccount
  amountMinor: bigint
  occurredAtUnix: number
  source: LedgerEntry['source']
  blockHash?: string
  txHash?: string
  logIndex?: number
}

export function entryId(input: EntryIdInput): string {
  return `le_${canonicalDigest([
    'entry.v1',
    input.batchKey,
    input.index,
    input.vault,
    input.asset,
    input.debit,
    input.credit,
    input.amountMinor,
    input.occurredAtUnix,
    input.source,
    input.blockHash,
    input.txHash,
    input.logIndex,
  ])}`
}

/**
 * Identity of a fee observation, used for replay dedupe.
 *
 * The chain coordinate (txHash, logIndex) is included when present because two
 * genuinely different credits inside one accrual window are otherwise
 * indistinguishable and must accumulate rather than collapse.
 */
export interface ObservationIdInput {
  vault: string
  asset: string
  source: string
  amountMinor: bigint
  occurredAtUnix: number
  accrualKey: string
  blockHash?: string
  txHash?: string
  logIndex?: number
  /** Set when an observation has no chain coordinate at all (e.g. a backfill). */
  externalRef?: string
}

export function observationId(input: ObservationIdInput): string {
  return `ob_${canonicalDigest([
    'observation.v1',
    input.vault,
    input.asset,
    input.source,
    input.amountMinor,
    input.occurredAtUnix,
    input.accrualKey,
    input.blockHash,
    input.txHash,
    input.logIndex,
    input.externalRef,
  ])}`
}

/**
 * Accrual keys group the observations of ONE economic event across sources.
 *
 * They cannot be a transaction hash. The three views of a single fee land in
 * three different transactions at three different times: the hook sweeps, the
 * escrow credits, and the vault claims. The only join available is scope plus
 * period, which is what these helpers build.
 */
const DAY_SECONDS = 86_400

export function dayBucketUnix(occurredAtUnix: number): number {
  if (!Number.isFinite(occurredAtUnix) || occurredAtUnix < 0) {
    throw new InvalidInputError('occurredAtUnix must be a non-negative finite number', 'occurredAtUnix')
  }
  return Math.floor(occurredAtUnix / DAY_SECONDS) * DAY_SECONDS
}

/** Default grouping: one accrual per vault, asset and UTC day. */
export function dailyAccrualKey(vault: string, asset: string, occurredAtUnix: number): string {
  return `day:${vault}:${asset}:${dayBucketUnix(occurredAtUnix)}`
}

/**
 * Per-sweep grouping, keyed off the hook's PoolFeesSwept. Post-graduation this
 * is the ONLY per-coin attribution available: all clients share one escrow
 * depositor and no escrow event carries a coin identifier.
 */
export function sweepAccrualKey(poolId: string, asset: string, sweepSeq: number | string): string {
  return `sweep:${poolId}:${asset}:${sweepSeq}`
}

/** Stable key for a non-fee posting batch that has a chain coordinate. */
export function chainBatchKey(kind: string, txHash: string, logIndex: number): string {
  return `chain:${kind}:${txHash}:${logIndex}`
}
