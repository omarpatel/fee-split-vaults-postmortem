-- 0022_dev_sessions.sql
--
-- THE DEV DASHBOARD'S SIGN-IN: a wallet signature over a server nonce, and the
-- bearer that signature buys. apps/api/src/v1/sessions.ts is the only writer.
--
-- THERE IS NO PASSWORD AND NO "SIGN IN AS ADDRESS". A dev route answers only
-- to a bearer minted after an EIP-191 personal_sign over a message this
-- service issued, and the message carries a nonce that is consumed on first
-- use whether or not the signature verified: a second presentation of the
-- same signed message is a replay and is refused by the row, not by memory.
--
-- THE BEARER IS STORED HASHED. dev_session.token_hash is sha256 of the token
-- the browser holds, so a read of this table yields nothing a request can
-- carry. The token itself is 32 random bytes, shown once, in the verify
-- response.
--
-- THE DEV'S ACKNOWLEDGEMENT OF AN ESCALATION is a distinct fact from the
-- operator's resolution, so it gets its own columns on ops_escalation rather
-- than overloading resolved_at_unix / resolved_by. A dev who says "seen" has
-- not closed anything; a dev who says "dismissed" has still not closed it for
-- the operator. Only the operator's resolve clears the open row.

CREATE TABLE IF NOT EXISTS dev_auth_challenge (
    -- 32 random bytes, 0x-hex. The only key the verify step presents.
    nonce             TEXT    PRIMARY KEY,
    address           TEXT    NOT NULL,
    -- The exact text the wallet was asked to sign. Verify compares byte for
    -- byte: a message that differs in one character is a different challenge.
    message           TEXT    NOT NULL,
    issued_at_unix    BIGINT  NOT NULL,
    expires_at_unix   BIGINT  NOT NULL,
    consumed_at_unix  BIGINT,

    CONSTRAINT dev_auth_challenge_nonce_is_bytes32 CHECK (nonce ~ '^0x[0-9a-f]{64}$'),
    CONSTRAINT dev_auth_challenge_address_is_address CHECK (address ~ '^0x[0-9a-f]{40}$'),
    CONSTRAINT dev_auth_challenge_window CHECK (expires_at_unix > issued_at_unix)
);

CREATE INDEX IF NOT EXISTS dev_auth_challenge_expiry_idx ON dev_auth_challenge (expires_at_unix);

CREATE TABLE IF NOT EXISTS dev_session (
    id                TEXT    PRIMARY KEY,
    token_hash        TEXT    NOT NULL UNIQUE,
    address           TEXT    NOT NULL,
    issued_at_unix    BIGINT  NOT NULL,
    expires_at_unix   BIGINT  NOT NULL,

    CONSTRAINT dev_session_token_hash_is_sha256 CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT dev_session_address_is_address CHECK (address ~ '^0x[0-9a-f]{40}$'),
    CONSTRAINT dev_session_window CHECK (expires_at_unix > issued_at_unix)
);

CREATE INDEX IF NOT EXISTS dev_session_address_idx ON dev_session (address, expires_at_unix);

ALTER TABLE ops_escalation ADD COLUMN IF NOT EXISTS acknowledged_at_unix BIGINT;
ALTER TABLE ops_escalation ADD COLUMN IF NOT EXISTS acknowledged_by      TEXT;
ALTER TABLE ops_escalation ADD COLUMN IF NOT EXISTS ack_decision         TEXT;
-- Dev-authored. Bounded on the way in; scrubbed on every way out.
ALTER TABLE ops_escalation ADD COLUMN IF NOT EXISTS ack_note             TEXT;

ALTER TABLE ops_escalation DROP CONSTRAINT IF EXISTS ops_escalation_ack_whole;
ALTER TABLE ops_escalation ADD CONSTRAINT ops_escalation_ack_whole
    CHECK ((acknowledged_at_unix IS NULL) = (acknowledged_by IS NULL)
       AND (acknowledged_at_unix IS NULL) = (ack_decision IS NULL));

ALTER TABLE ops_escalation DROP CONSTRAINT IF EXISTS ops_escalation_ack_decision_known;
ALTER TABLE ops_escalation ADD CONSTRAINT ops_escalation_ack_decision_known
    CHECK (ack_decision IS NULL OR ack_decision IN ('acknowledged', 'action_taken', 'dismissed'));

-- What a dev told us at quote time that the consent struct does not carry:
-- the narrative sources and the claimed handles. Keyed by the consent nonce
-- so the wallet-signed submit can pick them up without the browser having to
-- send dev-authored strings a second time. Never public; counted, not listed.
CREATE TABLE IF NOT EXISTS onboarding_quote (
    nonce              TEXT    PRIMARY KEY,
    dev_signer         TEXT    NOT NULL,
    narrative_sources  JSONB   NOT NULL,
    socials            JSONB,
    issued_at_unix     BIGINT  NOT NULL,
    expires_at_unix    BIGINT  NOT NULL,

    CONSTRAINT onboarding_quote_nonce_is_bytes32 CHECK (nonce ~ '^0x[0-9a-f]{64}$'),
    CONSTRAINT onboarding_quote_window CHECK (expires_at_unix > issued_at_unix)
);

CREATE INDEX IF NOT EXISTS onboarding_quote_expiry_idx ON onboarding_quote (expires_at_unix);
