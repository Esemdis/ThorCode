const express = require('express');
const router = express.Router();
const prisma = require('../../prisma/client');
const auth = require('../../auth/verifyJWT');
const roleCheck = require('../../middlewares/roleCheck');
const { RECORD_NOT_FOUND } = require('../../utils/apiResponse');

// Its own copy rather than bands.js's: a router importing another router's
// internals would tie two unrelated files together over three lines.
const CITY_WEATHER_BULK_CHUNK = 25;
const cityWeatherChunks = (list, size) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

// GET /data/cities — list all cities with concert count
//
// Named columns, not an include (THO-967). An include sent every column, and
// weather_monthly is a year of averages per city that the app downloaded on
// every load and never drew. What is left is what someone reads:
// python-crohn's sync_city_weather picks stale cities by latitude, longitude
// and weather_updated_at, and concert-map's CityAdminList edits airport_iata
// and reachable and shows the concert count.
router.get('/', auth, async (req, res, next) => {
  try {
    const cities = await prisma.city.findMany({
      orderBy: [{ country: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        country: true,
        latitude: true,
        longitude: true,
        reachable: true,
        airport_iata: true,
        weather_updated_at: true,
        _count: { select: { concerts: true } },
      },
    });
    res.json(cities);
  } catch (err) {
    next(err);
  }
});

// PATCH /data/cities/weather/bulk — update weather_monthly for multiple cities
// Body: [{id, weather_monthly, weather_updated_at}]
router.patch('/weather/bulk', auth, roleCheck(['SYSTEM']), async (req, res) => {
  if (!Array.isArray(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'Body must be a non-empty array' });
  }
  // A string id reached Prisma and failed the request partway through.
  if (!req.body.every((item) => item && (item.id == null || Number.isInteger(item.id)))) {
    return res.status(400).json({ error: 'Every entry needs an integer id' });
  }

  // In chunks, each its own transaction of updateMany — the shape the concert
  // and trip weather bulks already have (THO-967). One update per city in
  // turn threw P2025 on a city merged away since the sync read the list, and
  // the request answered 500 after every city before it had been written, so
  // the sync could not tell what had landed. updateMany counts a missing row
  // as nothing, and `updated` is what was really written.
  const updates = req.body.filter((item) => item.id);
  let updated = 0;
  try {
    for (const chunk of cityWeatherChunks(updates, CITY_WEATHER_BULK_CHUNK)) {
      const results = await prisma.$transaction(chunk.map((item) => prisma.city.updateMany({
        where: { id: item.id },
        data: {
          weather_monthly:    item.weather_monthly    ?? undefined,
          weather_updated_at: item.weather_updated_at ? new Date(item.weather_updated_at) : undefined,
        },
      })));
      updated += results.reduce((sum, r) => sum + (r?.count ?? 0), 0);
    }
    res.json({ updated });
  } catch (error) {
    console.error(`Error storing city weather after ${updated}/${updates.length}:`, error);
    return res.status(500).json({ error: 'Internal server error', updated });
  }
});

// PATCH /data/cities/:id — manually update a city (airport_iata, reachable, etc.)
router.patch('/:id', auth, roleCheck(['ADMIN', 'SYSTEM']), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid city id' });

    const { airport_iata, reachable } = req.body;

    const city = await prisma.city.update({
      where: { id },
      data: {
        ...(airport_iata !== undefined && { airport_iata }),
        ...(reachable    !== undefined && { reachable    }),
      },
    });

    res.json(city);
  } catch (err) {
    // No such city: the update's "record not found", which reached the
    // global handler without a status and went out as a 500.
    if (err.code === RECORD_NOT_FOUND) return res.status(404).json({ error: 'City not found' });
    next(err);
  }
});

module.exports = router;
