# Runbook: vendor non-delivery dispute

**Alerts:** `delivery_predicate_failed` (ticket), `kol_post_deleted_or_undisclosed` (page),
`sku_predicate_misconfigured` (page), `procurement_receipt_missing` (ticket)
**Auto-action:** payment withheld; vendor reliability penalised

A funded SKU's delivery predicate failed. The client's money bought something and
the machine check says it did not arrive, or did arrive and then vanished.

Three facts that shape the whole response:

- **We bought as principal.** The operator purchased the media and is reimbursed
  from the coin's escrowed budget. There is no third-party payee anywhere in the
  system, so this is our dispute with the vendor, not the client's.
- **Zero markup.** `charged_usd <= cost_usd` is a database constraint. There is
  no margin in the purchase to absorb a loss quietly, which is precisely why the
  dispute has to be real rather than written off.
- **The predicate fails closed.** Transport failure, malformed evidence and
  negative evidence are all "not delivered". That is deliberate, and it means
  some failures are ours (we could not look) rather than theirs (they did not
  deliver). Distinguishing the two is most of this runbook.

## Detection

- `delivery_predicate_failed` at any offset: the check ran and the evidence was
  absent or negative.
- `kol_post_deleted_or_undisclosed` at T+7d: the post existed at T+24h and does
  not now, or no longer carries its disclosure. This pages, because it is both a
  non-delivery and a live disclosure defect on something we paid for.
- `sku_predicate_misconfigured`: a funded `kol_post` SKU is missing the T+24h or
  T+7d offset. Delivery is unverifiable, so payment is withheld and paid promotion
  should stop until the catalog is fixed.
- `procurement_receipt_missing`: a check PASSED but the procurement receipt the
  tick should have written for that disbursement does not exist, so nothing
  could be re-issued as delivered. Not a vendor problem: the client's receipt
  page is missing a line for money that moved. Reconcile the receipt store
  against `ops_predicate_check` and `fleet_disbursement` before anything else.

The fleet's checks live in `ops_predicate_check` (migration 0013), fed by the
tick loop; `predicate_check` in the queries below is the 0003 receipt-side
table and holds what the onboarding-era disbursement flow wrote. Check both.

```bash
node ops/scheduler/status.js dead-letters --job delivery.predicates
psql "$DATABASE_URL" -c "SELECT disbursement_id, vault, sku_id, vendor_id, cost_usd, offset_seconds, passed, evidence_uri, note FROM ops_predicate_check WHERE passed = FALSE ORDER BY checked_at_unix DESC LIMIT 50;"
psql "$DATABASE_URL" -c "SELECT d.id, d.vendor_id, d.sku_id, d.cost_usd, p.offset_seconds, p.passed, p.evidence_uri, p.note FROM disbursement d JOIN predicate_check p ON p.disbursement_id = d.id WHERE p.passed = FALSE ORDER BY p.checked_at_unix DESC LIMIT 50;"
```

## Immediate actions

1. **Confirm payment is actually withheld.** A fleet check writes
   `ops_predicate_withhold` (one row per disbursement, first reason wins); the
   0003 flow sets `disbursement.withheld_at_unix`. If the vendor has already
   been paid for this line, the dispute is a recovery rather than a hold and
   the client's report must say so.

2. **Look at the evidence before contacting anyone.** Every check records an
   evidence URI and a content hash. Open it. A predicate that failed because our
   fetch 404'd is not a vendor failure.

3. **Re-run the check by hand at the same offset.** Platforms rate-limit, and a
   single failed fetch is not proof of non-delivery. Two independent failures at
   different times is.

4. **If it is a genuine non-delivery, open the dispute inside the vendor's own
   window.** Most vendor terms have a short claim period; a dispute filed late is
   a dispute lost, and the loss lands on the operator.

5. **For a deleted or undisclosed sponsored post, capture what remains** - the archived
   copy, the T+24h evidence hash, the timestamps. That evidence is what makes the
   receipt honest later.

## Decision points

- **Was the failure ours or theirs?** Ours: transport errors, a changed vendor
  page layout, our own account suspended so we could not see the post (see
  `x-account-suspension.md`). Theirs: the artefact does not exist, or exists
  without the disclosure. Never penalise vendor reliability for our own blindness
  - record the check as unverifiable instead.
- **Did the post exist at T+24h and vanish by T+7d?** That is the case the two
  checkpoints exist for, and it is the one worth escalating hardest. A vendor who
  takes payment and deletes the post a day later is not a vendor who made a
  mistake.
