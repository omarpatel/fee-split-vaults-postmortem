# Runbook: a quote asset is paused

**Alert:** `quote_asset_proxy_paused` (page) · **Auto-action:** `disable_quote_asset`

Every approved quote asset on chain 4663 is an upgradeable, pausable,
issuer-controlled proxy. A pause is not a bug in our code and there is nothing to
fix on our side: the issuer has frozen transfers, claims revert, and any balance
credited to our vaults inside the shared Venue fee escrow is stranded until they
unpause. The job in this hour is to stop making it worse, tell the people whose
money it is, and be ready to claim the moment it lifts.

## Detection

- `quote_asset_proxy_paused` fires from the chain watcher on a `Paused` event or
  on a transfer simulation that reverts for the asset.
- Secondary symptoms that often arrive first:
  - `escrow_sweep_stalled` for every vault holding that asset,
  - a run of `escrow.sweep` dead letters with a revert error code,
  - `sweep_shortfall` if a partial pause let some chunks through.

Confirm it is a pause and not a local RPC problem before acting: two providers,
both reverting, at a pinned block.

```bash
# Which asset, and how much is stranded.
node ops/scheduler/status.js asset --address "$ASSET"

# Is it actually paused on chain, per the quorum readers?
node tools/escrow-index.ts --asset "$ASSET" --at latest --check-paused
```

## Immediate actions

1. **Confirm the kill switch flipped.** The alert's auto-action sets
   `quote_asset.enabled = FALSE`, which stops both accepting and claiming that
   asset without a deploy. Verify it, because everything below assumes it.

   ```sql
   SELECT address, symbol, enabled, disabled_reason, disabled_at_unix
     FROM quote_asset WHERE address = :asset;
   ```

   If it is still enabled, disable it by hand and record the reason.

   ```sql
   UPDATE quote_asset
      SET enabled = FALSE,
          disabled_reason = 'issuer pause observed at block :block',
          disabled_at_unix = :now,
          updated_at_unix = :now
    WHERE address = :asset;
   ```

2. **Stop the retry storm.** Sweeps against a paused asset will burn gas and fill
   the dead-letter queue. Once `enabled` is false the job returns
   `asset_disabled` and completes, so this should settle within one tick. Confirm
   it did.

3. **Do not attempt a workaround.** There is no claim-on-behalf on the Venue V2
   escrow - it is `msg.sender`-only - so there is no alternative path to the
   funds and no clever routing to try. Any "fix" that moves money through a
   different address is a custody event we do not do.

4. **Quantify the exposure per client.** The number that matters to a dev is
   their own stranded balance, not the fleet total.

   ```sql
   SELECT v.address, v.token, b.balance_minor
     FROM ledger_balance b JOIN vault v ON v.address = b.vault
    WHERE b.asset = :asset AND b.account = 'asset:escrow' AND b.balance_minor <> '0'
    ORDER BY length(b.balance_minor) DESC, b.balance_minor DESC;
   ```

5. **Tell every affected client, in the communication, today.** State what is
   frozen, that it is the asset issuer's action and not ours, that no fees are
   lost, and that claims resume automatically when the pause lifts. Do not
   estimate a duration you do not know.

## Decision points

- **Is any other quote asset unaffected?** If so, nothing else needs to stop.
  Suspending the whole book because one asset is frozen is an overreaction that
  costs clients service they are still paying for.
- **Is the pause partial?** Some issuers pause transfers above a threshold rather
  than entirely. If chunked claims still land, leave the asset enabled with a
  reduced `max_transfer_minor` rather than disabling it, and say so in the
  disabled-reason audit trail.
- **Has it been more than 72 hours?** Escalate commercially: the operator fee is
  charged on realized fees, and fees that cannot be realized are not billable.
  Do not accrue an operator fee against money nobody can move.
- **Is a client asking to terminate?** They may. The dev leg is pull-only and the
  vault's dev funds were never ours; termination does not require the pause to
  lift, and the stranded balance stays claimable by the vault afterwards.
- **Did the issuer announce an upgrade rather than a pause?** Then this is a
  different incident: an upgraded proxy may change transfer semantics (fee on
  transfer, new caps). Re-run the transfer simulation before re-enabling.

## Commands

```bash
# 1. Current state of every quote asset.
node ops/scheduler/status.js assets

# 2. Dead letters caused by this asset, so they can be replayed later.
node ops/scheduler/status.js dead-letters --job escrow.sweep --grep "$ASSET"

# 3. After the issuer unpauses: verify with two providers at a pinned block,
#    then re-enable and let the forced interval pick the backlog up.
node tools/escrow-index.ts --asset "$ASSET" --at latest --check-paused
psql "$DATABASE_URL" -c "UPDATE quote_asset SET enabled = TRUE, disabled_reason = NULL, updated_at_unix = extract(epoch from now()) WHERE address = '$ASSET';"

# 4. Force a sweep for one vault rather than waiting, once re-enabled.
node ops/scheduler/status.js run-now --job escrow.sweep --scope "$VAULT#$ASSET" --by "$OPERATOR"

# 5. Confirm the backlog cleared and the three-way match agrees.
node ops/scheduler/status.js run-now --job recon.sweep_match --scope fleet --by "$OPERATOR"
```

## Afterwards

- Record the incident, the stranded amount and the duration in each affected
  client's next weekly report, under **what we did not do**. A frozen week that
  goes unmentioned is the kind of omission that makes every other receipt look
  negotiable.
- If this is the second pause for the same issuer, raise the question of whether
  that asset should be on the approved list at all. `is_pausable_proxy` is
  recorded for every asset precisely so that this is an evidenced decision.
