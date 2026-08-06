-- CreateEnum
CREATE TYPE "ReviewUsage" AS ENUM ('NEVER', 'SOMETIMES', 'OFTEN');

-- CreateEnum
CREATE TYPE "ReviewVerdict" AS ENUM ('KEEP', 'REPLACE', 'DITCH');

-- CreateEnum
CREATE TYPE "ReviewQuantity" AS ENUM ('TOO_FEW', 'RIGHT', 'TOO_MANY');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('LOCKED', 'FLAGGED');

-- AlterTable
ALTER TABLE "GearItem" ADD COLUMN "review_status" "ReviewStatus",
ADD COLUMN "review_streak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "review_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "last_review_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ItemReview" (
    "id" SERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "trip_id" INTEGER NOT NULL,
    "trip_item_id" INTEGER,
    "gear_item_id" INTEGER,
    "item_name" VARCHAR(200) NOT NULL,
    "usage" "ReviewUsage" NOT NULL,
    "rating" INTEGER NOT NULL,
    "verdict" "ReviewVerdict" NOT NULL,
    "quantity" "ReviewQuantity",
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ItemReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ItemReview_trip_id_trip_item_id_key" ON "ItemReview"("trip_id", "trip_item_id");

-- CreateIndex
CREATE INDEX "ItemReview_gear_item_id_idx" ON "ItemReview"("gear_item_id");

-- AddForeignKey
ALTER TABLE "ItemReview" ADD CONSTRAINT "ItemReview_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemReview" ADD CONSTRAINT "ItemReview_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemReview" ADD CONSTRAINT "ItemReview_trip_item_id_fkey" FOREIGN KEY ("trip_item_id") REFERENCES "TripItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemReview" ADD CONSTRAINT "ItemReview_gear_item_id_fkey" FOREIGN KEY ("gear_item_id") REFERENCES "GearItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
