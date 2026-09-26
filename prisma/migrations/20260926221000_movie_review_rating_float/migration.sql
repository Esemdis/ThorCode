-- TMDB rates in half stars (0.5 to 10), and an INTEGER column quietly cut
-- 7.5 down to 7. Widening is lossless. Ratings already cut stay cut until
-- the owner's next sync, whose upsert rewrites each rating from TMDB.

-- AlterTable
ALTER TABLE "MovieReview" ALTER COLUMN "rating" SET DATA TYPE DOUBLE PRECISION;
