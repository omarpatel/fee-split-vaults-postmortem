-- 0009_agent_runs.sql
--
-- ONE ROW PER COIN PER TICK. This is what makes the fleet observable.
--
-- Every member coin has its own agent team, and the team runs on a schedule
-- whether or not anything happened. Without this table the only evidence a tick
-- ever occurred is a log line, and a log line cannot answer the two questions a
-- dev actually asks: "what did my team do this week", and "what did it refuse
-- to do, and why".
--
-- WHAT IS DELIBERATELY NOT IN HERE.
--
--   NO MESSAGES. Not a body, not an author, not a handle. The reader's output
--   is a census of closed-vocabulary counts, and that census is what is stored.
--   A holder's message never reaches this table, so an operator dump of it can
--   never become a dossier on a community.
--   NO POST BODIES. Published copy belongs on the receipts ledger with its
--   permalink. Only its length survives here, because "the planner wrote 180
--   characters" is an audit fact and the characters are not.
--   NO DISBURSEMENT INTERNALS. What moved and to whom is the ledger's job.
--   Duplicating it would create a second, unreconciled account of the same
--   money. This table records that a purchase was proposed and what the gate
--   decided about it.
--
-- WHAT IS DELIBERATELY IN HERE.
--
--   EVERY REFUSAL, with its phase and its machine code. A fail-closed system
--   whose refusals are invisible from the outside is indistinguishable from one
--   that has no rules, so the refusals are first-class columns rather than a
--   footnote in a log.
--   MODEL PROVENANCE, per run. A process that later gains a credential must not
--   be able to retroactively relabel the scripted runs it already served, so
--   the provenance is written with the row and never recomputed from current
--   configuration. The same argument covers faked_dependencies: a run served
--   with a fake anywhere in the money path names those fakes here, in the
--   record, and not only in a startup banner someone may not have read.
--
-- ABSENT IS NOT ZERO. Every count that could be unmeasured is NULLABLE, and NULL
-- means the phase did not run or could not be measured. Writing 0 for "we did
-- not look" is the exact bug the fail-closed rule exists to prevent, and the
-- all-or-nothing digest constraint below stops a half-written census being read
-- as a complete one.
--
-- MONEY IS AN INTEGER. cost_micro_usd is micro-USD, not a float. A float here
-- would be a rounding argument attached to a client's procurement budget, and
-- inference is charged against that budget before any procurement.

