ALTER TABLE "escort_orders"
ADD COLUMN "buyer_game_id" VARCHAR(20);

ALTER TABLE "reviews"
ADD COLUMN "buyer_game_id" VARCHAR(20),
ADD COLUMN "escort_order_id" TEXT;

CREATE INDEX "escort_orders_buyer_game_id_status_idx"
ON "escort_orders"("buyer_game_id", "status");

CREATE INDEX "reviews_buyer_game_id_idx"
ON "reviews"("buyer_game_id");

CREATE UNIQUE INDEX "reviews_escort_order_id_key"
ON "reviews"("escort_order_id");

ALTER TABLE "reviews"
ADD CONSTRAINT "reviews_escort_order_id_fkey"
FOREIGN KEY ("escort_order_id") REFERENCES "escort_orders"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
