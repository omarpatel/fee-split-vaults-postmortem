/**
 * Schedule and threshold parameters.
 *
 * These are OPERATIONAL numbers, not economic ones. Nothing here is a rate, a
 * split, or a fee: those live in config/protocol.ts and are reached through
 * ops/lib/protocol.ts. If a number in this file starts to look like a price, it
 * is in the wrong file.
 *
 * THE GAS ASSUMPTION IS LOAD-BEARING AND HAS AN EXPIRY. Every measurement behind
 * sweepValueThresholdUsd was taken inside the Robinhood Chain gas subsidy, which
 * ends around 29 September 2026. When it ends, the cost of a claim stops being
 * negligible and the threshold has to be re-derived from a real gas quote or the
 * sweep job will spend more on gas than it claims. GAS_SUBSIDY_EXPIRY_UNIX is
 * monitored (ops/monitoring/alerts.ts) precisely so that this cannot be
 * forgotten.
 */

import { DAY, HOUR, MINUTE } from '../lib/time.js'

/** ~29 September 2026, 00:00 UTC. */
export const GAS_SUBSIDY_EXPIRY_UNIX = Date.UTC(2026, 8, 29) / 1000

export const SWEEP = {
  /**
   * Claim as soon as a vault's unclaimed escrow is worth this much, without
   * waiting for the forced interval. Sized well above a subsidised claim's cost
   * and well below a day of a T1 coin's accrual, so a healthy coin sweeps on
   * value and a quiet one sweeps on the clock.
   */
  valueThresholdUsd: 50,
  /**
   * The forced interval. Even a dust balance is claimed daily, because escrow
   * credits sit in a shared, upgradeable, pausable contract we do not control:
   * time in escrow is the exposure, and a pause strands whatever is in there.
   */
  forcedIntervalSeconds: 24 * HOUR,
  /** How often the trigger is evaluated. Cheap: it is a read of cached credits. */
  evaluateEverySeconds: 10 * MINUTE,
  /** Refuse to claim more than this many chunks in one run; the rest waits a tick. */
  maxChunksPerRun: 8,
  /** A claim that lands short by more than this fraction raises a variance. */
  shortfallToleranceBps: 5,
  /**
   * An executor outbox row that has not been touched for this long belongs to
   * an attempt that died. Equal to the job's lease, so a live attempt is never
   * mistaken for a dead one: its lease would have expired first.
   */
  outboxStaleSeconds: 10 * MINUTE,
} as const

export const HEARTBEAT = {
  /** How often each vault's dead-man clock is read. Cheap: one pinned view. */
  evaluateEverySeconds: 6 * HOUR,
  /**
   * Send heartbeat() once operator silence reaches this fraction of the
   * contract's DEAD_MAN window (TERMS.deadManDays). A quarter leaves three
   * more chances before anyone may call emergencyDevRelease.
   */
  silenceFractionOfDeadMan: 4,
} as const

export const PUBLISHING_HEALTH = {
  /**
   * How often each bound X account's standing is probed. A quarter of the
   * freshness bound the publisher applies (HEALTH_MAX_AGE_SECONDS, 24h), so
   * three consecutive missed probes are needed before a healthy account is
   * refused for staleness.
   */
  probeEverySeconds: 6 * HOUR,
} as const

export const SETTLE = {
  /** Settlement follows a sweep. The interval is the safety net, not the trigger. */
  intervalSeconds: 6 * HOUR,
} as const

export const RECONCILIATION = {
  /** Continuous structural checks: cheap, in-process, no chain reads. */
  structuralEverySeconds: 5 * MINUTE,
  /** Per-sweep three-way match. Polls for sweeps that have no match yet. */
  sweepMatchEverySeconds: 2 * MINUTE,
  sweepMatchBatch: 50,
  /**
   * A sweep is offered to the three-way match only once it is this old. The
   * `received` and `ledger_recognized` legs come from the chain scan, which
   * runs on the fleet tick's cadence; matching a sweep the scan has not had a
   * chance to see would report a MISSING leg - correctly critical, and a
   * false page. The grace is what separates "the scan is behind" from "the
   * money never landed".
   */
  sweepMatchGraceSeconds: 15 * MINUTE,
  /** DAILY trial-balance recompute, diffed against the materialized table. */
  trialBalanceAtUtcHour: 2,
  trialBalanceAtUtcMinute: 0,
  /** WEEKLY clean-room recompute. Sunday 03:00 UTC. */
  cleanRoomDayOfWeekUtc: 0,
  cleanRoomAtUtcHour: 3,
  /** 5% sample of the book, PLUS 100% of top-tier coins. Both, not either. */
  cleanRoomSamplePct: 5,
  cleanRoomTopTier: 'T3',
} as const

