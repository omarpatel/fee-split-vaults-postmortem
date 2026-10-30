-- 0002_vaults.sql
--
-- Vaults, the consent that created them, and the quote-asset registry.
--
-- THE CONSENT IS THE CONTRACT. Every economic term the dev signed is stored
-- here, and the whole struct is the CREATE2 salt preimage: a different rate is a
-- different vault address. That is why operator_bps and budget_bps_max live on
-- the vault row and NOT in application config - reading them from config would
-- silently reprice an existing customer the moment the config changed. The
-- columns are immutable by convention and by the state machine; there is no
-- code path in this repository that updates them.
--
-- MONEY IS TEXT. Same rule as the ledger: base-10 strings of minor units.
-- Nothing in SQL ever sums one.

CREATE TABLE IF NOT EXISTS vault_consent (
    -- keccak of the EIP-712 struct. Also the dedupe key for a re-submitted signature.
    consent_hash        TEXT PRIMARY KEY,
    dev_signer          TEXT    NOT NULL,
    -- Sole withdrawer of the dev leg. No operator key ever reaches it.
    dev_payout          TEXT    NOT NULL,
    token               TEXT    NOT NULL,
    terms_hash          TEXT    NOT NULL,
    operator_bps        INTEGER NOT NULL,
    budget_bps_max      INTEGER NOT NULL,
    adapter             TEXT    NOT NULL,
    referrer            TEXT    NOT NULL,
    -- A share OF operator_bps, paid on realized revenue only. Never a third-party payee.
    referrer_bps        INTEGER NOT NULL,
    expiry_unix         BIGINT  NOT NULL,
    nonce               TEXT    NOT NULL,
    signature           TEXT    NOT NULL,
    recorded_at_unix    BIGINT  NOT NULL,

    CONSTRAINT vault_consent_bps_bounds
        CHECK (operator_bps >= 0 AND operator_bps <= 10000
               AND budget_bps_max >= 0 AND budget_bps_max <= 10000
               AND referrer_bps >= 0 AND referrer_bps <= 10000
               AND operator_bps + budget_bps_max <= 10000)
);

CREATE INDEX IF NOT EXISTS vault_consent_token_idx ON vault_consent (token);

CREATE TABLE IF NOT EXISTS vault (
    address              TEXT PRIMARY KEY,
    token                TEXT    NOT NULL,
    consent_hash         TEXT    NOT NULL REFERENCES vault_consent (consent_hash),
    state                TEXT    NOT NULL,
    tier                 TEXT    NOT NULL,
    -- The dev's live procurement dial. Raising is instant; lowering has a notice period.
    budget_bps           INTEGER NOT NULL,
    budget_bps_pending   INTEGER,
    budget_bps_effective_at_unix BIGINT,
    -- Read on-chain per token. Decides whether creator net is the 1x or the 1/2x branch.
    -- NOTHING may store the resulting RATE here; it is derived by creatorNetBps().
    buyback_enabled      BOOLEAN NOT NULL,
    -- Per-token, immutable, 0..1000. Paid 100% to the creator and never split.
    creator_tax_bps      INTEGER NOT NULL,
    deployed_at_unix     BIGINT  NOT NULL,
    activated_at_unix    BIGINT,
    terminated_at_unix   BIGINT,

    CONSTRAINT vault_state_known
        CHECK (state IN ('UNBOUND','PASSTHROUGH','BOUND','PENDING','ACTIVE','SUSPENDED','POISONED','TERMINATED')),
    CONSTRAINT vault_tier_known
        CHECK (tier IN ('T0','T1','T2','T3')),
    CONSTRAINT vault_creator_tax_bounds
        CHECK (creator_tax_bps >= 0 AND creator_tax_bps <= 1000),
    CONSTRAINT vault_budget_bounds
        CHECK (budget_bps >= 0 AND budget_bps <= 10000)
);

CREATE INDEX IF NOT EXISTS vault_state_idx ON vault (state);
CREATE UNIQUE INDEX IF NOT EXISTS vault_token_uq ON vault (token);

-- Append-only. "Who suspended this vault, when, and why" must survive.
CREATE TABLE IF NOT EXISTS vault_state_history (
    id               TEXT PRIMARY KEY,
    vault            TEXT    NOT NULL REFERENCES vault (address),
    from_state       TEXT,
    to_state         TEXT    NOT NULL,
    reason           TEXT    NOT NULL,
    actor            TEXT    NOT NULL,
    changed_at_unix  BIGINT  NOT NULL,
    block_hash       TEXT,
    tx_hash          TEXT
);

CREATE INDEX IF NOT EXISTS vault_state_history_scope_idx
    ON vault_state_history (vault, changed_at_unix);

