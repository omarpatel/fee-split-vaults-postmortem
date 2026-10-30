-- 0011_persistent_stores.sql
--
-- Storage for every store the tick loop, the publisher and the API used to hold
-- in process memory: the fee indexer's state, the vault record the orchestrator
-- mutates, screening verdicts, receipts, human approvals, vendor invoices, the
-- publisher's account bindings, posts, OAuth tokens and label attestations, and
-- the generated image assets. Before this migration a restart forgot all of
-- them, and a fleet that forgets a tier change, an open invoice or a posted
-- tweet is a fleet that will repeat the decision it already made.
--
-- THREE RULES, SAME AS 0001 AND 0008.
--
--   MONEY IS NUMERIC(78,0) OR TEXT, NEVER SUMMED IN SQL. A full uint256 fits;
--   every amount crosses the driver boundary as a string and becomes a bigint
--   in TypeScript.
--   ENUMS ARE CHECKED. A row with an unknown verdict, tier, side or channel is
--   refused at the constraint, so the reader never has to decide what an
--   unrecognised value means - it never exists.
--   SECRETS ARE SEALED. publisher_account_credential holds ciphertext only;
--   the key never touches the database and a row cannot be opened by a process
--   holding the wrong key (the key id is stored beside the blob and checked
--   first, so a rotation is a loud refusal rather than a garbage token).
--
-- 0002's `vault` / `vault_consent` are NOT reused for the orchestrator's vault
-- record: those rows are the SIGNED consent (consent_hash primary key,
-- signature NOT NULL) and the orchestrator's `Vault` carries neither. The
-- onboarding flow that produces a signature owns those tables; this one holds
-- what the tick loop reads and writes.

-- ---------------------------------------------------------------------------
-- Fee indexer
-- ---------------------------------------------------------------------------

-- One coin we are entitled to index. pool_id is the CONFIRMED post-graduation
-- attribution key and is absent until the hook's PoolRegistered has been seen;
-- candidate_pool_id is the derived key the registry scan is allowlisted on.
CREATE TABLE IF NOT EXISTS indexer_binding (
    token                TEXT PRIMARY KEY,
    vault                TEXT    NOT NULL,
    curve                TEXT    NOT NULL,
    pool_id              TEXT,
    candidate_pool_id    TEXT,
    quote_asset          TEXT    NOT NULL,
    launched_at_unix     BIGINT  NOT NULL,
    launch_block_number  BIGINT  NOT NULL,
    buyback_enabled      BOOLEAN NOT NULL,
    creator_tax_bps      INTEGER NOT NULL,
    coverage_start_unix  BIGINT  NOT NULL,
    graduated_at_unix    BIGINT,

    CONSTRAINT indexer_binding_creator_tax_bounds
        CHECK (creator_tax_bps >= 0 AND creator_tax_bps <= 1000)
);

CREATE INDEX IF NOT EXISTS indexer_binding_curve_idx ON indexer_binding (curve);
CREATE INDEX IF NOT EXISTS indexer_binding_pool_idx ON indexer_binding (pool_id);

-- One fee credit. The primary key is `${txHash}:${logIndex}`, so an overlapping
-- re-scan collides here instead of double-counting; the store inserts with
-- ON CONFLICT DO NOTHING and reports how many rows were new.
--
-- finalized is set ONLY by a join against indexer_block on (block_number,
-- block_hash): a posting whose block we no longer vouch for stays unfinalised
-- and grants no budget authority. buyback_amount_minor and tokens_locked are
-- present on sweeps only.
CREATE TABLE IF NOT EXISTS indexer_fee_posting (
    id                   TEXT PRIMARY KEY,
    vault                TEXT    NOT NULL,
    token                TEXT    NOT NULL,
    asset                TEXT    NOT NULL,
    credited_minor       NUMERIC(78,0) NOT NULL,
    gross_fee_minor      NUMERIC(78,0) NOT NULL,
    derivation           TEXT    NOT NULL,
    volume_minor         NUMERIC(78,0) NOT NULL,
    source               TEXT    NOT NULL,
    phase                TEXT    NOT NULL,
    classification       TEXT    NOT NULL,
    side                 TEXT    NOT NULL,
    counterparty         TEXT,
    block_number         BIGINT  NOT NULL,
    block_hash           TEXT    NOT NULL,
    tx_hash              TEXT    NOT NULL,
    log_index            INTEGER NOT NULL,
    occurred_at_unix     BIGINT  NOT NULL,
    finalized            BOOLEAN NOT NULL,
    buyback_amount_minor NUMERIC(78,0),
    tokens_locked        NUMERIC(78,0),

    CONSTRAINT indexer_fee_posting_amounts_non_negative
        CHECK (credited_minor >= 0 AND gross_fee_minor >= 0 AND volume_minor >= 0),
    CONSTRAINT indexer_fee_posting_derivation_known
        CHECK (derivation IN ('explicit','creator_share_of_fee')),
    CONSTRAINT indexer_fee_posting_source_known
        CHECK (source IN ('curve_event','pool_fees_swept')),
    CONSTRAINT indexer_fee_posting_phase_known
        CHECK (phase IN ('pre_graduation','post_graduation')),
    CONSTRAINT indexer_fee_posting_classification_known
        CHECK (classification IN ('trade','anti_snipe_window')),
    CONSTRAINT indexer_fee_posting_side_known
        CHECK (side IN ('buy','sell','sweep'))
);

