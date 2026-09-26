-- The year recap's picks: which of a night's files stand for it, and the
-- stretch of a picked video to play. Additive, and the default leaves every
-- existing file unpicked, which the recap reads as "choose for me".

-- AlterTable
ALTER TABLE "ConcertMedia" ADD COLUMN     "moment_end_ms" INTEGER,
ADD COLUMN     "moment_start_ms" INTEGER,
ADD COLUMN     "picked" BOOLEAN NOT NULL DEFAULT false;
