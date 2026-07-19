CREATE TYPE "AdminSessionAccessMode" AS ENUM ('operator', 'observer');

ALTER TABLE "admin_sessions"
ADD COLUMN "access_mode" "AdminSessionAccessMode" NOT NULL DEFAULT 'observer';

CREATE INDEX "admin_sessions_access_mode_created_at_idx"
ON "admin_sessions"("access_mode", "created_at");

CREATE UNIQUE INDEX "admin_sessions_single_operator_idx"
ON "admin_sessions"("access_mode")
WHERE "access_mode" = 'operator';