CREATE INDEX IF NOT EXISTS indexer_fee_posting_vault_time_idx
    ON indexer_fee_posting (vault, occurred_at_unix);
CREATE INDEX IF NOT EXISTS indexer_fee_posting_token_time_idx
    ON indexer_fee_posting (token, occurred_at_unix);
CREATE INDEX IF NOT EXISTS indexer_fee_posting_block_idx
    ON indexer_fee_posting (block_number);

-- The canonical chain as we tracked it, one row per height. This is what a
-- posting's block hash is checked against before it is finalised.
CREATE TABLE IF NOT EXISTS indexer_block (
    block_number    BIGINT PRIMARY KEY,
    block_hash      TEXT    NOT NULL,
    parent_hash     TEXT    NOT NULL,
    timestamp_unix  BIGINT  NOT NULL
);

-- Forward-only scan cursors for the three fee streams. Separate from
-- chain_scan_cursor (0008) because that table is keyed by (stream, vault)
-- for the money-movement scans; these are fleet-wide.
CREATE TABLE IF NOT EXISTS indexer_cursor (
    key           TEXT PRIMARY KEY,
    block_number  BIGINT NOT NULL,

    CONSTRAINT indexer_cursor_key_known
        CHECK (key IN ('curve_trades','pool_fees','registry_events'))
);

-- A pending owner override of a coin's fee recipient. Deduped on
-- (token, effective_at_unix, tx_hash), the same key the in-memory store uses.
CREATE TABLE IF NOT EXISTS indexer_pending_override (
    token              TEXT    NOT NULL,
    current_recipient  TEXT    NOT NULL,
    new_recipient      TEXT    NOT NULL,
    effective_at_unix  BIGINT  NOT NULL,
    expires_at_unix    BIGINT  NOT NULL,
    proposed_at_unix   BIGINT  NOT NULL,
    tx_hash            TEXT    NOT NULL,
    block_hash         TEXT    NOT NULL,
    block_number       BIGINT  NOT NULL,

    PRIMARY KEY (token, effective_at_unix, tx_hash)
);

-- Last confirmed answer to "who does the protocol pay for this coin?".
CREATE TABLE IF NOT EXISTS indexer_recipient_observation (
    token             TEXT PRIMARY KEY,
    recipient         TEXT    NOT NULL,
    expected          TEXT    NOT NULL,
    matches           BOOLEAN NOT NULL,
    block_hash        TEXT    NOT NULL,
    block_number      BIGINT  NOT NULL,
    observed_at_unix  BIGINT  NOT NULL
);

-- ---------------------------------------------------------------------------
-- Orchestrator registries
-- ---------------------------------------------------------------------------

-- The vault as the tick loop sees it. The consent is stored whole: it is the
-- CREATE2 salt preimage, every field is immutable, and the orchestrator reads
-- operatorBps / budgetBpsMax off it on every tick. State and tier are the two
-- fields the orchestrator writes.
CREATE TABLE IF NOT EXISTS vault_record (
    address            TEXT PRIMARY KEY,
    token              TEXT    NOT NULL,
    consent            JSONB   NOT NULL,
    state              TEXT    NOT NULL,
    tier               TEXT    NOT NULL,
    budget_bps         INTEGER NOT NULL,
    buyback_enabled    BOOLEAN NOT NULL,
    creator_tax_bps    INTEGER NOT NULL,
    deployed_at_unix   BIGINT  NOT NULL,
    activated_at_unix  BIGINT,

    CONSTRAINT vault_record_state_known
        CHECK (state IN ('UNBOUND','PASSTHROUGH','BOUND','PENDING','ACTIVE','SUSPENDED','POISONED','TERMINATED')),
    CONSTRAINT vault_record_tier_known
        CHECK (tier IN ('T0','T1','T2','T3')),
    CONSTRAINT vault_record_creator_tax_bounds
        CHECK (creator_tax_bps >= 0 AND creator_tax_bps <= 1000),
    CONSTRAINT vault_record_budget_bounds
        CHECK (budget_bps >= 0 AND budget_bps <= 10000)
);

