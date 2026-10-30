/**
 * Alert identifiers.
 *
 * A closed union, in a file with no imports, so both the scheduler (which raises
 * alerts) and the monitoring catalog (which defines them) can depend on it
 * without a cycle. The consequence that matters: a job cannot raise an alert
 * that has no definition and therefore no runbook, because the type will not
 * compile. An alert with no runbook is a page at 3am with no next step.
 */

export const ALERT_IDS = [
  // Money and books
  'ledger_variance_critical',
  'sweep_shortfall',
  'escrow_sweep_stalled',
  'settlement_stalled',

  // Chain-level threats to the fee path
  'vault_recipient_transferred',
  'venue_recipient_change_timelock_firing',
  'quote_asset_proxy_paused',

  // Spend controls
  'spend_gate_denials_spiking',
  'inference_cost_over_tier_cogs',

  // Publishing and disclosure
  'disclosure_readback_failure',
  'injection_detector_trip',
  'publishing_channel_suspended',

  // Delivery and vendors
  'delivery_predicate_failed',
  'kol_post_deleted_or_undisclosed',
  'sku_predicate_misconfigured',
  'procurement_receipt_missing',

  // Client lifecycle
  'tier_gate_crossed_downward',
  'screening_blocked_after_metadata_change',
  'screening_restricted_after_metadata_change',

  // Platform assumptions
  'gas_subsidy_expiry_approaching',

  // The operations plane itself
  'dead_letter_backlog',
  'scheduler_tick_stalled',
] as const

export type AlertId = (typeof ALERT_IDS)[number]

export function isAlertId(value: string): value is AlertId {
  return (ALERT_IDS as readonly string[]).includes(value)
}
