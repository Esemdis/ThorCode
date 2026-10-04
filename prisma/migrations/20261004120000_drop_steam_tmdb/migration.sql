-- The Steam and TMDB endpoints are gone: nothing called them. Their tables,
-- the linked Steam id and any stored TMDB sessions go with them.

-- TMDB sessions never expire, so a leftover row would stay a live credential.
DELETE FROM "OAuth" WHERE "provider" = 'tmdb';

-- DropForeignKey
ALTER TABLE "GameTime" DROP CONSTRAINT "GameTime_game_fkey";

-- DropForeignKey
ALTER TABLE "GameTime" DROP CONSTRAINT "GameTime_user_fkey";

-- DropForeignKey
ALTER TABLE "MovieReview" DROP CONSTRAINT "MovieReview_movie_fkey";

-- DropForeignKey
ALTER TABLE "MovieReview" DROP CONSTRAINT "MovieReview_user_fkey";

-- DropIndex
DROP INDEX "User_steam_id_key";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "steam_id";

-- DropTable
DROP TABLE "Game";

-- DropTable
DROP TABLE "GameTime";

-- DropTable
DROP TABLE "Movie";

-- DropTable
DROP TABLE "MovieReview";