CREATE UNIQUE INDEX IF NOT EXISTS vault_record_token_uq ON vault_record (token);

-- screening_result (0005) is REUSED for the orchestrator's ScreeningStore. Its
-- flags were modelled as screening_flag rows with a severity and a stage the
-- pipeline's ScreeningResult does not carry, so the flag union is stored here
-- as a JSON array instead of inventing severities. `latest()` is the is_current
-- row; put() retires the previous one in the same transaction.
ALTER TABLE screening_result ADD COLUMN IF NOT EXISTS flags JSONB;

-- receipt (0004) is REUSED for the ReceiptStore. Its two foreign keys pointed
-- at tables nothing in this repository writes - `vault` (the signed-consent
-- record, see the header) and `disbursement` - and a receipt that cannot be
-- stored because its vault row lives in a different table is a receipt that is
-- silently missing from the weekly report. The keys go; the columns stay.
ALTER TABLE receipt DROP CONSTRAINT IF EXISTS receipt_vault_fkey;
ALTER TABLE receipt DROP CONSTRAINT IF EXISTS receipt_disbursement_id_fkey;

-- A human approval bound to ONE decision digest. The broker verifies the
-- binding; the store only has to find it.
CREATE TABLE IF NOT EXISTS human_approval (
    vault             TEXT    NOT NULL,
    decision_digest   TEXT    NOT NULL,
    approver          TEXT    NOT NULL,
    approved_at_unix  BIGINT  NOT NULL,

    PRIMARY KEY (vault, decision_digest)
);

-- Countersigned vendor invoices awaiting reimbursement.
--
-- invoice_hash is keccak256 of the canonical invoice JSON without the
-- countersignature, `0x` + 64 lowercase hex, and it is the bytes32 the
-- settlement pull carries on chain. The same invoice for the same vault cannot
-- be recorded twice; a second put() is an error, not an upsert, because two
-- reimbursements against one invoice is the failure this table exists to
-- prevent. settled_tx_hash is set exactly once.
CREATE TABLE IF NOT EXISTS vendor_invoice (
    vault             TEXT    NOT NULL,
    invoice_hash      TEXT    NOT NULL,
    vendor_id         TEXT    NOT NULL,
    sku_id            TEXT    NOT NULL,
    quantity          INTEGER NOT NULL,
    issued_at_unix    BIGINT  NOT NULL,
    payload           JSONB   NOT NULL,
    settled_tx_hash   TEXT,
    settled_at_unix   BIGINT,

    PRIMARY KEY (vault, invoice_hash),
    CONSTRAINT vendor_invoice_hash_is_bytes32
        CHECK (invoice_hash ~ '^0x[0-9a-f]{64}$'),
    CONSTRAINT vendor_invoice_quantity_positive
        CHECK (quantity > 0),
    CONSTRAINT vendor_invoice_settled_together
        CHECK ((settled_tx_hash IS NULL) = (settled_at_unix IS NULL))
);

CREATE INDEX IF NOT EXISTS vendor_invoice_pending_idx
    ON vendor_invoice (vault, sku_id, quantity, issued_at_unix)
    WHERE settled_tx_hash IS NULL;

-- ---------------------------------------------------------------------------
-- Publisher
-- ---------------------------------------------------------------------------

-- One platform account, bound to exactly one client coin. account_id is stored
-- lowercased; the in-memory registry keys the same way.
CREATE TABLE IF NOT EXISTS publisher_account_binding (
    channel      TEXT    NOT NULL,
    account_id   TEXT    NOT NULL,
    coin_ref     TEXT    NOT NULL,
    vault        TEXT    NOT NULL,
    token        TEXT    NOT NULL,
    ticker       TEXT    NOT NULL,
    delegated    BOOLEAN NOT NULL,

    PRIMARY KEY (channel, account_id),
    CONSTRAINT publisher_account_binding_channel_known
        CHECK (channel IN ('telegram','x_operator','x_client_delegated','site'))
);

