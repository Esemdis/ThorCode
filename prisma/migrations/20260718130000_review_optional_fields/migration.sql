-- Swipe reviews record only a verdict; usage and rating become optional detail
ALTER TABLE "ItemReview" ALTER COLUMN "usage" DROP NOT NULL;
ALTER TABLE "ItemReview" ALTER COLUMN "rating" DROP NOT NULL;
