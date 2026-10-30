-- 0020_referrer_leg.sql
--
-- THE REFERRER LEG, UNFOLDED. On chain the referrer has always been a real
-- fourth leg (CoinVault legs[].referrer) with its own pull, withdrawReferrer,
-- callable only by REFERRER; its share is carved out of the OPERATOR's slice in
-- _splitOf, never out of the client's. Until now the off-chain ledger folded
-- it into liability:operator_claimable because core's LedgerAccount union had
-- no referrer account. It now has one, and this migration widens every place
-- that persisted the folded figure.
--
-- ROWS WRITTEN BEFORE THIS MIGRATION keep the folded figure: their
-- operator_minor is operator plus referrer and their referrer_minor is 0.
-- That is the honest reading of what was recorded, not a reconstruction; the
-- split for those rows is only recoverable from the chain's own Credited logs.
--
-- Every ALTER here is a DROP-then-ADD of a named CHECK, the same shape 0018
-- used for ops_escalation_kind_known: Postgres has no ALTER CONSTRAINT for a
-- CHECK body. Idempotent through IF EXISTS / IF NOT EXISTS.

-- 0001: the materialized balance table's closed account list. schema.sql in
-- packages/ledger is the source of truth and carries the same list.
ALTER TABLE ledger_balance DROP CONSTRAINT IF EXISTS ledger_balance_account_known;
ALTER TABLE ledger_balance ADD CONSTRAINT ledger_balance_account_known
    CHECK (account IN ('income:fees','asset:escrow','asset:vault',
                       'liability:dev_claimable','liability:budget',
                       'liability:operator_claimable','liability:referrer_claimable',
                       'expense:procurement','expense:cogs'));

-- 0008: the scanned Credited log, leg by leg. NUMERIC(78,0) like its siblings.
ALTER TABLE vault_allocation_observation
    ADD COLUMN IF NOT EXISTS referrer_minor NUMERIC(78, 0) NOT NULL DEFAULT 0;
ALTER TABLE vault_allocation_observation DROP CONSTRAINT IF EXISTS vault_allocation_legs_nonnegative;
ALTER TABLE vault_allocation_observation ADD CONSTRAINT vault_allocation_legs_nonnegative
    CHECK (dev_minor >= 0 AND budget_minor >= 0 AND operator_minor >= 0 AND referrer_minor >= 0);

-- 0015: the settle job's receipt, as the ledger was asked to acknowledge it.
ALTER TABLE ops_settlement_record
    ADD COLUMN IF NOT EXISTS referrer_minor TEXT NOT NULL DEFAULT '0';

-- 0019: the settlement executor's outbox. A completed row carries every leg,
-- so the completed-row CHECK grows by one equality; rows completed before this
-- migration are backfilled with 0 first so the new constraint admits them.
ALTER TABLE ops_settlement_outbox ADD COLUMN IF NOT EXISTS referrer_minor TEXT;
UPDATE ops_settlement_outbox SET referrer_minor = '0'
    WHERE operator_minor IS NOT NULL AND referrer_minor IS NULL;
ALTER TABLE ops_settlement_outbox DROP CONSTRAINT IF EXISTS ops_settlement_outbox_whole;
ALTER TABLE ops_settlement_outbox ADD CONSTRAINT ops_settlement_outbox_whole CHECK (
    (settled_at_unix IS NULL) = (credited_minor IS NULL)
    AND (credited_minor IS NULL) = (dev_leg_minor IS NULL)
    AND (dev_leg_minor IS NULL) = (budget_minor IS NULL)
    AND (budget_minor IS NULL) = (operator_minor IS NULL)
    AND (operator_minor IS NULL) = (referrer_minor IS NULL)
    AND (referrer_minor IS NULL) = (tx_hash IS NULL)
);
