# Runbook: a client rugs, or turns malicious, after activation

**Alerts:** `screening_blocked_after_metadata_change` (page),
`screening_restricted_after_metadata_change` (ticket)
**Auto-action:** `suspend_vault` / `halt_paid_media`

A coin we are publicly, disclosedly promoting has done something we cannot be
associated with: the deployer dumped, liquidity was pulled, the metadata was
changed into an infringing or prohibited form, or the project turned out to be a
different thing than the one that was screened.

Two facts shape every decision below.

- **We never hold the client token.** There is no position to unwind, no
  incentive to soften the disclosure, and nothing to sell into the people we
  have been talking to. Say so explicitly when you communicate.
- **Our name is on it.** Every promotional emission carried `#ad` and the
  operator name. Holders will find those posts. What we do in the next hour is
  the entire reputational outcome.

## Detection

- `screening_blocked_after_metadata_change` when a re-screen of changed metadata
  produces BLOCKED. Clean at signup, infringing by Thursday is the standard
  pattern and it is exactly what continuous re-screening exists for.
- Deployer-behaviour signals from the indexer: `deployerSupplySharePct` collapsing,
  a liquidity removal, `venuePoolVolumeSharePct` going to near zero.
- Human reports through the desk arriving as `scam_report` topic counts in the
  digest. Note that the desk reports a COUNT, never the text - do not go looking
  for the message bodies to act on. Verify on chain.

```bash
node ops/scheduler/status.js jobs
psql "$DATABASE_URL" -c "SELECT verdict, paid_media_permitted, screened_at_unix, metadata_hash FROM screening_result WHERE token = '$TOKEN' ORDER BY screened_at_unix DESC LIMIT 5;"
```

## Immediate actions

1. **Stop emitting.** The vault suspension halts publishing for that coin
   automatically on BLOCKED; on RESTRICTED only paid promotion stops. Confirm which
   happened, and if the situation is worse than the verdict, suspend by hand.

2. **Stop spending.** No new authorizations, and cancel anything scheduled that
   has not executed. Because of the commitment rule there is no forward
   obligation to unwind: nothing was ever financed against projected flow, so
   there is no vendor we owe money we do not have.

3. **Do not delete the history.** Published receipts and prior promotional posts
   stay up. Deleting them is the single worst available action: it converts a
   disclosed engagement that went wrong into a cover-up, and the posts are
   already archived by third parties anyway.

4. **Publish a factual notice in the same channels** that carried the promotion.
   What happened, when we learned it, what we stopped, what we hold (nothing),
   and what happens to the client's unspent budget. No adjectives, no
   speculation about the dev's intent, and no price commentary of any kind - the
   refusal classes apply here more than anywhere.

5. **Freeze the procurement budget and account for it.** Unspent budget belongs
   to the coin. Under the operator-withdrawal terms it is refundable; work
   already delivered and paid to a vendor is not recoverable and should be shown
   as such.

## Decision points

- **BLOCKED versus RESTRICTED.** BLOCKED suspends the vault: no publishing, no
  spend, terminate. RESTRICTED allows organic operations - answering factual
  questions at the desk - but no paid promotion. The middle option exists because
  cutting a coin's support desk hurts its holders, not its deployer.
- **Is the verdict sticky?** Yes. A re-screen NEVER un-blocks. If the dev reverts
  the metadata, the enforcement stays until a named human records an override in
  `screening_override` with a reason and a second approver. The cheapest attack
  on a content screen is to change it back after the promotion lands.
- **Is this a rug or a bad week?** A price collapse is not a rug and is not our
  business to judge; we do not comment on price. Distinguish observable facts -
  liquidity removed, supply moved from the deployer, metadata changed - from
  market movement. Only the former justifies suspension.
- **Do we owe the holders anything?** No, and saying otherwise creates a
  liability we cannot meet. What we owe them is the truth about what we did, what
  we were paid, and that we hold none of the token.
- **Was any paid promotion still live?** Sponsored posts continue to exist after we stop
  paying for them. Ask the vendor to remove them; if they will not, record that
  in the notice. The T+7d re-check will show it either way.
- **Terminate or suspend?** Suspend first - it is reversible and preserves the
  ledger's ability to settle. Terminate only after the final sweep, settlement
  and refund, or the dev's own claimable leg may be stuck behind a terminal
  state.

## Commands

```bash
# 1. Current screening posture and the change that caused it.
psql "$DATABASE_URL" -c "SELECT * FROM token_metadata_observation WHERE token = '$TOKEN' ORDER BY observed_at_unix DESC LIMIT 5;"
psql "$DATABASE_URL" -c "SELECT f.flag_code, f.severity, f.stage FROM screening_flag f JOIN screening_result r ON r.id = f.result_id WHERE r.token = '$TOKEN' AND r.is_current;"

# 2. Suspend the vault by hand if the automatic action did not cover it.
psql "$DATABASE_URL" -c "UPDATE vault SET state = 'SUSPENDED' WHERE address = '$VAULT';"
psql "$DATABASE_URL" -c "INSERT INTO vault_state_history (id, vault, from_state, to_state, reason, actor, changed_at_unix) VALUES (md5(random()::text), '$VAULT', 'ACTIVE', 'SUSPENDED', 'post-activation screening BLOCKED', '$OPERATOR', extract(epoch from now()));"

# 3. Everything we published for this coin, so the notice can reach the same places.
psql "$DATABASE_URL" -c "SELECT channel, external_id, published_at_unix, is_promotional, read_back_verified FROM publication WHERE vault = '$VAULT' ORDER BY published_at_unix DESC;"

# 4. Everything we bought, and what is still unproven.
psql "$DATABASE_URL" -c "SELECT d.id, d.sku_id, d.vendor_id, d.cost_usd, d.withheld_at_unix, p.offset_seconds, p.passed FROM disbursement d LEFT JOIN predicate_check p ON p.disbursement_id = d.id WHERE d.vault = '$VAULT' ORDER BY d.disbursed_at_unix DESC;"

# 5. Unspent budget, for the refund.
psql "$DATABASE_URL" -c "SELECT asset, balance_minor FROM ledger_balance WHERE vault = '$VAULT' AND account = 'liability:budget';"

# 6. Only a named human, with a reason, can ever relax a verdict.
psql "$DATABASE_URL" -c "INSERT INTO screening_override (id, token, from_verdict, to_verdict, reason, approved_by, second_approver, approved_at_unix) VALUES (md5(random()::text), '$TOKEN', 'BLOCKED', 'RESTRICTED', '$REASON', '$OPERATOR', '$SECOND', extract(epoch from now()));"
```

## Afterwards

- The final client report carries the full history including the suspension, and
  the **what we did not do** section carries the notice text.
- Re-examine the onboarding screen: what would have caught this at signup? If the
  answer is "nothing available to us", that is a finding about the product, not a
  failure of this incident.
- If the same deployer appears again under a new token, `client_diligence`
  records `prior_rug_count` per deployer. Use it.
