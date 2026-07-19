CREATE TYPE "EscortAssignmentStatus" AS ENUM ('invited', 'accepted', 'declined');

ALTER TABLE "escort_participants"
ADD COLUMN "assignment_status" "EscortAssignmentStatus" NOT NULL DEFAULT 'invited';

ALTER TABLE "admins"
ADD COLUMN "two_factor_secret" TEXT,
ADD COLUMN "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false;