-- Service tier over time, with the measurement that justified each change.
CREATE TABLE IF NOT EXISTS vault_tier_history (
    id                TEXT PRIMARY KEY,
    vault             TEXT    NOT NULL REFERENCES vault (address),
    from_tier         TEXT    NOT NULL,
    to_tier           TEXT    NOT NULL,
    direction         TEXT    NOT NULL,
    -- Trailing 7-day MEDIAN of daily credits, USD. A derived reporting figure,
    -- never money: money is minor units, in TEXT, in the ledger.
    qf_per_day_usd    DOUBLE PRECISION NOT NULL,
    observed_days     INTEGER NOT NULL,
    sustained_days    INTEGER NOT NULL,
    days_below_gate   INTEGER NOT NULL,
    reason            TEXT    NOT NULL,
    decided_at_unix   BIGINT  NOT NULL,

    CONSTRAINT vault_tier_history_direction_known CHECK (direction IN ('up','down','hold'))
);

CREATE INDEX IF NOT EXISTS vault_tier_history_scope_idx
    ON vault_tier_history (vault, decided_at_unix);

-- Daily QF observation, so days_below_gate is a stored fact rather than a
-- re-derivation over a week of history on every evaluation.
CREATE TABLE IF NOT EXISTS vault_qf_observation (
    vault             TEXT    NOT NULL REFERENCES vault (address),
    day_key           TEXT    NOT NULL,
    qf_per_day_usd    DOUBLE PRECISION NOT NULL,
    below_gate        BOOLEAN NOT NULL,
    observed_at_unix  BIGINT  NOT NULL,
    price_source      TEXT    NOT NULL,

    PRIMARY KEY (vault, day_key)
);

-- The quote assets we will accept and claim.
--
-- Every one of them is an upgradeable, pausable, issuer-controlled proxy. The
-- `enabled` column is the kill switch: flipping it stops accepting and claiming
-- that asset without a deploy, which is the whole response to a pause event.
CREATE TABLE IF NOT EXISTS quote_asset (
    address             TEXT PRIMARY KEY,
    symbol              TEXT    NOT NULL,
    decimals            INTEGER NOT NULL,
    is_pausable_proxy   BOOLEAN NOT NULL,
    enabled             BOOLEAN NOT NULL,
    -- Some equity quote assets impose a per-transfer cap; claims are chunked to it.
    max_transfer_minor  TEXT,
    disabled_reason     TEXT,
    disabled_at_unix    BIGINT,
    updated_at_unix     BIGINT  NOT NULL,

    CONSTRAINT quote_asset_decimals_bounds CHECK (decimals >= 0 AND decimals <= 36)
);

-- Sweeps and settlements, keyed so a replay is a no-op.
--
-- run_key is the scheduler's idempotency key. The UNIQUE constraint on it is
-- what makes "crashed between broadcasting the claim and recording it"
-- recoverable: the retry finds its own prior row instead of claiming twice.
CREATE TABLE IF NOT EXISTS escrow_sweep (
    sweep_id           TEXT PRIMARY KEY,
    run_key            TEXT    NOT NULL,
    vault              TEXT    NOT NULL REFERENCES vault (address),
    asset              TEXT    NOT NULL,
    expected_minor     TEXT    NOT NULL,
    claimed_minor      TEXT    NOT NULL,
    chunks             INTEGER NOT NULL,
    block_hash         TEXT    NOT NULL,
    tx_hashes          TEXT    NOT NULL,
    completed_at_unix  BIGINT  NOT NULL,
    matched_at_unix    BIGINT
);

CREATE UNIQUE INDEX IF NOT EXISTS escrow_sweep_run_key_uq ON escrow_sweep (run_key);
CREATE INDEX IF NOT EXISTS escrow_sweep_unmatched_idx ON escrow_sweep (matched_at_unix, completed_at_unix);

CREATE TABLE IF NOT EXISTS vault_settlement (
    settlement_id     TEXT PRIMARY KEY,
    run_key           TEXT    NOT NULL,
    vault             TEXT    NOT NULL REFERENCES vault (address),
    asset             TEXT    NOT NULL,
    amount_minor      TEXT    NOT NULL,
    -- CREDITED, not transferred. The dev leg is pull-only and no operator key
    -- can move it; this row records an allocation, not a payment.
    dev_leg_minor     TEXT    NOT NULL,
    budget_minor      TEXT    NOT NULL,
    operator_minor    TEXT    NOT NULL,
    operator_bps      INTEGER NOT NULL,
    budget_bps        INTEGER NOT NULL,
    tx_hash           TEXT,
    settled_at_unix   BIGINT  NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS vault_settlement_run_key_uq ON vault_settlement (run_key);
CREATE INDEX IF NOT EXISTS vault_settlement_scope_idx ON vault_settlement (vault, asset, settled_at_unix);
