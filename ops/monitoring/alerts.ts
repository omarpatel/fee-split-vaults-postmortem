/**
 * THE ALERT CATALOG.
 *
 * Ordered roughly by how much money is on fire. Each definition states the
 * failure it catches, because the thing that makes an alert useful at 3am is not
 * its threshold, it is knowing what the threshold means.
 */

import { HOUR, DAY } from '../lib/time.js'
import { SWEEP_STALL_SECONDS } from '../scheduler/jobs/escrow-sweep.js'
import { RECONCILIATION, SETTLE } from '../scheduler/config.js'
import type { AlertDefinition, AlertFiring, OpsSignals } from './types.js'

const RB = (name: string): string => `ops/runbooks/${name}`

// ---------------------------------------------------------------------------

export const ledgerVarianceCritical: AlertDefinition = {
  id: 'ledger_variance_critical',
  title: 'Ledger variance in the critical band',
  severity: 'page',
  runbook: RB('ledger-variance-critical.md'),
  rationale:
    'The books and the chain disagree by more than the critical threshold, or an internal invariant broke. ' +
    'Every downstream number - tier gates, spend caps, the dev report - is derived from the ledger, so an ' +
    'unexplained variance means we may be authorizing spend against money that is not there.',
  autoAction: 'freeze_new_authorizations',
  forSeconds: 0,
  evaluate(signals: OpsSignals): AlertFiring[] {
    return signals.ledger.openCriticalVariances.map((variance) => ({
      alertId: 'ledger_variance_critical' as const,
      severity: 'page' as const,
      scope: variance.vault,
      summary: `Critical ledger variance on ${variance.vault} / ${variance.asset}`,
      runbook: RB('ledger-variance-critical.md'),
      autoAction: 'freeze_new_authorizations' as const,
      facts: {
        vault: variance.vault,
        asset: variance.asset,
        delta_minor: variance.deltaMinor,
        detected_at_unix: variance.detectedAtUnix,
        age_seconds: signals.atUnix - variance.detectedAtUnix,
        already_frozen: signals.ledger.activeFreezeScopes.includes(variance.vault),
      },
    }))
  },
}

export const vaultRecipientTransferred: AlertDefinition = {
  id: 'vault_recipient_transferred',
  title: 'Creator fee recipient transferred away from an active vault',
  severity: 'page',
  runbook: RB('stranded-escrow-balance.md'),
  rationale:
    'The coin’s creator-fee recipiency no longer points at our vault. New fees route somewhere else and any ' +
    'balance still credited to the vault inside the shared escrow may be unreachable, because the Venue escrow ' +
    'is msg.sender-only with no claim-on-behalf. This is a client exit, a compromise, or a mistake, and all ' +
    'three need a human within minutes.',
  autoAction: 'freeze_new_authorizations',
  forSeconds: 0,
  evaluate(signals: OpsSignals): AlertFiring[] {
    return signals.chain.recipientTransfersOnActiveVaults.map((transfer) => ({
      alertId: 'vault_recipient_transferred' as const,
      severity: 'page' as const,
      scope: transfer.vault,
      summary: `Fee recipient transferred away from active vault ${transfer.vault}`,
      runbook: RB('stranded-escrow-balance.md'),
      autoAction: 'freeze_new_authorizations' as const,
      facts: {
        vault: transfer.vault,
        token: transfer.token,
        observed_at_unix: transfer.observedAtUnix,
        block_hash: transfer.blockHash,
      },
    }))
  },
}

/**
 * The platform-risk alert. Venue's owner can propose a creator-fee recipient
 * change behind a timelock; when that timelock is close to firing, the fee
 * stream for the named token can be redirected by someone who is not the client
 * and not us. Fires EARLY - a page after it executes is a post-mortem.
 */
