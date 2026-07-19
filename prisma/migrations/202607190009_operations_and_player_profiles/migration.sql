CREATE TYPE "AdminRole" AS ENUM ('owner', 'director', 'admin', 'observer');

ALTER TABLE "admins"
ADD COLUMN "role" "AdminRole" NOT NULL DEFAULT 'admin';

UPDATE "admins"
SET "role" = 'owner'
WHERE "id" = (
  SELECT "id" FROM "admins" ORDER BY "created_at" ASC, "id" ASC LIMIT 1
);

ALTER TABLE "escort_orders"
ADD COLUMN "review_code_hash" VARCHAR(64),
ADD COLUMN "review_code_issued_at" TIMESTAMP(3),
ADD COLUMN "review_code_consumed_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "escort_orders_review_code_hash_key"
ON "escort_orders"("review_code_hash");

CREATE TABLE "escort_player_profiles" (
  "id" TEXT NOT NULL,
  "game_id" VARCHAR(20) NOT NULL,
  "display_name" VARCHAR(64) NOT NULL,
  "contact" VARCHAR(128),
  "suspended_until" TIMESTAMP(3),
  "permanently_banned" BOOLEAN NOT NULL DEFAULT false,
  "banned_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "escort_player_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "escort_player_profiles_game_id_key"
ON "escort_player_profiles"("game_id");

CREATE INDEX "escort_player_profiles_permanently_banned_suspended_until_idx"
ON "escort_player_profiles"("permanently_banned", "suspended_until");

ALTER TABLE "escort_participants"
ADD COLUMN "player_profile_id" TEXT;

ALTER TABLE "escort_penalties"
ADD COLUMN "player_profile_id" TEXT,
ADD COLUMN "violation_date" DATE;

DROP INDEX IF EXISTS "escort_penalties_participant_id_sequence_key";

CREATE INDEX "escort_participants_player_profile_id_idx"
ON "escort_participants"("player_profile_id");

CREATE INDEX "escort_penalties_participant_id_sequence_idx"
ON "escort_penalties"("participant_id", "sequence");

CREATE UNIQUE INDEX "escort_penalties_player_profile_id_violation_date_sequence_key"
ON "escort_penalties"("player_profile_id", "violation_date", "sequence");

ALTER TABLE "escort_participants"
ADD CONSTRAINT "escort_participants_player_profile_id_fkey"
FOREIGN KEY ("player_profile_id") REFERENCES "escort_player_profiles"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "escort_penalties"
ADD CONSTRAINT "escort_penalties_player_profile_id_fkey"
FOREIGN KEY ("player_profile_id") REFERENCES "escort_player_profiles"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "audit_logs" (
  "id" TEXT NOT NULL,
  "admin_id" TEXT,
  "action" VARCHAR(80) NOT NULL,
  "entity_type" VARCHAR(64) NOT NULL,
  "entity_id" VARCHAR(64),
  "details" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");
CREATE INDEX "audit_logs_admin_id_created_at_idx" ON "audit_logs"("admin_id", "created_at");
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

ALTER TABLE "audit_logs"
ADD CONSTRAINT "audit_logs_admin_id_fkey"
FOREIGN KEY ("admin_id") REFERENCES "admins"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
