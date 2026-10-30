-- Double-entry attribution ledger.
--
-- PORTABILITY. Written to the intersection of Postgres and SQLite: no arrays,
-- no JSONB operators, no vendor upsert syntax in the DDL. The store issues
-- SELECT-then-INSERT/UPDATE inside a transaction rather than a dialect-specific
-- ON CONFLICT, so one implementation serves both.
--
-- MONEY IS TEXT. Every minor-unit amount is a base-10 string, and NOTHING in
-- this schema ever sums one. bigint arithmetic happens in TypeScript where the
-- width is unbounded; a NUMERIC column would invite a driver to hand back a
-- float and lose the low digits of a large balance in silence. The CHECK
-- constraints below are the price of that decision and are deliberate.
--
-- APPEND-ONLY. There is no UPDATE and no DELETE path for ledger_entry. The
-- materialized tables are derived and MAY be rebuilt from ledger_entry alone;
-- that rebuild is the trial-balance recompute and is the only check that
-- catches a broken incremental maintainer.

CREATE TABLE IF NOT EXISTS ledger_entry (
    id                TEXT PRIMARY KEY,
    seq               INTEGER NOT NULL,
    vault             TEXT    NOT NULL,
    asset             TEXT    NOT NULL,
    debit_account     TEXT    NOT NULL,
    credit_account    TEXT    NOT NULL,
    amount_minor      TEXT    NOT NULL,
    occurred_at_unix  INTEGER NOT NULL,
    block_hash        TEXT,
    tx_hash           TEXT,
    log_index         INTEGER,
    source            TEXT    NOT NULL,
    memo              TEXT,

    -- LIKE and length() only: a regex predicate would tie the schema to one
    -- engine. Full numeric-string validation is the application's job; this is
    -- the last line of defence against a negative or empty amount reaching disk.
    CONSTRAINT ledger_entry_amount_positive
        CHECK (length(amount_minor) > 0
               AND amount_minor NOT LIKE '-%'
               AND amount_minor <> '0'),
    CONSTRAINT ledger_entry_distinct_accounts
        CHECK (debit_account <> credit_account),
    CONSTRAINT ledger_entry_source_known
        CHECK (source IN ('curve_event','pool_fees_swept','escrow_credit','erc20_transfer','manual'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ledger_entry_seq_uq ON ledger_entry (seq);
CREATE INDEX IF NOT EXISTS ledger_entry_scope_idx ON ledger_entry (vault, asset, seq);
CREATE INDEX IF NOT EXISTS ledger_entry_time_idx  ON ledger_entry (occurred_at_unix);
-- Chain coordinates are not unique on their own: one log can legitimately
-- produce several entries, so the uniqueness that matters lives in id.
CREATE INDEX IF NOT EXISTS ledger_entry_tx_idx    ON ledger_entry (tx_hash, log_index);

-- One row per fee observation. The PRIMARY KEY is what makes replay a no-op:
-- a re-fed chain log regenerates the same deterministic id and collides here.
CREATE TABLE IF NOT EXISTS ledger_observation (
    id                TEXT PRIMARY KEY,
    vault             TEXT    NOT NULL,
    asset             TEXT    NOT NULL,
    accrual_key       TEXT    NOT NULL,
    source            TEXT    NOT NULL,
    amount_minor      TEXT    NOT NULL,
    occurred_at_unix  INTEGER NOT NULL,
    block_hash        TEXT,
    tx_hash           TEXT,
    log_index         INTEGER,
    outcome           TEXT    NOT NULL,
    entry_ids         TEXT    NOT NULL,

    CONSTRAINT ledger_observation_source_is_income
        CHECK (source IN ('curve_event','pool_fees_swept','escrow_credit','erc20_transfer'))
);

CREATE INDEX IF NOT EXISTS ledger_observation_key_idx
    ON ledger_observation (vault, asset, accrual_key);

-- Recognition state. AT MOST ONE ROW PER ACCRUAL KEY, enforced by the primary
-- key: that constraint is the "exactly once" in "income is recognised exactly
-- once". per_source_json holds the totals each source has reported, so a
-- higher-precedence source arriving late can supersede with the right delta.
CREATE TABLE IF NOT EXISTS ledger_recognition (
    vault                    TEXT    NOT NULL,
    asset                    TEXT    NOT NULL,
    accrual_key              TEXT    NOT NULL,
    per_source_json          TEXT    NOT NULL,
    recognized_source        TEXT    NOT NULL,
    recognized_minor         TEXT    NOT NULL,
    first_recognized_at_unix INTEGER NOT NULL,
    last_observed_at_unix    INTEGER NOT NULL,
    supersessions            INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (vault, asset, accrual_key),
    CONSTRAINT ledger_recognition_source_is_income
        CHECK (recognized_source IN
               ('curve_event','pool_fees_swept','escrow_credit','erc20_transfer'))
);

-- Materialized balances. DERIVED DATA. Truncating this table and replaying
-- ledger_entry must reproduce it exactly; ledger_balance_check() in the
-- application is that comparison.
CREATE TABLE IF NOT EXISTS ledger_balance (
    vault          TEXT    NOT NULL,
    asset          TEXT    NOT NULL,
    account        TEXT    NOT NULL,
    debits_minor   TEXT    NOT NULL,
    credits_minor  TEXT    NOT NULL,
    balance_minor  TEXT    NOT NULL,
    entry_count    INTEGER NOT NULL,

    PRIMARY KEY (vault, asset, account),
    CONSTRAINT ledger_balance_account_known
        CHECK (account IN ('income:fees','asset:escrow','asset:vault',
                           'liability:dev_claimable','liability:budget',
                           'liability:operator_claimable','liability:referrer_claimable',
                           'expense:procurement','expense:cogs'))
);

-- Materialized flow totals by posting kind. Income figures are read from here
-- and never off ledger_balance: the income:fees balance mixes recognition,
-- allocation and restricted-fund release, so it is not QF.
CREATE TABLE IF NOT EXISTS ledger_flow (
    vault         TEXT    NOT NULL,
    asset         TEXT    NOT NULL,
    posting_kind  TEXT    NOT NULL,
    amount_minor  TEXT    NOT NULL,
    entry_count   INTEGER NOT NULL,

    PRIMARY KEY (vault, asset, posting_kind)
);

CREATE TABLE IF NOT EXISTS ledger_variance (
    id                   TEXT PRIMARY KEY,
    vault                TEXT    NOT NULL,
    asset                TEXT    NOT NULL,
    ledger_balance_minor TEXT    NOT NULL,
    chain_balance_minor  TEXT    NOT NULL,
    delta_minor          TEXT    NOT NULL,
    severity             TEXT    NOT NULL,
    detected_at_unix     INTEGER NOT NULL,
    block_hash           TEXT,
    note                 TEXT,

    CONSTRAINT ledger_variance_severity_known
        CHECK (severity IN ('info','warn','critical'))
);

CREATE INDEX IF NOT EXISTS ledger_variance_scope_idx
    ON ledger_variance (vault, asset, detected_at_unix);

-- A critical variance freezes NEW spend authorization for its scope. Rows are
-- never deleted; clearing sets cleared_at_unix, so "who unfroze this and when"
-- survives.
CREATE TABLE IF NOT EXISTS ledger_freeze (
    id                TEXT PRIMARY KEY,
    scope_kind        TEXT    NOT NULL,
    scope_vault       TEXT,
    scope_asset       TEXT,
    reason            TEXT    NOT NULL,
    variance_id       TEXT,
    frozen_at_unix    INTEGER NOT NULL,
    cleared_at_unix   INTEGER,
    cleared_by        TEXT,

    CONSTRAINT ledger_freeze_scope_known
        CHECK (scope_kind IN ('global','vault','asset','vault_asset')),
    CONSTRAINT ledger_freeze_scope_fields
        CHECK (
            (scope_kind = 'global'      AND scope_vault IS NULL AND scope_asset IS NULL) OR
            (scope_kind = 'vault'       AND scope_vault IS NOT NULL AND scope_asset IS NULL) OR
            (scope_kind = 'asset'       AND scope_vault IS NULL AND scope_asset IS NOT NULL) OR
            (scope_kind = 'vault_asset' AND scope_vault IS NOT NULL AND scope_asset IS NOT NULL)
        )
);

CREATE INDEX IF NOT EXISTS ledger_freeze_active_idx ON ledger_freeze (cleared_at_unix);

-- Monotonic sequence for ledger_entry.seq. A separate single-row table rather
-- than an identity column so the value is read and advanced inside the same
-- transaction as the insert, which keeps cursor paging stable.
CREATE TABLE IF NOT EXISTS ledger_sequence (
    name       TEXT PRIMARY KEY,
    next_value INTEGER NOT NULL
);
