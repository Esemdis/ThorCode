-- Venues as their own rows (THO-346). Concert.venue stays the text the source
-- sent; Concert.venue_id points at the one Venue row every spelling of that
-- building in that city shares.
--
-- Spellings fold here only when they are the same words: case, whitespace and
-- accents aside ("Tavastia" / "TAVASTIA " / "Tavastía"). Anything looser
-- ("The O2" / "O2 Arena", two names at one spot) is scripts/merge-venues.js,
-- a dry run you read before applying.

-- The folding rule, used by this backfill and by ingest (utils/venueMatch.js),
-- so a spelling folds the same way in both. Accents off (NFD, then the
-- combining marks), whitespace squeezed, lower case.
CREATE FUNCTION venue_key(name text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT lower(btrim(regexp_replace(
    regexp_replace(normalize(name, NFD), '[̀-ͯ]', '', 'g'),
    '\s+', ' ', 'g')))
$$;

-- AlterTable
ALTER TABLE "Concert" ADD COLUMN     "venue_id" INTEGER;

-- CreateTable
CREATE TABLE "Venue" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "city_id" INTEGER NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Venue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Venue_city_id_name_key_key" ON "Venue"("city_id", "name_key");

-- CreateIndex
CREATE INDEX "Concert_venue_id_idx" ON "Concert"("venue_id");

-- AddForeignKey
ALTER TABLE "Concert" ADD CONSTRAINT "Concert_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venue" ADD CONSTRAINT "Venue_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Backfill. Every concert with a venue and a city: its own city_id, or for an
-- older row without one, the City of that exact name and country. A concert
-- with neither stays unlinked.
CREATE TEMP TABLE venue_backfill AS
SELECT c.id,
       btrim(c.venue) AS name,
       venue_key(c.venue) AS key,
       COALESCE(c.city_id, city.id) AS city_id,
       -- setlist.fm sends the city's position, not the building's.
       CASE WHEN c.source IS DISTINCT FROM 'setlistfm'
             AND btrim(c.latitude) ~ '^-?[0-9]+(\.[0-9]+)?$'
             AND btrim(c.longitude) ~ '^-?[0-9]+(\.[0-9]+)?$'
            THEN btrim(c.latitude)::double precision END AS lat,
       CASE WHEN c.source IS DISTINCT FROM 'setlistfm'
             AND btrim(c.latitude) ~ '^-?[0-9]+(\.[0-9]+)?$'
             AND btrim(c.longitude) ~ '^-?[0-9]+(\.[0-9]+)?$'
            THEN btrim(c.longitude)::double precision END AS lng
FROM "Concert" c
LEFT JOIN "City" city ON c.city_id IS NULL AND city.name = c.city AND city.country = c.country
WHERE venue_key(c.venue) <> '';

DELETE FROM venue_backfill WHERE city_id IS NULL;

-- Named after the spelling most of its concerts use, the earliest on a tie.
INSERT INTO "Venue" (name, name_key, city_id)
SELECT DISTINCT ON (city_id, key) name, key, city_id
FROM (
  SELECT city_id, key, name, count(*) AS n, min(id) AS first
  FROM venue_backfill GROUP BY city_id, key, name
) spellings
ORDER BY city_id, key, n DESC, first;

-- Placed where most of its concerts were placed, the latest on a tie.
UPDATE "Venue" v SET latitude = p.lat, longitude = p.lng
FROM (
  SELECT DISTINCT ON (city_id, key) city_id, key, lat, lng
  FROM (
    SELECT city_id, key, lat, lng, count(*) AS n, max(id) AS last
    FROM venue_backfill WHERE lat IS NOT NULL GROUP BY city_id, key, lat, lng
  ) points
  ORDER BY city_id, key, n DESC, last DESC
) p
WHERE v.city_id = p.city_id AND v.name_key = p.key;

UPDATE "Concert" c SET venue_id = v.id
FROM venue_backfill b
JOIN "Venue" v ON v.city_id = b.city_id AND v.name_key = b.key
WHERE c.id = b.id;

DROP TABLE venue_backfill;
