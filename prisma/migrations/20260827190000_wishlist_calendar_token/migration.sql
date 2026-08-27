-- The secret in a subscribable calendar feed URL.
--
-- Nullable and minted lazily: most users never subscribe, and a column full of
-- unused credentials is a liability rather than a feature. Unique because the
-- token is how the feed route finds the wishlist — there is no session on that
-- request to identify it any other way.
--
-- calendar_token_at records when the current token was issued, so a user can
-- see how long a URL has been live before deciding to regenerate it.
ALTER TABLE "Wishlist"
  ADD COLUMN "calendar_token"    TEXT,
  ADD COLUMN "calendar_token_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "Wishlist_calendar_token_key" ON "Wishlist"("calendar_token");
