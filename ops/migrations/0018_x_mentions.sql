-- 0018_x_mentions.sql
--
-- Three things the live desk needs that had no durable home:
--
--   1. THE X MENTIONS CURSOR. Mentions of a coin's bound X account are stored
--      in `inbound_message` beside the Telegram rows (origin = 'x_mention',
--      chat_id = 'x:<accountId>', update_id = 0) - the table already admits
--      that origin, and the Telegram store reads only its own. What the table
--      cannot hold is the per-account `since_id`: a tweet id is a 64-bit
--      snowflake above 2^53, `inbound_poll_offset.next_offset` is read back
--      through Number(), and a cursor that rounds re-fetches or skips. The
--      cursor is therefore TEXT and compared as numeric on write.
--
--   2. THE DESK REFUSAL LOG. Every refusal the desk issues is a High-Risk
--      control's visible edge, and a control nobody can audit after a restart
--      is a claim. The excerpt column is the airlock-scrubbed excerpt the desk
--      package produces (no address, link or amount can survive it); the
--      question itself is kept only as a fingerprint.
--
--   3. A NEW ESCALATION KIND. The desk raises to the same ops_escalation table
--      the tick already writes; its kind is added to the CHECK.

CREATE TABLE IF NOT EXISTS x_mention_cursor (
    -- The X user id of the bound account. Numeric, but never a number here.
    account_id      TEXT   PRIMARY KEY,
    -- Newest tweet id STORED for the account. Confirmed only after the rows.
    since_id        TEXT   NOT NULL,
    updated_at_unix BIGINT NOT NULL,

    CONSTRAINT x_mention_cursor_account_is_numeric CHECK (account_id ~ '^[0-9]{1,20}$'),
    CONSTRAINT x_mention_cursor_since_is_numeric CHECK (since_id ~ '^[0-9]{1,20}$')
);

CREATE TABLE IF NOT EXISTS desk_refusal (
    -- The short reference shown to the holder, so a ticket maps to a row.
    ref                  TEXT    PRIMARY KEY,
    at_unix              BIGINT  NOT NULL,
    vault                TEXT    NOT NULL,
    channel              TEXT    NOT NULL,
    chat_id              TEXT,
    -- Untrusted author id. Counted for the probe threshold; never rendered.
    author_id            TEXT,
    tripped_on           TEXT    NOT NULL,
    -- JSON arrays of closed-enum strings, as the desk classifier emitted them.
    classes_json         TEXT    NOT NULL,
    rule_ids_json        TEXT    NOT NULL,
    -- sha256 prefix of the question. Not reversible.
    question_fingerprint TEXT    NOT NULL,
    -- Scrubbed by the airlock before it got here. Cannot hold a destination.
    excerpt              TEXT    NOT NULL,
    language             TEXT    NOT NULL,

    CONSTRAINT desk_refusal_tripped_on_known CHECK (tripped_on IN ('input', 'output', 'none')),
    CONSTRAINT desk_refusal_channel_known
        CHECK (channel IN ('telegram', 'x_operator', 'x_client_delegated', 'site')),
    CONSTRAINT desk_refusal_excerpt_bounded CHECK (length(excerpt) <= 120)
);

CREATE INDEX IF NOT EXISTS desk_refusal_time_idx ON desk_refusal (at_unix);
CREATE INDEX IF NOT EXISTS desk_refusal_author_idx ON desk_refusal (author_id, at_unix);
CREATE INDEX IF NOT EXISTS desk_refusal_vault_idx ON desk_refusal (vault, at_unix);

-- The desk's escalations join the tick's. Dedupe by (vault, kind, code) while
-- open applies to them too: a probe that re-raises every window is one row.
ALTER TABLE ops_escalation DROP CONSTRAINT IF EXISTS ops_escalation_kind_known;
ALTER TABLE ops_escalation ADD CONSTRAINT ops_escalation_kind_known CHECK (kind IN (
    'planner_escalation','indexer_halt','ledger_freeze','screening_blocked',
    'screening_missing','tier_downgrade','settlement_failed','divergence_freeze',
    'desk_escalation'
));
