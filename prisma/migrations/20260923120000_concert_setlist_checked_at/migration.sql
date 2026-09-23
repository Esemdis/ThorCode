-- Records when the setlist backfill last looked this concert up. Null means
-- never. The backfill takes least-recently-checked first, so a show setlist.fm
-- will never have a setlist for (a support act nobody logged) goes to the back
-- of the queue instead of holding one of its fifty daily slots forever.
ALTER TABLE "Concert" ADD COLUMN "setlist_checked_at" TIMESTAMP(3);
