-- CreateTable
CREATE TABLE "MediaAlbumShareLink" (
    "id" SERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "attendance_ids" INTEGER[],
    "token" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "MediaAlbumShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaAlbumShareLink_token_key" ON "MediaAlbumShareLink"("token");

-- CreateIndex
CREATE INDEX "MediaAlbumShareLink_user_id_idx" ON "MediaAlbumShareLink"("user_id");

-- CreateIndex
CREATE INDEX "MediaAlbumShareLink_expires_at_idx" ON "MediaAlbumShareLink"("expires_at");

-- AddForeignKey
ALTER TABLE "MediaAlbumShareLink" ADD CONSTRAINT "MediaAlbumShareLink_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