export const venueRecipientChangeTimelockFiring: AlertDefinition = {
  id: 'venue_recipient_change_timelock_firing',
  title: 'Venue owner’s CreatorFeeRecipientChangeProposed timelock is about to fire',
  severity: 'page',
  runbook: RB('stranded-escrow-balance.md'),
  rationale:
    'The launchpad owner has proposed changing a creator-fee recipient and the timelock is close to expiry. ' +
    'On execution the fee stream for that token moves regardless of the vault, the consent, or the client’s ' +
    'wishes. The window between the proposal and the execution is the entire opportunity to respond.',
  autoAction: 'none',
  forSeconds: 0,
  evaluate(signals: OpsSignals): AlertFiring[] {
    const warnWithin = 24 * HOUR
    return signals.chain.pendingRecipientChangeProposals
      .filter((p) => p.effectiveAtUnix - signals.atUnix <= warnWithin)
      .map((p) => ({
        alertId: 'venue_recipient_change_timelock_firing' as const,
        severity: 'page' as const,
        scope: p.token,
        summary: `Recipient-change timelock for ${p.token} fires in ${Math.max(0, Math.round((p.effectiveAtUnix - signals.atUnix) / 3600))}h`,
        runbook: RB('stranded-escrow-balance.md'),
        autoAction: 'none' as const,
        facts: {
          token: p.token,
          proposed_at_unix: p.proposedAtUnix,
          effective_at_unix: p.effectiveAtUnix,
          seconds_remaining: Math.max(0, p.effectiveAtUnix - signals.atUnix),
        },
      }))
  },
}

export const quoteAssetProxyPaused: AlertDefinition = {
  id: 'quote_asset_proxy_paused',
  title: 'A quote-asset proxy is paused; escrow is stranded',
  severity: 'page',
  runbook: RB('paused-quote-asset.md'),
  rationale:
    'Every approved quote asset on this chain is an upgradeable, pausable, issuer-controlled proxy. A pause ' +
    'means claims revert and whatever is credited in the shared escrow cannot be withdrawn. The immediate ' +
    'action is to stop accepting and claiming that asset so the failure does not become a retry storm.',
  autoAction: 'disable_quote_asset',
  forSeconds: 0,
  evaluate(signals: OpsSignals): AlertFiring[] {
    return signals.chain.pausedQuoteAssets.map((asset) => ({
      alertId: 'quote_asset_proxy_paused' as const,
      severity: 'page' as const,
      scope: asset.asset,
      summary: `Quote asset ${asset.symbol} is paused; ~$${asset.strandedEscrowUsd.toFixed(0)} stranded in escrow`,
      runbook: RB('paused-quote-asset.md'),
      autoAction: 'disable_quote_asset' as const,
      facts: {
        asset: asset.asset,
        symbol: asset.symbol,
        stranded_escrow_usd: asset.strandedEscrowUsd,
        paused_at_unix: asset.pausedAtUnix,
      },
    }))
  },
}

export const disclosureReadBackFailure: AlertDefinition = {
  id: 'disclosure_readback_failure',
  title: 'Published post failed its disclosure read-back',
  severity: 'page',
  runbook: RB('prompt-injection-incident.md'),
  rationale:
    'After publishing, the live post is re-fetched and checked for the disclosure token. A failure means a ' +
    'promotional message went out without the disclosure the FTC Endorsement Guides, Securities Act 17(b), ' +
    'EU AI Act Art. 50 and CA SB 1001 all require IN the communication. The single post is deleted ' +
    'automatically; a run of them means the injection path is broken and publishing must stop.',
  autoAction: 'halt_publishing',
  forSeconds: 0,
  evaluate(signals: OpsSignals): AlertFiring[] {
    const failures = signals.publishing.readBackFailuresLastHour
    if (failures === 0) return []
    // Any failure at all is a page. The rate only decides the wording.
    const rate = signals.publishing.publishesLastHour > 0 ? failures / signals.publishing.publishesLastHour : 1
    return [
      {
        alertId: 'disclosure_readback_failure',
        severity: 'page',
        scope: 'fleet',
        summary: `${failures} post(s) failed disclosure read-back in the last hour`,
        runbook: RB('prompt-injection-incident.md'),
        autoAction: 'halt_publishing',
        facts: {
          failures,
          publishes: signals.publishing.publishesLastHour,
          failure_rate_pct: Number((rate * 100).toFixed(1)),
        },
      },
    ]
  },
}

