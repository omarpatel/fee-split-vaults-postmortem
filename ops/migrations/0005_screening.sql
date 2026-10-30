-- 0005_screening.sql
--
-- Screening results and the metadata observations that trigger a re-screen.
--
-- FLAGS UNION, VERDICTS ARE STICKY. Every stage may add a flag and no stage may
-- clear one, and the same holds across time: a re-screen that comes back CLEAR
-- on a token that was BLOCKED records the new result and leaves the enforcement
-- in place. Otherwise the cheapest attack is to change the metadata, get the
-- promotion, and change it back. Un-blocking is a human decision recorded in
-- screening_override, out of band, with a named actor.
--
-- NO METADATA TEXT IS STORED HERE. metadata_ref is an opaque handle and
-- metadata_hash is a content digest. The operations plane never dereferences
-- either; only the screening package does. Token metadata is attacker-authored
-- text sitting next to code that suspends accounts.

CREATE TABLE IF NOT EXISTS screening_result (
    id                    TEXT PRIMARY KEY,
    token                 TEXT    NOT NULL,
    vault                 TEXT    REFERENCES vault (address),
    verdict               TEXT    NOT NULL,
    -- RESTRICTED permits organic operations but NO paid media.
    paid_media_permitted  BOOLEAN NOT NULL,
    -- Comma-separated stage names actually run, for audit of what was skipped.
    stages_run            TEXT    NOT NULL,
    metadata_ref          TEXT,
    metadata_hash         TEXT,
    screened_at_unix      BIGINT  NOT NULL,
    note                  TEXT,
    -- True for the row that currently governs this token.
    is_current            BOOLEAN NOT NULL,

    CONSTRAINT screening_verdict_known CHECK (verdict IN ('CLEAR','RESTRICTED','BLOCKED')),
    -- A BLOCKED or RESTRICTED token may never carry paid-media permission.
    CONSTRAINT screening_paid_media_implies_clear
        CHECK (paid_media_permitted = FALSE OR verdict = 'CLEAR')
);

CREATE INDEX IF NOT EXISTS screening_result_token_idx ON screening_result (token, screened_at_unix);
CREATE UNIQUE INDEX IF NOT EXISTS screening_result_current_uq
    ON screening_result (token) WHERE is_current;

CREATE TABLE IF NOT EXISTS screening_flag (
    result_id   TEXT    NOT NULL REFERENCES screening_result (id),
    flag_code   TEXT    NOT NULL,
    severity    TEXT    NOT NULL,
    stage       TEXT    NOT NULL,
    excerpt_hash TEXT,

    PRIMARY KEY (result_id, flag_code),
    CONSTRAINT screening_flag_severity_known CHECK (severity IN ('info','warn','high','critical'))
);

-- The only path by which enforcement is relaxed. A named human, a reason, and a
-- timestamp. There is no automatic writer for this table.
CREATE TABLE IF NOT EXISTS screening_override (
    id                TEXT PRIMARY KEY,
    token             TEXT    NOT NULL,
    from_verdict      TEXT    NOT NULL,
    to_verdict        TEXT    NOT NULL,
    reason            TEXT    NOT NULL,
    approved_by       TEXT    NOT NULL,
    second_approver   TEXT,
    approved_at_unix  BIGINT  NOT NULL,

    CONSTRAINT screening_override_verdicts_known
        CHECK (from_verdict IN ('CLEAR','RESTRICTED','BLOCKED')
               AND to_verdict IN ('CLEAR','RESTRICTED','BLOCKED'))
);

CREATE INDEX IF NOT EXISTS screening_override_token_idx ON screening_override (token, approved_at_unix);

-- Observed metadata changes. The re-screen job reads this table forward from a
-- cursor; the hash is what makes a repeated observation a no-op.
CREATE TABLE IF NOT EXISTS token_metadata_observation (
    id                 TEXT PRIMARY KEY,
    token              TEXT    NOT NULL,
    vault              TEXT    REFERENCES vault (address),
    metadata_ref       TEXT    NOT NULL,
    metadata_hash      TEXT    NOT NULL,
    -- Closed vocabulary, comma separated: name,symbol,image,description,links,socials.
    changed_fields     TEXT    NOT NULL,
    observed_at_unix   BIGINT  NOT NULL,
    block_hash         TEXT    NOT NULL,
    screened_result_id TEXT    REFERENCES screening_result (id)
);

CREATE INDEX IF NOT EXISTS token_metadata_observation_cursor_idx
    ON token_metadata_observation (observed_at_unix);
CREATE UNIQUE INDEX IF NOT EXISTS token_metadata_observation_hash_uq
    ON token_metadata_observation (token, metadata_hash);

-- Client fraud diligence, kept separate from content screening because the two
-- have different evidence and different escalation paths.
CREATE TABLE IF NOT EXISTS client_diligence (
    token                TEXT PRIMARY KEY,
    deployer             TEXT    NOT NULL,
    -- Prior launches by the same deployer that ended badly.
    prior_rug_count      INTEGER NOT NULL,
    deployer_supply_share_pct DOUBLE PRECISION NOT NULL,
    top10_holder_share_pct    DOUBLE PRECISION NOT NULL,
    verdict              TEXT    NOT NULL,
    reviewed_by          TEXT,
    reviewed_at_unix     BIGINT  NOT NULL,

    CONSTRAINT client_diligence_verdict_known CHECK (verdict IN ('CLEAR','RESTRICTED','BLOCKED'))
);
