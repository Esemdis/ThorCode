-- When you land and when you fly out, as minutes since midnight on the first
-- and last day of the trip, plus optionally where those days begin and end.
--
-- The place columns are plain integers rather than foreign keys to TripPlace on
-- purpose: a real FK would have to be nulled by hand whenever a place is
-- deleted, and a stale id is already handled — the planner refuses to plan
-- against a terminal it cannot find in the places it was given, which is a
-- better failure than silently starting the day at the hotel instead.
ALTER TABLE "Trip"
  ADD COLUMN "arrival_time"       INTEGER,
  ADD COLUMN "departure_time"     INTEGER,
  ADD COLUMN "arrival_place_id"   INTEGER,
  ADD COLUMN "departure_place_id" INTEGER,
  ADD COLUMN "transfer_minutes"   INTEGER;
