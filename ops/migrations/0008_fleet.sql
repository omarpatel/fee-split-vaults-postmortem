-- 0008_fleet.sql
--
-- Storage for the real port implementations in packages/adapters: the fleet
-- spend counters, the escalation record, the chain scan cursors, the vault
-- money-movement observations, and inbound chat messages.
--
-- THE SPEND-COUNTER TABLES ARE GATES, NOT REPORTING. fleet_disbursement and
-- fleet_proposal exist so that four of the broker's caps can be answered:
-- fleet-wide disbursements per day, one vendor's spend across the whole client
-- book per day, a vault's proposal rate per hour, and thirty days of
-- related-party spend. Every index below exists for exactly one of those reads.
-- If a query here gets slow enough to time out, the adapter throws and spending
-- stops, which is the correct direction but is still an outage - so the indexes
-- are part of the safety argument, not a performance nicety.
--
-- WHY fleet_disbursement IS NOT THE `disbursement` TABLE. `disbursement` in
-- 0003 is the RECEIPT: it carries the invoice hash, the countersignature, the
-- predicate withholding, and USD as a double for reporting. This one is the
-- COUNTER: cents as an exact integer, a UTC day key computed by the caller so
-- the boundary does not move with the server's timezone, and the related-party
-- flag the 30-day cap reads. They are written in the same tick and can be
-- reconciled through disbursement_id, which is deliberately NOT a foreign key:
-- the counter must be recordable even if the receipt write is retried later,
-- because a disbursement that landed and was never counted is spend no cap sees.

CREATE TABLE IF NOT EXISTS fleet_disbursement (
    id                 TEXT    PRIMARY KEY,
    vault              TEXT    NOT NULL,
    vendor_id          TEXT    NOT NULL,
    -- CENTS, exact. Never a float: a cap compared against a rounded double is a
    -- cap whose edge is undefined.
    amount_cents       NUMERIC(38, 0) NOT NULL,
    is_related_party   BOOLEAN NOT NULL,
    at_unix            BIGINT  NOT NULL,
    -- floor(at_unix / 86400). Computed by the caller so it matches
    -- InMemoryFleetCounters.dayKey exactly and does not depend on the server's
    -- timezone. Stored rather than derived so the daily indexes are usable.
    day_key            BIGINT  NOT NULL,
    -- The receipt row this counter corresponds to, when there is one. No FK on
    -- purpose; see the header.
    disbursement_id    TEXT,

    CONSTRAINT fleet_disbursement_amount_nonnegative CHECK (amount_cents >= 0),
    CONSTRAINT fleet_disbursement_day_matches
        CHECK (day_key = floor(at_unix / 86400))
);

-- disbursementsToday: fleet-wide count for one day.
CREATE INDEX IF NOT EXISTS fleet_disbursement_day_idx
    ON fleet_disbursement (day_key);
-- disbursementsTodayForVault and vendorDisbursementsTodayForVault.
CREATE INDEX IF NOT EXISTS fleet_disbursement_vault_day_idx
    ON fleet_disbursement (vault, day_key, vendor_id);
-- vendorSpendTodayCents: one vendor across every vault, for one day.
CREATE INDEX IF NOT EXISTS fleet_disbursement_vendor_day_idx
    ON fleet_disbursement (vendor_id, day_key);
-- relatedPartySpend30dCents: a rolling 30-day window, related-party rows only.
CREATE INDEX IF NOT EXISTS fleet_disbursement_related_party_idx
    ON fleet_disbursement (vault, at_unix)
    WHERE is_related_party;

