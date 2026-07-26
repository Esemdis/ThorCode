-- CreateTable
CREATE TABLE "TripTodo" (
    "id" SERIAL NOT NULL,
    "trip_id" INTEGER NOT NULL,
    "text" VARCHAR(300) NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TripTodo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TripTodo_trip_id_idx" ON "TripTodo"("trip_id");

-- AddForeignKey
ALTER TABLE "TripTodo" ADD CONSTRAINT "TripTodo_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
