-- A SteamID64 is 17 digits (76561197960265728 and up), far past INTEGER's
-- 2147483647, so no real Steam account could ever be stored or looked up.
-- Widening is lossless; the unique index on it is rebuilt with the column.

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "steam_id" SET DATA TYPE BIGINT;
