-- 0021_publisher_health.sql
--
-- THE PUBLISHING ACCOUNT HEALTH LOG. A platform suspension used to be learned
-- from a failed publish, which the publisher recorded as a rejection rather
-- than as an account state - so `publishing.suspendedChannels` had no source
-- and the page could never fire. The `publishing.health` job now probes every
-- bound X account (GET /2/users/me under its own token) every six hours and
-- APPENDS the verdict here; the publisher refuses to post from an account
-- whose newest row is not a fresh `ok`, and the monitoring collector reads
-- the newest row per account.
--
-- One row per probe, never an upsert: the onset of a suspension is the first
-- non-ok row after the last ok one, and that is a fact the appeal needs.
-- `unreachable` is a probe result the job does not persist (the run fails and
-- is retried instead), but the CHECK admits it so a store that chooses to
-- record it is not refused by the schema.
--
-- detail is the platform's own words (HTTP status, problem type and detail),
-- bounded. It is operator-facing and is never rendered to a reader.

CREATE TABLE IF NOT EXISTS publisher_account_health (
    id               BIGSERIAL PRIMARY KEY,
    channel          TEXT   NOT NULL,
    -- Lowercased, like publisher_account_binding.account_id.
    account_id       TEXT   NOT NULL,
    status           TEXT   NOT NULL,
    observed_at_unix BIGINT NOT NULL,
    detail           TEXT   NOT NULL,

    CONSTRAINT publisher_account_health_channel_known
        CHECK (channel IN ('telegram','x_operator','x_client_delegated','site')),
    CONSTRAINT publisher_account_health_status_known
        CHECK (status IN ('ok','suspended','locked','unauthorized','unreachable')),
    CONSTRAINT publisher_account_health_detail_bounded CHECK (length(detail) <= 240)
);

-- "Newest row per account" is the only read: the publisher's gate and the
-- collector both take it.
CREATE INDEX IF NOT EXISTS publisher_account_health_latest_idx
    ON publisher_account_health (channel, account_id, observed_at_unix DESC, id DESC);
