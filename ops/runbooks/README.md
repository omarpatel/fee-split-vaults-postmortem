# Runbooks

Eight incidents, written for the person who has just been woken up. Each one has
the same four sections, in the same order:

- **Detection** — what fired, and how to tell it apart from the thing it looks
  like.
- **Immediate actions** — what to do in the first ten minutes, numbered.
- **Decision points** — the judgement calls, with the reasoning that should drive
  them rather than a flowchart that will not fit the incident you actually have.
- **Commands** — the exact commands, with the dangerous ones marked.

`ops/monitoring/__tests__/alerts.spec.ts` fails the build if any alert points at
a runbook that does not exist, or at one that is missing any of those headings.
An alert with no next step is a page that gets ignored.

## The runbooks

| Runbook | Fires on | Auto-action |
| --- | --- | --- |
| [paused-quote-asset.md](paused-quote-asset.md) | `quote_asset_proxy_paused` | disable the asset |
| [stranded-escrow-balance.md](stranded-escrow-balance.md) | `vault_recipient_transferred`, `venue_recipient_change_timelock_firing`, `escrow_sweep_stalled`, `sweep_shortfall` | freeze new authorizations |
| [ledger-variance-critical.md](ledger-variance-critical.md) | `ledger_variance_critical`, `settlement_stalled`, `dead_letter_backlog`, `scheduler_tick_stalled` | freeze new authorizations |
| [client-rug-post-activation.md](client-rug-post-activation.md) | `screening_blocked_after_metadata_change`, `screening_restricted_after_metadata_change` | suspend the vault / halt paid promotion |
| [prompt-injection-incident.md](prompt-injection-incident.md) | `injection_detector_trip`, `spend_gate_denials_spiking`, `disclosure_readback_failure` | halt publishing |
| [x-account-suspension.md](x-account-suspension.md) | `publishing_channel_suspended` | halt publishing |
| [vendor-non-delivery-dispute.md](vendor-non-delivery-dispute.md) | `delivery_predicate_failed`, `kol_post_deleted_or_undisclosed`, `sku_predicate_misconfigured`, `procurement_receipt_missing` | withhold payment |
| [tier-downgrade.md](tier-downgrade.md) | `tier_gate_crossed_downward`, `inference_cost_over_tier_cogs` | throttle the model |

The alert definitions themselves are in
[`ops/monitoring/alerts.ts`](../monitoring/alerts.ts) — severity, auto-action,
the predicate, and a rationale written for the responder rather than for the
author.

## Rules that apply to every incident

These are not per-runbook judgement calls. They hold regardless of how the
incident is going, and every runbook below assumes them.

1. **The protocol never custodies the dev's money.** The dev leg is pull-only.
   No incident response involves moving a client's funds through an operator
   address, however convenient it would be.
2. **No third-party payee, ever.** The operator buys as principal and is
   reimbursed. If a fix requires paying someone new, it is not a fix.
3. **Disclosure is injected by code, in the communication.** No incident makes it
   acceptable to publish an undisclosed promotional message, and no notice about
   an incident goes out without the same disclosure.
4. **Fail closed.** When a backend cannot be reached, the job does not run and
   the gate does not open. If your fix is to make something proceed on
   uncertainty, it is the wrong fix.
5. **Do not delete history.** Published receipts and prior posts stay up. The
   ledger is append-only and a correction is a new entry, never an edit.
6. **Tell the client the same day, in the report.** The **what we did not do**
   section is where an incident belongs. A client who finds out from silence has
   learned something worse than the incident.

## Getting oriented during an incident

```bash
export DATABASE_URL=postgres://...

# What is the scheduler doing, and what has it given up on?
node ops/scheduler/status.js jobs
node ops/scheduler/status.js dead-letters
node ops/scheduler/status.js locks

# What is frozen, and why?
node ops/scheduler/status.js freezes

# Is the money path healthy?
node ops/scheduler/status.js assets
node ops/scheduler/status.js unmatched-sweeps
```

Two commands in `status` can cost money and both require `--i-understand`:
`unlock`, which releases a lease another worker may still be holding, and
`retry`, which reopens a run record. `retry` refuses outright for a money-moving
job unless you insist, because a job whose work already happened on chain does
not need to happen again.
