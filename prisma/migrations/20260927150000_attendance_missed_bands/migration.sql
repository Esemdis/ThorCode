-- Acts on the bill of an attended show that you did not actually see. Attending
-- still counts the whole bill as seen; a row here is the exception. Additive:
-- no row means every act was seen, which is what every existing attendance
-- already said.

-- CreateTable
CREATE TABLE "AttendanceMissedBand" (
    "attendance_id" INTEGER NOT NULL,
    "band_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceMissedBand_pkey" PRIMARY KEY ("attendance_id","band_id")
);

-- CreateIndex
CREATE INDEX "AttendanceMissedBand_band_id_idx" ON "AttendanceMissedBand"("band_id");

-- AddForeignKey
ALTER TABLE "AttendanceMissedBand" ADD CONSTRAINT "AttendanceMissedBand_attendance_id_fkey" FOREIGN KEY ("attendance_id") REFERENCES "ConcertAttendance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceMissedBand" ADD CONSTRAINT "AttendanceMissedBand_band_id_fkey" FOREIGN KEY ("band_id") REFERENCES "Band"("id") ON DELETE CASCADE ON UPDATE CASCADE;

