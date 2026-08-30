-- Records that a Songkick/Bandsintown lookup ran. Null means "never checked";
-- a timestamp with one or both urls still null means MusicBrainz had nothing
-- for this band as of that check. Unlike spotify_checked_at this is not a
-- permanent skip: the cron backfill re-queues a band once this ages past its
-- staleDays window, since MusicBrainz relationships are added by volunteers
-- over time.
ALTER TABLE "Band" ADD COLUMN "source_urls_checked_at" TIMESTAMP(3);
