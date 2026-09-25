-- CreateTable: a time-boxed public URL to one ConcertMedia row
CREATE TABLE "MediaShareLink" (
    "id" SERIAL NOT NULL,
    "media_id" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "MediaShareLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MediaShareLink_token_key" ON "MediaShareLink"("token");
CREATE INDEX "MediaShareLink_media_id_idx" ON "MediaShareLink"("media_id");
CREATE INDEX "MediaShareLink_expires_at_idx" ON "MediaShareLink"("expires_at");

ALTER TABLE "MediaShareLink" ADD CONSTRAINT "MediaShareLink_media_id_fkey"
    FOREIGN KEY ("media_id") REFERENCES "ConcertMedia"("id") ON DELETE CASCADE ON UPDATE CASCADE;
