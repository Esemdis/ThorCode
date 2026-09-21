-- AlterTable: a third watch shape, matched against the event's own name rather
-- than a band row. Festivals are announced before their lineup exists, so there
-- is nothing to point a band watch at; venue_query narrows a recurring name
-- because most festivals return to a venue nobody else uses.
--
-- Both nullable and unconstrained at the database level, the way band_id and
-- city_id already are: the POST route is what keeps the shapes apart, and
-- utils/notificationMatch.js fails closed on a row that satisfies neither.
ALTER TABLE "NotificationSubscription" ADD COLUMN "tour_query" TEXT;
ALTER TABLE "NotificationSubscription" ADD COLUMN "venue_query" TEXT;
