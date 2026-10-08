-- The followed-show checker: python-crohn reads a followed show's own listing
-- every half hour, and every five minutes on the morning its sale opens,
-- rather than leaving it to the full sync three times a day. What it reads
-- beyond the ticket flags already here — who sells it, whether the show is
-- still going ahead, when the sale really opened — and when it last looked.
--
-- Every existing follow gets null for status_told, date_told and venue_told,
-- the "never recorded" case the alert pass reads as "say nothing, remember
-- this": nobody is told a show moved because this shipped.

-- AlterTable
ALTER TABLE "Concert" ADD COLUMN     "event_status" TEXT,
ADD COLUMN     "ticket_check_attempted_at" TIMESTAMP(3),
ADD COLUMN     "ticket_check_error" TEXT,
ADD COLUMN     "ticket_check_failures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ticket_check_requested_at" TIMESTAMP(3),
ADD COLUMN     "ticket_vendors" JSONB,
ADD COLUMN     "tickets_checked_at" TIMESTAMP(3),
ADD COLUMN     "tickets_opened_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ConcertFollow" ADD COLUMN     "date_told" TIMESTAMP(3),
ADD COLUMN     "status_told" TEXT,
ADD COLUMN     "venue_told" TEXT;
