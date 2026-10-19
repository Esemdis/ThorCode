-- CreateEnum
CREATE TYPE "VenueAccess" AS ENUM ('YES', 'PARTIAL', 'NO');

-- CreateTable
CREATE TABLE "VenueReview" (
    "id" SERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "venue_id" INTEGER NOT NULL,
    "sound" INTEGER,
    "view" INTEGER,
    "stage" INTEGER,
    "vibe" INTEGER,
    "wheelchair" "VenueAccess",
    "comment" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenueReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VenueReview_venue_id_idx" ON "VenueReview"("venue_id");

-- CreateIndex
CREATE UNIQUE INDEX "VenueReview_user_id_venue_id_key" ON "VenueReview"("user_id", "venue_id");

-- AddForeignKey
ALTER TABLE "VenueReview" ADD CONSTRAINT "VenueReview_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueReview" ADD CONSTRAINT "VenueReview_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

