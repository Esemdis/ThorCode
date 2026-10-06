-- An act joining a show already announced is news too. A festival is one row
-- that gains its acts one link at a time, and only the scrape that created the
-- row was ever announced: every act after it was filed as a duplicate and
-- reached no one, wishlist, band watch or festival watch.
--
-- notify_pending on the link is the outbox for those acts, as it is on the
-- show for a new one. Every existing link starts false, except on a show still
-- owed its announcement, which is owed it for every act on it.
--
-- created_at is when the act was put on the bill, which the email digest reads.
-- Added without a default and given one after, so the links already there stay
-- null rather than all reading as added today: a volatile default on ADD COLUMN
-- fills every existing row.

-- AlterTable
ALTER TABLE "ConcertBandReference" ADD COLUMN "notify_pending" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ConcertBandReference" ADD COLUMN "created_at" TIMESTAMP(3);
ALTER TABLE "ConcertBandReference" ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP;

UPDATE "ConcertBandReference" AS r
SET "notify_pending" = true
FROM "Concert" AS c
WHERE c."id" = r."concert" AND c."notify_pending";

-- A delivery is per act. Each existing one covered the bill the show had when
-- it was posted, which is as close as the old row can say: it becomes one row
-- per act on the bill now.
ALTER TABLE "ConcertDelivery" DROP CONSTRAINT "ConcertDelivery_pkey";
ALTER TABLE "ConcertDelivery" ADD COLUMN "band_id" INTEGER;

INSERT INTO "ConcertDelivery" ("concert_id", "wishlist_id", "band_id", "delivered_at")
SELECT d."concert_id", d."wishlist_id", r."band", d."delivered_at"
FROM "ConcertDelivery" AS d
JOIN "ConcertBandReference" AS r ON r."concert" = d."concert_id"
WHERE d."band_id" IS NULL;

DELETE FROM "ConcertDelivery" WHERE "band_id" IS NULL;

ALTER TABLE "ConcertDelivery" ALTER COLUMN "band_id" SET NOT NULL;
ALTER TABLE "ConcertDelivery" ADD CONSTRAINT "ConcertDelivery_pkey" PRIMARY KEY ("concert_id", "wishlist_id", "band_id");

-- AddForeignKey
ALTER TABLE "ConcertDelivery" ADD CONSTRAINT "ConcertDelivery_band_id_fkey" FOREIGN KEY ("band_id") REFERENCES "Band"("id") ON DELETE CASCADE ON UPDATE CASCADE;
