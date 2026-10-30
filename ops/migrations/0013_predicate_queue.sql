-- 0013_predicate_queue.sql
--
-- THE DELIVERY-PREDICATE QUEUE, FED BY THE TICK LOOP.
--
-- Until now the delivery.predicates job drained a port nothing wrote to: the
-- orchestrator's attemptSpend had nowhere to leave "this disbursement was
-- funded at T, re-check it at T+24h and T+7d". PgPredicateQueue
-- (ops/scheduler/store/predicates.ts) is both ends of that pipe - the
-- orchestrator enqueues one schedule per settled reimbursement, the ops job
-- lists what is due - and this is the table between them.
--
-- WHY NOT 0003's predicate_check. That table is keyed to `disbursement`, the
-- 0003 receipt row with FKs to vault, sku and vendor. The fleet does not write
-- those rows: its spend path records a fleet_disbursement counter (0008) and a
-- receipt (the orchestrator's ReceiptStore), and its catalog is loaded from
-- data/ rather than from the sku table. A queue row that could only exist once
-- a `disbursement` row existed would never exist. So the queue carries what the
-- verifier needs to reconstruct the check on its own - vault, token, the SKU's
-- predicate spec and the invoice's baseline - and references nothing.
--
-- ONE ROW PER (disbursement, offset). enqueue() expands the spec's offsets into
-- rows and is idempotent on the primary key, so a tick that retries after the
-- settlement landed but before its own bookkeeping cannot schedule a second
-- set of checks. recordResult() fills checked_at_unix/passed exactly once; the
-- partial index below is the due queue, and a checked row leaves it.
--
-- THE SPEC IS COPIED, NOT REFERENCED. The predicate that was promised at
-- purchase time is the one the vendor is held to. If the catalog later changes
-- a SKU's offsets, an already-funded delivery is still checked on the schedule
-- it was funded under.
--
-- WITHHOLDING AND PENALTIES are records, not transfers. The operator paid the
-- vendor as principal and was reimbursed against the invoice; a failed check
-- cannot claw money back through this table. What it can do is make the
-- dispute (ops/runbooks/vendor-non-delivery-dispute.md) a query rather than a
-- reconstruction, and put the vendor's failures where the next diligence pass
-- reads them.

CREATE TABLE IF NOT EXISTS ops_predicate_check (
    disbursement_id   TEXT    NOT NULL,
    offset_seconds    INTEGER NOT NULL,
    vault             TEXT    NOT NULL,
    token             TEXT    NOT NULL,
    sku_id            TEXT    NOT NULL,
    vendor_id         TEXT    NOT NULL,
    -- Reporting only. The reimbursement itself moved as exact minor units on
    -- chain; this is the catalog price the alert quotes.
    cost_usd          DOUBLE PRECISION NOT NULL,
    funded_at_unix    BIGINT  NOT NULL,
    due_at_unix       BIGINT  NOT NULL,
    -- core DeliveryPredicateSpec, as funded. Read back whole by the verifier.
    spec              JSONB   NOT NULL,
    -- { boosts?, rank? } from the invoice, captured before the purchase.
    baseline          JSONB,
    enqueued_at_unix  BIGINT  NOT NULL,

    checked_at_unix   BIGINT,
    passed            BOOLEAN,
    evidence_uri      TEXT,
    evidence_hash     TEXT,
    note              TEXT,

    PRIMARY KEY (disbursement_id, offset_seconds),

    CONSTRAINT ops_predicate_check_offset_nonnegative CHECK (offset_seconds >= 0),
    CONSTRAINT ops_predicate_check_due_derived CHECK (due_at_unix = funded_at_unix + offset_seconds),
    -- A result is a timestamp AND a verdict. Half a result is not a result.
    CONSTRAINT ops_predicate_check_result_whole CHECK ((checked_at_unix IS NULL) = (passed IS NULL))
);

-- The due queue: unchecked rows, oldest due first. A checked row is not in it.
CREATE INDEX IF NOT EXISTS ops_predicate_check_due_idx
    ON ops_predicate_check (due_at_unix)
    WHERE checked_at_unix IS NULL;

CREATE INDEX IF NOT EXISTS ops_predicate_check_vendor_idx
    ON ops_predicate_check (vendor_id, checked_at_unix);

-- First failure wins: the reason recorded is the one from the check that
-- withheld, and a later check for the same disbursement does not rewrite it.
CREATE TABLE IF NOT EXISTS ops_predicate_withhold (
    disbursement_id   TEXT    PRIMARY KEY,
    vendor_id         TEXT    NOT NULL,
    reason            TEXT    NOT NULL,
    withheld_at_unix  BIGINT  NOT NULL
);

-- Append-only. One row per failed check; the vendor's record is the count.
CREATE TABLE IF NOT EXISTS ops_vendor_penalty (
    id                 BIGSERIAL PRIMARY KEY,
    vendor_id          TEXT    NOT NULL,
    reason             TEXT    NOT NULL,
    penalized_at_unix  BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS ops_vendor_penalty_vendor_idx
    ON ops_vendor_penalty (vendor_id, penalized_at_unix);
