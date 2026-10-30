# Runbook: ledger variance in the critical band

**Alerts:** `ledger_variance_critical` (page), `settlement_stalled` (ticket),
`dead_letter_backlog` (ticket/page), `scheduler_tick_stalled` (page)
**Auto-action:** `freeze_new_authorizations`

The books and the world disagree, or the books disagree with themselves. Until it
is explained, every number downstream is suspect: tier gates, spend caps, the
dev report, the operator fee. The freeze is automatic and it is correct - do not
lift it to unblock a campaign.

Four checks can raise this, and which one fired tells you where to look:

| Source | What it compares | What a failure means |
| --- | --- | --- |
| `recon.structural` | The ledger against its own invariants | An entry does not balance, or income was recognised twice |
| `recon.sweep_match` | Hook sweep vs escrow credit vs ERC-20 received vs book | A leg is missing or the four disagree |
| `recon.trial_balance` | Recompute from `ledger_entry` vs `ledger_balance` | The incremental maintainer is broken |
| `recon.clean_room` | Independent recompute from raw logs | A bug both the ledger and its own recompute share |

## Detection

The page carries the source. Start there rather than at the top.

```bash
node ops/scheduler/status.js freezes
node ops/scheduler/status.js jobs
psql "$DATABASE_URL" -c "SELECT id, vault, asset, severity, delta_minor, detected_at_unix, note FROM ledger_variance WHERE detected_at_unix > extract(epoch from now()) - 86400 ORDER BY detected_at_unix DESC;"
```

## Immediate actions

1. **Leave the freeze in place.** Reconciliation jobs are deliberately exempt
   from it, so the checks keep running and the freeze can be cleared once the
   books are trustworthy again. Nothing about the freeze is blocking your
   investigation.

2. **Establish the direction and the size.** `delta_minor` is
   `ledger - chain` in minor units. Negative means the chain holds less than the
   book says. That is the bad direction: it can mean money left, or was never
   there.

3. **Do not "fix" a balance.** `ledger_entry` is append-only and there is no
   UPDATE path. A correction is a new, signed, `manual`-sourced entry with a memo
   naming this incident - never an edit. If you find yourself writing an UPDATE
   against `ledger_entry`, stop.

4. **Check the obvious external causes before assuming a code defect:**
   - a paused or upgraded quote asset (see `paused-quote-asset.md`),
   - a fee-on-transfer asset, which makes `received < swept` by design,
   - a recipient transfer (see `stranded-escrow-balance.md`),
   - a reorg that reached a block we treated as finalized. The indexer halts
     rather than rewriting in that case, so look for its halt first.

5. **Re-run the specific check by hand** at a pinned block rather than trusting a
   cached result.

## Decision points

- **Is the variance explained and benign?** A fee-on-transfer asset or a rounding
  convention mismatch is explained. Record the explanation on the variance row,
  post the correcting entry, then clear the freeze naming yourself.
- **Is it unexplained and larger than one client's daily fees?** Escalate to a
  fleet freeze rather than a per-vault one, and stop all paid promotion across the
  book. A systematic accounting error is not a per-coin problem.
- **Did the clean room disagree while the trial balance agreed?** That is the
  worst signature: the primary path and its own recompute share a bug. Suspect
  the attribution layer - `PoolFeesSwept` mapped through `TokenLaunched`, plus
  the pre-graduation curve events - not the ledger.
- **Was income recognised twice?** Look for one fee that arrived as a curve
  event, an escrow credit, and an ERC-20 transfer. Income is recognised exactly
  once, at accrual, from the declared precedence source; every sweep, claim,
  split and budget pull is a TRANSFER. A duplicate recognition is the most likely
  silent-money bug in the system.
- **Can any client's money have been spent against a phantom balance?** Check
  disbursements authorized since the variance was first observable. If any were,
  they are the operator's loss and are refunded to the coin's budget, not
  clawed back from a vendor who delivered.

## Commands

```bash
# 1. Which check fired, and its detail.
psql "$DATABASE_URL" -c "SELECT * FROM ledger_variance ORDER BY detected_at_unix DESC LIMIT 10;"

# 2. Recompute the trial balance for one vault, out of band.
node ops/scheduler/status.js jobs
psql "$DATABASE_URL" -c "SELECT account, asset, debits_minor, credits_minor, balance_minor, entry_count FROM ledger_balance WHERE vault = '$VAULT';"

# 3. The entries behind a suspicious balance, newest first.
psql "$DATABASE_URL" -c "SELECT seq, source, debit_account, credit_account, amount_minor, tx_hash, log_index, memo FROM ledger_entry WHERE vault = '$VAULT' AND asset = '$ASSET' ORDER BY seq DESC LIMIT 50;"

# 4. Recognition state for an accrual: has one fee been recognised from two sources?
psql "$DATABASE_URL" -c "SELECT accrual_key, recognized_source, recognized_minor, supersessions, per_source_json FROM ledger_recognition WHERE vault = '$VAULT' AND asset = '$ASSET' ORDER BY last_observed_at_unix DESC LIMIT 20;"

# 5. Sweeps that never matched.
node ops/scheduler/status.js unmatched-sweeps

# 6. Dead letters, which often carry the first failure that caused all of this.
node ops/scheduler/status.js dead-letters

# 7. Only after the books are trustworthy again.
node ops/scheduler/status.js unfreeze --id "$FREEZE_ID" --by "$OPERATOR"
```

## Afterwards

- The variance, its cause and its resolution go in the affected clients' weekly
  reports. A frozen week that a client only learns about from a quiet campaign is
  worse than the variance.
- If a code defect caused it, the regression test comes before the fix ships, and
  it belongs in the ledger package's own suite - not here.
- If the freeze lasted more than a day, waive the operator fee for that period.
  We charge for realized fees and a period we could not account for is not one we
  should bill.
