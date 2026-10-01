-- A show still owed its new-concert notification (see Concert.notify_pending).
-- Every existing row starts false: whatever was going to be announced about
-- them has been, and setting it on old rows would announce them all again.
-- A NOT NULL column with a constant default is a catalog change on Postgres 11
-- and later, so the table is not rewritten.
ALTER TABLE "Concert" ADD COLUMN "notify_pending" BOOLEAN NOT NULL DEFAULT false;
