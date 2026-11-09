-- AlterTable
ALTER TABLE "Concert" ADD COLUMN     "sources" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Backfill (THO-775): every row says at least the source it already names.
-- A show Songkick and Bandsintown both listed before this column existed was
-- merged down to one `source`, and which other site had it was never kept, so
-- those rows start with one entry and gain the other on their next sync only
-- if that site posts it again.
UPDATE "Concert" SET "sources" = ARRAY["source"] WHERE "source" IS NOT NULL;
