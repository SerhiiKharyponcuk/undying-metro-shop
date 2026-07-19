ALTER TABLE "escort_orders"
ADD COLUMN "creator_amount_minor" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "escort_participants"
ADD COLUMN "excluded_at" TIMESTAMP(3);
