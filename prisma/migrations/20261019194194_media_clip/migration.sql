-- CreateTable
CREATE TABLE "MediaClip" (
    "id" SERIAL NOT NULL,
    "media_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,

    CONSTRAINT "MediaClip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MediaClip_media_id_idx" ON "MediaClip"("media_id");

-- AddForeignKey
ALTER TABLE "MediaClip" ADD CONSTRAINT "MediaClip_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "ConcertMedia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

