-- Following a show for its tickets: going on sale, selling out, coming back
-- (see ConcertFollow). Nothing exists to backfill.

-- CreateTable
CREATE TABLE "ConcertFollow" (
    "user_id" TEXT NOT NULL,
    "concert_id" INTEGER NOT NULL,
    "told_state" TEXT NOT NULL,
    "reminded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConcertFollow_pkey" PRIMARY KEY ("user_id","concert_id")
);

-- CreateIndex
CREATE INDEX "ConcertFollow_concert_id_idx" ON "ConcertFollow"("concert_id");

-- AddForeignKey
ALTER TABLE "ConcertFollow" ADD CONSTRAINT "ConcertFollow_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConcertFollow" ADD CONSTRAINT "ConcertFollow_concert_id_fkey" FOREIGN KEY ("concert_id") REFERENCES "Concert"("id") ON DELETE CASCADE ON UPDATE CASCADE;
