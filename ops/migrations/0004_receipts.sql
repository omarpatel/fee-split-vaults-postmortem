-- 0004_receipts.sql
--
-- Receipts and the weekly client report.
--
-- THE 72-HOUR EMBARGO IS A COLUMN, NOT A CONVENTION. publish_after_unix exists
-- because a live feed of unexecuted commitments is a front-runnable purchase
-- calendar: "we are about to buy trending placement for this coin" is a trade
-- signal, and publishing it would make our own receipts a way to trade against
-- our clients' holders. Every read path filters on it.
--
-- WHAT WE DID NOT DO IS A REQUIRED SECTION. It has its own table and the report
-- job refuses to send a report whose section is empty. Refusals, withheld vendor
-- payments and declined promotions are the part of the product a client cannot
-- verify any other way.

CREATE TABLE IF NOT EXISTS receipt (
    id                 TEXT PRIMARY KEY,
    vault              TEXT    NOT NULL REFERENCES vault (address),
    disbursement_id    TEXT    REFERENCES disbursement (id),
    kind               TEXT    NOT NULL,
    amount_usd         DOUBLE PRECISION NOT NULL,
    description        TEXT    NOT NULL,
    -- Nothing is published before this instant.
    publish_after_unix BIGINT  NOT NULL,
    occurred_at_unix   BIGINT  NOT NULL,
    evidence_uri       TEXT,
    evidence_hash      TEXT,
    published_at_unix  BIGINT,

    CONSTRAINT receipt_kind_known CHECK (kind IN ('procurement','operations','refund','fee')),
    CONSTRAINT receipt_embargo_not_before_event CHECK (publish_after_unix >= occurred_at_unix)
);

CREATE INDEX IF NOT EXISTS receipt_scope_idx ON receipt (vault, occurred_at_unix);
CREATE INDEX IF NOT EXISTS receipt_embargo_idx ON receipt (publish_after_unix);

CREATE TABLE IF NOT EXISTS weekly_report (
    id                   TEXT PRIMARY KEY,
    vault                TEXT    NOT NULL REFERENCES vault (address),
    -- ISO week key, yyyy-Www. The uniqueness constraint below is what stops a
    -- restart from sending the same report twice.
    week_key             TEXT    NOT NULL,
    period_start_unix    BIGINT  NOT NULL,
    period_end_unix      BIGINT  NOT NULL,
    -- Derived reporting figures with price provenance. Not money.
    qf_received_usd      DOUBLE PRECISION NOT NULL,
    dev_leg_usd          DOUBLE PRECISION NOT NULL,
    budget_spent_usd     DOUBLE PRECISION NOT NULL,
    operator_fee_usd     DOUBLE PRECISION NOT NULL,
    price_source         TEXT    NOT NULL,
    verified_reach_summary TEXT  NOT NULL,
    attributed_new_buyers  INTEGER,
    cost_per_attributed_buyer_usd DOUBLE PRECISION,
    delivered_at_unix    BIGINT,
    delivery_channel     TEXT,
    delivery_external_id TEXT,
    built_at_unix        BIGINT  NOT NULL,

    CONSTRAINT weekly_report_period_ordered CHECK (period_end_unix > period_start_unix)
);

CREATE UNIQUE INDEX IF NOT EXISTS weekly_report_week_uq ON weekly_report (vault, week_key);

CREATE TABLE IF NOT EXISTS weekly_report_line (
    report_id   TEXT    NOT NULL REFERENCES weekly_report (id),
    line_no     INTEGER NOT NULL,
    receipt_id  TEXT    REFERENCES receipt (id),
    description TEXT    NOT NULL,
    amount_usd  DOUBLE PRECISION NOT NULL,

    PRIMARY KEY (report_id, line_no)
);

-- The fixed section. A report with no rows here is rejected before delivery.
CREATE TABLE IF NOT EXISTS weekly_report_omission (
    report_id  TEXT    NOT NULL REFERENCES weekly_report (id),
    line_no    INTEGER NOT NULL,
    statement  TEXT    NOT NULL,

    PRIMARY KEY (report_id, line_no)
);

CREATE TABLE IF NOT EXISTS weekly_report_withheld_payment (
    report_id  TEXT    NOT NULL REFERENCES weekly_report (id),
    line_no    INTEGER NOT NULL,
    vendor_id  TEXT    NOT NULL REFERENCES vendor (id),
    amount_usd DOUBLE PRECISION NOT NULL,
    reason     TEXT    NOT NULL,

    PRIMARY KEY (report_id, line_no)
);

-- Every emission we published, with the read-back result.
--
-- read_back_verified is the record that the disclosure was present in the LIVE
-- post, not merely in what we submitted. A false here means the post was deleted
-- automatically; the row stays, because the attempt is part of the audit trail.
CREATE TABLE IF NOT EXISTS publication (
    id                  TEXT PRIMARY KEY,
    vault               TEXT    NOT NULL REFERENCES vault (address),
    channel             TEXT    NOT NULL,
    is_promotional      BOOLEAN NOT NULL,
    -- Hash, not text. The body is attacker-adjacent content and this table is
    -- read by operators; a hash is enough to prove what was sent.
    body_hash           TEXT    NOT NULL,
    disclosure_tags     TEXT    NOT NULL,
    external_id         TEXT,
    published_at_unix   BIGINT,
    read_back_verified  BOOLEAN,
    read_back_at_unix   BIGINT,
    deleted_at_unix     BIGINT,
    rejected_reason     TEXT,

    CONSTRAINT publication_channel_known
        CHECK (channel IN ('telegram','x_operator','x_client_delegated','site'))
);

CREATE INDEX IF NOT EXISTS publication_scope_idx ON publication (vault, published_at_unix);
CREATE INDEX IF NOT EXISTS publication_readback_idx ON publication (read_back_verified, read_back_at_unix);
