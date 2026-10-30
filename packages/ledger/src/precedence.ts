/**
 * Source precedence for income recognition.
 *
 * One fee is visible three or four times: as a curve event, as the hook's
 * PoolFeesSwept, as a credit inside the shared Venue fee escrow, and finally as
 * an ERC-20 transfer when the vault claims. Recognising each of them as income
 * triple-counts revenue, inflates QF, and lifts a coin into a tier it did not
 * earn. This module is the reason that cannot happen.
 *
 * THE RULE. For one accrual key, income equals the total observed by the
 * HIGHEST-PRECEDENCE source that has been seen. Lower-precedence observations of
 * the same key are recorded for audit and post nothing. A higher-precedence
 * source arriving later supersedes: the difference is posted as a correction and
 * the winning source changes.
 *
 * Precedence is ordered by attribution fidelity, not by arrival time:
 *
 *   curve_event       per-trade, carries the coin identifier
 *   pool_fees_swept   per-pool; poolId maps to token. Post-graduation this is
 *                     the only per-coin attribution that exists
 *   escrow_credit     shared depositor, no coin identifier; aggregate only
 *   erc20_transfer    movement, not attribution; says nothing about whose fee
 *
 * `manual` is deliberately absent. An operator assertion may reclassify, refund,
 * or correct, but it may never MINT income.
 */

import type { LedgerEntry } from '@fee-split-vaults/core'
import { PrecedenceError } from './errors.js'

export const INCOME_SOURCE_PRECEDENCE = [
  'curve_event',
  'pool_fees_swept',
  'escrow_credit',
  'erc20_transfer',
] as const

export type IncomeSource = (typeof INCOME_SOURCE_PRECEDENCE)[number]

/** Every value LedgerEntry.source may take, including the non-income one. */
export type EntrySource = LedgerEntry['source']

const RANK: ReadonlyMap<string, number> = new Map(
  INCOME_SOURCE_PRECEDENCE.map((s, i) => [s, i]),
)

export function isIncomeSource(value: unknown): value is IncomeSource {
  return typeof value === 'string' && RANK.has(value)
}

export function assertIncomeSource(value: unknown): IncomeSource {
  if (!isIncomeSource(value)) {
    throw new PrecedenceError(
      `${JSON.stringify(value)} is not an income source; income may only be recognised from ` +
        INCOME_SOURCE_PRECEDENCE.join(' > '),
    )
  }
  return value
}

/** Lower rank wins. Throws on anything outside the declared order. */
export function precedenceRank(source: unknown): number {
  const rank = RANK.get(assertIncomeSource(source))
  if (rank === undefined) throw new PrecedenceError('precedence table is inconsistent')
  return rank
}

export type PerSourceTotals = Partial<Record<IncomeSource, bigint>>

/** The source whose total is currently authoritative for an accrual key. */
export function winningSource(totals: PerSourceTotals): IncomeSource | undefined {
  let best: IncomeSource | undefined
  for (const source of INCOME_SOURCE_PRECEDENCE) {
    if (totals[source] !== undefined) {
      best = source
      break
    }
  }
  return best
}

export type RecognitionOutcome =
  /** Income moved: a first recognition, or an increase from the winning source. */
  | 'recognized'
  /** A higher-precedence source took over and the amount was corrected. */
  | 'superseded'
  /** A lower- or equal-precedence view of an already-recognised fee. No income. */
  | 'duplicate_ignored'
  /** This exact observation was already applied. Byte-identical no-op. */
  | 'replayed'
  /** The correction could not be posted without breaking a balance rule. */
  | 'refused_unbalanced'

export interface PrecedenceDecision {
  /** Source that owns recognition after this observation. */
  winner: IncomeSource
  /** Total the winner has observed for this accrual key. */
  targetMinor: bigint
  /** Signed change against what is currently recognised. */
  deltaMinor: bigint
  outcome: Exclude<RecognitionOutcome, 'replayed' | 'refused_unbalanced'>
  perSource: PerSourceTotals
}

export interface PrecedenceInput {
  /** Totals already observed per source for this accrual key. */
  perSource: PerSourceTotals
  /** Amount currently recognised as income for this accrual key. */
  recognizedMinor: bigint
  /** Source that currently owns recognition, if any. */
  recognizedSource?: IncomeSource
  /** The new observation. */
  source: IncomeSource
  amountMinor: bigint
}

/**
 * Pure decision function. It moves no money and touches no store, so the whole
 * anti-double-count rule is testable without a database.
 */
export function decideRecognition(input: PrecedenceInput): PrecedenceDecision {
  const source = assertIncomeSource(input.source)
  if (input.amountMinor <= 0n) {
    throw new PrecedenceError('observation amount must be a positive minor-unit integer')
  }

  const perSource: PerSourceTotals = { ...input.perSource }
  perSource[source] = (perSource[source] ?? 0n) + input.amountMinor

  const winner = winningSource(perSource)
  if (winner === undefined) throw new PrecedenceError('no winning source after observation')

  const targetMinor = perSource[winner] ?? 0n
  const deltaMinor = targetMinor - input.recognizedMinor

  let outcome: PrecedenceDecision['outcome']
  if (input.recognizedSource !== undefined && winner !== input.recognizedSource) {
    outcome = 'superseded'
  } else if (deltaMinor === 0n) {
    outcome = 'duplicate_ignored'
  } else {
    outcome = 'recognized'
  }

  return { winner, targetMinor, deltaMinor, perSource, outcome }
}
