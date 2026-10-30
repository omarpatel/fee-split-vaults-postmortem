-- 0017_api_attestations.sql
--
-- Dev identity attestations, written by apps/api (POST /diligence/kyb/attest)
-- and read by its diligence gate (ManualKybAttestationProvider).
--
-- THERE IS NO IDENTITY VENDOR IN THE LOOP. A named operator performed a
-- KYB/KYC check outside this system and records here THAT they did: who
-- attested, an opaque reference into the provider's file, when, and until
-- when. The gate credits only an unexpired attestation; an absent or expired
-- one is UNKNOWN, which the diligence conjunction counts as a failure.
--
-- NO DOCUMENT, NAME OR OTHER PII OF THE DEV IS STORED. provider_ref is a
-- handle the operator can resolve against the provider; it is never
-- dereferenced by code.

CREATE TABLE IF NOT EXISTS kyb_attestation (
    dev_signer          TEXT    NOT NULL,
    attested_by         TEXT    NOT NULL,
    provider_ref        TEXT    NOT NULL,
    attested_at_unix    BIGINT  NOT NULL,
    expires_at_unix     BIGINT  NOT NULL,

    PRIMARY KEY (dev_signer, attested_at_unix),
    CONSTRAINT kyb_attestation_expires_after_attested CHECK (expires_at_unix > attested_at_unix),
    CONSTRAINT kyb_attestation_signer_is_address CHECK (dev_signer ~ '^0x[0-9a-f]{40}$'),
    CONSTRAINT kyb_attestation_attested_by_named CHECK (length(attested_by) > 0),
    CONSTRAINT kyb_attestation_provider_ref_named CHECK (length(provider_ref) > 0)
);

CREATE INDEX IF NOT EXISTS kyb_attestation_signer_expiry_idx
    ON kyb_attestation (dev_signer, expires_at_unix);
