-- The whole schema, for a database that has none of it — and, for one that
-- already has it, whatever it lacks of the migrations this replaced.
--
-- This replaces the forty-two migrations before it, which could not build a
-- database from empty: the first three were empty files, nothing created User,
-- Band, Concert, Trip or most other tables — they were made with `db push`
-- while migrations were gitignored — and the fourth altered a "PackingItem"
-- table and a "PackingStatus" type that no migration ever made. `migrate
-- deploy` on an empty database stopped there, so a fresh environment, a
-- restore from nothing, or a CI job against a real Postgres could not be had.
-- Those migrations remain in git history.
--
-- Three cases:
--
-- * An empty database: the schema is built in full, below.
-- * An existing database with every old migration recorded as applied —
--   production, normally: nothing changes, and the baseline is simply
--   recorded, with no `migrate resolve` needed first.
-- * An existing database that is behind. Once this is recorded nothing will
--   ever offer it the old migrations it lacks, so skipping it outright would
--   leave it short of tables for good with every check saying it was up to
--   date. The ones from July on are replayed here, each exactly as it was, in
--   order, when not recorded. The June ones cannot be: the first uses an enum
--   value in the transaction that added it, which Postgres refuses. A database
--   missing one of those is refused, with the steps to bring it up to date.
--
-- The from-empty part was generated with:
--   prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script

DO $baseline$
DECLARE
  applied text[];
  missing text[];
