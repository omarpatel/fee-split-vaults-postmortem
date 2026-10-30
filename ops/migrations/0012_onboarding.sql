-- 0012_onboarding.sql
--
-- THE DUAL-CONSENT MACHINE'S RECORD, PERSISTED.
--
-- Until now the control plane held every onboarding in a Map: a restart forgot
-- which devs had signed, which coins were pointed, and every refusal in the
-- audit trail. That trail is the document a dispute reads, so it has to
-- outlive the process that wrote it.
--
-- WHY NOT vault_consent. 0002's vault_consent is keyed by the consent hash and
-- requires a signature: it describes a consent that WAS signed. An onboarding
-- starts before the dev has signed anything, can be declined before a vault
-- exists, and carries state that is not the consent at all - the screening
-- verdict, the diligence report, the narrative candidate. Bending that table
-- to hold an unsigned draft would loosen the one constraint that makes it a
-- record of signed terms. So onboarding gets its own row, and vault_consent
-- keeps meaning what it means.
--
-- COLUMNS VERSUS JSON. Everything the store queries or indexes on is a column:
-- id, state, token, vault, coin_ref, the timestamps. Structured sub-documents
-- whose shape is owned by TypeScript validators - the consent, the screening
-- result, the diligence report, the history, the narrative - are JSONB, read
-- back whole and re-validated by the code that owns them. Nothing in SQL ever
-- interprets one.
--
-- THE SUBJECT IS ATTACKER-AUTHORED. name, symbol, description and links are
-- what the dev typed. They are stored at full fidelity because screening and
-- creative need them, and they are read back only by code that scrubs before
-- echoing. socials is the dev's claimed X handle: operator-only, never on the
-- public record, never shown to a model.
--
-- MONEY. There is none here. The consent's basis points ride inside the
-- consent JSON exactly as the dev signed them; this table repricing nobody.

CREATE TABLE IF NOT EXISTS onboarding (
    id                          TEXT PRIMARY KEY,
    state                       TEXT    NOT NULL,
    vault                       TEXT    NOT NULL,
    token                       TEXT    NOT NULL,
    coin_ref                    TEXT    NOT NULL,
    created_at_unix             BIGINT  NOT NULL,
    updated_at_unix             BIGINT  NOT NULL,
    -- The EIP-712 Consent struct, unchanged from what the dev signs.
    consent                     JSONB   NOT NULL,

    name                        TEXT    NOT NULL,
    symbol                      TEXT    NOT NULL,
    description                 TEXT,
    links                       JSONB   NOT NULL,
    narrative_sources           JSONB   NOT NULL,
    socials                     JSONB,

    dev_signature               TEXT,
    signature_verified_at_unix  BIGINT,
    screening                   JSONB,
    diligence                   JSONB,
    deployed_at_unix            BIGINT,
    deploy_tx_hash              TEXT,
    pointed_at_unix             BIGINT,
    accepted_at_unix            BIGINT,
    activated_at_unix           BIGINT,
    launched_at_unix            BIGINT,
    decline_reason              TEXT,
    narrative_candidate         JSONB,
    narrative                   JSONB,
    -- Append-only in practice: the machine only ever pushes. Stored whole so
    -- the order a dispute reads is the order the events happened in.
    history                     JSONB   NOT NULL,

    CONSTRAINT onboarding_state_known
        CHECK (state IN ('drafted','signed','screened','deployed','awaiting_pointing',
                         'pointed','accepted','active','declined','withdrawn'))
);

CREATE INDEX IF NOT EXISTS onboarding_token_idx ON onboarding (token, created_at_unix);
CREATE INDEX IF NOT EXISTS onboarding_vault_idx ON onboarding (vault);
CREATE INDEX IF NOT EXISTS onboarding_state_idx ON onboarding (state);
