-- 0016_holders.sql
--
-- WHO HOLDS EACH MEMECOIN, REPLAYED FROM ITS OWN Transfer LOG.
--
-- The concentration signals (top-10 share, deployer share) that gate a tier
-- need a holder table, and no chain API serves one: there is only
-- Transfer(from, to, value), replayed from the launch block. The holder
-- indexer (packages/indexer/src/holders.ts) writes here, one cursor per token,
-- and the signal module reads a hash-pinned snapshot of it.
--
-- BALANCES ARE EXACT. A memecoin balance is a uint256, which does not fit a
-- BIGINT; NUMERIC(78,0) holds every uint256 without rounding, and the store
-- reads it back as a bigint through a checked decode, never Number().
--
-- THE CURSOR CARRIES A HASH. The scanner stops at the FINALIZED block on
-- purpose (no rollback path exists for balances), and on every tick it checks
-- the cursor's hash is still canonical before advancing. A finalized block that
-- is not canonical is a finality violation: the balances below it are void and
-- the scan refuses rather than repairs.
--
-- ONE TRANSACTION PER RANGE. The deltas of a range and the cursor that says the
-- range was applied are written together (see PgHolderBalanceStore.apply); a
-- cursor without its balances double-applies on restart, balances without their
-- cursor skip a range. Zero balances are deleted rather than kept, so `top` is
-- a scan of holders, not of everyone who ever held.

CREATE TABLE IF NOT EXISTS token_holder_balance (
    token          TEXT           NOT NULL,
    holder         TEXT           NOT NULL,
    balance        NUMERIC(78, 0) NOT NULL,
    -- The last block whose Transfer touched this row.
    updated_block  BIGINT         NOT NULL,

    PRIMARY KEY (token, holder),

    CONSTRAINT token_holder_balance_token_lower CHECK (token = lower(token)),
    CONSTRAINT token_holder_balance_holder_lower CHECK (holder = lower(holder)),
    -- >= 0, not > 0: a range that empties a holder lands as zero and is
    -- deleted in the same transaction. A negative is a conservation failure.
    CONSTRAINT token_holder_balance_nonnegative CHECK (balance >= 0)
);

CREATE INDEX IF NOT EXISTS token_holder_balance_top_idx
    ON token_holder_balance (token, balance DESC, holder);

CREATE TABLE IF NOT EXISTS token_holder_cursor (
    token                 TEXT   PRIMARY KEY,
    block_number          BIGINT NOT NULL,
    block_hash            TEXT   NOT NULL,
    block_timestamp_unix  BIGINT NOT NULL,
    updated_at_unix       BIGINT NOT NULL,

    CONSTRAINT token_holder_cursor_token_lower CHECK (token = lower(token)),
    CONSTRAINT token_holder_cursor_block_nonnegative CHECK (block_number >= 0)
);
