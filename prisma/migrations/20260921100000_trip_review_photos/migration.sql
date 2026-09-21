-- AlterTable
ALTER TABLE "TripReview"
  ADD COLUMN "culture_photos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "food_photos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "fun_photos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