- **Did the post lose its DISCLOSURE rather than disappear?** Equally serious and
  more common. The disclosure obligation attaches to the communication, and the
  T+7d re-check is the only mechanism by which it survives contact with a third
  party. Treat an undisclosed live post as non-delivery AND ask for removal.
- **Does the vendor stay in the catalog?** `reliability_score` feeds the spend
  gate directly. One failure is a penalty; a pattern is a disable. Disable rather
  than "watch closely" - a watched vendor still gets picked.
- **Who eats the cost?** If the vendor refuses and the money is gone, the
  operator absorbs it. It is refunded to the coin's budget, not charged onward.
  Charging a client for undelivered media is the exact thing the receipts model
  exists to make impossible.
- **Is this a related-party vendor?** Then the bar is higher, not lower. Related
  parties are capped at a fraction of a coin's 30-day budget and require per-dev
  opt-in; a delivery failure from one should trigger a review of whether it
  belongs in the catalog at all.

## Commands

```bash
# 1. The full check history for the disbursement - fleet queue, then the 0003 table.
psql "$DATABASE_URL" -c "SELECT offset_seconds, due_at_unix, checked_at_unix, passed, evidence_uri, evidence_hash, note FROM ops_predicate_check WHERE disbursement_id = '$DISBURSEMENT' ORDER BY offset_seconds;"
psql "$DATABASE_URL" -c "SELECT * FROM ops_predicate_withhold WHERE disbursement_id = '$DISBURSEMENT';"
psql "$DATABASE_URL" -c "SELECT * FROM predicate_check WHERE disbursement_id = '$DISBURSEMENT' ORDER BY offset_seconds;"

# 2. The SKU's predicate and its offsets - is it even verifiable?
psql "$DATABASE_URL" -c "SELECT id, vendor_id, predicate_kind, verify_offsets_seconds, unit_cost_usd FROM sku WHERE id = '$SKU';"

# 3. Zero-markup evidence for the client's receipt.
psql "$DATABASE_URL" -c "SELECT d.cost_usd, d.charged_usd, o.observed_cost_usd, o.source_uri, o.evidence_hash FROM disbursement d LEFT JOIN vendor_rate_card_observation o ON o.sku_id = d.sku_id WHERE d.id = '$DISBURSEMENT' ORDER BY o.observed_at_unix DESC LIMIT 5;"

# 4. This vendor's record across the whole book: fleet penalties, then the 0003 view.
psql "$DATABASE_URL" -c "SELECT vendor_id, count(*) AS penalties, min(penalized_at_unix) AS first_unix, max(penalized_at_unix) AS last_unix FROM ops_vendor_penalty WHERE vendor_id = '$VENDOR' GROUP BY 1;"
psql "$DATABASE_URL" -c "SELECT v.id, v.reliability_score, v.enabled, count(*) FILTER (WHERE p.passed = FALSE) AS failures, count(*) AS checks FROM vendor v JOIN disbursement d ON d.vendor_id = v.id JOIN predicate_check p ON p.disbursement_id = d.id WHERE v.id = '$VENDOR' GROUP BY 1,2,3;"

# 5. Disable a vendor. The spend gate reads `enabled` on every proposal.
psql "$DATABASE_URL" -c "UPDATE vendor SET enabled = FALSE, disabled_reason = '$REASON', updated_at_unix = extract(epoch from now()) WHERE id = '$VENDOR';"

# 6. Re-run the due queue after fixing a catalog misconfiguration.
node ops/scheduler/status.js dead-letters --job delivery.predicates
node ops/scheduler/status.js retry --run-key "$RUN_KEY" --by "$OPERATOR"

# 7. Record the refund to the coin's budget when the operator absorbs the cost.
psql "$DATABASE_URL" -c "INSERT INTO receipt (id, vault, disbursement_id, kind, amount_usd, description, publish_after_unix, occurred_at_unix) VALUES (md5(random()::text), '$VAULT', '$DISBURSEMENT', 'refund', $AMOUNT, 'Vendor non-delivery, absorbed by the operator and refunded to the procurement budget', extract(epoch from now()), extract(epoch from now()));"
```

## Afterwards

- The withheld payment appears in the client's weekly report under
  `withheldPayments`, with the vendor, the amount and the reason. Every time.
  This is the part of the product a client cannot verify any other way, and
  reporting it is how the whole receipts model earns its keep.
- If the same predicate keeps failing for reasons that are ours, the predicate
  is wrong. Fix the verifier or retire the SKU - a check that cannot be trusted
  is worse than no check, because it produces disputes with honest vendors.
