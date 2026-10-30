-- 0003_vendors.sql
--
-- Vendors, the SKU catalog, spend decisions, disbursements and delivery proof.
--
-- NO THIRD-PARTY PAYEE, ANYWHERE. There is exactly one payout_address column in
-- this schema and it belongs to a vendor row that an operator allowlisted. It is
-- never written from a model output, a community message, or token metadata.
-- The planner selects a SKU ID; it does not name a price and it does not name a
-- payee. The operator buys media as principal and is reimbursed from the coin's
-- own escrowed budget - so a disbursement row is a REIMBURSEMENT record, not an
-- instruction to pay someone.
--
-- ZERO MARKUP IS AN INVARIANT, NOT A POLICY. unit_cost_usd is the vendor's
-- public list price and charged_usd must equal it. The CHECK below is the last
-- line of defence; the broker enforces it first.

CREATE TABLE IF NOT EXISTS vendor (
    id                    TEXT PRIMARY KEY,
    display_name          TEXT    NOT NULL,
    -- Operator-allowlisted. NEVER supplied by a model or by user content.
    payout_address        TEXT,
    kyb_verified_at_unix  BIGINT,
    ofac_screened_at_unix BIGINT,
    -- Operator-affiliated vendors are capped and require per-dev opt-in.
    is_related_party      BOOLEAN NOT NULL,
    -- Rolling delivery reliability, 0..1. An input to the spend gate.
    reliability_score     DOUBLE PRECISION NOT NULL,
    enabled               BOOLEAN NOT NULL,
    disabled_reason       TEXT,
    updated_at_unix       BIGINT  NOT NULL,

    CONSTRAINT vendor_reliability_bounds CHECK (reliability_score >= 0 AND reliability_score <= 1)
);

CREATE INDEX IF NOT EXISTS vendor_enabled_idx ON vendor (enabled);

CREATE TABLE IF NOT EXISTS sku (
    id                   TEXT PRIMARY KEY,
    vendor_id            TEXT    NOT NULL REFERENCES vendor (id),
    description          TEXT    NOT NULL,
    -- Public list price. Charged at cost, ZERO markup, reconciled daily.
    unit_cost_usd        DOUBLE PRECISION NOT NULL,
    category             TEXT    NOT NULL,
    -- No predicate, no purchase.
    predicate_kind       TEXT    NOT NULL,
    -- Comma-separated seconds. For kol_post this MUST contain both 86400 and 604800.
    verify_offsets_seconds TEXT  NOT NULL,
    predicate_params_json  TEXT  NOT NULL,
    -- Comma-separated tier ids at which this SKU may be offered at all.
    available_at_tiers   TEXT    NOT NULL,
    enabled              BOOLEAN NOT NULL,
    updated_at_unix      BIGINT  NOT NULL,

    CONSTRAINT sku_category_known
        CHECK (category IN ('listing','boost','trending','kol','moderation','build','creative')),
    CONSTRAINT sku_predicate_known
        CHECK (predicate_kind IN ('eti_listing','boost_delta','trending_rank','kol_post','manual_attestation')),
    CONSTRAINT sku_cost_positive CHECK (unit_cost_usd > 0)
);

CREATE INDEX IF NOT EXISTS sku_vendor_idx ON sku (vendor_id);

-- The vendor's published rate card as we observed it, so "we charged list price"
-- is a checkable claim rather than an assertion.
CREATE TABLE IF NOT EXISTS vendor_rate_card_observation (
    id                 TEXT PRIMARY KEY,
    vendor_id          TEXT    NOT NULL REFERENCES vendor (id),
    sku_id             TEXT    NOT NULL REFERENCES sku (id),
    observed_cost_usd  DOUBLE PRECISION NOT NULL,
    source_uri         TEXT    NOT NULL,
    evidence_hash      TEXT    NOT NULL,
    observed_at_unix   BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS vendor_rate_card_scope_idx
    ON vendor_rate_card_observation (sku_id, observed_at_unix);

-- Every spend decision, approved or denied, with the FIRST failing gate.
-- Denials are kept because a spike in them is a monitored signal.
CREATE TABLE IF NOT EXISTS spend_decision (
    id                     TEXT PRIMARY KEY,
    vault                  TEXT    NOT NULL REFERENCES vault (address),
    sku_id                 TEXT    NOT NULL REFERENCES sku (id),
    quantity               INTEGER NOT NULL,
    approved               BOOLEAN NOT NULL,
    -- Gates are ordered and evaluated deterministically; this is the first that failed.
    failed_gate            TEXT,
    reason                 TEXT    NOT NULL,
    requires_human_approval BOOLEAN NOT NULL,
    quoted_cost_usd        DOUBLE PRECISION,
    -- Advisory planner text. NEVER parsed for values by anything.
    rationale              TEXT,
    policy_token_id        TEXT,
    decided_at_unix        BIGINT  NOT NULL,

    CONSTRAINT spend_decision_quantity_positive CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS spend_decision_time_idx ON spend_decision (decided_at_unix);
CREATE INDEX IF NOT EXISTS spend_decision_gate_idx ON spend_decision (failed_gate, decided_at_unix);

CREATE TABLE IF NOT EXISTS disbursement (
    id                  TEXT PRIMARY KEY,
    vault               TEXT    NOT NULL REFERENCES vault (address),
    sku_id              TEXT    NOT NULL REFERENCES sku (id),
    vendor_id           TEXT    NOT NULL REFERENCES vendor (id),
    decision_id         TEXT    REFERENCES spend_decision (id),
    cost_usd            DOUBLE PRECISION NOT NULL,
    charged_usd         DOUBLE PRECISION NOT NULL,
    invoice_hash        TEXT    NOT NULL,
    vendor_countersig   TEXT,
    -- Set when a failed predicate withheld payment. Never silently refunded.
    withheld_at_unix    BIGINT,
    withheld_reason     TEXT,
    disbursed_at_unix   BIGINT  NOT NULL,

    -- Zero markup. Charging more than list is not a configuration option.
    CONSTRAINT disbursement_no_markup CHECK (charged_usd <= cost_usd)
);

CREATE INDEX IF NOT EXISTS disbursement_scope_idx ON disbursement (vault, disbursed_at_unix);
CREATE INDEX IF NOT EXISTS disbursement_vendor_idx ON disbursement (vendor_id, disbursed_at_unix);

-- One row per (disbursement, offset). The primary key is what makes a re-run of
-- the delivery job a no-op instead of a second dispute.
CREATE TABLE IF NOT EXISTS predicate_check (
    disbursement_id   TEXT    NOT NULL REFERENCES disbursement (id),
    offset_seconds    INTEGER NOT NULL,
    due_at_unix       BIGINT  NOT NULL,
    checked_at_unix   BIGINT,
    passed            BOOLEAN,
    evidence_uri      TEXT,
    evidence_hash     TEXT,
    note              TEXT,

    PRIMARY KEY (disbursement_id, offset_seconds)
);

-- The due queue. A NULL checked_at_unix with a passed due_at_unix is work.
CREATE INDEX IF NOT EXISTS predicate_check_due_idx ON predicate_check (checked_at_unix, due_at_unix);
