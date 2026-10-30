/**
 * Alerting as code.
 *
 * An alert definition is not a threshold in a dashboard. It is four things
 * bound together and version-controlled next to the code they watch:
 *
 *   a PREDICATE over an explicit signal snapshot,
 *   a SEVERITY that says whether it wakes someone,
 *   an AUTO-ACTION the system takes without waiting for a human, and
 *   a RUNBOOK the responder opens.
 *
 * The last one is enforced: ops/monitoring/__tests__ fails if any definition
 * points at a runbook file that does not exist. An alert with no next step is
 * noise, and noise is how a real page gets ignored.
 */

import type { AlertId } from './ids.js'

export type AlertSeverity = 'page' | 'ticket' | 'info'

/**
 * What the system does on its own when the alert fires. Every one of these is a
 * RESTRICTION. There is deliberately no auto-action that spends, publishes, or
 * unblocks: automation may narrow the blast radius, never widen it.
 */
export type AutoAction =
  | 'none'
  | 'freeze_new_authorizations'
  | 'halt_publishing'
  | 'halt_paid_media'
  | 'disable_quote_asset'
  | 'suspend_vault'
  | 'throttle_model'
  | 'halt_sweeps'

export interface AlertFiring {
  alertId: AlertId
  severity: AlertSeverity
  /** Vault address, asset address, or 'fleet'. */
  scope: string
  summary: string
  runbook: string
  autoAction: AutoAction
  facts: Record<string, string | number | boolean>
}

export interface AlertDefinition {
  id: AlertId
  title: string
  severity: AlertSeverity
  /** Repo-relative path. Checked to exist by the test suite. */
  runbook: string
  /** The failure this exists to catch. Written for the person woken at 3am. */
  rationale: string
  autoAction: AutoAction
  /**
   * The condition must hold for this long before the alert fires. Zero means
   * fire on the first observation - correct for anything that is already a loss.
   */
  forSeconds: number
  evaluate(signals: OpsSignals): AlertFiring[]
}

// ---------------------------------------------------------------------------
// The signal snapshot
// ---------------------------------------------------------------------------

/**
 * Everything the alert predicates are allowed to see.
 *
 * It is a plain data structure, gathered by a collector and passed in, so the
 * whole alerting layer is a pure function of a snapshot and can be tested by
 * constructing one. No predicate reaches out to a database mid-evaluation.
 */
export interface OpsSignals {
  atUnix: number
  ledger: LedgerSignals
  chain: ChainSignals
  spend: SpendSignals
  publishing: PublishingSignals
  security: SecuritySignals
  tiers: TierSignals
  cost: CostSignals
  sweeps: SweepSignals
  ops: SchedulerSignals
}

export interface LedgerSignals {
  /** Variances currently classified critical and not yet cleared. */
  openCriticalVariances: Array<{ vault: string; asset: string; deltaMinor: string; detectedAtUnix: number }>
  /** Freezes currently in force. Used to avoid re-paging on an already-frozen scope. */
  activeFreezeScopes: string[]
  /** Unmatched sweeps older than the match interval, i.e. the three-way match is behind. */
  unmatchedSweepsOlderThanSeconds: number
}

export interface ChainSignals {
  /**
   * A CreatorFeeRecipientTransferred on a vault we still treat as active. This
   * means the fee stream has been redirected away from the vault: everything
   * downstream keeps accruing on paper and nothing arrives.
   */
  recipientTransfersOnActiveVaults: Array<{ vault: string; token: string; observedAtUnix: number; blockHash: string }>
  /**
   * The Venue owner's CreatorFeeRecipientChangeProposed timelock. When it fires,
   * the platform can move a creator's fee recipient. We need to know before it
   * executes, not after.
   */
  pendingRecipientChangeProposals: Array<{ token: string; proposedAtUnix: number; effectiveAtUnix: number }>
  /**
   * A paused quote-asset proxy. Every approved quote asset on this chain is an
   * upgradeable, pausable, issuer-controlled proxy, and a pause strands whatever
   * is sitting in the shared escrow.
   */
  pausedQuoteAssets: Array<{ asset: string; symbol: string; strandedEscrowUsd: number; pausedAtUnix: number }>
  /** Unix seconds at which the chain's gas subsidy is expected to end. */
  gasSubsidyExpiryUnix: number
}

export interface SpendSignals {
  denialsLastHour: number
  /** Trailing baseline the current hour is compared against. */
  denialsPerHourBaseline: number
  /** Denials broken out by the gate that failed, for triage. */
  denialsByGate: Record<string, number>
}

export interface PublishingSignals {
  publishesLastHour: number
  /**
   * A published post whose disclosure was NOT present when the live post was
   * re-fetched. The post is deleted automatically; the alert is because a
   * systematic read-back failure means we are publishing undisclosed promotion.
   */
  readBackFailuresLastHour: number
  /**
   * A channel account we can no longer post from. On X this is usually an
   * automation-policy suspension, and it takes the disclosed desk offline for
   * every coin bound to that account.
   */
  suspendedChannels: Array<{ channel: string; accountRef: string; detectedAtUnix: number; affectedVaults: number }>
}

export interface SecuritySignals {
  /**
   * Reader-plane or desk-plane detections of an injection attempt. Individually
   * expected and harmless - the airlock is the defense, not the detector - but a
   * spike is a campaign and a human should look.
   */
  injectionDetectorTripsLastHour: number
  injectionTripsBaselinePerHour: number
}

export interface TierSignals {
  /** Downgrades applied in the last day. */
  downgradesLastDay: Array<{ vault: string; from: string; to: string; qfPerDay: number }>
}

export interface CostSignals {
  /**
   * Measured inference spend per coin per day, against the tier's modelled COGS.
   * A coin costing more to serve than its tier assumes is a coin we are losing
   * money on, and at a median lifetime creator take of $15.73 there is no room.
   */
  perCoin: Array<{ vault: string; tier: string; inferenceUsdPerDay: number; tierCogsPerDay: number }>
}

export interface SweepSignals {
  /** Per vault-asset: how long since a successful sweep. */
  stalest: Array<{ scope: string; secondsSinceLastSweep: number; pendingUsd: number }>
  /** Per vault-asset: how long a swept balance has sat unsettled. */
  oldestUnsettledSeconds: number
}

export interface SchedulerSignals {
  openDeadLetters: number
  deadLettersByJob: Record<string, number>
  lastTickUnix: number
}

/** A snapshot with everything quiet. Tests build on it and change one field. */
export function emptySignals(atUnix: number): OpsSignals {
  return {
    atUnix,
    ledger: { openCriticalVariances: [], activeFreezeScopes: [], unmatchedSweepsOlderThanSeconds: 0 },
    chain: {
      recipientTransfersOnActiveVaults: [],
      pendingRecipientChangeProposals: [],
      pausedQuoteAssets: [],
      gasSubsidyExpiryUnix: atUnix + 365 * 24 * 3600,
    },
    spend: { denialsLastHour: 0, denialsPerHourBaseline: 0, denialsByGate: {} },
    publishing: { publishesLastHour: 0, readBackFailuresLastHour: 0, suspendedChannels: [] },
    security: { injectionDetectorTripsLastHour: 0, injectionTripsBaselinePerHour: 0 },
    tiers: { downgradesLastDay: [] },
    cost: { perCoin: [] },
    sweeps: { stalest: [], oldestUnsettledSeconds: 0 },
    ops: { openDeadLetters: 0, deadLettersByJob: {}, lastTickUnix: atUnix },
  }
}
