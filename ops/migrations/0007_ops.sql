-- 0007_ops.sql
--
-- The operations plane's own state: job runs, singleton locks, dead letters and
-- alert firings.
--
-- ops_job_run IS THE IDEMPOTENCY RECORD. Its primary key is the run key, a pure
-- function of (job, scope, period). That is what makes a crash between doing the
-- work and recording it recoverable: the retry computes the same key and finds
-- the prior row instead of doing the work twice. For the escrow sweep, "twice"
-- means a second on-chain claim.
--
-- ops_job_lock IS A LEASE, NOT A MUTEX. A holder that dies must not wedge a job
-- forever, so rows expire. A lease can therefore expire while its holder is
-- still working, which is exactly why every job is idempotent as well: the lock
-- makes double execution rare, the run key makes it harmless.

CREATE TABLE IF NOT EXISTS ops_job_run (
    run_key             TEXT PRIMARY KEY,
    job_id              TEXT    NOT NULL,
    scope               TEXT    NOT NULL,
    period              TEXT    NOT NULL,
    state               TEXT    NOT NULL,
    attempt             INTEGER NOT NULL,
    started_at_unix     BIGINT  NOT NULL,
    updated_at_unix     BIGINT  NOT NULL,
    -- Only set while in_progress. Lets a crashed attempt be reclaimed.
    lease_expires_at_unix BIGINT,
    completed_at_unix   BIGINT,
    -- A machine code. Never a remote service's message text.
    code                TEXT,

    CONSTRAINT ops_job_run_state_known
        CHECK (state IN ('in_progress','completed','retry','dead_lettered')),
    CONSTRAINT ops_job_run_attempt_positive CHECK (attempt >= 1),
    -- A completed run has a completion time; nothing else does.
    CONSTRAINT ops_job_run_completed_has_time
        CHECK ((state = 'completed') = (completed_at_unix IS NOT NULL))
);

-- The interval triggers read this: "when did this job last succeed for this scope".
CREATE INDEX IF NOT EXISTS ops_job_run_last_success_idx
    ON ops_job_run (job_id, scope, completed_at_unix);
CREATE INDEX IF NOT EXISTS ops_job_run_state_idx ON ops_job_run (state, updated_at_unix);

CREATE TABLE IF NOT EXISTS ops_job_lock (
    lock_key           TEXT PRIMARY KEY,
    -- Random per acquisition. Release and renew are refused unless it matches,
    -- so a process whose lease expired cannot delete its successor's lock.
    token              TEXT    NOT NULL,
    owner              TEXT    NOT NULL,
    acquired_at_unix   BIGINT  NOT NULL,
    expires_at_unix    BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS ops_job_lock_expiry_idx ON ops_job_lock (expires_at_unix);

-- A job that exhausted its attempts. Nothing retries these; the growth alert is
-- what makes someone look.
CREATE TABLE IF NOT EXISTS ops_dead_letter (
    id                   TEXT PRIMARY KEY,
    job_id               TEXT    NOT NULL,
    scope                TEXT    NOT NULL,
    period               TEXT    NOT NULL,
    run_key              TEXT    NOT NULL,
    attempts             INTEGER NOT NULL,
    error_code           TEXT    NOT NULL,
    -- Bounded, machine-generated JSON. NEVER untrusted text: a dead letter gets
    -- read by a human in a terminal and replayed by hand.
    facts_json           TEXT    NOT NULL,
    reason_kind          TEXT    NOT NULL,
    first_failed_at_unix BIGINT  NOT NULL,
    last_failed_at_unix  BIGINT  NOT NULL,
    resolved_at_unix     BIGINT,
    resolved_by          TEXT,
    resolution           TEXT,

    CONSTRAINT ops_dead_letter_resolution_known
        CHECK (resolution IS NULL OR resolution IN ('replayed','discarded','fixed_out_of_band')),
    CONSTRAINT ops_dead_letter_resolution_has_actor
        CHECK ((resolved_at_unix IS NULL) = (resolved_by IS NULL))
);

CREATE INDEX IF NOT EXISTS ops_dead_letter_open_idx ON ops_dead_letter (resolved_at_unix, last_failed_at_unix);
CREATE INDEX IF NOT EXISTS ops_dead_letter_job_idx ON ops_dead_letter (job_id, resolved_at_unix);

-- Alert firings, so "was this paging all weekend" is answerable and so the
-- for-duration and dedupe state survives a restart of the monitor.
CREATE TABLE IF NOT EXISTS ops_alert_firing (
    id                TEXT PRIMARY KEY,
    alert_id          TEXT    NOT NULL,
    scope             TEXT    NOT NULL,
    severity          TEXT    NOT NULL,
    summary           TEXT    NOT NULL,
    runbook           TEXT    NOT NULL,
    auto_action       TEXT    NOT NULL,
    facts_json        TEXT    NOT NULL,
    first_seen_at_unix BIGINT NOT NULL,
    fired_at_unix     BIGINT  NOT NULL,
    cleared_at_unix   BIGINT,
    acknowledged_by   TEXT,
    acknowledged_at_unix BIGINT,

    CONSTRAINT ops_alert_severity_known CHECK (severity IN ('page','ticket','info'))
);

CREATE INDEX IF NOT EXISTS ops_alert_firing_open_idx ON ops_alert_firing (alert_id, scope, cleared_at_unix);
CREATE INDEX IF NOT EXISTS ops_alert_firing_time_idx ON ops_alert_firing (fired_at_unix);

-- Durable cursors for the jobs that read a stream forward. A restart that lost
-- its cursor would re-screen the entire book; a restart that advanced it too far
-- would skip a metadata change. Both are worse than a row.
CREATE TABLE IF NOT EXISTS ops_cursor (
    name             TEXT PRIMARY KEY,
    position_unix    BIGINT  NOT NULL,
    updated_at_unix  BIGINT  NOT NULL
);

-- Per-coin model spend, instrumented from day one. The tier COGS alert reads it.
CREATE TABLE IF NOT EXISTS ops_inference_cost (
    vault             TEXT    NOT NULL,
    day_key           TEXT    NOT NULL,
    tier              TEXT    NOT NULL,
    input_tokens      BIGINT  NOT NULL,
    output_tokens     BIGINT  NOT NULL,
    cache_read_tokens BIGINT  NOT NULL,
    -- A cost, not money owed. Derived from a published price list at the time.
    cost_usd          DOUBLE PRECISION NOT NULL,
    price_list_version TEXT   NOT NULL,
    updated_at_unix   BIGINT  NOT NULL,

    PRIMARY KEY (vault, day_key)
);

CREATE INDEX IF NOT EXISTS ops_inference_cost_day_idx ON ops_inference_cost (day_key);