export const injectionDetectorTrip: AlertDefinition = {
  id: 'injection_detector_trip',
  title: 'Prompt-injection detector tripping above baseline',
  severity: 'ticket',
  runbook: RB('prompt-injection-incident.md'),
  rationale:
    'The airlock, not the detector, is the defense: the reader has no tools and the planner never sees raw ' +
    'text. A trip is therefore not an incident on its own. A SPIKE is - it means someone is working on us, ' +
    'and the response is to look at what they are aiming at before they find the one hole.',
  autoAction: 'none',
  forSeconds: 15 * 60,
  evaluate(signals: OpsSignals): AlertFiring[] {
    const { injectionDetectorTripsLastHour: trips, injectionTripsBaselinePerHour: baseline } = signals.security
    // Absolute floor as well as a multiple, so a baseline of zero does not make
    // one lone trip look like a 100x campaign.
    if (trips < 10) return []
    if (trips < Math.max(10, baseline * 5)) return []
    return [
      {
        alertId: 'injection_detector_trip',
        severity: 'ticket',
        scope: 'fleet',
        summary: `Injection detector tripped ${trips} times in the last hour (baseline ${baseline})`,
        runbook: RB('prompt-injection-incident.md'),
        autoAction: 'none',
        facts: { trips, baseline },
      },
    ]
  },
}

export const publishingChannelSuspended: AlertDefinition = {
  id: 'publishing_channel_suspended',
  title: 'A publishing channel account is suspended',
  severity: 'page',
  runbook: RB('x-account-suspension.md'),
  rationale:
    'The disclosed desk cannot speak. Every coin bound to that account loses its support channel at once, and ' +
    'the mitigation is bounded by policy rather than by engineering: exactly one ticker per account, no ' +
    'covert accounts, and no evasion of a platform’s enforcement. Queue the work, tell the affected clients, ' +
    'and appeal - do not spin up a replacement account.',
  autoAction: 'halt_publishing',
  forSeconds: 0,
  evaluate(signals: OpsSignals): AlertFiring[] {
    return signals.publishing.suspendedChannels.map((channel) => ({
      alertId: 'publishing_channel_suspended' as const,
      severity: 'page' as const,
      scope: channel.accountRef,
      summary: `${channel.channel} account ${channel.accountRef} is suspended (${channel.affectedVaults} coin(s) affected)`,
      runbook: RB('x-account-suspension.md'),
      autoAction: 'halt_publishing' as const,
      facts: {
        channel: channel.channel,
        account_ref: channel.accountRef,
        affected_vaults: channel.affectedVaults,
        detected_at_unix: channel.detectedAtUnix,
      },
    }))
  },
}

export const spendGateDenialsSpiking: AlertDefinition = {
  id: 'spend_gate_denials_spiking',
  title: 'Spend-gate denials spiking',
  severity: 'ticket',
  runbook: RB('prompt-injection-incident.md'),
  rationale:
    'The broker denying spend is the system working. A spike means something upstream is repeatedly asking ' +
    'for money it cannot have - a compromised planner, a bad catalog, or a stale policy token - and the gate ' +
    'is the only thing standing in the way. Look at WHICH gate is failing: a spike in the commitment-rule ' +
    'gate is a very different incident from a spike in vendor reliability.',
  autoAction: 'none',
  forSeconds: 10 * 60,
  evaluate(signals: OpsSignals): AlertFiring[] {
    const { denialsLastHour: denials, denialsPerHourBaseline: baseline } = signals.spend
    if (denials < 20) return []
    if (denials < Math.max(20, baseline * 4)) return []
    const topGate = Object.entries(signals.spend.denialsByGate).sort((a, b) => b[1] - a[1])[0]
    return [
      {
        alertId: 'spend_gate_denials_spiking',
        severity: 'ticket',
        scope: 'fleet',
        summary: `${denials} spend-gate denials in the last hour (baseline ${baseline})`,
        runbook: RB('prompt-injection-incident.md'),
        autoAction: 'none',
        facts: {
          denials,
          baseline,
          top_gate: topGate?.[0] ?? 'unknown',
          top_gate_count: topGate?.[1] ?? 0,
        },
      },
    ]
  },
}

