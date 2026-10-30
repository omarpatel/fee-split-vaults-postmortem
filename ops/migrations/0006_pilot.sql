-- 0006_pilot.sql
--
-- The Section 9 experiment harness.
--
-- The pilot answers one question - does a staffed desk raise a coin's
-- quote-denominated Venue-pool creator fees - and the schema is built so that a
-- negative answer is easy to reach and hard to talk around.
--
-- IT RANDOMIZES WHEN, NEVER WHETHER. Coverage is assigned to time windows within
-- a coin, and every coin has full coverage for the second half of the trial. A
-- design that withheld a free service from a subset of coins would be running an
-- experiment on people's money without their upside; this one does not.
--
-- PRE-REGISTRATION IS A ROW WITH A HASH, WRITTEN BEFORE ANY DATA EXISTS. The
-- analysis plan is recorded and hashed up front so the outcome cannot be chosen
-- after seeing the data. registered_at_unix earlier than the first measurement
-- is the check that makes it mean anything.

CREATE TABLE IF NOT EXISTS pilot_preregistration (
    id                    TEXT PRIMARY KEY,
    -- Digest over the full plan document. Published before enrolment opens.
    plan_hash             TEXT    NOT NULL,
    hypothesis            TEXT    NOT NULL,
    primary_outcome       TEXT    NOT NULL,
    -- The mechanical rule that decides Phase 1. Written down BEFORE the data.
    decision_rule         TEXT    NOT NULL,
    minimum_detectable_effect DOUBLE PRECISION NOT NULL,
    alpha                 DOUBLE PRECISION NOT NULL,
    planned_coins         INTEGER NOT NULL,
    planned_window_hours  INTEGER NOT NULL,
    registered_at_unix    BIGINT  NOT NULL,
    registered_by         TEXT    NOT NULL,

    CONSTRAINT pilot_prereg_alpha_bounds CHECK (alpha > 0 AND alpha < 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS pilot_prereg_plan_hash_uq ON pilot_preregistration (plan_hash);

CREATE TABLE IF NOT EXISTS pilot_enrolment (
    -- The pilot is FREE: no fee take, no budget, no vault. Enrolment is keyed on
    -- the token, not on a vault address, because there is no vault.
    token               TEXT PRIMARY KEY,
    prereg_id           TEXT    NOT NULL REFERENCES pilot_preregistration (id),
    -- Read on-chain. Recorded because creator net branches on it and the effect
    -- size has to be interpreted against the coin's own rate.
    buyback_enabled     BOOLEAN NOT NULL,
    creator_tax_bps     INTEGER NOT NULL,
    consented_at_unix   BIGINT  NOT NULL,
    -- The one-page agreement the dev signed. No vault, no contract beyond this.
    agreement_hash      TEXT    NOT NULL,
    trial_start_unix    BIGINT  NOT NULL,
    trial_end_unix      BIGINT  NOT NULL,
    withdrawn_at_unix   BIGINT,

    CONSTRAINT pilot_enrolment_trial_ordered CHECK (trial_end_unix > trial_start_unix)
);

-- One row per (token, window). `covered` is the treatment.
--
-- assignment_hash is a digest of (plan_hash, token, window_index) so the
-- assignment is reproducible by anyone holding the pre-registration - which is
-- what stops it being re-rolled until it looks good.
CREATE TABLE IF NOT EXISTS pilot_assignment (
    token             TEXT    NOT NULL REFERENCES pilot_enrolment (token),
    window_index      INTEGER NOT NULL,
    window_start_unix BIGINT  NOT NULL,
    window_end_unix   BIGINT  NOT NULL,
    covered           BOOLEAN NOT NULL,
    -- TRUE for windows in the guaranteed-coverage second half. Those are not
    -- randomized and are excluded from the primary contrast.
    guaranteed        BOOLEAN NOT NULL,
    assignment_hash   TEXT    NOT NULL,
    assigned_at_unix  BIGINT  NOT NULL,

    PRIMARY KEY (token, window_index),
    CONSTRAINT pilot_assignment_window_ordered CHECK (window_end_unix > window_start_unix),
    -- A guaranteed window that is not covered would break the promise the dev
    -- agreed to. The database refuses to store one.
    CONSTRAINT pilot_assignment_guaranteed_is_covered
        CHECK (guaranteed = FALSE OR covered = TRUE)
);

CREATE INDEX IF NOT EXISTS pilot_assignment_time_idx ON pilot_assignment (window_start_unix);

-- The outcome, measured per window from the same indexer path the ledger uses.
--
-- qf_usd here is Venue-pool creator fees only. Headline volume is deliberately
-- absent: Phase 0 measured a 122x gap between headline and fee-bearing volume on
-- a winner, so a harness that recorded headline volume would be measuring the
-- wrong thing and would look impressive doing it.
CREATE TABLE IF NOT EXISTS pilot_measurement (
    token             TEXT    NOT NULL REFERENCES pilot_enrolment (token),
    window_index      INTEGER NOT NULL,
    qf_usd            DOUBLE PRECISION NOT NULL,
    price_source      TEXT    NOT NULL,
    venue_pool_volume_usd DOUBLE PRECISION NOT NULL,
    unique_buyers     INTEGER NOT NULL,
    desk_messages_answered INTEGER NOT NULL,
    desk_refusals     INTEGER NOT NULL,
    block_hash        TEXT    NOT NULL,
    measured_at_unix  BIGINT  NOT NULL,

    PRIMARY KEY (token, window_index),
    FOREIGN KEY (token, window_index) REFERENCES pilot_assignment (token, window_index)
);

-- The mechanical Phase 1 decision, and the data it was computed from. One row
-- per pre-registration; a second run that disagrees is a visible contradiction
-- rather than a quiet overwrite.
CREATE TABLE IF NOT EXISTS pilot_decision (
    id                 TEXT PRIMARY KEY,
    prereg_id          TEXT    NOT NULL REFERENCES pilot_preregistration (id),
    tokens_analysed    INTEGER NOT NULL,
    windows_analysed   INTEGER NOT NULL,
    effect_estimate    DOUBLE PRECISION NOT NULL,
    ci_low             DOUBLE PRECISION NOT NULL,
    ci_high            DOUBLE PRECISION NOT NULL,
    p_value            DOUBLE PRECISION NOT NULL,
    -- PROCEED, STOP, or EXTEND. Produced by the pre-registered rule, not by a person.
    decision           TEXT    NOT NULL,
    decided_at_unix    BIGINT  NOT NULL,

    CONSTRAINT pilot_decision_known CHECK (decision IN ('PROCEED','STOP','EXTEND')),
    CONSTRAINT pilot_decision_ci_ordered CHECK (ci_high >= ci_low)
);

CREATE INDEX IF NOT EXISTS pilot_decision_prereg_idx ON pilot_decision (prereg_id, decided_at_unix);
