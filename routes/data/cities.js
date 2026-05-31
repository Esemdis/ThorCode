const express = require('express');
const router = express.Router();
const prisma = require('../../prisma/client');
const auth = require('../../auth/verifyJWT');
const roleCheck = require('../../middlewares/roleCheck');

// GET /data/cities — list all cities with concert count
router.get('/', auth, async (req, res, next) => {
  try {
    const cities = await prisma.city.findMany({
      orderBy: [{ country: 'asc' }, { name: 'asc' }],
      include: {
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
router.patch('/weather/bulk', auth, roleCheck(['SYSTEM']), async (req, res, next) => {
  try {
    const updates = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'Body must be a non-empty array' });
    }

    let updated = 0;
    for (const item of updates) {
      if (!item.id) continue;
      await prisma.city.update({
        where: { id: item.id },
        data: {
          weather_monthly:    item.weather_monthly    ?? undefined,
          weather_updated_at: item.weather_updated_at ? new Date(item.weather_updated_at) : undefined,
        },
      });
      updated++;
    }

    res.json({ updated });
  } catch (err) {
    next(err);
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
    next(err);
  }
});

module.exports = router;