CREATE TABLE IF NOT EXISTS ops_agent_run (
    -- `${vault}:${at_unix}`. Deterministic, so re-projecting an archived tick
    -- result writes the same row rather than a duplicate.
    id                          TEXT PRIMARY KEY,
    -- The scheduler's (job, scope, period) key. UNIQUE is the idempotency
    -- guarantee: the fleet tick can authorize a reimbursement pull, and a retry
    -- that found no prior row would be free to authorize a second one.
    run_key                     TEXT    NOT NULL UNIQUE,
    coin_ref                    TEXT    NOT NULL,
    vault                       TEXT    NOT NULL,
    tier                        TEXT    NOT NULL,
    at_unix                     BIGINT  NOT NULL,
    -- What the coin itself said about when it next has work. The scheduler
    -- honours it; keeping it here makes a stalled cadence diagnosable.
    next_due_unix               BIGINT  NOT NULL,
    ran_chain_poll              BOOLEAN NOT NULL,
    ran_cognition               BOOLEAN NOT NULL,

    -- The window and the reader's census. All NULL together, or all present.
    window_id                   TEXT,
    window_start_unix           BIGINT,
    window_end_unix             BIGINT,
    admitted_message_count      INTEGER,
    dropped_message_count       INTEGER,
    distinct_author_count       INTEGER,
    reader_refusals             INTEGER,
    -- Gists the reader emitted that trusted code dropped at the boundary. A
    -- rising number here is an attacker probing the airlock, not noise.
    rejected_gist_count         INTEGER,
    -- [{code,count}] over the closed topic vocabulary, in the vocabulary's own
    -- order. The ORDER the model chose is itself a channel, so it is not kept.
    topic_counts_json           TEXT,
    signals_json                TEXT,
    -- Scrubbed at the airlock and scrubbed again on the way out. The only text
    -- in this table that ever passed through untrusted input.
    gists_json                  TEXT,

    -- Why there was no model call, when there was none.
    skipped                     TEXT,
    -- The divergence detector's verdict, when it fired.
    freeze_level                TEXT,
    freeze_reason               TEXT,

    proposal_count              INTEGER NOT NULL,
    proposals_json              TEXT    NOT NULL,
    -- Proposals a freeze removed, WITH the reason. A suppressed proposal that
    -- vanished silently would make the freeze invisible to the client paying
    -- for it.
    suppressed_count            INTEGER NOT NULL,
    suppressed_json             TEXT    NOT NULL,
    -- Tool calls the planner made that trusted code rejected outright.
    violation_count             INTEGER NOT NULL,
    violations_json             TEXT    NOT NULL,
    refusal_count               INTEGER NOT NULL,
    refusals_json               TEXT    NOT NULL,
    spend_count                 INTEGER NOT NULL,
    spends_json                 TEXT    NOT NULL,
    publish_count               INTEGER NOT NULL,
    publishes_json              TEXT    NOT NULL,

    input_tokens                BIGINT  NOT NULL,
    output_tokens               BIGINT  NOT NULL,
    cache_creation_input_tokens BIGINT  NOT NULL,
    cache_read_input_tokens     BIGINT  NOT NULL,
    cost_micro_usd              BIGINT  NOT NULL,
    degrade_level               TEXT    NOT NULL,

    model_provenance            TEXT    NOT NULL,
    -- Comma-separated dependency names that ran as fakes for this run. Empty
    -- string means nothing was faked. Never NULL: "we did not record it" and
    -- "nothing was faked" must not be the same value.
    faked_dependencies          TEXT    NOT NULL,
    recorded_at_unix            BIGINT  NOT NULL,

    CONSTRAINT ops_agent_run_provenance_known
        CHECK (model_provenance IN ('live', 'fake', 'unknown')),
    -- A half-written census is worse than none: it reads as a complete one.
    CONSTRAINT ops_agent_run_digest_all_or_nothing
        CHECK (
            (window_id IS NULL AND window_start_unix IS NULL AND window_end_unix IS NULL
                AND admitted_message_count IS NULL AND dropped_message_count IS NULL
                AND distinct_author_count IS NULL AND reader_refusals IS NULL
                AND rejected_gist_count IS NULL AND topic_counts_json IS NULL
                AND signals_json IS NULL AND gists_json IS NULL)
            OR
            (window_id IS NOT NULL AND window_start_unix IS NOT NULL AND window_end_unix IS NOT NULL
                AND admitted_message_count IS NOT NULL AND dropped_message_count IS NOT NULL
                AND distinct_author_count IS NOT NULL AND reader_refusals IS NOT NULL
                AND rejected_gist_count IS NOT NULL AND topic_counts_json IS NOT NULL
                AND signals_json IS NOT NULL AND gists_json IS NOT NULL)
        ),
    CONSTRAINT ops_agent_run_freeze_pair
        CHECK ((freeze_level IS NULL) = (freeze_reason IS NULL)),
    CONSTRAINT ops_agent_run_freeze_known
        CHECK (freeze_level IS NULL OR freeze_level IN ('purchases', 'all')),
    CONSTRAINT ops_agent_run_counts_are_counts
        CHECK (proposal_count >= 0 AND suppressed_count >= 0 AND violation_count >= 0
               AND refusal_count >= 0 AND spend_count >= 0 AND publish_count >= 0
               AND input_tokens >= 0 AND output_tokens >= 0
               AND cache_creation_input_tokens >= 0 AND cache_read_input_tokens >= 0),
    -- Inference is charged against the client's procurement budget. A negative
    -- charge would be a credit to the operator paid by the client.
    CONSTRAINT ops_agent_run_cost_not_negative CHECK (cost_micro_usd >= 0)
);

-- The dev-facing read: this coin's runs, newest first.
CREATE INDEX IF NOT EXISTS ops_agent_run_coin_idx ON ops_agent_run (coin_ref, at_unix DESC);
CREATE INDEX IF NOT EXISTS ops_agent_run_vault_idx ON ops_agent_run (vault, at_unix DESC);
-- "Show me everything that was served by a fake." One index, one answer.
CREATE INDEX IF NOT EXISTS ops_agent_run_provenance_idx
    ON ops_agent_run (model_provenance, at_unix DESC);
-- Per-coin inference cost over a period, for the tier COGS alert.
CREATE INDEX IF NOT EXISTS ops_agent_run_cost_idx ON ops_agent_run (at_unix, coin_ref);
