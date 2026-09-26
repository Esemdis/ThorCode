/**
 * Finding and listing bands.
 *
 * Split out of routes/data/bands.js, which had grown to 1571 lines and
 * twenty-six endpoints. bands.js now mounts this and its siblings in the
 * order they were declared in, so the routing surface is unchanged — see
 * the manifest test in bands.test.js.
 */
const express = require('express');
const router = express.Router();
const { shapeBandOverview } = require('../../../utils/bandOverview');
const { searchArtists, getArtists } = require('../../../utils/spotify');
const { resolveArtistImages } = require('../../../utils/bandImages');
const prisma = require('../../../prisma/client');
const { setCache, getCache } = require('../../../utils/cache');

// Bound to the module's cache and Spotify client once, so no route has to
// remember which three functions resolveArtistImages needs.
const bandImageDeps = { getCache, setCache, getArtists };

// Search bands by name for autocomplete
router.get('/bands/search', async (req, res) => {
  try {
    const { q } = req.query;

    // A repeated ?q= arrives as an array, and .trim() on it was a 500.
    if (typeof q !== 'string' || q.trim().length < 2) {
      return res.json([]);
    }

    const searchTerm = q.trim();
    // Clamped: "abc" became take: NaN (a 500) and a large number returned the
    // whole table to an unauthenticated caller.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);

    const bands = await prisma.band.findMany({
      where: {
        name: {
          contains: searchTerm,
          mode: 'insensitive',
        },
      },
      select: {
        id: true,
        name: true,
      },
      orderBy: [
        {
          name: 'asc',
        },
      ],
      take: limit,
    });

    // Sort results to prioritize matches that start with the search term
    const sortedBands = bands.sort((a, b) => {
      const aStartsWith = a.name
        .toLowerCase()
        .startsWith(searchTerm.toLowerCase());
      const bStartsWith = b.name
        .toLowerCase()
        .startsWith(searchTerm.toLowerCase());

      if (aStartsWith && !bStartsWith) return -1;
      if (!aStartsWith && bStartsWith) return 1;
      return a.name.localeCompare(b.name);
    });

    res.json(sortedBands);
  } catch (error) {
    console.error('Error searching bands:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List all bands with concert counts (number of ConcertBandReferences)
router.get('/upcoming/bands', async (req, res) => {
  try {
    const now = new Date();

    // DISTINCT ON picks one row per band: the earliest concert still to come,
    // and the latest that has already happened. This replaced one findFirst per
    // band inside a Promise.all — 114 queries for the current band list, and it
    // would have been 228 once the last-seen column was added, 342 with touring.
    const [bands, nextRows, lastRows, countryRows, perCityRows] = await Promise.all([
      prisma.band.findMany({
        select: {
          id: true,
          name: true,
          songkick_url: true,
          bandsintown_url: true,
          spotify_id: true,
          _count: { select: { concerts: { where: { concert_rel: { concert_date: { gte: now } } } } } },
        },
        orderBy: { name: 'asc' },
      }),
      prisma.$queryRaw`
        SELECT DISTINCT ON (r.band) r.band AS band_id, c.concert_date, c.country, c.sold_out
        FROM "ConcertBandReference" r
        JOIN "Concert" c ON c.id = r.concert
        WHERE c.concert_date >= ${now}
        ORDER BY r.band, c.concert_date ASC`,
      prisma.$queryRaw`
        SELECT DISTINCT ON (r.band) r.band AS band_id, c.concert_date, c.country
        FROM "ConcertBandReference" r
        JOIN "Concert" c ON c.id = r.concert
        WHERE c.concert_date < ${now}
        ORDER BY r.band, c.concert_date DESC`,
      // Every country a band is playing next, not just the one its soonest
      // concert is in — a band touring DE, NL and BE used to read as German.
      // Ordered by country so the flags do not reshuffle between requests.
      prisma.$queryRaw`
        SELECT r.band AS band_id, array_agg(DISTINCT c.country ORDER BY c.country) AS countries
        FROM "ConcertBandReference" r
        JOIN "Concert" c ON c.id = r.concert
        WHERE c.concert_date >= ${now} AND c.country IS NOT NULL
        GROUP BY r.band`,
      // The soonest show in every city, not just the soonest show overall. The
      // overview leads with the one nearest you, and "nearest" depends on your
      // home city and where you have been — both client-side state. Sending
      // your position up instead would make this per-user and kill the
      // cacheability, for a payload that stays a few thousand small rows.
      prisma.$queryRaw`
        SELECT DISTINCT ON (r.band, c.country, c.city)
               r.band AS band_id, c.id AS concert_id, c.concert_date, c.sold_out,
               c.country, c.city,
               city.latitude AS city_lat, city.longitude AS city_lng,
               c.latitude AS raw_lat, c.longitude AS raw_lng
        FROM "ConcertBandReference" r
        JOIN "Concert" c ON c.id = r.concert
        LEFT JOIN "City" city ON city.id = c.city_id
        WHERE c.concert_date >= ${now}
        ORDER BY r.band, c.country, c.city, c.concert_date ASC`,
    ]);

    // Cache-only, and deliberately so: this route lists every band there is, and
    // fetching the misses here is one Spotify request per band on the request
    // path — 120 of them, ten seconds, past the client's timeout, and enough
    // volume to trip Spotify's rate limit outright. The cron warms the cache;
    // anything not warm yet renders as a monogram until it is.
    const images = await resolveArtistImages(bands.map((b) => b.spotify_id), bandImageDeps, { cacheOnly: true });

    res.json(shapeBandOverview(bands, nextRows, lastRows, countryRows, perCityRows, images));
  } catch (error) {
    console.error('Error fetching bands:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/bands', async (req, res) => {
  try {
    const bands = await prisma.band.findMany({
      // No ticketmaster_id: the scraper polls Ticketmaster only for bands it
      // receives one for, and that source is no longer used.
      select: { id: true, name: true, MBID: true, songkick_url: true, bandsintown_url: true },
      orderBy: { created_at: 'asc' },
    });
    res.json(bands);
  } catch (error) {
    console.error('Error fetching bands:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
