CREATE TYPE "PenaltyAppealStatus" AS ENUM ('pending', 'approved', 'rejected');

ALTER TABLE "admins"
  ADD COLUMN "passkey_challenge" VARCHAR(512),
  ADD COLUMN "passkey_challenge_expires_at" TIMESTAMP(3);

ALTER TABLE "escort_player_profiles"
  ADD COLUMN "portal_code_hash" VARCHAR(64);

CREATE TABLE "penalty_appeals" (
  "id" TEXT NOT NULL,
  "penalty_id" TEXT NOT NULL,
  "player_profile_id" TEXT NOT NULL,
  "message" VARCHAR(1200) NOT NULL,
  "status" "PenaltyAppealStatus" NOT NULL DEFAULT 'pending',
  "admin_reply" VARCHAR(1200),
  "reviewed_by_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewed_at" TIMESTAMP(3),
  CONSTRAINT "penalty_appeals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "admin_passkeys" (
  "id" TEXT NOT NULL,
  "admin_id" TEXT NOT NULL,
  "credential_id" VARCHAR(512) NOT NULL,
  "public_key" BYTEA NOT NULL,
  "counter" BIGINT NOT NULL DEFAULT 0,
  "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "device_type" VARCHAR(32) NOT NULL DEFAULT 'singleDevice',
  "backed_up" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" TIMESTAMP(3),
  CONSTRAINT "admin_passkeys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_passkeys_credential_id_key" ON "admin_passkeys"("credential_id");
CREATE INDEX "admin_passkeys_admin_id_idx" ON "admin_passkeys"("admin_id");
CREATE INDEX "penalty_appeals_status_created_at_idx" ON "penalty_appeals"("status", "created_at");
CREATE INDEX "penalty_appeals_player_profile_id_created_at_idx" ON "penalty_appeals"("player_profile_id", "created_at");

ALTER TABLE "penalty_appeals" ADD CONSTRAINT "penalty_appeals_penalty_id_fkey" FOREIGN KEY ("penalty_id") REFERENCES "escort_penalties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "penalty_appeals" ADD CONSTRAINT "penalty_appeals_player_profile_id_fkey" FOREIGN KEY ("player_profile_id") REFERENCES "escort_player_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "penalty_appeals" ADD CONSTRAINT "penalty_appeals_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "admin_passkeys" ADD CONSTRAINT "admin_passkeys_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
