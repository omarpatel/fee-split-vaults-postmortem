/**
 * Fee display arithmetic.
 *
 * This is a byte-for-byte mirror of CoinVault._splitOf in
 * contracts/src/CoinVault.sol. It exists so a figure quoted on the page can
 * never disagree with what settlement actually does, including in the rounding:
 *
 *     opGross    = amount * operatorBps / BPS      (floor)
 *     toBudget   = amount * budgetBps   / BPS      (floor)
 *     toDev      = amount - opGross - toBudget     (absorbs the remainder)
 *     toReferrer = opGross * referrerBps / BPS     (floor, out of the operator's own slice)
 *     toOperator = opGross - toReferrer
 *
 * Two properties fall out and both are tested: the four legs sum to `amount`
 * exactly with no dust escaping, and integer division can only ever round in
 * the dev's favour.
 *
 * THE FOUR LEGS ARE NEVER SUMMED INTO ONE "RETAINED" FIGURE. A page that shows
 * "you keep $X" after a service fee is the exact misrepresentation this product
 * is built to avoid, so there is no function here that produces such a number
 * and the presentation model below returns four labelled rows.
 */

import { creatorNetBps, devBps, TERMS } from '../protocol.js'
import { formatBps, type Minor } from './money.js'

const BPS = 10_000n

export interface SplitConfig {
  /** Immutable, in the salt preimage. */
  operatorBps: number
  /** The dev's dial, 0..budgetBpsMax. */
  budgetBps: number
  /** Share OF operatorBps. Never dilutes the dev. */
  referrerBps: number
}

export interface FeeSplit {
  dev: Minor
  budget: Minor
  operator: Minor
  referrer: Minor
}

export class FeeSplitError extends Error {
  constructor(message: string) {
    super(`fees: ${message}`)
    this.name = 'FeeSplitError'
  }
}

function assertBps(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new FeeSplitError(`${label} must be an integer in 0..10000, got ${value}`)
  }
}

/**
 * Split one credit. `charging` is false for a vault that is not ACTIVE and for
 * the launch token, both of which pass 100% to the dev on chain.
 */
export function splitCredit(amount: Minor, cfg: SplitConfig, charging = true): FeeSplit {
  if (amount < 0n) throw new FeeSplitError('cannot split a negative credit')
  assertBps('operatorBps', cfg.operatorBps)
  assertBps('budgetBps', cfg.budgetBps)
  assertBps('referrerBps', cfg.referrerBps)
  if (cfg.operatorBps + cfg.budgetBps >= 10_000) {
    throw new FeeSplitError('operatorBps + budgetBps would leave the dev nothing')
  }

  if (!charging) return { dev: amount, budget: 0n, operator: 0n, referrer: 0n }

  const opGross = (amount * BigInt(cfg.operatorBps)) / BPS
  const budget = (amount * BigInt(cfg.budgetBps)) / BPS
  const dev = amount - opGross - budget
  const referrer = (opGross * BigInt(cfg.referrerBps)) / BPS
  const operator = opGross - referrer

  return { dev, budget, operator, referrer }
}

/** The dev's share of QF at a dial setting, in bps. Never hardcoded. */
export function devShareBps(cfg: Pick<SplitConfig, 'operatorBps' | 'budgetBps'>): number {
  // devBps() in config assumes TERMS.operatorBps. A deployed vault's rate is
  // frozen in its salt, so the vault's own operatorBps wins when it differs.
  return cfg.operatorBps === TERMS.operatorBps
    ? devBps(cfg.budgetBps)
    : 10_000 - cfg.operatorBps - cfg.budgetBps
}

/**
 * The break-even multiple for a dial setting: the multiple the service must
 * deliver on the dev's own fee flow before the dev is ahead of doing nothing.
 * config/protocol.ts owns the formula; this wrapper exists only to keep the
 * vault's own frozen operatorBps in play.
 */
export function breakEvenMultipleFor(cfg: Pick<SplitConfig, 'operatorBps' | 'budgetBps'>): number {
  const dev = devShareBps(cfg)
  if (dev <= 0) throw new FeeSplitError('dev share is zero; break-even is undefined')
  return 10_000 / dev
}

/**
 * The creator's net rate as bps OF TRADE VOLUME, for one token's configuration.
 *
 * This BRANCHES on buybackEnabled - 0.70% off, 0.35% on - and the branch is
 * resolved by config/protocol.ts, never by a constant in this app. A page that
 * printed a single creator rate would be wrong for half the member book.
 */
export function creatorRateBps(buybackEnabled: boolean, creatorTaxBps: number): number {
  return creatorNetBps(buybackEnabled, creatorTaxBps)
}

export interface FeeFlowRow {
  key: 'qf' | 'dev' | 'budget' | 'operator' | 'referrer'
  label: string
  /** What this leg is FOR, in the dev's language. Shown, not a tooltip. */
  note: string
  amount: Minor
  /** Present for the three split legs; absent for the QF total row. */
  bps?: number
  /** True only for the gross figure the split is taken from. */
  isSource: boolean
}

/**
 * The presentation model for the fee flow.
 *
 * Returns the received gross plus each leg as its own row. There is
 * deliberately no "retained" or "net to you after fees" row: summing the dev
 * leg and the budget leg would imply the budget is the dev's money to keep,
 * and summing the operator fee into anything would hide it.
 */
export function buildFeeFlowRows(qfGross: Minor, cfg: SplitConfig, charging = true): FeeFlowRow[] {
  const split = splitCredit(qfGross, cfg, charging)
  const rows: FeeFlowRow[] = [
    {
      key: 'qf',
      label: 'Creator fees received',
      note: 'Credited to this coin’s own vault. Gross, before any split.',
      amount: qfGross,
      isSource: true,
    },
    {
      key: 'dev',
      label: 'Dev leg',
      note: 'Withdrawable only by the dev’s own payout address. No operator key reaches it.',
      amount: split.dev,
      bps: charging ? devShareBps(cfg) : 10_000,
      isSource: false,
    },
    {
      key: 'budget',
      label: 'Procurement budget',
      note: 'Dev-elected. Spent on third-party media at cost, or refunded if unproven.',
      amount: split.budget,
      bps: charging ? cfg.budgetBps : 0,
      isSource: false,
    },
    {
      key: 'operator',
      label: 'Operator fee',
      note: 'Flat percentage of credited fees. This is what the operator is paid.',
      amount: split.operator,
      bps: charging ? cfg.operatorBps - Math.floor((cfg.operatorBps * cfg.referrerBps) / 10_000) : 0,
      isSource: false,
    },
  ]

  if (split.referrer > 0n || cfg.referrerBps > 0) {
    rows.push({
      key: 'referrer',
      label: 'Referrer',
      note: 'Paid out of the operator’s own slice. Does not dilute the dev.',
      amount: split.referrer,
      bps: charging ? Math.floor((cfg.operatorBps * cfg.referrerBps) / 10_000) : 0,
      isSource: false,
    })
  }

  return rows
}

/** Human label for a rate, e.g. "0.7% of volume". */
export function formatRate(bps: number, of: string): string {
  return `${formatBps(bps)} of ${of}`
}
