-- The bill a follower was last told about, so an act joining a show they
-- follow is news and the acts already on it are not (see ConcertFollow).
--
-- Null on every existing row, which is the "never recorded" case the alert
-- pass reads as "say nothing, remember this bill": nobody is told about a
-- lineup that was already there when this shipped.

-- AlterTable
ALTER TABLE "ConcertFollow" ADD COLUMN "lineup_told" TEXT;
