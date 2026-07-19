CREATE TYPE "OrderCurrency" AS ENUM ('UAH', 'EUR', 'USD');
CREATE TYPE "EscortOrderStatus" AS ENUM ('planned', 'completed', 'paid', 'cancelled');
CREATE TYPE "ExchangeRateSource" AS ENUM ('uah', 'nbu', 'manual');

CREATE TABLE "escort_orders" (
    "id" TEXT NOT NULL,
    "item" VARCHAR(160) NOT NULL,
    "buyer_name" VARCHAR(64) NOT NULL,
    "buyer_contact" VARCHAR(128),
    "original_amount_minor" BIGINT NOT NULL,
    "currency" "OrderCurrency" NOT NULL,
    "exchange_rate_micros" BIGINT NOT NULL,
    "rate_source" "ExchangeRateSource" NOT NULL,
    "amount_uah_minor" BIGINT NOT NULL,
    "developer_amount_minor" BIGINT NOT NULL,
    "escort_pool_minor" BIGINT NOT NULL,
    "order_date" DATE NOT NULL,
    "status" "EscortOrderStatus" NOT NULL DEFAULT 'planned',
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "escort_orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "escort_participants" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "contact" VARCHAR(128),
    "share_uah_minor" BIGINT NOT NULL,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "escort_participants_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "escort_orders_status_order_date_idx" ON "escort_orders"("status", "order_date");
CREATE INDEX "escort_orders_created_by_id_idx" ON "escort_orders"("created_by_id");
CREATE INDEX "escort_participants_order_id_idx" ON "escort_participants"("order_id");

ALTER TABLE "escort_orders" ADD CONSTRAINT "escort_orders_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "escort_participants" ADD CONSTRAINT "escort_participants_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "escort_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