export const tierGateCrossedDownward: AlertDefinition = {
  id: 'tier_gate_crossed_downward',
  title: 'A coin dropped below its tier gate',
  severity: 'ticket',
  runbook: RB('tier-downgrade.md'),
  rationale:
    'A downgrade cuts the service the client is receiving and it is applied automatically after the grace ' +
    'period. The client must hear it from us before they notice it themselves. Given a measured mean age of ' +
    '2.14 days for the above-gate stock, this will be a common event, not a rare one.',
  autoAction: 'none',
  forSeconds: 0,
  evaluate(signals: OpsSignals): AlertFiring[] {
    return signals.tiers.downgradesLastDay.map((d) => ({
      alertId: 'tier_gate_crossed_downward' as const,
      severity: 'ticket' as const,
      scope: d.vault,
      summary: `${d.vault} downgraded ${d.from} -> ${d.to}`,
      runbook: RB('tier-downgrade.md'),
      autoAction: 'none' as const,
      facts: { vault: d.vault, from: d.from, to: d.to, qf_per_day: Number(d.qfPerDay.toFixed(2)) },
    }))
  },
}

export const inferenceCostOverTierCogs: AlertDefinition = {
  id: 'inference_cost_over_tier_cogs',
  title: 'Inference cost for a coin exceeds its tier’s modelled COGS',
  severity: 'ticket',
  runbook: RB('tier-downgrade.md'),
  rationale:
    'Each tier carries a modelled cost to serve and the model plane is instrumented per coin from day one. A ' +
    'coin costing more than its tier assumes is a coin we lose money on every day it stays. With a median ' +
    'lifetime creator take of $15.73 across the platform, there is no margin to absorb it quietly.',
  autoAction: 'throttle_model',
  forSeconds: 60 * 60,
  evaluate(signals: OpsSignals): AlertFiring[] {
    return signals.cost.perCoin
      .filter((c) => c.tierCogsPerDay > 0 && c.inferenceUsdPerDay > c.tierCogsPerDay)
      .map((c) => ({
        alertId: 'inference_cost_over_tier_cogs' as const,
        severity: 'ticket' as const,
        scope: c.vault,
        summary: `${c.vault} inference $${c.inferenceUsdPerDay.toFixed(2)}/day exceeds ${c.tier} COGS $${c.tierCogsPerDay.toFixed(2)}/day`,
        runbook: RB('tier-downgrade.md'),
        autoAction: 'throttle_model' as const,
        facts: {
          vault: c.vault,
          tier: c.tier,
          inference_usd_per_day: Number(c.inferenceUsdPerDay.toFixed(4)),
          tier_cogs_per_day: c.tierCogsPerDay,
          overrun_pct: Number((((c.inferenceUsdPerDay - c.tierCogsPerDay) / c.tierCogsPerDay) * 100).toFixed(1)),
        },
      }))
  },
}

// ---------------------------------------------------------------------------
// Delivery and vendors
// ---------------------------------------------------------------------------

export const deliveryPredicateFailed: AlertDefinition = {
  id: 'delivery_predicate_failed',
  title: 'A funded SKU failed its delivery predicate',
  severity: 'ticket',
  runbook: RB('vendor-non-delivery-dispute.md'),
  rationale:
    'The purchase was funded and the machine check says it was not delivered. Payment is withheld ' +
    'automatically; the ticket exists so someone opens the dispute inside the vendor’s own window.',
  autoAction: 'none',
  forSeconds: 0,
  // Raised directly by the delivery-predicates job, which has the per-check
  // detail. There is no aggregate signal to evaluate here.
  evaluate: () => [],
}