BEGIN
  IF to_regclass('"User"') IS NOT NULL THEN
    SELECT COALESCE(array_agg(migration_name), '{}') INTO applied
      FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;

    SELECT array_agg(wanted.migration) INTO missing
      FROM unnest(ARRAY[
      '20260604120000_replace_packing_status',
      '20260604130000_trip_money_budget',
      '20260604140000_category_budgets',
      '20260604150000_expense_end_date',
      '20260604160000_loadout_entry_worn',
      '20260604180000_loadout_entry_bag_id',
      '20260605120000_trip_item_bag_id',
      '20260605130000_wishlist_keywords',
      '20260606120000_role_system'
      ]::text[]) AS wanted(migration)
      WHERE NOT (wanted.migration = ANY (applied));
    IF missing IS NOT NULL THEN
      RAISE EXCEPTION 'This database is missing migrations the baseline cannot replay: %', array_to_string(missing, ', ')
        USING HINT = 'Run `prisma migrate resolve --rolled-back 20260926190000_baseline`, then `prisma migrate deploy` from a commit that still has those migrations (e141fed does), then deploy this again.';
    END IF;

    IF NOT ('20260717120000_item_reviews' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260717120000_item_reviews';
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
    END IF;

    IF NOT ('20260718120000_gear_essential' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260718120000_gear_essential';
      -- AlterTable
      ALTER TABLE "GearItem" ADD COLUMN "essential" BOOLEAN NOT NULL DEFAULT false;
    END IF;

    IF NOT ('20260718130000_review_optional_fields' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260718130000_review_optional_fields';
      -- Swipe reviews record only a verdict; usage and rating become optional detail
      ALTER TABLE "ItemReview" ALTER COLUMN "usage" DROP NOT NULL;
      ALTER TABLE "ItemReview" ALTER COLUMN "rating" DROP NOT NULL;
    END IF;

    IF NOT ('20260718140000_rates_and_upgrades' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260718140000_rates_and_upgrades';
      -- AlterTable: per-trip manual exchange rates, e.g. { "EUR": 11.2 } (foreign → trip currency)
      ALTER TABLE "Trip" ADD COLUMN "exchange_rates" JSONB;

      -- AlterTable: gear upgrade trail — retired items point at their replacement
      ALTER TABLE "GearItem" ADD COLUMN "retired" BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN "replaced_by_id" INTEGER;

      -- AddForeignKey
      ALTER TABLE "GearItem" ADD CONSTRAINT "GearItem_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "GearItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;

    IF NOT ('20260718150000_gear_photo' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260718150000_gear_photo';
      -- AlterTable: small client-side-compressed photo stored as a data URL
      ALTER TABLE "GearItem" ADD COLUMN "photo" TEXT;
    END IF;

    IF NOT ('20260719120000_gear_prices_trip_tags' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260719120000_gear_prices_trip_tags';
      -- AlterTable: what the item costs in store vs what was actually paid
      ALTER TABLE "GearItem" ADD COLUMN "retail_price" DECIMAL(10,2);
      ALTER TABLE "GearItem" ADD COLUMN "bought_for" DECIMAL(10,2);
      ALTER TABLE "GearItem" ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'SEK';

      -- AlterTable: trip vibe tags (concert, friends, culture, food, …)
      ALTER TABLE "Trip" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
    END IF;

    IF NOT ('20260719190000_gear_fill_level' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260719190000_gear_fill_level';
      -- AlterTable: consumables — % remaining (NULL = not a consumable)
      ALTER TABLE "GearItem" ADD COLUMN "fill_level" INTEGER;
    END IF;

    IF NOT ('20260724100000_notification_subscriptions' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260724100000_notification_subscriptions';
      -- CreateTable: per-user watch for new concerts (by band, by city, or a band+city combo)
      CREATE TABLE "NotificationSubscription" (
          "id" SERIAL NOT NULL,
          "user_id" TEXT NOT NULL,
          "band_id" INTEGER,
          "city_id" INTEGER,
          "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

          CONSTRAINT "NotificationSubscription_pkey" PRIMARY KEY ("id")
      );

      CREATE INDEX "NotificationSubscription_band_id_idx" ON "NotificationSubscription"("band_id");
      CREATE INDEX "NotificationSubscription_city_id_idx" ON "NotificationSubscription"("city_id");

      ALTER TABLE "NotificationSubscription" ADD CONSTRAINT "NotificationSubscription_user_id_fkey"
          FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
      ALTER TABLE "NotificationSubscription" ADD CONSTRAINT "NotificationSubscription_band_id_fkey"
          FOREIGN KEY ("band_id") REFERENCES "Band"("id") ON DELETE CASCADE ON UPDATE CASCADE;
      ALTER TABLE "NotificationSubscription" ADD CONSTRAINT "NotificationSubscription_city_id_fkey"
          FOREIGN KEY ("city_id") REFERENCES "City"("id") ON DELETE CASCADE ON UPDATE CASCADE;

      -- CreateTable: single-row cursor tracking the last time the notification digest cron ran
      CREATE TABLE "NotificationDigestRun" (
          "id" SERIAL NOT NULL,
          "last_run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

          CONSTRAINT "NotificationDigestRun_pkey" PRIMARY KEY ("id")
      );
    END IF;

    IF NOT ('20260724120000_trip_review' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260724120000_trip_review';
      -- CreateTable
      CREATE TABLE "TripReview" (
          "id" SERIAL NOT NULL,
          "user_id" TEXT NOT NULL,
          "trip_id" INTEGER NOT NULL,
          "culture_rating" INTEGER,
          "culture_note" TEXT,
          "food_rating" INTEGER,
          "food_note" TEXT,
          "fun_rating" INTEGER,
          "fun_note" TEXT,
          "missing_gear_item_ids" INTEGER[],
          "missing_note" TEXT,
          "comment" TEXT,
          "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updated_at" TIMESTAMP(3) NOT NULL,

          CONSTRAINT "TripReview_pkey" PRIMARY KEY ("id")
      );

      -- CreateIndex
      CREATE UNIQUE INDEX "TripReview_trip_id_key" ON "TripReview"("trip_id");

      -- AddForeignKey
      ALTER TABLE "TripReview" ADD CONSTRAINT "TripReview_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

      -- AddForeignKey
      ALTER TABLE "TripReview" ADD CONSTRAINT "TripReview_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT ('20260724130000_gear_photo_focus' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260724130000_gear_photo_focus';
      -- AlterTable
      ALTER TABLE "GearItem" ADD COLUMN "photo_focus" JSONB;
    END IF;

    IF NOT ('20260724140000_drop_gear_photo_focus' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260724140000_drop_gear_photo_focus';
      -- AlterTable
      ALTER TABLE "GearItem" DROP COLUMN IF EXISTS "photo_focus";
    END IF;

    IF NOT ('20260724150000_gear_price_irrelevant' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260724150000_gear_price_irrelevant';
      ALTER TABLE "GearItem" ADD COLUMN "price_irrelevant" BOOLEAN NOT NULL DEFAULT false;
    END IF;

    IF NOT ('20260726110000_add_email_verification' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260726110000_add_email_verification';
      -- CreateTable
      CREATE TABLE "EmailVerification" (
          "id" SERIAL NOT NULL,
          "user_id" TEXT NOT NULL,
          "new_email" TEXT NOT NULL,
          "code" TEXT NOT NULL,
          "expires_at" TIMESTAMP(3) NOT NULL,
          "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

          CONSTRAINT "EmailVerification_pkey" PRIMARY KEY ("id")
      );

      -- CreateIndex
      CREATE UNIQUE INDEX "EmailVerification_code_key" ON "EmailVerification"("code");

      -- CreateIndex
      CREATE INDEX "EmailVerification_user_id_idx" ON "EmailVerification"("user_id");

      -- AddForeignKey
      ALTER TABLE "EmailVerification" ADD CONSTRAINT "EmailVerification_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT ('20260802120000_trip_places' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260802120000_trip_places';
      -- CreateEnum
      CREATE TYPE "PlaceKind" AS ENUM ('SIGHT', 'FOOD', 'HOTEL');

      -- AlterTable
      ALTER TABLE "Trip" ADD COLUMN     "plan_data" JSONB,
      ADD COLUMN     "plan_updated_at" TIMESTAMP(3);

      -- CreateTable
      CREATE TABLE "TripPlace" (
          "id" SERIAL NOT NULL,
          "trip_id" INTEGER NOT NULL,
          "name" VARCHAR(200) NOT NULL,
          "kind" "PlaceKind" NOT NULL DEFAULT 'SIGHT',
          "lat" DOUBLE PRECISION,
          "lon" DOUBLE PRECISION,
          "address" VARCHAR(500),
          "url" VARCHAR(1000),
          "duration" INTEGER,
          "priority" INTEGER NOT NULL DEFAULT 3,
          "outdoor" BOOLEAN NOT NULL DEFAULT false,
          "hours" JSONB,
          "pinned_day" DATE,
          "note" TEXT,
          "sort_order" INTEGER NOT NULL DEFAULT 0,
          "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updated_at" TIMESTAMP(3) NOT NULL,

          CONSTRAINT "TripPlace_pkey" PRIMARY KEY ("id")
      );

      -- CreateIndex
      CREATE INDEX "TripPlace_trip_id_idx" ON "TripPlace"("trip_id");

      -- AddForeignKey
      ALTER TABLE "TripPlace" ADD CONSTRAINT "TripPlace_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT ('20260802160000_place_booking_times' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260802160000_place_booking_times';
      -- AlterTable
      ALTER TABLE "TripPlace" ADD COLUMN     "arrive_after" INTEGER,
      ADD COLUMN     "arrive_by" INTEGER;
    END IF;

    IF NOT ('20260802170000_place_ignore_hours' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260802170000_place_ignore_hours';
      -- AlterTable
      ALTER TABLE "TripPlace" ADD COLUMN     "ignore_hours" BOOLEAN NOT NULL DEFAULT false;
    END IF;

    IF NOT ('20260803200000_trip_arrival_departure' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260803200000_trip_arrival_departure';
      -- When you land and when you fly out, as minutes since midnight on the first
      -- and last day of the trip, plus optionally where those days begin and end.
      --
      -- The place columns are plain integers rather than foreign keys to TripPlace on
      -- purpose: a real FK would have to be nulled by hand whenever a place is
      -- deleted, and a stale id is already handled — the planner refuses to plan
      -- against a terminal it cannot find in the places it was given, which is a
      -- better failure than silently starting the day at the hotel instead.
      ALTER TABLE "Trip"
        ADD COLUMN "arrival_time"       INTEGER,
        ADD COLUMN "departure_time"     INTEGER,
        ADD COLUMN "arrival_place_id"   INTEGER,
        ADD COLUMN "departure_place_id" INTEGER,
        ADD COLUMN "transfer_minutes"   INTEGER;
    END IF;

    IF NOT ('20260803230000_place_blurb' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260803230000_place_blurb';
      -- A short description of a place from Wikipedia, cached.
      --
      -- blurb_checked_at records that we looked rather than that we found something.
      -- Most places have no article and never will, and without a "looked and found
      -- nothing" marker every refresh would ask Wikipedia about the same
      -- neighbourhood restaurant again.
      ALTER TABLE "TripPlace"
        ADD COLUMN "blurb"            TEXT,
        ADD COLUMN "blurb_url"        VARCHAR(500),
        ADD COLUMN "blurb_checked_at" TIMESTAMP(3);
    END IF;

    IF NOT ('20260812120000_oauth_token_refresh' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260812120000_oauth_token_refresh';
      -- AlterTable: OAuth providers whose access tokens expire.
      -- TMDB session ids never do, so its rows keep NULL in all three columns.
      ALTER TABLE "OAuth" ADD COLUMN "refresh_token" TEXT,
      ADD COLUMN "expires_at" TIMESTAMP(3),
      ADD COLUMN "scope" TEXT;
    END IF;

    IF NOT ('20260827190000_wishlist_calendar_token' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260827190000_wishlist_calendar_token';
      -- The secret in a subscribable calendar feed URL.
      --
      -- Nullable and minted lazily: most users never subscribe, and a column full of
      -- unused credentials is a liability rather than a feature. Unique because the
      -- token is how the feed route finds the wishlist — there is no session on that
      -- request to identify it any other way.
      --
      -- calendar_token_at records when the current token was issued, so a user can
      -- see how long a URL has been live before deciding to regenerate it.
      ALTER TABLE "Wishlist"
        ADD COLUMN "calendar_token"    TEXT,
        ADD COLUMN "calendar_token_at" TIMESTAMP(3);

      CREATE UNIQUE INDEX "Wishlist_calendar_token_key" ON "Wishlist"("calendar_token");
    END IF;

    IF NOT ('20260830140000_band_spotify_id' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260830140000_band_spotify_id';
      -- The Spotify artist id is stored; the photo url is not. Spotify's terms cap
      -- image caching at 24 hours and their CDN urls rotate, so the url is resolved
      -- from this id on demand and cached in Redis instead.
      ALTER TABLE "Band" ADD COLUMN "spotify_id" TEXT;

      -- Records that we looked. Null means "never searched"; a timestamp with a null
      -- spotify_id means Spotify has no artist under that exact name, and stops the
      -- search running again on every request.
      ALTER TABLE "Band" ADD COLUMN "spotify_checked_at" TIMESTAMP(3);

      CREATE UNIQUE INDEX "Band_spotify_id_key" ON "Band"("spotify_id");
    END IF;

    IF NOT ('20260830203000_band_source_urls_checked_at' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260830203000_band_source_urls_checked_at';
      -- Records that a Songkick/Bandsintown lookup ran. Null means "never checked";
      -- a timestamp with one or both urls still null means MusicBrainz had nothing
      -- for this band as of that check. Unlike spotify_checked_at this is not a
      -- permanent skip: the cron backfill re-queues a band once this ages past its
      -- staleDays window, since MusicBrainz relationships are added by volunteers
      -- over time.
      ALTER TABLE "Band" ADD COLUMN "source_urls_checked_at" TIMESTAMP(3);
    END IF;

    IF NOT ('20260830204500_drop_wishlist_scoring_columns' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260830204500_drop_wishlist_scoring_columns';
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
    END IF;

    IF NOT ('20260919120000_concert_media' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260919120000_concert_media';
      CREATE TYPE "MediaKind" AS ENUM ('PHOTO', 'VIDEO');

      CREATE TABLE "ConcertMedia" (
          "id"            SERIAL       NOT NULL,
          "attendance_id" INTEGER      NOT NULL,
          "band_id"       INTEGER,
          "rel_path"      TEXT         NOT NULL,
          "filename"      TEXT         NOT NULL,
          "kind"          "MediaKind"  NOT NULL,
          "bytes"         INTEGER      NOT NULL,
          "sha256"        TEXT         NOT NULL,
          "width"         INTEGER,
          "height"        INTEGER,
          "duration_ms"   INTEGER,
          "caption"       TEXT,
          "taken_at"      TIMESTAMP(3),
          "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

          CONSTRAINT "ConcertMedia_pkey" PRIMARY KEY ("id")
      );

      CREATE UNIQUE INDEX "ConcertMedia_attendance_id_filename_key" ON "ConcertMedia"("attendance_id", "filename");
      CREATE INDEX "ConcertMedia_band_id_idx" ON "ConcertMedia"("band_id");
      CREATE INDEX "ConcertMedia_attendance_id_idx" ON "ConcertMedia"("attendance_id");

      -- RESTRICT, not CASCADE. This constraint is the last thing standing between an
      -- orphan-cleanup query and the only copy of someone's photographs.
      ALTER TABLE "ConcertMedia"
        ADD CONSTRAINT "ConcertMedia_attendance_id_fkey"
        FOREIGN KEY ("attendance_id") REFERENCES "ConcertAttendance"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

      ALTER TABLE "ConcertMedia"
        ADD CONSTRAINT "ConcertMedia_band_id_fkey"
        FOREIGN KEY ("band_id") REFERENCES "Band"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;

    IF NOT ('20260921090000_notification_tour_watch' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260921090000_notification_tour_watch';
      -- AlterTable: a third watch shape, matched against the event's own name rather
      -- than a band row. Festivals are announced before their lineup exists, so there
      -- is nothing to point a band watch at; venue_query narrows a recurring name
      -- because most festivals return to a venue nobody else uses.
      --
      -- Both nullable and unconstrained at the database level, the way band_id and
      -- city_id already are: the POST route is what keeps the shapes apart, and
      -- utils/notificationMatch.js fails closed on a row that satisfies neither.
      ALTER TABLE "NotificationSubscription" ADD COLUMN "tour_query" TEXT;
      ALTER TABLE "NotificationSubscription" ADD COLUMN "venue_query" TEXT;
    END IF;

    IF NOT ('20260921100000_trip_review_photos' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260921100000_trip_review_photos';
      -- AlterTable
      ALTER TABLE "TripReview"
        ADD COLUMN "culture_photos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        ADD COLUMN "food_photos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        ADD COLUMN "fun_photos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
    END IF;

    IF NOT ('20260921140000_media_song' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260921140000_media_song';
      -- AlterTable
      ALTER TABLE "ConcertMedia" ADD COLUMN "song" TEXT;
    END IF;

    IF NOT ('20260923120000_concert_setlist_checked_at' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260923120000_concert_setlist_checked_at';
      -- Records when the setlist backfill last looked this concert up. Null means
      -- never. The backfill takes least-recently-checked first, so a show setlist.fm
      -- will never have a setlist for (a support act nobody logged) goes to the back
      -- of the queue instead of holding one of its fifty daily slots forever.
      ALTER TABLE "Concert" ADD COLUMN "setlist_checked_at" TIMESTAMP(3);
    END IF;

    IF NOT ('20260926120000_media_share_link' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260926120000_media_share_link';
      -- CreateTable: a time-boxed public URL to one ConcertMedia row
      CREATE TABLE "MediaShareLink" (
          "id" SERIAL NOT NULL,
          "media_id" INTEGER NOT NULL,
          "token" TEXT NOT NULL,
          "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "expires_at" TIMESTAMP(3) NOT NULL,
          "revoked_at" TIMESTAMP(3),

          CONSTRAINT "MediaShareLink_pkey" PRIMARY KEY ("id")
      );

      CREATE UNIQUE INDEX "MediaShareLink_token_key" ON "MediaShareLink"("token");
      CREATE INDEX "MediaShareLink_media_id_idx" ON "MediaShareLink"("media_id");
      CREATE INDEX "MediaShareLink_expires_at_idx" ON "MediaShareLink"("expires_at");

      ALTER TABLE "MediaShareLink" ADD CONSTRAINT "MediaShareLink_media_id_fkey"
          FOREIGN KEY ("media_id") REFERENCES "ConcertMedia"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT ('20260926140000_media_share_moment' = ANY (applied)) THEN
      RAISE NOTICE 'Baseline: applying %, which this database had not had.', '20260926140000_media_share_moment';
      -- A share link to a moment of a video rather than the whole file. Both null is
      -- the whole file, which is every link made before this.
      ALTER TABLE "MediaShareLink" ADD COLUMN "start_ms" INTEGER;
      ALTER TABLE "MediaShareLink" ADD COLUMN "end_ms" INTEGER;
    END IF;

    RETURN;
  END IF;

  -- CreateEnum
  CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN', 'SYSTEM');

  -- CreateEnum
  CREATE TYPE "BandTier" AS ENUM ('LOVE', 'LIKE', 'FOLLOW');

  -- CreateEnum
  CREATE TYPE "MediaKind" AS ENUM ('PHOTO', 'VIDEO');

  -- CreateEnum
  CREATE TYPE "PackingStatus" AS ENUM ('NEED_TO_BUY', 'BOUGHT', 'PACKED', 'NOT_PACKED');

  -- CreateEnum
  CREATE TYPE "PlaceKind" AS ENUM ('SIGHT', 'FOOD', 'HOTEL');

  -- CreateEnum
  CREATE TYPE "ReviewUsage" AS ENUM ('NEVER', 'SOMETIMES', 'OFTEN');

  -- CreateEnum
  CREATE TYPE "ReviewVerdict" AS ENUM ('KEEP', 'REPLACE', 'DITCH');

  -- CreateEnum
  CREATE TYPE "ReviewQuantity" AS ENUM ('TOO_FEW', 'RIGHT', 'TOO_MANY');

  -- CreateEnum
  CREATE TYPE "ReviewStatus" AS ENUM ('LOCKED', 'FLAGGED');

  -- CreateTable
  CREATE TABLE "User" (
      "id" TEXT NOT NULL,
      "email" TEXT NOT NULL,
      "password_hash" TEXT,
      "role" "Role" NOT NULL DEFAULT 'USER',
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "steam_id" INTEGER,
      "settings" JSONB,

      CONSTRAINT "User_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "Game" (
      "id" SERIAL NOT NULL,
      "appid" INTEGER NOT NULL,
      "name" TEXT NOT NULL,

      CONSTRAINT "Game_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "GameTime" (
      "id" SERIAL NOT NULL,
      "user" TEXT NOT NULL,
      "game" INTEGER NOT NULL,
      "play_time" INTEGER NOT NULL,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT "GameTime_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "Movie" (
      "id" SERIAL NOT NULL,
      "tmdb_id" INTEGER NOT NULL,
      "name" TEXT NOT NULL,

      CONSTRAINT "Movie_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "MovieReview" (
      "id" SERIAL NOT NULL,
      "user" TEXT NOT NULL,
      "movie" INTEGER NOT NULL,
      "rating" INTEGER NOT NULL,

      CONSTRAINT "MovieReview_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "OAuth" (
      "id" SERIAL NOT NULL,
      "provider" TEXT NOT NULL,
      "provider_user_id" TEXT NOT NULL,
      "access_token" TEXT NOT NULL,
      "refresh_token" TEXT,
      "expires_at" TIMESTAMP(3),
      "scope" TEXT,
      "user" TEXT NOT NULL,

      CONSTRAINT "OAuth_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "Band" (
      "id" SERIAL NOT NULL,
      "name" TEXT NOT NULL,
      "ticketmaster_id" TEXT,
      "created_at" TIMESTAMP(3),
      "MBID" TEXT,
      "songkick_url" TEXT,
      "bandsintown_url" TEXT,
      "source_urls_checked_at" TIMESTAMP(3),
      "setlist" JSONB,
      "setlist_updated_at" TIMESTAMP(3),
      "spotify_id" TEXT,
      "spotify_checked_at" TIMESTAMP(3),

      CONSTRAINT "Band_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "Concert" (
      "id" SERIAL NOT NULL,
      "country" TEXT NOT NULL,
      "venue" TEXT NOT NULL,
      "created_at" TIMESTAMP(3) NOT NULL,
      "on_sale" BOOLEAN NOT NULL,
      "city" TEXT NOT NULL,
      "concert_date" TIMESTAMP(3),
      "event_id" TEXT,
      "latitude" VARCHAR,
      "longitude" VARCHAR,
      "metadata" TEXT,
      "name" TEXT,
      "ticket_sale_start" TIMESTAMP(6),
      "url" TEXT,
      "festival" BOOLEAN DEFAULT false,
      "source" TEXT,
      "weather" JSONB,
      "price_min" DOUBLE PRECISION,
      "price_max" DOUBLE PRECISION,
      "price_currency" TEXT,
      "sold_out" BOOLEAN DEFAULT false,
      "reachable" TEXT,
      "setlist_checked_at" TIMESTAMP(3),
      "city_id" INTEGER,

      CONSTRAINT "Concert_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "City" (
      "id" SERIAL NOT NULL,
      "name" TEXT NOT NULL,
      "country" TEXT NOT NULL,
      "latitude" DOUBLE PRECISION,
      "longitude" DOUBLE PRECISION,
      "reachable" TEXT,
      "airport_iata" TEXT,
      "weather_monthly" JSONB,
      "weather_updated_at" TIMESTAMP(3),
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT "City_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "Country" (
      "id" SERIAL NOT NULL,
      "name" TEXT NOT NULL,
      "iso" TEXT NOT NULL,

      CONSTRAINT "Country_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "ConcertBandReference" (
      "id" SERIAL NOT NULL,
      "concert" INTEGER NOT NULL,
      "band" INTEGER NOT NULL,
      "setlist" JSONB,

      CONSTRAINT "ConcertBandReference_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "Wishlist" (
      "id" SERIAL NOT NULL,
      "name" TEXT NOT NULL,
      "user_id" TEXT NOT NULL,
      "discord_webhook" TEXT,
      "last_active_at" TIMESTAMP(3),
      "calendar_token" TEXT,
      "calendar_token_at" TIMESTAMP(3),

      CONSTRAINT "Wishlist_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "ActivityLog" (
      "id" SERIAL NOT NULL,
      "wishlist_id" INTEGER NOT NULL,
      "type" TEXT NOT NULL,
      "data" TEXT NOT NULL,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "WishlistBandReference" (
      "id" SERIAL NOT NULL,
      "band_id" INTEGER NOT NULL,
      "wishlist_id" INTEGER NOT NULL,
      "tier" "BandTier" NOT NULL DEFAULT 'FOLLOW',

      CONSTRAINT "WishlistBandReference_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "ConcertAttendance" (
      "id" SERIAL NOT NULL,
      "wishlist_id" INTEGER NOT NULL,
      "concert_id" INTEGER NOT NULL,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT "ConcertAttendance_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "ConcertMedia" (
      "id" SERIAL NOT NULL,
      "attendance_id" INTEGER NOT NULL,
      "band_id" INTEGER,
      "rel_path" TEXT NOT NULL,
      "filename" TEXT NOT NULL,
      "kind" "MediaKind" NOT NULL,
      "bytes" INTEGER NOT NULL,
      "sha256" TEXT NOT NULL,
      "width" INTEGER,
      "height" INTEGER,
      "duration_ms" INTEGER,
      "caption" TEXT,
      "song" TEXT,
      "taken_at" TIMESTAMP(3),
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT "ConcertMedia_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "MediaShareLink" (
      "id" SERIAL NOT NULL,
      "media_id" INTEGER NOT NULL,
      "token" TEXT NOT NULL,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "expires_at" TIMESTAMP(3) NOT NULL,
      "revoked_at" TIMESTAMP(3),
      "start_ms" INTEGER,
      "end_ms" INTEGER,

      CONSTRAINT "MediaShareLink_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "NotificationSubscription" (
      "id" SERIAL NOT NULL,
      "user_id" TEXT NOT NULL,
      "band_id" INTEGER,
      "city_id" INTEGER,
      "tour_query" TEXT,
      "venue_query" TEXT,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT "NotificationSubscription_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "NotificationDigestRun" (
      "id" SERIAL NOT NULL,
      "last_run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT "NotificationDigestRun_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "EmailVerification" (
      "id" SERIAL NOT NULL,
      "user_id" TEXT NOT NULL,
      "new_email" TEXT NOT NULL,
      "code" TEXT NOT NULL,
      "expires_at" TIMESTAMP(3) NOT NULL,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT "EmailVerification_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "Trip" (
      "id" SERIAL NOT NULL,
      "user_id" TEXT NOT NULL,
      "name" VARCHAR(200) NOT NULL,
      "destination" VARCHAR(200),
      "start_date" DATE,
      "end_date" DATE,
      "notes" TEXT,
      "weight_budget" INTEGER,
      "money_budget" DECIMAL(10,2),
      "currency" VARCHAR(3) NOT NULL DEFAULT 'SEK',
      "budget_flights" DECIMAL(10,2),
      "budget_hotel" DECIMAL(10,2),
      "budget_entertainment" DECIMAL(10,2),
      "budget_food" DECIMAL(10,2),
      "weather_data" JSONB,
      "weather_updated_at" TIMESTAMP(3),
      "exchange_rates" JSONB,
      "tags" TEXT[],
      "arrival_time" INTEGER,
      "departure_time" INTEGER,
      "arrival_place_id" INTEGER,
      "departure_place_id" INTEGER,
      "transfer_minutes" INTEGER,
      "plan_data" JSONB,
      "plan_updated_at" TIMESTAMP(3),
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL,

      CONSTRAINT "Trip_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "TripPlace" (
      "id" SERIAL NOT NULL,
      "trip_id" INTEGER NOT NULL,
      "name" VARCHAR(200) NOT NULL,
      "kind" "PlaceKind" NOT NULL DEFAULT 'SIGHT',
      "lat" DOUBLE PRECISION,
      "lon" DOUBLE PRECISION,
      "address" VARCHAR(500),
      "url" VARCHAR(1000),
      "duration" INTEGER,
      "priority" INTEGER NOT NULL DEFAULT 3,
      "outdoor" BOOLEAN NOT NULL DEFAULT false,
      "hours" JSONB,
      "pinned_day" DATE,
      "arrive_after" INTEGER,
      "arrive_by" INTEGER,
      "ignore_hours" BOOLEAN NOT NULL DEFAULT false,
      "blurb" TEXT,
      "blurb_url" VARCHAR(500),
      "blurb_checked_at" TIMESTAMP(3),
      "note" TEXT,
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL,

      CONSTRAINT "TripPlace_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "TripTodo" (
      "id" SERIAL NOT NULL,
      "trip_id" INTEGER NOT NULL,
      "text" VARCHAR(300) NOT NULL,
      "done" BOOLEAN NOT NULL DEFAULT false,
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL,

      CONSTRAINT "TripTodo_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "TripItem" (
      "id" SERIAL NOT NULL,
      "trip_id" INTEGER NOT NULL,
      "name" VARCHAR(200) NOT NULL,
      "category" VARCHAR(100),
      "status" "PackingStatus" NOT NULL DEFAULT 'NEED_TO_BUY',
      "note" TEXT,
      "url" VARCHAR(500),
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      "gear_item_id" INTEGER,
      "worn" BOOLEAN NOT NULL DEFAULT false,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL,
      "bag_id" INTEGER,

      CONSTRAINT "TripItem_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "ExpenseEstimate" (
      "id" SERIAL NOT NULL,
      "trip_id" INTEGER NOT NULL,
      "category" VARCHAR(100) NOT NULL,
      "amount" DECIMAL(10,2) NOT NULL,
      "currency" VARCHAR(3) NOT NULL DEFAULT 'SEK',
      "date" DATE,
      "end_date" DATE,
      "note" TEXT,
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL,

      CONSTRAINT "ExpenseEstimate_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "Template" (
      "id" SERIAL NOT NULL,
      "user_id" TEXT NOT NULL,
      "name" VARCHAR(200) NOT NULL,
      "description" TEXT,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL,

      CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "TemplateItem" (
      "id" SERIAL NOT NULL,
      "template_id" INTEGER NOT NULL,
      "name" VARCHAR(200) NOT NULL,
      "category" VARCHAR(100),
      "note" TEXT,
      "url" VARCHAR(500),
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT "TemplateItem_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "GearItem" (
      "id" SERIAL NOT NULL,
      "user_id" TEXT NOT NULL,
      "name" VARCHAR(200) NOT NULL,
      "model" VARCHAR(200),
      "brand" VARCHAR(100),
      "category" VARCHAR(100),
      "dimensions" JSONB,
      "tags" TEXT[],
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      "worn" BOOLEAN NOT NULL DEFAULT false,
      "notes" TEXT,
      "url" VARCHAR(500),
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL,
      "review_status" "ReviewStatus",
      "review_streak" INTEGER NOT NULL DEFAULT 0,
      "review_count" INTEGER NOT NULL DEFAULT 0,
      "last_review_at" TIMESTAMP(3),
      "essential" BOOLEAN NOT NULL DEFAULT false,
      "retired" BOOLEAN NOT NULL DEFAULT false,
      "replaced_by_id" INTEGER,
      "photo" TEXT,
      "retail_price" DECIMAL(10,2),
      "bought_for" DECIMAL(10,2),
      "currency" VARCHAR(3) NOT NULL DEFAULT 'SEK',
      "fill_level" INTEGER,
      "price_irrelevant" BOOLEAN NOT NULL DEFAULT false,

      CONSTRAINT "GearItem_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "ItemReview" (
      "id" SERIAL NOT NULL,
      "user_id" TEXT NOT NULL,
      "trip_id" INTEGER NOT NULL,
      "trip_item_id" INTEGER,
      "gear_item_id" INTEGER,
      "item_name" VARCHAR(200) NOT NULL,
      "usage" "ReviewUsage",
      "rating" INTEGER,
      "verdict" "ReviewVerdict" NOT NULL,
      "quantity" "ReviewQuantity",
      "note" TEXT,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL,

      CONSTRAINT "ItemReview_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "TripReview" (
      "id" SERIAL NOT NULL,
      "user_id" TEXT NOT NULL,
      "trip_id" INTEGER NOT NULL,
      "culture_rating" INTEGER,
      "culture_note" TEXT,
      "culture_photos" TEXT[] DEFAULT ARRAY[]::TEXT[],
      "food_rating" INTEGER,
      "food_note" TEXT,
      "food_photos" TEXT[] DEFAULT ARRAY[]::TEXT[],
      "fun_rating" INTEGER,
      "fun_note" TEXT,
      "fun_photos" TEXT[] DEFAULT ARRAY[]::TEXT[],
      "missing_gear_item_ids" INTEGER[],
      "missing_note" TEXT,
      "comment" TEXT,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL,

      CONSTRAINT "TripReview_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "TravelWishlistItem" (
      "id" SERIAL NOT NULL,
      "user_id" TEXT NOT NULL,
      "name" VARCHAR(200) NOT NULL,
      "brand" VARCHAR(100),
      "model" VARCHAR(200),
      "category" VARCHAR(100),
      "url" VARCHAR(500),
      "notes" TEXT,
      "price" DOUBLE PRECISION,
      "currency" VARCHAR(3) NOT NULL DEFAULT 'SEK',
      "dimensions" JSONB,
      "keywords" TEXT[],
      "bought" BOOLEAN NOT NULL DEFAULT false,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL,

      CONSTRAINT "TravelWishlistItem_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "Loadout" (
      "id" SERIAL NOT NULL,
      "user_id" TEXT NOT NULL,
      "name" VARCHAR(200) NOT NULL,
      "description" TEXT,
      "weight_budget" INTEGER,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL,

      CONSTRAINT "Loadout_pkey" PRIMARY KEY ("id")
  );

  -- CreateTable
  CREATE TABLE "LoadoutEntry" (
      "id" SERIAL NOT NULL,
      "loadout_id" INTEGER NOT NULL,
      "gear_item_id" INTEGER NOT NULL,
      "worn" BOOLEAN NOT NULL DEFAULT false,
      "bag_id" INTEGER,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT "LoadoutEntry_pkey" PRIMARY KEY ("id")
  );

  -- CreateIndex
  CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

  -- CreateIndex
  CREATE UNIQUE INDEX "User_steam_id_key" ON "User"("steam_id");

  -- CreateIndex
  CREATE UNIQUE INDEX "Game_appid_key" ON "Game"("appid");

  -- CreateIndex
  CREATE INDEX "GameTime_game_idx" ON "GameTime"("game");

  -- CreateIndex
  CREATE UNIQUE INDEX "GameTime_user_game_key" ON "GameTime"("user", "game");

  -- CreateIndex
  CREATE UNIQUE INDEX "Movie_tmdb_id_key" ON "Movie"("tmdb_id");

  -- CreateIndex
  CREATE INDEX "MovieReview_movie_idx" ON "MovieReview"("movie");

  -- CreateIndex
  CREATE UNIQUE INDEX "MovieReview_user_movie_key" ON "MovieReview"("user", "movie");

  -- CreateIndex
  CREATE UNIQUE INDEX "OAuth_user_provider_key" ON "OAuth"("user", "provider");

  -- CreateIndex
  CREATE UNIQUE INDEX "Band_name_key" ON "Band"("name");

  -- CreateIndex
  CREATE UNIQUE INDEX "Band_ticketmaster_id_key" ON "Band"("ticketmaster_id");

  -- CreateIndex
  CREATE UNIQUE INDEX "Band_MBID_key" ON "Band"("MBID");

  -- CreateIndex
  CREATE UNIQUE INDEX "Band_spotify_id_key" ON "Band"("spotify_id");

  -- CreateIndex
  CREATE UNIQUE INDEX "Concert_event_id_key" ON "Concert"("event_id");

  -- CreateIndex
  CREATE INDEX "Concert_city_id_idx" ON "Concert"("city_id");

  -- CreateIndex
  CREATE INDEX "Concert_concert_date_latitude_longitude_idx" ON "Concert"("concert_date", "latitude", "longitude");

  -- CreateIndex
  CREATE INDEX "Concert_concert_date_idx" ON "Concert"("concert_date");

  -- CreateIndex
  CREATE UNIQUE INDEX "City_name_country_key" ON "City"("name", "country");

  -- CreateIndex
  CREATE INDEX "ConcertBandReference_band_idx" ON "ConcertBandReference"("band");

  -- CreateIndex
  CREATE UNIQUE INDEX "ConcertBandReference_concert_band_key" ON "ConcertBandReference"("concert", "band");

  -- CreateIndex
  CREATE UNIQUE INDEX "Wishlist_user_id_key" ON "Wishlist"("user_id");

  -- CreateIndex
  CREATE UNIQUE INDEX "Wishlist_calendar_token_key" ON "Wishlist"("calendar_token");

  -- CreateIndex
  CREATE INDEX "ActivityLog_wishlist_id_idx" ON "ActivityLog"("wishlist_id");

  -- CreateIndex
  CREATE INDEX "WishlistBandReference_wishlist_id_idx" ON "WishlistBandReference"("wishlist_id");

  -- CreateIndex
  CREATE UNIQUE INDEX "WishlistBandReference_band_id_wishlist_id_key" ON "WishlistBandReference"("band_id", "wishlist_id");

  -- CreateIndex
  CREATE INDEX "ConcertAttendance_concert_id_idx" ON "ConcertAttendance"("concert_id");

  -- CreateIndex
  CREATE UNIQUE INDEX "ConcertAttendance_wishlist_id_concert_id_key" ON "ConcertAttendance"("wishlist_id", "concert_id");

  -- CreateIndex
  CREATE INDEX "ConcertMedia_band_id_idx" ON "ConcertMedia"("band_id");

  -- CreateIndex
  CREATE INDEX "ConcertMedia_attendance_id_idx" ON "ConcertMedia"("attendance_id");

  -- CreateIndex
  CREATE UNIQUE INDEX "ConcertMedia_attendance_id_filename_key" ON "ConcertMedia"("attendance_id", "filename");

  -- CreateIndex
  CREATE UNIQUE INDEX "MediaShareLink_token_key" ON "MediaShareLink"("token");

  -- CreateIndex
  CREATE INDEX "MediaShareLink_media_id_idx" ON "MediaShareLink"("media_id");

  -- CreateIndex
  CREATE INDEX "MediaShareLink_expires_at_idx" ON "MediaShareLink"("expires_at");

  -- CreateIndex
  CREATE INDEX "NotificationSubscription_band_id_idx" ON "NotificationSubscription"("band_id");

  -- CreateIndex
  CREATE INDEX "NotificationSubscription_city_id_idx" ON "NotificationSubscription"("city_id");

  -- CreateIndex
  CREATE UNIQUE INDEX "EmailVerification_code_key" ON "EmailVerification"("code");

  -- CreateIndex
  CREATE INDEX "EmailVerification_user_id_idx" ON "EmailVerification"("user_id");

  -- CreateIndex
  CREATE INDEX "Trip_user_id_idx" ON "Trip"("user_id");

  -- CreateIndex
  CREATE INDEX "TripPlace_trip_id_idx" ON "TripPlace"("trip_id");

  -- CreateIndex
  CREATE INDEX "TripTodo_trip_id_idx" ON "TripTodo"("trip_id");

  -- CreateIndex
  CREATE INDEX "TripItem_bag_id_idx" ON "TripItem"("bag_id");

  -- CreateIndex
  CREATE INDEX "TripItem_gear_item_id_idx" ON "TripItem"("gear_item_id");

  -- CreateIndex
  CREATE INDEX "TripItem_trip_id_idx" ON "TripItem"("trip_id");

  -- CreateIndex
  CREATE INDEX "ExpenseEstimate_trip_id_idx" ON "ExpenseEstimate"("trip_id");

  -- CreateIndex
  CREATE INDEX "Template_user_id_idx" ON "Template"("user_id");

  -- CreateIndex
  CREATE INDEX "TemplateItem_template_id_idx" ON "TemplateItem"("template_id");

  -- CreateIndex
  CREATE INDEX "GearItem_replaced_by_id_idx" ON "GearItem"("replaced_by_id");

  -- CreateIndex
  CREATE INDEX "GearItem_user_id_idx" ON "GearItem"("user_id");

  -- CreateIndex
  CREATE INDEX "ItemReview_gear_item_id_idx" ON "ItemReview"("gear_item_id");

  -- CreateIndex
  CREATE INDEX "ItemReview_trip_item_id_idx" ON "ItemReview"("trip_item_id");

  -- CreateIndex
  CREATE INDEX "ItemReview_user_id_idx" ON "ItemReview"("user_id");

  -- CreateIndex
  CREATE UNIQUE INDEX "ItemReview_trip_id_trip_item_id_key" ON "ItemReview"("trip_id", "trip_item_id");

  -- CreateIndex
  CREATE UNIQUE INDEX "TripReview_trip_id_key" ON "TripReview"("trip_id");

  -- CreateIndex
  CREATE INDEX "TripReview_user_id_idx" ON "TripReview"("user_id");

  -- CreateIndex
  CREATE INDEX "TravelWishlistItem_user_id_idx" ON "TravelWishlistItem"("user_id");

  -- CreateIndex
  CREATE INDEX "Loadout_user_id_idx" ON "Loadout"("user_id");

  -- CreateIndex
  CREATE INDEX "LoadoutEntry_bag_id_idx" ON "LoadoutEntry"("bag_id");

  -- CreateIndex
  CREATE INDEX "LoadoutEntry_gear_item_id_idx" ON "LoadoutEntry"("gear_item_id");

  -- CreateIndex
  CREATE UNIQUE INDEX "LoadoutEntry_loadout_id_gear_item_id_key" ON "LoadoutEntry"("loadout_id", "gear_item_id");

  -- AddForeignKey
  ALTER TABLE "GameTime" ADD CONSTRAINT "GameTime_game_fkey" FOREIGN KEY ("game") REFERENCES "Game"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "GameTime" ADD CONSTRAINT "GameTime_user_fkey" FOREIGN KEY ("user") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "MovieReview" ADD CONSTRAINT "MovieReview_movie_fkey" FOREIGN KEY ("movie") REFERENCES "Movie"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "MovieReview" ADD CONSTRAINT "MovieReview_user_fkey" FOREIGN KEY ("user") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "OAuth" ADD CONSTRAINT "OAuth_user_fkey" FOREIGN KEY ("user") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "Concert" ADD CONSTRAINT "Concert_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "City"("id") ON DELETE SET NULL ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "ConcertBandReference" ADD CONSTRAINT "ConcertBandReference_band_fkey" FOREIGN KEY ("band") REFERENCES "Band"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "ConcertBandReference" ADD CONSTRAINT "ConcertBandReference_concert_fkey" FOREIGN KEY ("concert") REFERENCES "Concert"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "Wishlist" ADD CONSTRAINT "Wishlist_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_wishlist_id_fkey" FOREIGN KEY ("wishlist_id") REFERENCES "Wishlist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "WishlistBandReference" ADD CONSTRAINT "WishlistBandReference_band_id_fkey" FOREIGN KEY ("band_id") REFERENCES "Band"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "WishlistBandReference" ADD CONSTRAINT "WishlistBandReference_wishlist_id_fkey" FOREIGN KEY ("wishlist_id") REFERENCES "Wishlist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "ConcertAttendance" ADD CONSTRAINT "ConcertAttendance_wishlist_id_fkey" FOREIGN KEY ("wishlist_id") REFERENCES "Wishlist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "ConcertAttendance" ADD CONSTRAINT "ConcertAttendance_concert_id_fkey" FOREIGN KEY ("concert_id") REFERENCES "Concert"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "ConcertMedia" ADD CONSTRAINT "ConcertMedia_attendance_id_fkey" FOREIGN KEY ("attendance_id") REFERENCES "ConcertAttendance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "ConcertMedia" ADD CONSTRAINT "ConcertMedia_band_id_fkey" FOREIGN KEY ("band_id") REFERENCES "Band"("id") ON DELETE SET NULL ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "MediaShareLink" ADD CONSTRAINT "MediaShareLink_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "ConcertMedia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "NotificationSubscription" ADD CONSTRAINT "NotificationSubscription_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "NotificationSubscription" ADD CONSTRAINT "NotificationSubscription_band_id_fkey" FOREIGN KEY ("band_id") REFERENCES "Band"("id") ON DELETE CASCADE ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "NotificationSubscription" ADD CONSTRAINT "NotificationSubscription_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "City"("id") ON DELETE CASCADE ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "EmailVerification" ADD CONSTRAINT "EmailVerification_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "Trip" ADD CONSTRAINT "Trip_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "TripPlace" ADD CONSTRAINT "TripPlace_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "TripTodo" ADD CONSTRAINT "TripTodo_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "TripItem" ADD CONSTRAINT "TripItem_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "TripItem" ADD CONSTRAINT "TripItem_gear_item_id_fkey" FOREIGN KEY ("gear_item_id") REFERENCES "GearItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "TripItem" ADD CONSTRAINT "TripItem_bag_id_fkey" FOREIGN KEY ("bag_id") REFERENCES "GearItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "ExpenseEstimate" ADD CONSTRAINT "ExpenseEstimate_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "Template" ADD CONSTRAINT "Template_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "TemplateItem" ADD CONSTRAINT "TemplateItem_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "Template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "GearItem" ADD CONSTRAINT "GearItem_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "GearItem" ADD CONSTRAINT "GearItem_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "GearItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "ItemReview" ADD CONSTRAINT "ItemReview_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "ItemReview" ADD CONSTRAINT "ItemReview_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "ItemReview" ADD CONSTRAINT "ItemReview_trip_item_id_fkey" FOREIGN KEY ("trip_item_id") REFERENCES "TripItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "ItemReview" ADD CONSTRAINT "ItemReview_gear_item_id_fkey" FOREIGN KEY ("gear_item_id") REFERENCES "GearItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "TripReview" ADD CONSTRAINT "TripReview_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "TripReview" ADD CONSTRAINT "TripReview_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "TravelWishlistItem" ADD CONSTRAINT "TravelWishlistItem_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "Loadout" ADD CONSTRAINT "Loadout_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "LoadoutEntry" ADD CONSTRAINT "LoadoutEntry_loadout_id_fkey" FOREIGN KEY ("loadout_id") REFERENCES "Loadout"("id") ON DELETE CASCADE ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "LoadoutEntry" ADD CONSTRAINT "LoadoutEntry_gear_item_id_fkey" FOREIGN KEY ("gear_item_id") REFERENCES "GearItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

  -- AddForeignKey
  ALTER TABLE "LoadoutEntry" ADD CONSTRAINT "LoadoutEntry_bag_id_fkey" FOREIGN KEY ("bag_id") REFERENCES "GearItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

END
$baseline$;
