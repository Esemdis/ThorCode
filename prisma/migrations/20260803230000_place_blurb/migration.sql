-- A short description of a place from Wikipedia, cached.
--
-- blurb_checked_at records that we looked rather than that we found something.
-- Most places have no article and never will, and without a "looked and found
-- nothing" marker every refresh would ask Wikipedia about the same
-- neighbourhood restaurant again.
ALTER TABLE "TripPlace"
  ADD COLUMN "blurb"            TEXT,
  ADD COLUMN "blurb_url"        VARCHAR(500),
  ADD COLUMN "blurb_checked_at" TIMESTAMP(3);
