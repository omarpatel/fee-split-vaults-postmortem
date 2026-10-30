-- 0014_pending_purchase.sql
--
-- APPROVED PURCHASES THE OPERATOR HAS NOT YET EVIDENCED.
--
-- The spend path is: the planner proposes, the broker approves, the operator
-- BUYS AS PRINCIPAL in its own name, and only then - against a countersigned
-- invoice - is the operator reimbursed from the vault. Between "approved" and
-- "invoiced" a purchase is a to-do for a human. The tick loop writes one here
-- on every `awaiting_invoice` outcome; the API reads the list to show the
-- operator what to buy and invoice, and clears the line once an invoice is on
-- file or the reimbursement settled.
--
-- ONE ROW PER (vault, sku, quantity). The tick loop re-decides the same line
-- every window; a re-report is the SAME to-do, not a newer one, so the upsert
-- keeps the earliest proposed_at_unix. Nothing here moves money: the row is a
-- reminder, and the reimbursement it reminds about still needs the invoice.

CREATE TABLE IF NOT EXISTS pending_purchase (
    vault             TEXT    NOT NULL,
    sku_id            TEXT    NOT NULL,
    quantity          INTEGER NOT NULL,
    vendor_id         TEXT    NOT NULL,
    -- The catalog quote the broker approved, in USD cents. Exact.
    quote_cents       NUMERIC(20, 0) NOT NULL,
    proposed_at_unix  BIGINT  NOT NULL,

    PRIMARY KEY (vault, sku_id, quantity),

    CONSTRAINT pending_purchase_vault_lower CHECK (vault = lower(vault)),
    CONSTRAINT pending_purchase_quantity_positive CHECK (quantity > 0),
    CONSTRAINT pending_purchase_quote_nonnegative CHECK (quote_cents >= 0)
);

CREATE INDEX IF NOT EXISTS pending_purchase_vault_idx
    ON pending_purchase (vault, proposed_at_unix);
