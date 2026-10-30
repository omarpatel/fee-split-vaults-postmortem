-- 0010_category_spend.sql
--
-- THE PER-CATEGORY SUB-CAP WAS INERT, AND THIS IS THE COLUMN THAT ENDS IT.
--
-- `categorySubcapGate` bounds what one coin may spend in one SKU category over
-- the 30-day period: 30% of the period budget on listings, 20% on boosts, and
-- so on down CATEGORY_SUBCAP_BPS. It computes that by comparing
-- `spent + quote` against the cap. Until now `spent` was fed from a map the
-- live tick path hardcoded to `{}`, so every purchase was measured as though
-- it were the first one in its category and the cap never accumulated. A coin
-- could buy a $299 listing, then another, then another, each one comfortably
-- inside a $840 sub-cap, and pass through the ceiling in aggregate without a
-- single gate objecting. The same empty map fed the adjacent check that bounds
-- total procurement against the period budget, so that one was inert too.
--
-- The accumulating figure has to outlive a tick. fleet_disbursement is already
-- where the other accumulating spend gates read from - it is written on the
-- same code path, in exact cents, and it survives a restart - so the category
-- goes here rather than into a new table.
--
-- WHY NULL IS ALLOWED, AND WHY THAT IS NOT A HOLE. Rows written before this
-- migration have no category, and there is no honest way to invent one: the
-- counter row records vault, vendor, cents and time, and a SKU category is not
-- derivable from any of them. Guessing would attribute real spend to a cap it
-- was never measured against. So historical rows stay NULL, the read skips
-- them explicitly, and the effect is that a sub-cap begins accumulating from
-- the deployment of this migration rather than from a fabricated history.
-- Every row written from now on carries a category, because the port makes the
-- field required and has no default.
--
-- The read that uses it is PgFleetCounters.categorySpend30dCents, which GROUPs
-- BY this column. It refuses outright on a value it does not recognise rather
-- than skipping the row, because a skipped row is spend missing from the total
-- the procurement-budget check reads, and a spend counter that reads low opens
-- the cap it bounds.

ALTER TABLE fleet_disbursement
    ADD COLUMN IF NOT EXISTS category TEXT;

-- categorySpend30dCents: one vault, a rolling 30-day window, grouped by
-- category. Partial on NOT NULL so the pre-migration rows the read already
-- excludes do not sit in the index too.
CREATE INDEX IF NOT EXISTS fleet_disbursement_vault_category_idx
    ON fleet_disbursement (vault, at_unix, category)
    WHERE category IS NOT NULL;
