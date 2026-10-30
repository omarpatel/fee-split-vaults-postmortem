-- 0015_ops_ports.sql
--
-- THE OPERATIONS PLANE'S OWN PORTS, MADE DURABLE.
--
-- Until this migration every ops port except the predicate queue was an
-- in-memory fake, so the scheduler could report a healthy tier evaluation, a
-- delivered weekly report or a clean three-way match while holding nothing.
-- These tables are what the real ports (ops/scheduler/adapters/*) write.
--
-- 0002 already declared vault_tier_history and vault_qf_observation, but both
-- reference the 0002 `vault` table, which the live path never populates: the
-- orchestrator's record is `vault_record` (0011). Rather than write rows into
-- a table whose foreign key can never be satisfied, the tier registry gets its
-- own tables here, keyed on the vault address the way vault_record is.
--
-- MONEY IS TEXT, as in 0001. Every minor-unit amount below is a base-10
-- string and nothing in this schema sums one. USD figures are DOUBLE PRECISION
-- because they are derived reporting numbers, never money.

-- Every tier decision the re-evaluation job APPLIED, with the measurement that
-- justified it. Append-only; the monitoring collector reads "downgrades in the
-- last day" off it.
CREATE TABLE IF NOT EXISTS ops_tier_history (
    id                TEXT PRIMARY KEY,
    vault             TEXT    NOT NULL,
    from_tier         TEXT    NOT NULL,
    to_tier           TEXT    NOT NULL,
    direction         TEXT    NOT NULL,
    qf_per_day_usd    DOUBLE PRECISION NOT NULL,
    observed_days     INTEGER NOT NULL,
    sustained_days    INTEGER NOT NULL,
    reason            TEXT    NOT NULL,
    decided_at_unix   BIGINT  NOT NULL,

    CONSTRAINT ops_tier_history_direction_known CHECK (direction IN ('up','down','hold')),
    CONSTRAINT ops_tier_history_tiers_known
        CHECK (from_tier IN ('T0','T1','T2','T3') AND to_tier IN ('T0','T1','T2','T3'))
);

CREATE INDEX IF NOT EXISTS ops_tier_history_scope_idx ON ops_tier_history (vault, decided_at_unix);
CREATE INDEX IF NOT EXISTS ops_tier_history_time_idx ON ops_tier_history (decided_at_unix);

-- One row per vault per UTC day: was QF below the CURRENT tier's gate that day.
-- days_below_gate is the length of the trailing run of below_gate rows, so it
-- is a stored fact the registry counts rather than a week of history the job
-- re-derives on every evaluation. Idempotent per day by the primary key.
CREATE TABLE IF NOT EXISTS ops_qf_observation (
    vault             TEXT    NOT NULL,
    day_key           TEXT    NOT NULL,
    qf_per_day_usd    DOUBLE PRECISION NOT NULL,
    below_gate        BOOLEAN NOT NULL,
    observed_at_unix  BIGINT  NOT NULL,

    PRIMARY KEY (vault, day_key)
);

-- Sweeps the ops plane executed, as the executor reported them, and the state
-- of their three-way match. The ledger's own claim entries are written by the
-- chain scan, keyed on the transaction the claim landed in; this row is the
-- EXPECTATION the match compares that scan against. Idempotent by sweep_id.
CREATE TABLE IF NOT EXISTS ops_sweep_match (
    sweep_id           TEXT PRIMARY KEY,
    run_key            TEXT    NOT NULL,
    vault              TEXT    NOT NULL,
    asset              TEXT    NOT NULL,
    claimed_minor      TEXT    NOT NULL,
    chunks             INTEGER NOT NULL,
    -- Comma-separated 0x hashes. The match joins the ledger's claim entries on these.
    tx_hashes          TEXT    NOT NULL,
    block_hash         TEXT    NOT NULL,
    swept_at_unix      BIGINT  NOT NULL,
    recorded_at_unix   BIGINT  NOT NULL,
    matched_at_unix    BIGINT,
    match_status       TEXT,
    -- Comma-separated ledger_variance ids the match recorded, if any.
    variance_ids       TEXT,

    CONSTRAINT ops_sweep_match_status_known
        CHECK (match_status IS NULL OR match_status IN ('matched','variance','incomplete')),
    CONSTRAINT ops_sweep_match_matched_whole
        CHECK ((matched_at_unix IS NULL) = (match_status IS NULL))
);

CREATE INDEX IF NOT EXISTS ops_sweep_match_unmatched_idx
    ON ops_sweep_match (swept_at_unix)
    WHERE matched_at_unix IS NULL;
CREATE INDEX IF NOT EXISTS ops_sweep_match_scope_idx ON ops_sweep_match (vault, asset, swept_at_unix);

-- Settlements the ops plane executed, as reported. The ledger's allocation
-- entries come from the chain scan of settle(); this is the receipt the settle
-- job asked the ledger to acknowledge. Idempotent by settlement_id.
CREATE TABLE IF NOT EXISTS ops_settlement_record (
    settlement_id     TEXT PRIMARY KEY,
    vault             TEXT    NOT NULL,
    asset             TEXT    NOT NULL,
    dev_leg_minor     TEXT    NOT NULL,
    budget_minor      TEXT    NOT NULL,
    operator_minor    TEXT    NOT NULL,
    tx_hash           TEXT,
    settled_at_unix   BIGINT  NOT NULL,
    recorded_at_unix  BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS ops_settlement_record_scope_idx
    ON ops_settlement_record (vault, asset, settled_at_unix);

-- One row per delivered weekly report. The unique key on (vault, period_end)
-- is what stops a retried report job sending the same week twice.
CREATE TABLE IF NOT EXISTS ops_report_delivery (
    id                 TEXT PRIMARY KEY,
    vault              TEXT    NOT NULL,
    period_start_unix  BIGINT  NOT NULL,
    period_end_unix    BIGINT  NOT NULL,
    channel            TEXT    NOT NULL,
    external_id        TEXT,
    -- Digest of the delivered body, so "what did the client actually receive"
    -- is answerable without storing the body.
    body_hash          TEXT    NOT NULL,
    delivered_at_unix  BIGINT  NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ops_report_delivery_period_uq
    ON ops_report_delivery (vault, period_end_unix);

-- The content hash the last screening of a token was made against. The
-- screening_result table is written only by the orchestrator's store, which
-- carries no hash; the re-screen job needs one to recognise a repeat
-- observation, so it lives beside the result rather than inside it.
CREATE TABLE IF NOT EXISTS ops_screening_hash (
    token             TEXT PRIMARY KEY,
    metadata_hash     TEXT    NOT NULL,
    screened_at_unix  BIGINT  NOT NULL
);

-- 0005's observation table references the never-populated 0002 `vault`. The
-- metadata watcher writes the vault_record address here, so the constraint
-- goes; the column, the index and the hash uniqueness stay.
ALTER TABLE token_metadata_observation DROP CONSTRAINT IF EXISTS token_metadata_observation_vault_fkey;

-- Which job raised an alert firing. The monitoring job clears the firings IT
-- raised when their condition stops holding; a page raised directly by a
-- reconciliation job is cleared by the human who resolved it.
ALTER TABLE ops_alert_firing ADD COLUMN IF NOT EXISTS raised_by TEXT;
