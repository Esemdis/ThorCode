-- AlterTable: OAuth providers whose access tokens expire.
-- TMDB session ids never do, so its rows keep NULL in all three columns.
ALTER TABLE "OAuth" ADD COLUMN "refresh_token" TEXT,
ADD COLUMN "expires_at" TIMESTAMP(3),
ADD COLUMN "scope" TEXT;
