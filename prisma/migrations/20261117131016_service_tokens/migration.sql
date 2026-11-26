-- CreateTable
CREATE TABLE "ServiceToken" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "scope" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "withdrawn_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceToken_user_id_idx" ON "ServiceToken"("user_id");

-- AddForeignKey
ALTER TABLE "ServiceToken" ADD CONSTRAINT "ServiceToken_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

