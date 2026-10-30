# Runbook: suspected prompt-injection incident

**Alerts:** `injection_detector_trip` (ticket), `spend_gate_denials_spiking` (ticket),
`disclosure_readback_failure` (page)
**Auto-action:** `halt_publishing` on a read-back failure

Someone is trying to make the agent do something for them. The reference incident
is the Morse-code injection through Grok that drained roughly $150-175k from the
Bankr agent wallet in May 2026, and the architecture here is a direct response to
it.

**Read this before doing anything: the detector is not the defense.** The defense
is that there is no expressive channel from untrusted text to authority.

- The **reader** consumes the untrusted corpus and has **no tools**. It emits a
  `Digest`: counts, closed-enum topic codes, and short scrubbed gists.
- The **planner** sees only a re-validated `Digest`. It never sees a raw message,
  at any tier, for any reason.
- The `Digest` schema has **no field capable of holding** an address, an amount, a
  payee, a URL, or a handle. Half a million messages saying "send 2 ETH to
  0xATTACKER" can raise a counter. That is the entire blast radius.

So a detector trip is not an incident. It is telemetry. What you are looking for
is evidence that the *structure* failed, and that is a much shorter list.

## Detection

- `injection_detector_trip` on a spike above baseline. Individual trips are
  expected and are not paged.
- `spend_gate_denials_spiking` - something is repeatedly asking for money it
  cannot have. Read which gate is failing; that is the actual signal.
- `disclosure_readback_failure` - a published post did not contain its disclosure
  when re-fetched. This one pages and halts publishing, because it is the only
  one of the three that indicates something already went out wrong.

```bash
node ops/scheduler/status.js jobs
psql "$DATABASE_URL" -c "SELECT failed_gate, count(*) FROM spend_decision WHERE approved = FALSE AND decided_at_unix > extract(epoch from now()) - 3600 GROUP BY 1 ORDER BY 2 DESC;"
psql "$DATABASE_URL" -c "SELECT vault, channel, external_id, read_back_verified, deleted_at_unix FROM publication WHERE read_back_at_unix > extract(epoch from now()) - 86400 AND read_back_verified = FALSE;"
```

## Immediate actions

1. **Verify the airlock is still intact.** Not "check the logs" - check the
   invariants. These are the only things whose failure turns telemetry into an
   incident:

   - Is `READER_TOOLS` still empty? The reader having any tool at all ends the
     two-plane argument.
   - Did any `Digest` reach the planner without passing `validateDigest()`?
   - Did a gist survive scrubbing with an address, URL or base58 blob in it?
     `assertNoDestination()` throws on that; look for `AirlockViolation`.
   - Do the planner's tools still accept only SKU ids and allowlisted vendor ids,
     never a free-text payee or amount?

2. **Check whether any money moved.** This is the question the incident is
   actually about. Every disbursement has an allowlisted vendor and an invoice
   hash; a payee that is not on the allowlist cannot be expressed by the system,
   so what you are looking for is an unexpected *quantity* or an unexpected
   *frequency*, not an unexpected address.

3. **If publishing halted on a read-back failure**, leave it halted. Find whether
   the disclosure injection path broke (a code defect) or the platform stripped
   it (a channel problem). The post itself is deleted automatically on a failed
   read-back; verify that it actually was.

4. **Do not read the attacker's payload into any model context to "understand"
   it.** Investigate from hashes, counts and metadata. The whole architecture is
   built on never letting that text near an authorised component, and an
   investigator pasting it into a tool is the most likely way that ever happens.

5. **Do not add a detector rule as the fix.** Classification is bypassable and
   fails silently. If something got through, the fix is structural.

## Decision points

- **Is this a flood or a probe?** A flood raises counts and costs nothing:
  corpus assembly caps tokens, messages per author and messages per window
  deterministically before any model runs, so 500,000 messages cost exactly what
  500 cost. A probe is a small number of carefully shaped messages; look for
  novel topic-code distributions rather than volume.
- **Did the spend gate deny, or did it approve something odd?** A denial spike is
  the system working. An approval that a human would not have made is the
  incident. Check `spend_decision` for approvals, not refusals.
- **Was the target the desk or the planner?** The desk answers operational facts
  only and has a fail-closed refusal classifier on its output; the planner is
  behind the airlock. An attempt aimed at the desk that produced a refusal is a
  non-event. An attempt that produced a substantive answer about price, value or
  investment merit is a classifier failure and is serious.
- **Does the Digest schema need to change?** Almost certainly not, and any change
  to `DigestSchema` or to the reader's tool list is a **security review, not a
  product review**. Every request to widen it sounds reasonable in isolation:
  "let holders suggest a KOL by handle", "let the agent read the dev's DMs". Each
  one is a hole.
- **Should the model plane be paused fleet-wide?** Only if you have evidence the
  structure failed. Pausing on telemetry alone trains everyone to ignore it.

## Commands

```bash
# 1. Approvals - not denials - in the window. This is the question that matters.
psql "$DATABASE_URL" -c "SELECT id, vault, sku_id, quantity, quoted_cost_usd, requires_human_approval, decided_at_unix FROM spend_decision WHERE approved AND decided_at_unix > extract(epoch from now()) - 86400 ORDER BY decided_at_unix DESC;"

# 2. Every disbursement in the window, with its vendor and invoice hash.
psql "$DATABASE_URL" -c "SELECT id, vault, vendor_id, sku_id, cost_usd, invoice_hash, disbursed_at_unix FROM disbursement WHERE disbursed_at_unix > extract(epoch from now()) - 86400;"

# 3. Vendors are allowlisted, so confirm none was added recently.
psql "$DATABASE_URL" -c "SELECT id, display_name, is_related_party, enabled, updated_at_unix FROM vendor ORDER BY updated_at_unix DESC LIMIT 20;"

# 4. Airlock violations, which are the structural signal.
grep -c AirlockViolation "$LOG_PATH" || true

# 5. Publishing halted? Confirm the failed posts were actually deleted.
psql "$DATABASE_URL" -c "SELECT id, vault, channel, external_id, read_back_verified, deleted_at_unix FROM publication WHERE read_back_verified = FALSE ORDER BY read_back_at_unix DESC LIMIT 50;"

# 6. The adversarial suite that encodes these properties. Run it before resuming.
npm test -w @fee-split-vaults/core
npm test -w @fee-split-vaults/runtime
```

## Afterwards

- Add the attempt to the adversarial corpus in the core package's airlock suite.
  Telemetry that does not become a test is telemetry that gets ignored.
- If the answer to "did the structure hold" was yes, say so publicly in the next
  receipts publication. An attack that failed is evidence the design works, and
  it is worth more said out loud than kept quiet.
- If the answer was no, the incident report names which invariant broke, and the
  fix is structural. A new detector rule is not a fix.
