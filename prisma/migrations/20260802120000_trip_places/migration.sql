-- CreateEnum
CREATE TYPE "PlaceKind" AS ENUM ('SIGHT', 'FOOD', 'HOTEL');

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "plan_data" JSONB,
ADD COLUMN     "plan_updated_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TripPlace" (
    "id" SERIAL NOT NULL,
    "trip_id" INTEGER NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "kind" "PlaceKind" NOT NULL DEFAULT 'SIGHT',
    "lat" DOUBLE PRECISION,
    "lon" DOUBLE PRECISION,
    "address" VARCHAR(500),
    "url" VARCHAR(1000),
    "duration" INTEGER,
    "priority" INTEGER NOT NULL DEFAULT 3,
    "outdoor" BOOLEAN NOT NULL DEFAULT false,
    "hours" JSONB,
    "pinned_day" DATE,
    "note" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TripPlace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TripPlace_trip_id_idx" ON "TripPlace"("trip_id");

-- AddForeignKey
ALTER TABLE "TripPlace" ADD CONSTRAINT "TripPlace_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