export const kolPostDeletedOrUndisclosed: AlertDefinition = {
  id: 'kol_post_deleted_or_undisclosed',
  title: 'Paid KOL post is gone or lost its disclosure at T+7d',
  severity: 'page',
  runbook: RB('vendor-non-delivery-dispute.md'),
  rationale:
    'The post existed at T+24h and does not exist - or no longer carries the disclosure - at T+7d. That is ' +
    'both a non-delivery and a live disclosure defect on a communication we paid for. It has to be recorded ' +
    'in the client’s receipts and disclosed in the weekly report, not quietly refunded.',
  autoAction: 'none',
  forSeconds: 0,
  evaluate: () => [],
}

export const skuPredicateMisconfigured: AlertDefinition = {
  id: 'sku_predicate_misconfigured',
  title: 'A funded KOL SKU is missing a mandatory verification offset',
  severity: 'page',
  runbook: RB('vendor-non-delivery-dispute.md'),
  rationale:
    'No SKU without a predicate, and no KOL predicate without both the T+24h and the T+7d checks. A funded ' +
    'SKU missing one is a purchase we cannot verify, which means a receipt we cannot publish honestly.',
  autoAction: 'halt_paid_media',
  forSeconds: 0,
  evaluate: () => [],
}

export const procurementReceiptMissing: AlertDefinition = {
  id: 'procurement_receipt_missing',
  title: 'A delivery check passed but the procurement receipt it should re-issue does not exist',
  severity: 'ticket',
  runbook: RB('vendor-non-delivery-dispute.md'),
  rationale:
    'Every funded purchase writes a withheld procurement receipt in the same tick; the first passing delivery ' +
    'check re-issues it as delivered so the client’s public record shows what was bought and proven. A pass ' +
    'with no receipt to re-issue means a purchase the record never saw - a ledger/receipt divergence, not a ' +
    'vendor problem - and the client’s receipt page is silently incomplete until someone reconciles it.',
  autoAction: 'none',
  forSeconds: 0,
  evaluate: () => [],
}

// ---------------------------------------------------------------------------
// Client lifecycle
// ---------------------------------------------------------------------------

export const screeningBlockedAfterMetadataChange: AlertDefinition = {
  id: 'screening_blocked_after_metadata_change',
  title: 'A live client changed metadata into a BLOCKED verdict',
  severity: 'page',
  runbook: RB('client-rug-post-activation.md'),
  rationale:
    'Clean at signup, infringing by Thursday. The vault is suspended automatically; the page is because a ' +
    'BLOCKED verdict on a live client has publishing, contractual and reputational consequences that all ' +
    'need a human in the same hour.',
  autoAction: 'suspend_vault',
  forSeconds: 0,
  evaluate: () => [],
}

export const screeningRestrictedAfterMetadataChange: AlertDefinition = {
  id: 'screening_restricted_after_metadata_change',
  title: 'A live client changed metadata into a RESTRICTED verdict',
  severity: 'ticket',
  runbook: RB('client-rug-post-activation.md'),
  rationale:
    'RESTRICTED permits organic operations but no paid media. Paid media is suspended automatically; the ' +
    'ticket is to tell the client why their campaign stopped before they ask.',
  autoAction: 'halt_paid_media',
  forSeconds: 0,
  evaluate: () => [],
}

// ---------------------------------------------------------------------------
// Money-path liveness
// ---------------------------------------------------------------------------

