ALTER TABLE "escort_orders"
ADD COLUMN "director_amount_minor" BIGINT NOT NULL DEFAULT 0;

-- The previous 3% creator allocation now belongs to the company director.
UPDATE "escort_orders"
SET "director_amount_minor" = "creator_amount_minor",
    "creator_amount_minor" = 0
WHERE "developer_amount_minor" = 0
  AND "creator_amount_minor" > 0;

-- Preserve older 10% developer allocations as creator allocations without
-- changing the already fixed escort pool or participant payouts.
UPDATE "escort_orders"
SET "creator_amount_minor" = "developer_amount_minor",
    "developer_amount_minor" = 0
WHERE "developer_amount_minor" > 0
  AND "creator_amount_minor" = 0;
