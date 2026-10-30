/**
 * Pilot domain types.
 *
 * Section 9 is the gate that decides whether the business should exist. The
 * pilot is a FREE service whose TIMING is randomized; nothing here may acquire
 * a fee, a budget, a vault or a spending authority. The config type encodes
 * that as literal types so a non-zero take rate is a compile error before it is
 * a runtime refusal.
 */

import type { Address, AssetAddress, PoolId, TxHash, UsdValue } from '@fee-split-vaults/core'

export type Arm = 'STAFFED' | 'UNSTAFFED'

export type BlockPhase = 'RANDOMIZED' | 'FULL_COVERAGE'

/**
 * Pilot parameters. `takeBps`, `budgetBps`, `requiresVault` and
 * `requiresContract` are literal types, not settings: the pilot is free by
 * construction. Changing any of them changes the ethics of the study and must
 * therefore change this type.
 */
export interface PilotConfig {
  pilotId: string
  /** Published before enrolment. The assignment is a pure function of it. */
  seed: string
  /** Day 0, UTC. Must sit exactly on a block boundary. */
  startUnix: number
  /** Total pilot length. 60 in the registered design. */
  totalDays: number
  /** Block length. 12 in the registered design. */
  blockHours: number
  /**
   * Days from the start whose blocks are randomized. Every later day is FULL
   * COVERAGE for every coin: we randomize WHEN a free service is provided,
   * never WHETHER.
   */
  randomizedDays: number
  /** The desk is never away for longer than this many consecutive blocks. */
  maxConsecutiveUnstaffedBlocks: number
  /** Bounded constrained-randomization redraws before the generator fails closed. */
  maxDrawAttempts: number

  readonly takeBps: 0
  readonly budgetBps: 0
  readonly requiresVault: false
  readonly requiresContract: false
}

export interface PilotCoin {
  /** Opaque, audit-stable identifier. Never derived from user content. */
  coinRef: string
  token: Address
  /**
   * Per-coin attribution is driven off the hook's PoolFeesSwept(poolId, ...).
   * Escrow events cannot carry a coin identifier post-graduation: all clients
   * share one depositor there.
   */
  poolId: PoolId
  /** Quote asset the Venue pool charges fees in. */
  quoteAsset: AssetAddress
  enrolledAtUnix: number
  /**
   * TokenLaunched timestamp. REQUIRED, because the registered anti-snipe
   * exclusion is defined relative to it: Venue charges 99% at t=0 decaying to
   * zero over roughly three seconds and that windfall reaches the fee recipient
   * along the ordinary rails. Without a launch time the exclusion cannot be
   * evaluated, and a window that cannot be screened must not be analysed.
   */
  launchedAtUnix: number
  /** Telegram chat the away notice is posted to, if the coin has one. */
  telegramChatRef?: string
  /** Optional pre-registered balancing stratum for the ETI sub-study. */
  baselineStratum?: string
  /**
   * First observed PoolFeesSwept: the observable moment of graduation, which is
   * also the moment the fee MECHANISM changes under the coin's own series.
   */
  graduatedAtUnix?: number
  /** When the coin's creator-fee recipient moved, if it moved during the trial. */
  recipientChangedAtUnix?: number
}

export interface BlockAssignment {
  coinRef: string
  blockIndex: number
  startUnix: number
  endUnixExclusive: number
  /** Stratification variable. Never an adjustment covariate. */
  hourOfDay: number
  /** Stratification variable. Never an adjustment covariate. */
  dayOfWeek: number
  phase: BlockPhase
  arm: Arm
  /**
   * Published so a third party can recompute the arm from the seed. The draw is
   * taken at the DAY level, so both blocks of a day carry the same key: the day
   * is a matched pair and the key decides which half of it is staffed.
   */
  drawKey: string
}

export interface StratumBalance {
  hourOfDay: number
  dayOfWeek: number
  staffed: number
  unstaffed: number
}

