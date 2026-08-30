-- The Spotify artist id is stored; the photo url is not. Spotify's terms cap
-- image caching at 24 hours and their CDN urls rotate, so the url is resolved
-- from this id on demand and cached in Redis instead.
ALTER TABLE "Band" ADD COLUMN "spotify_id" TEXT;

-- Records that we looked. Null means "never searched"; a timestamp with a null
-- spotify_id means Spotify has no artist under that exact name, and stops the
-- search running again on every request.
ALTER TABLE "Band" ADD COLUMN "spotify_checked_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "Band_spotify_id_key" ON "Band"("spotify_id");