export const escrowSweepStalled: AlertDefinition = {
  id: 'escrow_sweep_stalled',
  title: 'Escrow has not been swept within the forced interval',
  severity: 'page',
  runbook: RB('stranded-escrow-balance.md'),
  rationale:
    'The forced 24h sweep exists because time in a shared, pausable escrow is counterparty exposure. If it ' +
    'has not run, either the job is wedged or claims are reverting - and a reverting claim is usually the ' +
    'first symptom of a paused asset or a transferred recipient.',
  autoAction: 'none',
  forSeconds: 0,
  evaluate(signals: OpsSignals): AlertFiring[] {
    return signals.sweeps.stalest
      .filter((s) => s.secondsSinceLastSweep > SWEEP_STALL_SECONDS)
      .map((s) => ({
        alertId: 'escrow_sweep_stalled' as const,
        severity: 'page' as const,
        scope: s.scope,
        summary: `No successful sweep for ${s.scope} in ${Math.round(s.secondsSinceLastSweep / 3600)}h`,
        runbook: RB('stranded-escrow-balance.md'),
        autoAction: 'none' as const,
        facts: {
          scope: s.scope,
          seconds_since_last_sweep: s.secondsSinceLastSweep,
          pending_usd: s.pendingUsd,
        },
      }))
  },
}

export const sweepShortfall: AlertDefinition = {
  id: 'sweep_shortfall',
  title: 'An escrow claim landed short of the credited amount',
  severity: 'ticket',
  runbook: RB('stranded-escrow-balance.md'),
  rationale:
    'The claim succeeded but less arrived than the escrow said was credited. A fee-on-transfer asset, a ' +
    'partial pause, or an accounting error - all three need the three-way match consulted before the next ' +
    'settlement allocates money that did not arrive.',
  autoAction: 'none',
  forSeconds: 0,
  evaluate: () => [],
}

export const settlementStalled: AlertDefinition = {
  id: 'settlement_stalled',
  title: 'Swept funds have sat unsettled beyond the safety interval',
  severity: 'ticket',
  runbook: RB('ledger-variance-critical.md'),
  rationale:
    'Swept but unallocated money means the dev’s claimable leg is understated and the procurement budget is ' +
    'unavailable. Usually a wedged settle job; occasionally a corrupt dial that the job is right to refuse.',
  autoAction: 'none',
  forSeconds: 0,
  evaluate(signals: OpsSignals): AlertFiring[] {
    const threshold = SETTLE.intervalSeconds * 4
    if (signals.sweeps.oldestUnsettledSeconds <= threshold) return []
    return [
      {
        alertId: 'settlement_stalled',
        severity: 'ticket',
        scope: 'fleet',
        summary: `Oldest unsettled balance is ${Math.round(signals.sweeps.oldestUnsettledSeconds / 3600)}h old`,
        runbook: RB('ledger-variance-critical.md'),
        autoAction: 'none',
        facts: { oldest_unsettled_seconds: signals.sweeps.oldestUnsettledSeconds, threshold_seconds: threshold },
      },
    ]
  },
}

// ---------------------------------------------------------------------------
// Platform assumptions and the ops plane itself
// ---------------------------------------------------------------------------

/**
 * Every measurement behind the sweep threshold was taken inside the Robinhood
 * Chain gas subsidy. This alert exists so that its expiry is a scheduled piece
 * of work rather than a surprise in the ledger.
 */
export const gasSubsidyExpiryApproaching: AlertDefinition = {
  id: 'gas_subsidy_expiry_approaching',
  title: 'The chain gas subsidy is approaching expiry',
  severity: 'ticket',
  runbook: RB('paused-quote-asset.md'),
  rationale:
    'The sweep value threshold, the forced-interval cadence and the unit economics of every small claim were ' +
    'all measured while gas was subsidised. When the subsidy ends, a claim costs real money and sweeping a ' +
    'dust balance can cost more than it recovers. Re-derive the thresholds from a live gas quote before it ' +
    'lapses, not after.',
  autoAction: 'none',
  forSeconds: 0,
  evaluate(signals: OpsSignals): AlertFiring[] {
    const remaining = signals.chain.gasSubsidyExpiryUnix - signals.atUnix
    if (remaining > 30 * DAY) return []
    return [
      {
        alertId: 'gas_subsidy_expiry_approaching',
        severity: remaining <= 7 * DAY ? 'page' : 'ticket',
        scope: 'fleet',
        summary: `Gas subsidy expires in ${Math.max(0, Math.round(remaining / DAY))} day(s); sweep thresholds need re-deriving`,
        runbook: RB('paused-quote-asset.md'),
        autoAction: 'none',
        facts: {
          expiry_unix: signals.chain.gasSubsidyExpiryUnix,
          days_remaining: Math.max(0, Math.round(remaining / DAY)),
        },
      },
    ]
  },
}