-- One row per spend PROPOSAL, whether or not it became a disbursement. The
-- hourly rate limit is about how fast a coin is being asked to spend, not about
-- how often it said yes, so a rejected proposal still counts.
CREATE TABLE IF NOT EXISTS fleet_proposal (
    id        TEXT   PRIMARY KEY,
    vault     TEXT   NOT NULL,
    at_unix   BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS fleet_proposal_vault_time_idx ON fleet_proposal (vault, at_unix);

-- Anything a human has to look at, surviving the restart that the failure
-- itself probably caused. Deduped by (vault, kind, code) while open so a halt
-- that re-raises every tick is one row with a count, keeping its FIRST raise
-- time - "since when" is the question an operator actually asks.
CREATE TABLE IF NOT EXISTS ops_escalation (
    id                  BIGSERIAL PRIMARY KEY,
    coin_ref            TEXT    NOT NULL,
    vault               TEXT    NOT NULL,
    kind                TEXT    NOT NULL,
    -- A machine code. Never free text from a model or from message content.
    code                TEXT    NOT NULL,
    -- Machine-generated, length-capped by the adapter. A human reads this in a
    -- terminal, which is the same reason ops_dead_letter.facts_json is bounded.
    detail              TEXT    NOT NULL,
    raised_at_unix      BIGINT  NOT NULL,
    last_raised_at_unix BIGINT  NOT NULL,
    occurrences         INTEGER NOT NULL DEFAULT 1,
    resolved_at_unix    BIGINT,
    resolved_by         TEXT,

    CONSTRAINT ops_escalation_kind_known CHECK (kind IN (
        'planner_escalation','indexer_halt','ledger_freeze','screening_blocked',
        'screening_missing','tier_downgrade','settlement_failed','divergence_freeze'
    )),
    CONSTRAINT ops_escalation_occurrences_positive CHECK (occurrences >= 1),
    CONSTRAINT ops_escalation_resolution_has_actor
        CHECK ((resolved_at_unix IS NULL) = (resolved_by IS NULL))
);

-- The dedupe key. PARTIAL, so a resolved escalation does not block the same
-- failure from being raised again next week.
CREATE UNIQUE INDEX IF NOT EXISTS ops_escalation_open_key
    ON ops_escalation (vault, kind, code) WHERE resolved_at_unix IS NULL;
CREATE INDEX IF NOT EXISTS ops_escalation_open_idx
    ON ops_escalation (resolved_at_unix, raised_at_unix);

-- Forward-only block cursors for the chain scans.
--
-- NOT ops_cursor. That table's column is `position_unix` and its semantics are
-- "this job has processed up to this INSTANT". A block number is not an
-- instant; putting 56,321,180 in a field every other reader treats as a clock
-- would give the first person who computes an age from it an answer 1.7 billion
-- seconds wrong. Both fields live here under their real names instead.
--
-- block_timestamp_unix is the COVERAGE WATERMARK and is deliberately NULLABLE.
-- NULL means "this cursor has advanced but covers nothing you may rely on yet",
-- which is where a cold backfill sits. It is not 0: a zero would read as a 1970
-- timestamp and look like a clock bug rather than an honest unknown.
CREATE TABLE IF NOT EXISTS chain_scan_cursor (
    stream               TEXT   NOT NULL,
    -- The vault address for a per-vault stream, or the literal 'fleet'.
    scope                TEXT   NOT NULL,
    block_number         BIGINT NOT NULL,
    block_timestamp_unix BIGINT,
    updated_at_unix      BIGINT NOT NULL,

    PRIMARY KEY (stream, scope),
    CONSTRAINT chain_scan_cursor_stream_known
        CHECK (stream IN ('vault_movements','fees')),
    CONSTRAINT chain_scan_cursor_block_nonnegative CHECK (block_number >= 0)
);

-- One claim() / claimToken() observed on a vault. The primary key is
-- `${txHash}:${logIndex}`, a pure function of chain position, which is what
-- makes a re-scanned or overlapping range idempotent instead of a double count.
CREATE TABLE IF NOT EXISTS vault_claim_observation (
    id               TEXT    PRIMARY KEY,
    vault            TEXT    NOT NULL,
    asset            TEXT    NOT NULL,
    amount_minor     NUMERIC(78, 0) NOT NULL,
    occurred_at_unix BIGINT  NOT NULL,
    tx_hash          TEXT    NOT NULL,
    log_index        INTEGER NOT NULL,
    block_number     BIGINT  NOT NULL,
    block_hash       TEXT,

    CONSTRAINT vault_claim_amount_nonnegative CHECK (amount_minor >= 0)
);

CREATE INDEX IF NOT EXISTS vault_claim_window_idx
    ON vault_claim_observation (vault, occurred_at_unix);
CREATE INDEX IF NOT EXISTS vault_claim_block_idx
    ON vault_claim_observation (vault, block_number);

-- One settle() split. The legs are stored as the adapter reduced them: the
-- referrer's cut is carved out of the OPERATOR's slice on chain and never the
-- client's, and core's LedgerAccount union has no referrer account, so operator
-- and referrer are one figure here and the split between them is not
-- recoverable from this ledger.
--
-- NUMERIC(78,0) holds a full uint256, so a token with 18 decimals and an absurd
-- supply cannot overflow the column and be silently rejected mid-scan.
CREATE TABLE IF NOT EXISTS vault_allocation_observation (
    id               TEXT    PRIMARY KEY,
    vault            TEXT    NOT NULL,
    asset            TEXT    NOT NULL,
    dev_minor        NUMERIC(78, 0) NOT NULL,
    budget_minor     NUMERIC(78, 0) NOT NULL,
    operator_minor   NUMERIC(78, 0) NOT NULL,
    occurred_at_unix BIGINT  NOT NULL,
    tx_hash          TEXT    NOT NULL,
    log_index        INTEGER NOT NULL,
    block_number     BIGINT  NOT NULL,
    block_hash       TEXT,

    CONSTRAINT vault_allocation_legs_nonnegative
        CHECK (dev_minor >= 0 AND budget_minor >= 0 AND operator_minor >= 0)
);

CREATE INDEX IF NOT EXISTS vault_allocation_window_idx
    ON vault_allocation_observation (vault, occurred_at_unix);
CREATE INDEX IF NOT EXISTS vault_allocation_block_idx
    ON vault_allocation_observation (vault, block_number);

-- Open halt notices. The indexer SIGNALS a halt and the broker ENFORCES it, and
-- nothing in between owned it, so an in-memory sink lost every open halt on
-- restart - and a process that comes back up reporting "no halts" has just
-- restored spend authority for a coin whose fee recipient may have been taken.
--
-- Deduped by (token, reason) while open: `watch_stale` re-fires every sweep
-- interval for as long as the chain is unreachable.
CREATE TABLE IF NOT EXISTS chain_halt_notice (
    id               BIGSERIAL PRIMARY KEY,
    vault            TEXT    NOT NULL,
    token            TEXT    NOT NULL,
    reason           TEXT    NOT NULL,
    detail           TEXT    NOT NULL,
    detected_at_unix BIGINT  NOT NULL,
    block_hash       TEXT,
    block_number     BIGINT,
    tx_hash          TEXT,
    cleared_at_unix  BIGINT,
    cleared_by       TEXT,

    CONSTRAINT chain_halt_reason_known CHECK (reason IN (
        'recipient_diverged','recipient_transferred','owner_override_proposed',
        'owner_override_executable','watch_stale','asset_disabled','read_failure'
    )),
    CONSTRAINT chain_halt_cleared_has_actor
        CHECK ((cleared_at_unix IS NULL) = (cleared_by IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS chain_halt_notice_open_key
    ON chain_halt_notice (token, reason) WHERE cleared_at_unix IS NULL;
CREATE INDEX IF NOT EXISTS chain_halt_notice_open_idx
    ON chain_halt_notice (token, cleared_at_unix);

-- Inbound chat messages, held between the poll that fetched them and the ticks
-- that read overlapping windows over them.
--
-- Telegram's getUpdates is a CONSUMING stream with no historical window:
-- confirming an offset discards everything below it server-side, and the API
-- cannot be asked what was said between two instants. The tick loop asks
-- exactly that. So the poller writes here and the tick reads from here.
--
-- bound_coin_ref IS STAMPED FROM THE CHAT, from a map the operator wrote. It is
-- never parsed out of body_text. body_text is attacker-authored and is stored
-- verbatim for the runtime's sanitiser to handle; nothing in the adapter plane
-- reads it.
CREATE TABLE IF NOT EXISTS inbound_message (
    chat_id         TEXT    NOT NULL,
    -- Source-assigned message id. Untrusted; used only for dedupe and audit.
    source_id       TEXT    NOT NULL,
    origin          TEXT    NOT NULL,
    -- Untrusted author id. Pseudonymised downstream; never rendered.
    author_id       TEXT    NOT NULL,
    body_text       TEXT    NOT NULL,
    posted_at_unix  BIGINT  NOT NULL,
    bound_coin_ref  TEXT    NOT NULL,
    -- Bot API update_id. The poll offset is derived from the maximum, so the
    -- cursor cannot get ahead of what was actually stored.
    update_id       BIGINT  NOT NULL,

    PRIMARY KEY (chat_id, source_id),
    CONSTRAINT inbound_message_origin_known
        CHECK (origin IN ('telegram','x_mention','token_metadata','vendor_response'))
);

CREATE INDEX IF NOT EXISTS inbound_message_window_idx
    ON inbound_message (bound_coin_ref, posted_at_unix);
CREATE INDEX IF NOT EXISTS inbound_message_update_idx ON inbound_message (update_id);

-- The poll offset, SEPARATE from the messages.
--
-- Deriving it from max(update_id) over inbound_message would mean an update
-- from a chat no coin claims - one we correctly decline to store - never
-- advances it, so every poll re-fetches the same backlog forever and Telegram
-- never expires it. Confirming an offset is what discards an update
-- server-side, and an update we chose not to keep still has to be discarded.
--
-- Written only AFTER that batch's messages are stored, so a crash in between
-- re-fetches rather than skips; inbound_message's primary key makes the replay
-- a no-op.
CREATE TABLE IF NOT EXISTS inbound_poll_offset (
    poller          TEXT   PRIMARY KEY,
    next_offset     BIGINT NOT NULL,
    updated_at_unix BIGINT NOT NULL,

    CONSTRAINT inbound_poll_offset_nonnegative CHECK (next_offset >= 0)
);
