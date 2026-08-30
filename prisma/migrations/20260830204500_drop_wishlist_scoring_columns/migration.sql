-- Drops the last three columns of a per-wishlist concert scoring feature that
-- no longer exists in the code. Nothing has read or written them since it was
-- removed: three of nine wishlists still held values, but they were computed by
-- a ranking pass that is gone, so the numbers described a scoring model the app
-- can no longer explain or reproduce. Kept around they read as live data.
--
-- If scoring returns it should be recomputed from Concert/WishlistBandReference
-- rather than resumed from these, which is why this drops rather than archives.
ALTER TABLE "Wishlist" DROP COLUMN "concert_scores";
ALTER TABLE "Wishlist" DROP COLUMN "city_rankings";
ALTER TABLE "Wishlist" DROP COLUMN "scores_computed_at";
