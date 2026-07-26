-- Indexes on foreign keys that don't have one.
--
-- Postgres indexes primary keys and unique constraints, and nothing else — a
-- foreign key column is bare unless you say otherwise. That costs twice:
--   1. every "give me this user's trips" / "this trip's items" is a sequential
--      scan of the whole table;
--   2. deleting a parent row scans each child table once *per row deleted* to
--      find what to cascade or null out. That is the likely reason trip
--      deletion feels broken as the tables grow.
--
-- A composite unique already covers lookups on its *first* column, so those are
-- skipped here (LoadoutEntry.loadout_id, ItemReview.trip_id, GameTime.user…).
-- Second columns are not covered, so they are included.
--
-- Names follow Prisma's own convention ("Table_column_idx"), so a later
-- `prisma db pull` writes plain @@index([column]) with no @map noise.
--
-- CONCURRENTLY keeps writes working while each index builds; it cannot run
-- inside a transaction, so apply this file with psql (autocommit), not wrapped
-- in BEGIN/COMMIT. It is safe to re-run.

-- ── Travel bag: the hot paths ────────────────────────────────────────────────
-- Every travel route filters by user_id, and the trip page loads its children.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Trip_user_id_idx"                ON "Trip" ("user_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "GearItem_user_id_idx"            ON "GearItem" ("user_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Loadout_user_id_idx"             ON "Loadout" ("user_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Template_user_id_idx"            ON "Template" ("user_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "TravelWishlistItem_user_id_idx"  ON "TravelWishlistItem" ("user_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ItemReview_user_id_idx"          ON "ItemReview" ("user_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "TripReview_user_id_idx"          ON "TripReview" ("user_id");

-- Children of a trip: read on every trip page, walked on every trip delete.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "TripItem_trip_id_idx"            ON "TripItem" ("trip_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ExpenseEstimate_trip_id_idx"     ON "ExpenseEstimate" ("trip_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "TemplateItem_template_id_idx"    ON "TemplateItem" ("template_id");

-- Gear referenced from elsewhere. These are the SET NULL / CASCADE targets when
-- a piece of gear is deleted, and the reverse lookups behind "where is this
-- item used?".
CREATE INDEX CONCURRENTLY IF NOT EXISTS "TripItem_gear_item_id_idx"       ON "TripItem" ("gear_item_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "TripItem_bag_id_idx"             ON "TripItem" ("bag_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "LoadoutEntry_gear_item_id_idx"   ON "LoadoutEntry" ("gear_item_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "LoadoutEntry_bag_id_idx"         ON "LoadoutEntry" ("bag_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ItemReview_trip_item_id_idx"     ON "ItemReview" ("trip_item_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "GearItem_replaced_by_id_idx"     ON "GearItem" ("replaced_by_id");

-- ── Concerts and wishlists ───────────────────────────────────────────────────
-- WishlistBandReference's unique is (band_id, wishlist_id), so reads go the one
-- way it doesn't cover: "the bands on my wishlist".
CREATE INDEX CONCURRENTLY IF NOT EXISTS "WishlistBandReference_wishlist_id_idx" ON "WishlistBandReference" ("wishlist_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ConcertBandReference_band_idx"         ON "ConcertBandReference" ("band");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ConcertAttendance_concert_id_idx"      ON "ConcertAttendance" ("concert_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ActivityLog_wishlist_id_idx"           ON "ActivityLog" ("wishlist_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Concert_city_id_idx"                   ON "Concert" ("city_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "GameTime_game_idx"                     ON "GameTime" ("game");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "MovieReview_movie_idx"                 ON "MovieReview" ("movie");