-- Every client coin on the book, keyed by upper-cased ticker. Read only to
-- detect cross-promotion.
CREATE TABLE IF NOT EXISTS publisher_roster (
    ticker_key   TEXT PRIMARY KEY,
    ticker       TEXT    NOT NULL,
    vault        TEXT    NOT NULL,
    token        TEXT    NOT NULL
);

-- publication (0004) is REUSED as the PostRegistry. It already records the
-- channel, the body hash, the disclosure and the read-back result; the
-- publisher's PostRecord adds the account, the correlation id, the classifier
-- rules and the full read-back outcome. The vault foreign key goes for the
-- same reason as receipt's. `id` and `external_id` both hold the platform's
-- post id: the registry is keyed by it.
ALTER TABLE publication DROP CONSTRAINT IF EXISTS publication_vault_fkey;
ALTER TABLE publication ADD COLUMN IF NOT EXISTS account_id           TEXT;
ALTER TABLE publication ADD COLUMN IF NOT EXISTS correlation_id       TEXT;
ALTER TABLE publication ADD COLUMN IF NOT EXISTS classification_rules JSONB;
ALTER TABLE publication ADD COLUMN IF NOT EXISTS disclosure           JSONB;
ALTER TABLE publication ADD COLUMN IF NOT EXISTS required_tokens      JSONB;
ALTER TABLE publication ADD COLUMN IF NOT EXISTS body_truncated       BOOLEAN;
ALTER TABLE publication ADD COLUMN IF NOT EXISTS approved_by          TEXT;
ALTER TABLE publication ADD COLUMN IF NOT EXISTS read_back            JSONB;

CREATE INDEX IF NOT EXISTS publication_awaiting_readback_idx
    ON publication (published_at_unix)
    WHERE read_back IS NULL;

-- OAuth tokens for the disclosed per-coin X accounts. CIPHERTEXT ONLY: the
-- sealed blob is AES-256-GCM under a key the process receives at construction
-- and never stores. key_id is a fingerprint of that key, checked before any
-- decryption is attempted, so a process started with the wrong key refuses
-- rather than producing garbage.
CREATE TABLE IF NOT EXISTS publisher_account_credential (
    account_id       TEXT PRIMARY KEY,
    key_id           TEXT    NOT NULL,
    sealed           TEXT    NOT NULL,
    expires_at_unix  BIGINT  NOT NULL
);

-- A named human's attestation that an account carries the platform's
-- automated-account label. Expires; an expired attestation is no attestation.
CREATE TABLE IF NOT EXISTS publisher_label_attestation (
    account_id        TEXT PRIMARY KEY,
    attested_by       TEXT    NOT NULL,
    attested_at_unix  BIGINT  NOT NULL,
    expires_at_unix   BIGINT  NOT NULL,

    CONSTRAINT publisher_label_attestation_expires_after
        CHECK (expires_at_unix > attested_at_unix)
);

-- ---------------------------------------------------------------------------
-- Generated image assets
-- ---------------------------------------------------------------------------

-- Rendered banners, avatars and cards. The id is minted by trusted code from
-- the content hash (`${coinRef}:${kind}:${sha256[0..16]}`); the bytes are
-- resolved at publish time after the model is out of the loop. Content
-- addressed: the same bytes for the same coin and kind is one row.
CREATE TABLE IF NOT EXISTS image_asset (
    id         TEXT PRIMARY KEY,
    coin_ref   TEXT    NOT NULL,
    kind       TEXT    NOT NULL,
    mime       TEXT    NOT NULL,
    width      INTEGER NOT NULL,
    height     INTEGER NOT NULL,
    sha256     TEXT    NOT NULL,
    bytes      BYTEA   NOT NULL,

    CONSTRAINT image_asset_kind_known CHECK (kind IN ('banner','avatar','card')),
    CONSTRAINT image_asset_mime_known CHECK (mime IN ('image/png')),
    CONSTRAINT image_asset_sha256_is_hex CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT image_asset_dimensions_positive CHECK (width > 0 AND height > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS image_asset_content_uq ON image_asset (coin_ref, kind, sha256);
CREATE INDEX IF NOT EXISTS image_asset_coin_idx ON image_asset (coin_ref, kind);
