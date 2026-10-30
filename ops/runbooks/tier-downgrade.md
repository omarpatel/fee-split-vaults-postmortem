# Runbook: a coin crossed a tier gate downward

**Alerts:** `tier_gate_crossed_downward` (ticket), `inference_cost_over_tier_cogs` (ticket)
**Auto-action:** none for the downgrade; `throttle_model` for the cost overrun

A coin's trailing 7-day median QF fell below its tier's gate for longer than the
grace period, and the service level was reduced automatically. This is not a
failure. **It is the normal case**, and the numbers say so: Phase 0 measured a
mean age of 2.14 days for the stock of coins above the qualification gate, and
even the most survivor-biased cohort only reached 12.9 days. Coins fall out of
tier constantly. What must not happen is a client finding out from the silence.

## Detection

- `tier_gate_crossed_downward` from the daily re-evaluation, after
  `TIERING.downgradeGraceDays` consecutive daily observations below the gate.
- `inference_cost_over_tier_cogs` when a coin's measured model spend exceeds the
  modelled cost to serve for its tier. Frequently the same coin: fee flow drops
  while message volume does not.

```bash
psql "$DATABASE_URL" -c "SELECT vault, from_tier, to_tier, qf_per_day_usd, observed_days, sustained_days, days_below_gate, reason, decided_at_unix FROM vault_tier_history WHERE direction = 'down' ORDER BY decided_at_unix DESC LIMIT 20;"
psql "$DATABASE_URL" -c "SELECT vault, day_key, qf_per_day_usd, below_gate FROM vault_qf_observation WHERE vault = '$VAULT' ORDER BY day_key DESC LIMIT 14;"
```

## Immediate actions

1. **Sanity-check the measurement before telling anyone anything.** The gate is a
   trailing 7-day **median** of daily credits, deliberately - a mean is farmable
   with one day of wash volume. Confirm:
   - `observed_days >= 7`. Below that no paid tier can be granted at all, and a
     downgrade on thin history is a measurement artefact.
   - The coin has not simply migrated its liquidity. `venuePoolVolumeSharePct`
     collapsing while headline volume holds means fees stopped being fee-bearing,
     not that interest stopped. Phase 0 measured a 122x gap between headline and
     Venue-pool volume on a live winner.
   - The indexer is not behind. A stalled indexer produces a book-wide phantom
     downgrade, so check whether one coin fell or all of them did.

2. **Contact the client before they notice.** Say what changed, what the tier
   now includes, what the gate is, and what would restore it. Do not editorialise
   about their coin's prospects, and do not imply a price or volume outcome -
   the refusal classes apply to client communication too.

3. **Settle the procurement budget honestly.** Unspent budget stays the coin's.
   If the new tier does not permit paid media, the budget stops being spent and
   is refundable; it is not quietly retained against a future upgrade.

4. **Check the qualification floor.** Below roughly $1,500/month of implied
   procurement budget, a paid tier cannot fund even a $299 Dexscreener Enhanced
   Token Info listing. If the coin is below the floor, the honest position is
   that the paid tier is not on offer - not that it is available but unfunded.

## Decision points

- **Downgrade or terminate?** T0 costs about a cent a day to serve and is
  deterministic - no model in the loop. Keeping a fallen coin at T0 is nearly
  free and preserves the relationship. Terminate only if the client asks or if
  screening has changed.
- **Is the model spend the real problem?** If `inference_cost_over_tier_cogs`
  fired, the coin is costing more than its tier assumes. The auto-action throttles
  the model; the decision is whether to move it to T0, where no model runs at all.
  At a platform-median lifetime creator take of $15.73, there is no margin to
  absorb an over-serving coin out of goodwill.
- **Is this a one-week dip or a dead coin?** The grace period already filtered
  single quiet days. Look at `vault_qf_observation` over 14 days: a cliff is a
  liquidity migration or a rug; a decay is the normal lifecycle.
- **Should the coin be re-promoted on recovery?** An upgrade needs the gate held
  for the tier's `sustainedDays`, at least seven observed days, the wash-trading
  conjuncts to clear, and the budget floor. The asymmetry is deliberate:
  promotion is slow, demotion is patient, and yo-yoing a client's service level
  is worse than being briefly generous in either direction.
- **Did several coins downgrade at once?** That is an infrastructure question
  before it is a commercial one. Check the indexer's watch set and its last
  finalized block before sending a single client email.

## Commands

```bash
# 1. The decision and the measurement behind it.
psql "$DATABASE_URL" -c "SELECT * FROM vault_tier_history WHERE vault = '$VAULT' ORDER BY decided_at_unix DESC LIMIT 5;"

# 2. Fourteen days of daily observations - cliff or decay?
psql "$DATABASE_URL" -c "SELECT day_key, qf_per_day_usd, below_gate, price_source FROM vault_qf_observation WHERE vault = '$VAULT' ORDER BY day_key DESC LIMIT 14;"

# 3. Is this coin alone, or did the whole book move? (An indexer problem.)
psql "$DATABASE_URL" -c "SELECT day_key, count(*) FILTER (WHERE below_gate) AS below, count(*) AS total FROM vault_qf_observation WHERE day_key > to_char(now() - interval '5 days','YYYY-MM-DD') GROUP BY 1 ORDER BY 1 DESC;"

# 4. Model spend against the tier's modelled COGS.
psql "$DATABASE_URL" -c "SELECT day_key, tier, cost_usd, input_tokens, output_tokens, cache_read_tokens FROM ops_inference_cost WHERE vault = '$VAULT' ORDER BY day_key DESC LIMIT 14;"

# 5. Unspent procurement budget, for the refund conversation.
psql "$DATABASE_URL" -c "SELECT asset, balance_minor FROM ledger_balance WHERE vault = '$VAULT' AND account = 'liability:budget';"

# 6. Re-run the evaluation out of band after fixing an indexer problem.
node ops/scheduler/status.js retry --run-key "tier.reevaluate:$VAULT:$PERIOD" --by "$OPERATOR"
```

## Afterwards

- The tier change, its cause and the budget treatment go in the next weekly
  report. If we got the downgrade wrong and reversed it, that goes in too, under
  **what we did not do**.
- If downgrades are clustering at one gate, the gate may be wrong for this
  market. That is a pricing decision with evidence attached, and it belongs in
  `config/protocol.ts` with a note - not in an ad-hoc exception for one client.
