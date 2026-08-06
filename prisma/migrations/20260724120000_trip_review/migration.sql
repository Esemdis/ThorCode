-- CreateTable
CREATE TABLE "TripReview" (
    "id" SERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "trip_id" INTEGER NOT NULL,
    "culture_rating" INTEGER,
    "culture_note" TEXT,
    "food_rating" INTEGER,
    "food_note" TEXT,
    "fun_rating" INTEGER,
    "fun_note" TEXT,
    "missing_gear_item_ids" INTEGER[],
    "missing_note" TEXT,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TripReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TripReview_trip_id_key" ON "TripReview"("trip_id");

-- AddForeignKey
ALTER TABLE "TripReview" ADD CONSTRAINT "TripReview_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripReview" ADD CONSTRAINT "TripReview_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