export const deadLetterBacklog: AlertDefinition = {
  id: 'dead_letter_backlog',
  title: 'Dead-letter queue is growing',
  severity: 'ticket',
  runbook: RB('ledger-variance-critical.md'),
  rationale:
    'A dead letter is a job that gave up. Nothing retries it. One is a bad afternoon; a backlog means a job ' +
    'class is failing systematically and work is silently not happening.',
  autoAction: 'none',
  forSeconds: 0,
  evaluate(signals: OpsSignals): AlertFiring[] {
    if (signals.ops.openDeadLetters < 5) return []
    const worst = Object.entries(signals.ops.deadLettersByJob).sort((a, b) => b[1] - a[1])[0]
    return [
      {
        alertId: 'dead_letter_backlog',
        severity: signals.ops.openDeadLetters >= 25 ? 'page' : 'ticket',
        scope: 'fleet',
        summary: `${signals.ops.openDeadLetters} unresolved dead letters`,
        runbook: RB('ledger-variance-critical.md'),
        autoAction: 'none',
        facts: {
          open: signals.ops.openDeadLetters,
          worst_job: worst?.[0] ?? 'unknown',
          worst_job_count: worst?.[1] ?? 0,
        },
      },
    ]
  },
}

export const schedulerTickStalled: AlertDefinition = {
  id: 'scheduler_tick_stalled',
  title: 'The scheduler has not ticked',
  severity: 'page',
  runbook: RB('ledger-variance-critical.md'),
  rationale:
    'If the scheduler is not ticking, nothing in this document is running: not the sweep, not the ' +
    'reconciliation, not the delivery re-checks. Everything else here is downstream of this one alert.',
  autoAction: 'none',
  forSeconds: 0,
  evaluate(signals: OpsSignals): AlertFiring[] {
    const stalled = signals.atUnix - signals.ops.lastTickUnix
    const threshold = Math.max(RECONCILIATION.sweepMatchEverySeconds * 5, 10 * 60)
    if (stalled <= threshold) return []
    return [
      {
        alertId: 'scheduler_tick_stalled',
        severity: 'page',
        scope: 'fleet',
        summary: `No scheduler tick for ${Math.round(stalled / 60)} minutes`,
        runbook: RB('ledger-variance-critical.md'),
        autoAction: 'none',
        facts: { seconds_since_tick: stalled, threshold_seconds: threshold },
      },
    ]
  },
}

// ---------------------------------------------------------------------------

export const ALERTS: readonly AlertDefinition[] = [
  ledgerVarianceCritical,
  vaultRecipientTransferred,
  venueRecipientChangeTimelockFiring,
  quoteAssetProxyPaused,
  disclosureReadBackFailure,
  injectionDetectorTrip,
  publishingChannelSuspended,
  spendGateDenialsSpiking,
  tierGateCrossedDownward,
  inferenceCostOverTierCogs,
  deliveryPredicateFailed,
  kolPostDeletedOrUndisclosed,
  skuPredicateMisconfigured,
  procurementReceiptMissing,
  screeningBlockedAfterMetadataChange,
  screeningRestrictedAfterMetadataChange,
  escrowSweepStalled,
  sweepShortfall,
  settlementStalled,
  gasSubsidyExpiryApproaching,
  deadLetterBacklog,
  schedulerTickStalled,
]