export interface AssignmentBalance {
  randomizedBlocks: number
  staffedRandomized: number
  unstaffedRandomized: number
  byHourOfDay: Array<{ hourOfDay: number; staffed: number; unstaffed: number }>
  byHourAndDay: StratumBalance[]
  maxConsecutiveUnstaffed: number
  fullCoverageBlocks: number
}

export interface CoinAssignment {
  coinRef: string
  /** Redraw index that satisfied the consecutive-absence constraint. */
  drawNonce: number
  blocks: BlockAssignment[]
  balance: AssignmentBalance
}

export interface PilotAssignment {
  pilotId: string
  seed: string
  configHash: string
  coins: CoinAssignment[]
  /** Commit this before the pilot starts. It pins every arm of every block. */
  assignmentHash: string
  generatedAtUnix: number
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

export interface FeeCredit {
  asset: AssetAddress
  /** Minor units. Never a float. */
  minor: bigint
  occurredAtUnix: number
  /** Reads are pinned by blockHash, never blockNumber. */
  blockHash: string
  txHash: TxHash
  logIndex: number
  /**
   * Which rail carried it. Absent means unknown, and the fee mechanism is then
   * inferred from the coin's graduation timestamp instead.
   */
  source?: 'curve_event' | 'pool_fees_swept'
  /**
   * Set by a source rich enough to classify per credit. When present it WINS
   * over the timestamp heuristic, because a source that can see the trade knows
   * better than a window boundary can.
   */
  classification?: 'trade' | 'anti_snipe_window'
}

export interface MembershipDelta {
  joins: number
  leaves: number
  membersEnd: number
}

// ---------------------------------------------------------------------------
// Contamination facts and the registered exclusions that read them
// ---------------------------------------------------------------------------

/**
 * Which rail the coin's creator fees arrived on during the window.
 *
 * Pre-graduation the fee is an explicit per-trade field on the per-launch
 * curve's own event; post-graduation it is an aggregated sweep keyed by poolId.
 * The two are not the same measurement: a sweep's timestamp is the sweep's, not
 * the trade's, so a coin that crosses this boundary mid-trial has a series whose
 * MEASUREMENT changed underneath it.
 */
export type FeeMechanism = 'PRE_GRADUATION_CURVE' | 'POST_GRADUATION_SWEEP' | 'MIXED' | 'NONE'

/**
 * The facts a registered exclusion rule is allowed to read.
 *
 * Recorded at MEASUREMENT time, from chain observation, never reconstructed at
 * analysis time. Every field here exists because some mechanism can put money
 * into the primary endpoint that a staffed desk did not cause; the exclusion
 * engine is the only consumer, and it is pre-registered.
 */
export interface BlockIntegrity {
  /** Seconds from the coin's launch to the START of the follow window. */
  secondsSinceLaunch: number
  /**
   * USD in this window the classifier attributed to the anti-snipe window
   * rather than to trade flow: inside ANTI_SNIPE_WINDOW_SECONDS of launch, or
   * an effective fee rate implausible for an ordinary trade.
   */
  antiSnipeUsd: number
  feeMechanism: FeeMechanism
  /** Seconds from the observed graduation to the window start. Absent: never seen. */
  graduationAgeSeconds?: number
  /** Unix time the creator-fee recipient moved, if it moved at or before this window. */
  recipientChangedAtUnix?: number
  /**
   * FALSE when a quote asset was paused, unapproved or unpriced. Such a window
   * is UNMEASURED, not zero: `primaryLog1pFeesUsd` is deliberately NaN so that
   * a failure to exclude it is a loud refusal rather than a silent zero.
   */
  valuationComplete: boolean
  /** Largest single fee credit as a share of the window's USD total. 0 when empty. */
  largestCreditShare: number
  /**
   * Did the desk actually do what the draw said? FALSE covers both directions:
   * an assigned-STAFFED block we failed to cover for our own reasons, and an
   * assigned-UNSTAFFED block somebody answered in anyway. The primary is
   * intention-to-treat and KEEPS these; a registered sensitivity drops them.
   */
  deliveredAsAssigned: boolean
}

/** Every exclusion the registered plan may apply to the primary endpoint. */
export type ExclusionRuleId =
  | 'non_randomized_phase'
  | 'unvalued_window'
  | 'launch_window_anti_snipe'
  | 'graduation_mechanism_change'
  | 'recipient_change'

/** Registered re-runs that are REPORTED and can never move the verdict. */
export type SensitivityAnalysisId = 'per_protocol_delivery' | 'whale_dominated_window'

export interface ExcludedBlock {
  coinRef: string
  blockIndex: number
  ruleId: ExclusionRuleId
}

/**
 * What the exclusion engine did, hashed. The analysis recomputes this from the
 * committed plan and refuses to run if a report supplied with the dataset does
 * not match, which is what stops an exclusion from being quietly added, dropped
 * or retuned between commitment and analysis.
 */
export interface ExclusionReport {
  /** Hash of the plan's exclusion rules and parameters alone. */
  planExclusionHash: string
  excluded: ExcludedBlock[]
  countsByRule: Array<{ ruleId: ExclusionRuleId; blocks: number }>
  observedBlocks: number
  keptBlocks: number
  /** Flagged, never dropped: outcome-conditioned exclusions can bias an effect. */
  whaleFlaggedBlocks: number
  undeliveredStaffedBlocks: number
  undeliveredUnstaffedBlocks: number
  undeliveredStaffedShare: number
  /** True when delivery failure exceeded the pre-registered ceiling. */
  deliveryCeilingBreached: boolean
  reportHash: string
}

/**
 * One randomized unit of observation.
 *
 * The primary endpoint is measured over the 12 hours FOLLOWING the block, which
 * is the next block's own span. That overlap is a property of the registered
 * design, not an oversight: `nextBlockArm` is recorded as a DIAGNOSTIC so the
 * carryover can be described in the report. It is not a covariate and the
 * analysis will refuse it as one.
 */
export interface BlockOutcome {
  coinRef: string
  blockIndex: number
  arm: Arm
  phase: BlockPhase
  hourOfDay: number
  dayOfWeek: number
  followWindowStartUnix: number
  followWindowEndUnixExclusive: number

