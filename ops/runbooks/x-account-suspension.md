# Runbook: an X (or other channel) account is suspended

**Alert:** `publishing_channel_suspended` (page) · **Auto-action:** `halt_publishing`

A publishing account has been suspended or restricted by the platform. The
disclosed desk for every coin bound to that account is offline.

**The single most important line in this runbook: do not create a replacement
account.** Ban evasion is against every relevant platform policy, it is exactly
the behaviour a "covert accounts" business would exhibit, and this business is
sold on not being that. The mitigation is bounded by policy, not by engineering.
We appeal, we tell the clients, and we wait.

The structural commitments that constrain the response:

- **Exactly one ticker per account.** `DISCLOSURE.maxTickersPerAccount` is 1. We
  do not consolidate the affected coins onto a surviving account, because that is
  cross-promotion between clients.
- **No covert accounts, ever.** Not for continuity, not "temporarily".
- **Every emission is disclosed** as AI-operated and, when promotional, as paid.
  If the suspension is because that disclosure looked like spam to a classifier,
  the answer is a better appeal, not less disclosure.

## Detection

- The `publishing.health` job (every 6h per bound X account, `ops/scheduler/jobs/publishing-health.ts`)
  asks each account for its own standing with `GET /2/users/me` under the
  account's token and appends the verdict to `publisher_account_health`. A
  newest row that is `suspended`, `locked` or `unauthorized` is what
  `publishing.suspendedChannels` reports, and the catalog pages
  `publishing_channel_suspended` on it with the onset of the run as
  `detected_at_unix`.
- The publisher REFUSES to post from that account at stage `channel_suspended`
  the moment the row lands - and also when the newest `ok` is older than 24h
  (`health_stale`) or the account was never probed (`health_unobserved`). There
  is no retry storm to stop: nothing reaches X while the row stands.
- Secondary: read-backs start failing for that account because the posts are no
  longer publicly visible. Note that this produces `disclosure_readback_failure`
  too - check for a suspension before treating that as a disclosure defect.

```bash
node ops/scheduler/status.js jobs
# The verdict history for every account, newest first. `detail` is X's own problem type and detail.
psql "$DATABASE_URL" -c "SELECT channel, account_id, status, to_timestamp(observed_at_unix) AS observed, detail FROM publisher_account_health ORDER BY observed_at_unix DESC LIMIT 20;"
# Force a fresh probe on the next tick instead of waiting for the interval: the
# scheduler measures the interval from the scope's last completed run, and a
# scope with none is due. One scope per account, '<channel>:<accountId>'.
psql "$DATABASE_URL" -c "DELETE FROM ops_job_run WHERE job_id = 'publishing.health' AND scope = 'x_operator:$ACCOUNT_ID' AND state = 'completed';"
```

## Immediate actions

1. **Confirm publishing halted rather than looping.** A suspended account will
   fail every attempt; a retry storm looks like abuse and harms the appeal.

2. **Establish the scope.** Which accounts, which coins, and whether the desk
   (answering questions) or only promotion is affected. A read-only suspension is
   materially different from a full one.

3. **Read the actual enforcement notice.** Automation policy, spam, impersonation
   and platform-manipulation enforcement each need a different appeal, and
   guessing wastes the one appeal you get.

4. **Tell the affected clients within the hour**, in whatever channel still
   works - Telegram usually survives an X suspension. State that their desk is
   offline, that we are appealing, that we will not create a replacement account,
   and what that means for the current period's fee.

5. **File the appeal.** Lead with what is verifiable: the account is disclosed as
   AI-operated in its bio and in every post, promotional posts carry `#ad`, it
   promotes exactly one ticker, and there is a published receipts ledger. That is
   an unusually strong appeal and it is only available because those things are
   true.

## Decision points

- **Is the suspension a policy problem or a content problem?** If a specific post
  triggered it, check whether that post passed screening and disclosure
  injection. A post that got through our own gates and still broke a platform
  rule is a gap in the rules we encode.
- **Was it triggered by an impersonation report?** The desk detects impersonators
  and reports them; a hostile actor mass-reporting our account is a plausible
  retaliation. Say so in the appeal, with evidence.
- **Should the desk move to Telegram for the duration?** Yes, if the client
  agrees. That is not evasion: it is a different, already-disclosed channel that
  the client already has. Do not mirror X content to a new X account.
- **Do we still charge the operator fee?** For a coin whose paid service is
  offline, no. Suspend the fee for the affected period and say so in the report
  before the client asks.
- **Is the affected account also the read-back path for live paid promotion?** If so,
  the T+24h and T+7d sponsored-post checks may fail for a reason that is not the vendor's
  fault. Do not withhold vendor payment on evidence you could not gather -
  record the check as unverifiable and re-run it once access returns.
- **Has this happened more than once?** Two suspensions is a product finding: the
  X-based desk may not be a viable channel for this business, and the answer may
  be to sell Telegram-first rather than to keep appealing.

## Commands

```bash
# 1. Which coins are affected, and what was last delivered.
psql "$DATABASE_URL" -c "SELECT v.address, v.token, v.tier, max(p.published_at_unix) AS last_publish FROM vault v LEFT JOIN publication p ON p.vault = v.address AND p.channel = 'x_operator' WHERE v.state = 'ACTIVE' GROUP BY 1,2,3;"

# 2. Recent posts from the account, to attach to the appeal.
psql "$DATABASE_URL" -c "SELECT external_id, is_promotional, disclosure_tags, published_at_unix, read_back_verified FROM publication WHERE channel = 'x_operator' ORDER BY published_at_unix DESC LIMIT 50;"

# 3. Confirm the one-ticker-per-account invariant held, which is the appeal's core claim.
psql "$DATABASE_URL" -c "SELECT channel, count(DISTINCT vault) AS tickers FROM publication WHERE channel = 'x_operator' GROUP BY 1;"

# 4. Live paid promotion whose verification depends on this account.
psql "$DATABASE_URL" -c "SELECT d.id, d.vendor_id, d.sku_id, p.offset_seconds, p.due_at_unix FROM disbursement d JOIN predicate_check p ON p.disbursement_id = d.id WHERE p.checked_at_unix IS NULL ORDER BY p.due_at_unix;"

# 5. Nothing pauses the channel by hand: the publisher already refuses the account
#    while its newest health row is not ok. If the desk moves to Telegram for the
#    duration, that is a binding change, not a vault state change.

# 6. After reinstatement, re-probe rather than waiting up to 6h (see Detection);
#    the newest row flipping to ok reopens the account. Then confirm read-backs
#    pass before resuming promotion.
psql "$DATABASE_URL" -c "DELETE FROM ops_job_run WHERE job_id = 'publishing.health' AND scope = 'x_operator:$ACCOUNT_ID' AND state = 'completed';"
psql "$DATABASE_URL" -c "SELECT status, to_timestamp(observed_at_unix) FROM publisher_account_health WHERE account_id = '$ACCOUNT_ID' ORDER BY observed_at_unix DESC LIMIT 1;"
node ops/scheduler/status.js jobs
```

## Afterwards

- The outage, its duration and the fee treatment go in each affected client's
  weekly report, in **what we did not do**.
- If the suspension was upheld, that is a real constraint on the product. Record
  it in the threat model rather than routing around it, and price the risk into
  what the desk promises.
