/**
 * THE THING THAT ACTUALLY RUNS THE TEAMS.
 *
 * One Orchestrator, one CoinTicker per coin, held for the life of the process,
 * ticked one coin at a time by whatever is holding the clock - the ops
 * scheduler in production, the fleet CLI on a laptop.
 *
 * WHY THE TICKERS ARE HELD RATHER THAN REBUILT PER TICK. A CoinTicker owns its
 * coin's CostGovernor and its DivergenceDetector, and both are HISTORY. Rebuild
 * the ticker every tick and the day's inference spend resets to zero every
 * thirty minutes, and the divergence baseline - the thing that decides whether
 * this window's topic histogram looks steered - resets with it. An attacker who
 * could provoke a rebuild would get a free reset of the anomaly baseline. So the
 * Orchestrator is process-lifetime state and registration happens once.
 *
 * WHY ONE COIN PER CALL AND NOT tickAll(). Orchestrator.tickAll is sequential on
 * purpose, and its own comment says why: concurrency is unsafe until the SQL
 * ledger store does row locking. Nothing here changes that. The scheduler scopes
 * a run to ONE coin so that one coin's failure dead-letters alone, so this calls
 * require(coinRef).tick() and the sequencing is the scheduler's - it dispatches
 * runs one at a time. No concurrency is introduced anywhere in this file.
 *
 * WHY THE RUN KEY IS CHECKED FIRST. A tick can reach the spend path, and the
 * spend path can authorize a reimbursement pull. Re-running a tick under a run
 * key that already completed is how a client pays twice for one listing, so the
 * store is asked before anything else and a hit ends the attempt.
 */

import {
  Orchestrator,
  projectAgentRun,
  type AgentRunRecord,
  type CoinTickerConfig,
  type CoinTickerDeps,
} from '@fee-split-vaults/orchestrator'
import type { TierId } from '../../../config/protocol.js'
import type {
  FleetCoinRef,
  FleetRunner,
  FleetTickSummary,
  ModelProvenance,
} from '../../../ops/scheduler/ports.js'

/** One coin, ready to be registered on the Orchestrator. */
export interface RegisteredCoin {
  config: CoinTickerConfig
  deps: CoinTickerDeps
  /** The tier the ticker starts at. Updated in place as the tier moves. */
  tier: TierId
}

export interface FleetOptions {
  coins: ReadonlyMap<string, RegisteredCoin>
  store: {
    put(entry: { runKey: string; run: AgentRunRecord; faked: readonly string[]; recordedAtUnix: number }): Promise<void>
    findByRunKey(runKey: string): Promise<{ run: AgentRunRecord } | undefined>
    latest(vault: string): Promise<AgentRunRecord | undefined>
  }
  /** Written into every run record. Never recomputed from later configuration. */
  provenance: ModelProvenance
  /** Dependency names that are fakes in this process. Written per run. */
  faked: readonly string[]
  /**
   * Called before a coin ticks, with the instant the scheduler asked for. The
   * sandbox uses it to move its fixed clock and re-pin its price feed; a live
   * deployment uses it to refresh the real price book and drain the message
   * stream. May be async, because a real refresh is a network round trip.
   */
  prepare?: (coinRef: string, nowUnix: number) => void | Promise<void>
  /**
   * Refuse to tick when this returns a reason. The CLI's --dry-run uses it, so
   * that "dry run" is enforced in one place rather than by asking every
   * downstream port to please not do anything.
   */
  refuseTick?: (coinRef: string) => string | undefined
}

export class FleetTickRefused extends Error {
  constructor(
    readonly coinRef: string,
    readonly reason: string,
  ) {
    super(`fleet refused to tick ${coinRef}: ${reason}`)
    this.name = 'FleetTickRefused'
  }
}

export class Fleet implements FleetRunner {
  readonly #orchestrator = new Orchestrator()
  readonly #options: FleetOptions
  /** Last reported nextDueUnix per coin. Rebuilt from the store on a restart. */
  readonly #nextDue = new Map<string, number>()

  constructor(options: FleetOptions) {
    this.#options = options
  }

  get orchestrator(): Orchestrator {
    return this.#orchestrator
  }