  /** PRIMARY: log1p(quote-denominated Venue-pool creator fees, USD). */
  primaryLog1pFeesUsd: number
  feesUsd: UsdValue
  feesMinorByAsset: Array<{ asset: AssetAddress; minor: bigint }>

  uniqueNewBuyers: number
  membership: MembershipDelta
  /** Sum of the Digest topic code `unanswered_backlog`. Digest-only by design. */
  unansweredBacklog: number

  nextBlockArm: Arm | null

  /** REQUIRED. The registered exclusions are evaluated against exactly this. */
  integrity: BlockIntegrity
}

export interface PilotDataset {
  pilotId: string
  /** Must equal the committed assignment hash or the analysis refuses to run. */
  assignmentHash: string
  outcomes: BlockOutcome[]
  /** Earliest observation. Proves the plan hash predates data collection. */
  firstObservationUnix: number
  collectedAtUnix: number
  /**
   * The exclusion report the collecting pipeline produced, if it produced one.
   * The analysis recomputes the exclusions from the committed plan regardless
   * and REFUSES if this does not match, so an out-of-band filtering pass cannot
   * pass unnoticed.
   */
  exclusionReport?: ExclusionReport
}

// ---------------------------------------------------------------------------
// ETI sub-study
// ---------------------------------------------------------------------------

export type EtiCohort = 'EARLY' | 'LATE'

export interface EtiAssignmentEntry {
  coinRef: string
  cohort: EtiCohort
  /** When the operator buys the listing for this coin. */
  purchaseAtUnix: number
  drawKey: string
  stratum: string
}

export interface EtiTrialAssignment {
  pilotId: string
  seed: string
  /** Common boundary: EARLY buys here, LATE is still untreated. */
  earlyPurchaseUnix: number
  /** LATE buys here. The control lag. */
  latePurchaseUnix: number
  lagDays: number
  entries: EtiAssignmentEntry[]
  assignmentHash: string
}
