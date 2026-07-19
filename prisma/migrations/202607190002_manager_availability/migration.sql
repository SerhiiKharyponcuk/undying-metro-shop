-- CreateTable
CREATE TABLE "manager_availability" (
    "manager_key" VARCHAR(32) NOT NULL,
    "busy_until" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manager_availability_pkey" PRIMARY KEY ("manager_key")
);

-- CreateIndex
CREATE INDEX "manager_availability_busy_until_idx" ON "manager_availability"("busy_until");