export const TIERING = {
  /** Re-evaluate on the trailing 7-day median once a day, staggered per vault. */
  evaluateEverySeconds: 1 * DAY,
  /**
   * A downgrade takes effect only after the gate has been missed for this long.
   * Asymmetric on purpose: an upgrade needs sustainedDays at the gate, and a
   * downgrade needs patience, because a single quiet day is not a tier change
   * and yo-yoing a client's service level is worse than being slightly generous.
   */
  downgradeGraceDays: 3,
  /**
   * Conjuncts an UPGRADE must also clear. Wash trading can manufacture fee flow;
   * it cannot cheaply manufacture breadth or deconcentration, so these are the
   * cheap half of the qualification test and they only ever block a promotion -
   * never trigger a demotion, because a coin that got quiet is not a fraud.
   */
  upgradeConjuncts: {
    minUniqueBuyers7d: 50,
    maxTop10HolderSharePct: 60,
    maxDeployerSupplySharePct: 20,
    maxSelfTradeSharePct: 25,
    /**
     * Venue-pool volume as a share of observed volume. Below this the coin has
     * migrated its liquidity and its headline volume is not fee-bearing. Phase 0
     * measured a 122x gap between headline and Venue-pool volume on a winner.
     */
    minVenuePoolVolumeSharePct: 20,
    minCoinAgeDays: 3,
  },
} as const

export const PREDICATES = {
  /** How often the due queue is drained. Offsets are per-SKU, in the spec. */
  pollEverySeconds: 15 * MINUTE,
  batchSize: 100,
  /**
   * KOL checks at T+24h and T+7d. Present here as an assertion target, not as a
   * source of truth: the offsets come from each SKU's DeliveryPredicateSpec, and
   * the job asserts that a kol_post spec contains both.
   */
  requiredKolOffsetsSeconds: [24 * HOUR, 7 * DAY],
} as const

export const REPORTING = {
  /** Weekly dev report: Monday 09:00 UTC. */
  dayOfWeekUtc: 1,
  atUtcHour: 9,
  /**
   * Unexecuted commitments publish on a lag so the report is not a front-runnable
   * purchase calendar. Mirrors Receipt.publishAfterUnix.
   */
  unexecutedCommitmentLagSeconds: 72 * HOUR,
} as const

export const RESCREENING = {
  /** Event-driven, with this as the safety net if the watcher misses an event. */
  sweepEverySeconds: 30 * MINUTE,
  batchSize: 200,
} as const

export const FLEET = {
  /**
   * How often the fleet's due list is evaluated. This is the SCHEDULER's grid,
   * not a coin's cadence: each coin reports its own nextDueUnix and is skipped
   * until that instant, so this number only bounds how late a coin can be woken
   * after it becomes due. Five minutes against a 30-minute cognition window.
   */
  evaluateEverySeconds: 5 * MINUTE,
  /**
   * How long a tick may run before the attempt is abandoned. A tick makes at
   * most two model calls and a bounded set of store reads; anything past this
   * is a hung dependency, and hanging on to the lease helps nobody.
   */
  tickTimeoutSeconds: 300,
} as const

/** Vault states the operations plane treats as live for money-moving jobs. */
export const MONEY_JOB_STATES = ['ACTIVE'] as const

/** Vault states that still get reconciled and reported on. A suspended coin still owes a ledger. */
export const OBSERVED_STATES = ['BOUND', 'PENDING', 'ACTIVE', 'SUSPENDED', 'POISONED'] as const
