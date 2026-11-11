-- AlterTable
ALTER TABLE "Concert" ADD COLUMN     "event_status" TEXT,
ADD COLUMN     "tickets_opened_at" TIMESTAMP(3),
ADD COLUMN     "vendors" JSONB;

-- CreateTable
CREATE TABLE "ConcertListingCheck" (
    "concert_id" INTEGER NOT NULL,
    "checked_at" TIMESTAMP(3),
    "attempted_at" TIMESTAMP(3),
    "requested_at" TIMESTAMP(3),
    "failures" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "ConcertListingCheck_pkey" PRIMARY KEY ("concert_id")
);

-- AddForeignKey
ALTER TABLE "ConcertListingCheck" ADD CONSTRAINT "ConcertListingCheck_concert_id_fkey" FOREIGN KEY ("concert_id") REFERENCES "Concert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

