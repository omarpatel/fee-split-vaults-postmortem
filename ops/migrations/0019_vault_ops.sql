-- 0019_vault_ops.sql
--
-- THE EXECUTOR OUTBOXES: what the on-chain sweep and settlement executors
-- (ops/scheduler/adapters/{sweeper,settlement}.ts) hold between a broadcast
-- and the ledger's acknowledgement.
--
-- WHY THE ROW IS OPENED BEFORE THE FIRST BROADCAST. A claim that was broadcast
-- and then lost before the ledger write has already drained the escrow, so the
-- value trigger and the forced interval both see nothing to do and the money
-- never reaches the books. SweepExecutor.unrecorded() is the only path back,
-- and it can only return a row that exists. So the executor inserts the row
-- under the run key first, appends each confirmed chunk to it, and marks it
-- complete last; a retry under the same run key finds the row and re-reports
-- exactly the chunks that landed. It never claims again on a key it has seen.
--
-- A CHUNK OF UNKNOWN FATE IS RECORDED AS PENDING, NOT AS CLAIMED. When a
-- broadcast produces no confirmed receipt inside the deadline the hash goes in
-- pending_tx_hash and nothing is added to claimed_minor. The next attempt
-- resolves it from the receipt before doing anything else: landed -> folded in
-- from the vault's own Claimed log; reverted -> cleared; still absent -> the
-- attempt refuses, because claiming on top of an in-flight claim is exactly the
-- double claim the run key exists to prevent.
--
-- WHY NOT 0002's escrow_sweep / vault_settlement. Both reference the 0002
-- `vault` table, which the live path never populates (the record is
-- vault_record, 0011), and both are keyed on the ledger's view of a completed
-- sweep. The ledger side is 0015's ops_sweep_match / ops_settlement_record;
-- these are the executor's side, and they key on the run key because that is
-- what a crashed attempt still knows.
--
-- MONEY IS TEXT, as everywhere: base-10 strings of minor units.

CREATE TABLE IF NOT EXISTS ops_sweep_outbox (
    run_key            TEXT    PRIMARY KEY,
    sweep_id           TEXT    NOT NULL,
    vault              TEXT    NOT NULL,
    asset              TEXT    NOT NULL,
    expected_minor     TEXT    NOT NULL,
    -- Sum of Claimed.received over the confirmed chunks. What actually landed.
    claimed_minor      TEXT    NOT NULL,
    chunks             INTEGER NOT NULL,
    -- JSON array of confirmed chunk tx hashes, in send order.
    tx_hashes          JSONB   NOT NULL,
    -- The block of the last confirmed chunk. NULL until one lands.
    block_hash         TEXT,
    pending_tx_hash    TEXT,
    opened_at_unix     BIGINT  NOT NULL,
    updated_at_unix    BIGINT  NOT NULL,
    completed_at_unix  BIGINT,
    -- Set by confirmRecorded() after ledger.recordSweep succeeded.
    recorded_at_unix   BIGINT,

    CONSTRAINT ops_sweep_outbox_chunks_nonnegative CHECK (chunks >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ops_sweep_outbox_sweep_id_uq ON ops_sweep_outbox (sweep_id);

-- The outbox drain: rows the ledger has not acknowledged, oldest first.
CREATE INDEX IF NOT EXISTS ops_sweep_outbox_unrecorded_idx
    ON ops_sweep_outbox (updated_at_unix)
    WHERE recorded_at_unix IS NULL;

-- One settle() per run key. The row is opened with the legs read before the
-- call and completed from the vault's own Credited log in the receipt, so the
-- split reported is the split the contract emitted, not one recomputed here.
CREATE TABLE IF NOT EXISTS ops_settlement_outbox (
    run_key            TEXT    PRIMARY KEY,
    settlement_id      TEXT    NOT NULL,
    vault              TEXT    NOT NULL,
    asset              TEXT    NOT NULL,
    -- What the executor was asked to settle.
    requested_minor    TEXT    NOT NULL,
    -- Legs before the call, for the after-minus-before check.
    dev_before_minor       TEXT NOT NULL,
    budget_before_minor    TEXT NOT NULL,
    operator_before_minor  TEXT NOT NULL,
    referrer_before_minor  TEXT NOT NULL,
    -- From the Credited log. NULL until the call is confirmed.
    credited_minor     TEXT,
    dev_leg_minor      TEXT,
    budget_minor       TEXT,
    operator_minor     TEXT,
    tx_hash            TEXT,
    block_hash         TEXT,
    pending_tx_hash    TEXT,
    opened_at_unix     BIGINT  NOT NULL,
    settled_at_unix    BIGINT,

    -- A completed row carries every leg; an open row carries none.
    CONSTRAINT ops_settlement_outbox_whole CHECK (
        (settled_at_unix IS NULL) = (credited_minor IS NULL)
        AND (credited_minor IS NULL) = (dev_leg_minor IS NULL)
        AND (dev_leg_minor IS NULL) = (budget_minor IS NULL)
        AND (budget_minor IS NULL) = (operator_minor IS NULL)
        AND (operator_minor IS NULL) = (tx_hash IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS ops_settlement_outbox_settlement_id_uq ON ops_settlement_outbox (settlement_id);
CREATE INDEX IF NOT EXISTS ops_settlement_outbox_scope_idx ON ops_settlement_outbox (vault, asset, settled_at_unix);
