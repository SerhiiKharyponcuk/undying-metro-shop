ALTER TABLE "escort_participants"
ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "replaced_at" TIMESTAMP(3),
ADD COLUMN "replacement_for_id" TEXT;

CREATE UNIQUE INDEX "escort_participants_replacement_for_id_key" ON "escort_participants"("replacement_for_id");

ALTER TABLE "escort_participants"
ADD CONSTRAINT "escort_participants_replacement_for_id_fkey"
FOREIGN KEY ("replacement_for_id") REFERENCES "escort_participants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "escort_penalties" (
    "id" TEXT NOT NULL,
    "participant_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "percentage" INTEGER NOT NULL,
    "amount_uah_minor" BIGINT NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "escort_penalties_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "escort_penalties_participant_id_sequence_key" ON "escort_penalties"("participant_id", "sequence");
CREATE INDEX "escort_penalties_created_at_idx" ON "escort_penalties"("created_at");
CREATE INDEX "escort_penalties_created_by_id_idx" ON "escort_penalties"("created_by_id");

ALTER TABLE "escort_penalties"
ADD CONSTRAINT "escort_penalties_participant_id_fkey"
FOREIGN KEY ("participant_id") REFERENCES "escort_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "escort_penalties"
ADD CONSTRAINT "escort_penalties_created_by_id_fkey"
FOREIGN KEY ("created_by_id") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
