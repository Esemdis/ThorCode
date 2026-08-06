-- CreateTable: per-user watch for new concerts (by band, by city, or a band+city combo)
CREATE TABLE "NotificationSubscription" (
    "id" SERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "band_id" INTEGER,
    "city_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationSubscription_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NotificationSubscription_band_id_idx" ON "NotificationSubscription"("band_id");
CREATE INDEX "NotificationSubscription_city_id_idx" ON "NotificationSubscription"("city_id");

ALTER TABLE "NotificationSubscription" ADD CONSTRAINT "NotificationSubscription_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationSubscription" ADD CONSTRAINT "NotificationSubscription_band_id_fkey"
    FOREIGN KEY ("band_id") REFERENCES "Band"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationSubscription" ADD CONSTRAINT "NotificationSubscription_city_id_fkey"
    FOREIGN KEY ("city_id") REFERENCES "City"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: single-row cursor tracking the last time the notification digest cron ran
CREATE TABLE "NotificationDigestRun" (
    "id" SERIAL NOT NULL,
    "last_run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDigestRun_pkey" PRIMARY KEY ("id")
);
