CREATE TYPE "MediaKind" AS ENUM ('PHOTO', 'VIDEO');

CREATE TABLE "ConcertMedia" (
    "id"            SERIAL       NOT NULL,
    "attendance_id" INTEGER      NOT NULL,
    "band_id"       INTEGER,
    "rel_path"      TEXT         NOT NULL,
    "filename"      TEXT         NOT NULL,
    "kind"          "MediaKind"  NOT NULL,
    "bytes"         INTEGER      NOT NULL,
    "sha256"        TEXT         NOT NULL,
    "width"         INTEGER,
    "height"        INTEGER,
    "duration_ms"   INTEGER,
    "caption"       TEXT,
    "taken_at"      TIMESTAMP(3),
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConcertMedia_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConcertMedia_attendance_id_filename_key" ON "ConcertMedia"("attendance_id", "filename");
CREATE INDEX "ConcertMedia_band_id_idx" ON "ConcertMedia"("band_id");
CREATE INDEX "ConcertMedia_attendance_id_idx" ON "ConcertMedia"("attendance_id");

-- RESTRICT, not CASCADE. This constraint is the last thing standing between an
-- orphan-cleanup query and the only copy of someone's photographs.
ALTER TABLE "ConcertMedia"
  ADD CONSTRAINT "ConcertMedia_attendance_id_fkey"
  FOREIGN KEY ("attendance_id") REFERENCES "ConcertAttendance"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ConcertMedia"
  ADD CONSTRAINT "ConcertMedia_band_id_fkey"
  FOREIGN KEY ("band_id") REFERENCES "Band"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