  /** Coin refs this fleet holds. Never any of their state. */
  refs(): string[] {
    return [...this.#options.coins.keys()].sort()
  }

  async dueCoins(nowUnix: number): Promise<FleetCoinRef[]> {
    const out: FleetCoinRef[] = []
    for (const [coinRef, coin] of this.#options.coins) {
      const nextDueUnix = await this.#nextDueFor(coinRef, coin)
      if (nextDueUnix > nowUnix) continue
      out.push({ coinRef, vault: coin.config.vault, nextDueUnix })
    }
    return out.sort((a, b) => (a.coinRef < b.coinRef ? -1 : a.coinRef > b.coinRef ? 1 : 0))
  }

  /**
   * A coin with no history is DUE. "Never ticked" reads as due rather than as
   * "wait one interval", which is what makes a cold start catch the whole book
   * up instead of leaving it silent for the first window.
   */
  async #nextDueFor(coinRef: string, coin: RegisteredCoin): Promise<number> {
    const held = this.#nextDue.get(coinRef)
    if (held !== undefined) return held
    const latest = await this.#options.store.latest(coin.config.vault)
    const nextDueUnix = latest?.nextDueUnix ?? 0
    this.#nextDue.set(coinRef, nextDueUnix)
    return nextDueUnix
  }

  async findByRunKey(runKey: string): Promise<FleetTickSummary | undefined> {
    const held = await this.#options.store.findByRunKey(runKey)
    return held === undefined ? undefined : summarize(held.run, true)
  }

  /**
   * What the last ticks learned, and nothing else. Reads the in-memory map
   * only: a coin that has never ticked in this process is not represented,
   * which is what makes a cold start read as "nothing known" rather than
   * "due at zero" - dueCoins() is the call that consults the store.
   */
  earliestDueUnix(): number | undefined {
    let earliest: number | undefined
    for (const nextDueUnix of this.#nextDue.values()) {
      if (earliest === undefined || nextDueUnix < earliest) earliest = nextDueUnix
    }
    return earliest
  }

  async tick(input: { coinRef: string; nowUnix: number; runKey: string }): Promise<FleetTickSummary> {
    const replay = await this.findByRunKey(input.runKey)
    if (replay !== undefined) return replay

    const coin = this.#options.coins.get(input.coinRef)
    if (coin === undefined) throw new FleetTickRefused(input.coinRef, 'not a coin this fleet holds')

    const refusal = this.#options.refuseTick?.(input.coinRef)
    if (refusal !== undefined) throw new FleetTickRefused(input.coinRef, refusal)

    await this.#options.prepare?.(input.coinRef, input.nowUnix)

    const ticker =
      this.#orchestrator.get(input.coinRef) ??
      this.#orchestrator.register(coin.config, coin.deps, coin.tier)

    const result = await ticker.tick()

    // The tier the record is stamped with is the tier this tick RAN AT, taken
    // from the decision the tick made rather than from configuration that may
    // have moved underneath it.
    const tier = result.tier?.tier ?? coin.tier
    coin.tier = tier

    const record = projectAgentRun(result, {
      tier,
      modelProvenance: this.#options.provenance,
    })
    await this.#options.store.put({
      runKey: input.runKey,
      run: record,
      faked: this.#options.faked,
      recordedAtUnix: input.nowUnix,
    })
    this.#nextDue.set(input.coinRef, result.nextDueUnix)

    return summarize(record, false)
  }
}

/**
 * The record, narrowed to what the scheduler may see.
 *
 * Counts and machine codes only. Nothing that passed through a model and
 * nothing that came out of a holder's message crosses this boundary, because
 * the other side of it is a log line and a dead-letter row that a human reads
 * in a terminal.
 */
export function summarize(record: AgentRunRecord, replayed: boolean): FleetTickSummary {
  const disbursed = record.spends.filter((spend) => spend.status === 'disbursed').length
  const published = record.publishes.filter((attempt) => attempt.published).length
  const summary: FleetTickSummary = {
    coinRef: record.coinRef,
    vault: record.vault,
    tier: record.tier,
    atUnix: record.atUnix,
    replayed,
    ranChainPoll: record.ranChainPoll,
    ranCognition: record.ranCognition,
    proposals: record.proposals.length,
    suppressed: record.suppressed.length,
    refusals: record.refusals.map((refusal) => `${refusal.phase}:${refusal.code}`),
    disbursed,
    spendsRefused: record.spends.length - disbursed,
    published,
    publishRejected: record.publishes.length - published,
    // An integer count of micro-USD. The meter's own unit is integer micro-USD
    // for the reason agent.ts gives; it is not converted to dollars here.
    inferenceMicroUsd: Number(record.cost.microUsd),
    degradeLevel: record.cost.degradeLevel,
    modelProvenance: record.modelProvenance,
    nextDueUnix: record.nextDueUnix,
  }
  if (record.digest !== undefined) {
    summary.windowId = record.digest.windowId
    summary.admittedMessages = record.digest.admittedMessageCount
  }
  return summary
}
