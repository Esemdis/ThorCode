-- Per-recipient delivery of new-show announcements (see ConcertDelivery).
-- notify_pending used to be cleared for every show in a request, even when a
-- recipient's Discord post had failed, so that recipient was never sent it
-- again. A failed post now keeps the show pending, and these rows let the
-- retry skip the recipients whose post went through.
--
-- announced_at is when the activity feeds were told, so a retry does not add
-- a second BAND_ADDED entry to them. Null on existing rows: nothing announces
-- those again.

-- AlterTable
ALTER TABLE "Concert" ADD COLUMN     "announced_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ConcertDelivery" (
    "concert_id" INTEGER NOT NULL,
    "wishlist_id" INTEGER NOT NULL,
    "delivered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConcertDelivery_pkey" PRIMARY KEY ("concert_id","wishlist_id")
);

-- CreateIndex
CREATE INDEX "ConcertDelivery_wishlist_id_idx" ON "ConcertDelivery"("wishlist_id");

-- AddForeignKey
ALTER TABLE "ConcertDelivery" ADD CONSTRAINT "ConcertDelivery_concert_id_fkey" FOREIGN KEY ("concert_id") REFERENCES "Concert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConcertDelivery" ADD CONSTRAINT "ConcertDelivery_wishlist_id_fkey" FOREIGN KEY ("wishlist_id") REFERENCES "Wishlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
