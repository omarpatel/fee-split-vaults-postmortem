/**
 * The fleet: a registry of per-coin tickers and the one genuinely fleet-scoped
 * piece of state, the spend counters.
 *
 * Two of the broker's gates are about the WHOLE client book - one vendor's
 * spend across every coin per day, and the total number of disbursements per
 * day - so they cannot be answered from per-coin state. That is the only shared
 * mutable object here, it returns numbers rather than identities, and no coin's
 * tick can read another coin's rows through it.
 *
 * Everything else is per-coin by construction: `require(coinRef)` is the only
 * way to reach a ticker, and it throws on a ref the fleet does not hold.
 */

import type { Address } from '@fee-split-vaults/core'
import type { SkuCategory } from '@fee-split-vaults/broker'
import type { TierId } from '../../../config/protocol.js'
import { CoinTicker, type CoinTickResult, type CoinTickerConfig, type CoinTickerDeps } from './coin.js'
import { CoinIsolationError } from './errors.js'
import type { FleetCounters, FleetDisbursementRecord } from './ports.js'

const DAY_SECONDS = 86_400
const HOUR_SECONDS = 3_600

function dayKey(unix: number): number {
  return Math.floor(unix / DAY_SECONDS)
}

/**
 * In-memory fleet counters.
 *
 * The production implementation is the same shape over a shared store. Note the
 * READ side is what the gates use, so a counter store that is unreachable must
 * throw rather than return zero: the broker treats a stale counter as unknown
 * and unknown means no spend, but a confident zero would open every cap.
 */
export class InMemoryFleetCounters implements FleetCounters {
  readonly #disbursements: FleetDisbursementRecord[] = []
  readonly #proposals: Array<{ vault: Address; atUnix: number }> = []

  async disbursementsToday(nowUnix: number): Promise<number> {
    const d = dayKey(nowUnix)
    return this.#disbursements.filter((r) => dayKey(r.atUnix) === d).length
  }

  async disbursementsTodayForVault(vault: Address, nowUnix: number): Promise<number> {
    const d = dayKey(nowUnix)
    return this.#disbursements.filter((r) => r.vault === vault && dayKey(r.atUnix) === d).length
  }

  async vendorSpendTodayCents(vendorId: string, nowUnix: number): Promise<bigint> {
    const d = dayKey(nowUnix)
    let total = 0n
    for (const r of this.#disbursements) {
      if (r.vendorId === vendorId && dayKey(r.atUnix) === d) total += r.amountCents
    }
    return total
  }

  async vendorDisbursementsTodayForVault(
    vault: Address,
    vendorId: string,
    nowUnix: number,
  ): Promise<number> {
    const d = dayKey(nowUnix)
    return this.#disbursements.filter(
      (r) => r.vault === vault && r.vendorId === vendorId && dayKey(r.atUnix) === d,
    ).length
  }

  async proposalsLastHour(vault: Address, nowUnix: number): Promise<number> {
    return this.#proposals.filter((p) => p.vault === vault && p.atUnix > nowUnix - HOUR_SECONDS)
      .length
  }

  async relatedPartySpend30dCents(vault: Address, nowUnix: number): Promise<bigint> {
    const from = nowUnix - 30 * DAY_SECONDS
    let total = 0n
    for (const r of this.#disbursements) {
      if (r.vault === vault && r.isRelatedParty && r.atUnix >= from) total += r.amountCents
    }
    return total
  }

  async categorySpend30dCents(
    vault: Address,
    nowUnix: number,
  ): Promise<Partial<Record<SkuCategory, bigint>>> {
    const from = nowUnix - 30 * DAY_SECONDS
    const totals: Partial<Record<SkuCategory, bigint>> = {}
    for (const r of this.#disbursements) {
      if (r.vault !== vault || r.atUnix < from) continue
      totals[r.category] = (totals[r.category] ?? 0n) + r.amountCents
    }
    return totals
  }

  async recordDisbursement(entry: FleetDisbursementRecord): Promise<void> {
    this.#disbursements.push(entry)
  }

  async recordProposal(vault: Address, atUnix: number): Promise<void> {
    this.#proposals.push({ vault, atUnix })
  }
}

export interface FleetTickResult {
  atUnix: number
  results: CoinTickResult[]
  /** Earliest instant any coin has work again. The scheduler sleeps to it. */
  nextDueUnix: number
  /** Coins whose tick threw. A throw here is a bug, and it is not swallowed. */
  failures: Array<{ coinRef: string; error: string }>
}

export class Orchestrator {
  readonly #tickers = new Map<string, CoinTicker>()

  register(config: CoinTickerConfig, deps: CoinTickerDeps, initialTier: TierId = 'T0'): CoinTicker {
    if (this.#tickers.has(config.coinRef)) {
      throw new CoinIsolationError(config.coinRef, config.coinRef, 'coinRef already registered')
    }
    // ONE VAULT, ONE TICKER. Two coin refs pointed at the same vault are not
    // two clients, they are one client's budget leg with two tickers drawing on
    // it - and because each tick builds its own BudgetLedgerView before the
    // other one's disbursement is written, the solvency and rolling caps are
    // both computed against a balance that the sibling is about to spend. A
    // measured run of exactly this shape drew $299 twice out of one $2,800
    // budget inside a single tickAll. It is refused at registration, which is
    // the only place the fleet can still see both of them at once.
    for (const [existingRef, existing] of this.#tickers) {
      if (existing.vault === config.vault) {
        throw new CoinIsolationError(
          existingRef,
          config.coinRef,
          `vault ${config.vault} is already ticked by ${existingRef}`,
        )
      }
    }
    const ticker = new CoinTicker(config, deps, initialTier)
    this.#tickers.set(config.coinRef, ticker)
    return ticker
  }

  get(coinRef: string): CoinTicker | undefined {
    return this.#tickers.get(coinRef)
  }

  require(coinRef: string): CoinTicker {
    const ticker = this.#tickers.get(coinRef)
    if (ticker === undefined) {
      throw new CoinIsolationError(coinRef, '<none>', 'no ticker registered for this coin')
    }
    return ticker
  }

  remove(coinRef: string): boolean {
    return this.#tickers.delete(coinRef)
  }

  get size(): number {
    return this.#tickers.size
  }

  refs(): string[] {
    return [...this.#tickers.keys()]
  }

  /**
   * Tick every coin.
   *
   * SEQUENTIALLY, on purpose. Concurrency here would let one coin's chain read
   * interleave with another's ledger write, and the ledger's own note says the
   * SQL store needs row locking before it is safe under real concurrency. When
   * that lands, this becomes a bounded-concurrency map and nothing else changes.
   */
  async tickAll(nowUnix: number): Promise<FleetTickResult> {
    const results: CoinTickResult[] = []
    const failures: FleetTickResult['failures'] = []
    let nextDue = Number.POSITIVE_INFINITY

    for (const [coinRef, ticker] of this.#tickers) {
      try {
        const result = await ticker.tick()
        results.push(result)
        nextDue = Math.min(nextDue, result.nextDueUnix)
      } catch (error) {
        // One coin failing must not stop the fleet, but it must be loud.
        failures.push({ coinRef, error: error instanceof Error ? error.message : String(error) })
      }
    }

    return {
      atUnix: nowUnix,
      results,
      nextDueUnix: Number.isFinite(nextDue) ? nextDue : nowUnix,
      failures,
    }
  }
}
