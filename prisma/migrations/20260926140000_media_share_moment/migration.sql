-- A share link to a moment of a video rather than the whole file. Both null is
-- the whole file, which is every link made before this.
ALTER TABLE "MediaShareLink" ADD COLUMN "start_ms" INTEGER;
ALTER TABLE "MediaShareLink" ADD COLUMN "end_ms" INTEGER;
