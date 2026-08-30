/**
 * Jobs the cron and the admin screen kick off.
 *
 * Split out of routes/data/bands.js, which had grown to 1571 lines and
 * twenty-six endpoints. bands.js now mounts this and its siblings in the
 * order they were declared in, so the routing surface is unchanged — see
 * the manifest test in bands.test.js.
 */
const express = require('express');
const router = express.Router();
const { validationResult, body } = require('express-validator');
const { pythonServicePost } = require('../../../utils/pythonService');
const { matchBandToSpotify, backfillSpotifyIds } = require('../../../utils/bandSpotifyMatch');
const auth = require('../../../auth/verifyJWT');
const roleCheck = require('../../../middlewares/roleCheck');
const prisma = require('../../../prisma/client');
const { Prisma } = require('@prisma/client');

/**
 * Match unsearched bands to Spotify artists, so the overview has photos before
 * anyone has opened each band individually.
 *
 * The manual door to the same backfill the daily cron runs; useful after
 * clearing `spotify_checked_at` on a band that was matched wrongly. Capped per
 * run, and resumable — hitting the cap just means running it again.
 */
router.post('/bands/sync-spotify-ids', auth, roleCheck(['ADMIN']), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    res.json({ status: 'success', ...(await backfillSpotifyIds({ limit })) });
  } catch (error) {
    console.error('Error backfilling Spotify artist ids:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/bands/sync-all', auth, roleCheck(['ADMIN']), async (_req, res) => {
  try {
    const syncResponse = await pythonServicePost(`/trigger`);
    res.status(200).json({ status: 'success', ...syncResponse.data });
  } catch (error) {
    console.error('Error triggering full sync:', error.message);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// POST /sync-weather — proxy to Python weather sync (ADMIN only)
router.post('/sync-weather', auth, roleCheck(['ADMIN']), async (_req, res) => {
  try {
    await pythonServicePost(`/sync-weather`, {}, { timeout: 300000 });
    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Error triggering weather sync:', error.message);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// POST /bands/sync-setlists — proxy to Python setlist sync (ADMIN only)
router.post('/bands/sync-setlists', auth, roleCheck(['ADMIN']), async (_req, res) => {
  try {
    await pythonServicePost(`/sync-setlists`, {}, { timeout: 300000 });
    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Error triggering setlist sync:', error.message);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// GET /bandsintown/enrich-pending — future BIT concerts with numeric event IDs that can be enriched
router.get('/bandsintown/enrich-pending', auth, roleCheck(['ADMIN', 'SYSTEM']), async (_req, res) => {
  try {
    const concerts = await prisma.concert.findMany({
      where: {
        source: 'bandsintown',
        concert_date: { gte: new Date() },
        event_id: { startsWith: 'bit_' },
      },
      select: { id: true, event_id: true },
    });
    // Only numeric IDs — hashed JSON-LD IDs can't be used to reconstruct the event URL
    const pending = concerts.filter((c) => /^bit_\d+$/.test(c.event_id));
    res.json(pending);
  } catch (error) {
    console.error('[enrich-pending] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /weather-pending — future concerts with coordinates but no weather data yet (SYSTEM only)
router.get('/weather-pending', auth, roleCheck(['SYSTEM']), async (_req, res) => {
  try {
    const in16Days = new Date(Date.now() + 16 * 24 * 60 * 60 * 1000);
    const concerts = await prisma.concert.findMany({
      where: {
        concert_date: { gte: new Date() },
        latitude: { not: null },
        longitude: { not: null },
        OR: [
          { weather: { equals: Prisma.DbNull } },
          { concert_date: { lte: in16Days } },
        ],
      },
      select: { id: true, latitude: true, longitude: true, concert_date: true },
    });
    res.json(concerts);
  } catch (error) {
    console.error('[weather-pending] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /bands/setlist-pending — bands with no setlist or stale setlist (> 3 days)
// ?force=true returns all bands regardless of when they were last updated (SYSTEM only)
router.get('/bands/setlist-pending', auth, roleCheck(['SYSTEM']), async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const where = force ? {} : {
      OR: [
        { setlist: { equals: Prisma.DbNull } },
        { setlist_updated_at: { lt: threeDaysAgo } },
      ],
    };
    const bands = await prisma.band.findMany({
      where,
      select: { id: true, name: true, MBID: true },
    });
    res.json(bands);
  } catch (error) {
    console.error('[setlist-pending] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /bands/setlists/bulk — store fetched setlists for multiple bands (SYSTEM only)
router.patch('/bands/setlists/bulk', auth, roleCheck(['SYSTEM']), async (req, res) => {
  try {
    const updates = req.body; // [{ id, setlist }]
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'Expected non-empty array of { id, setlist }' });
    }
    await Promise.all(
      updates.map(({ id, setlist }) =>
        prisma.band.update({
          where: { id },
          data: { setlist, setlist_updated_at: new Date() },
        })
      )
    );
    res.json({ ok: true, updated: updates.length });
  } catch (error) {
    console.error('[setlists/bulk] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /concerts/:concertId — hard-delete a single concert and all its band references
router.delete('/concerts/:concertId', auth, roleCheck(['ADMIN']), async (req, res) => {
  const concertId = parseInt(req.params.concertId, 10);
  if (Number.isNaN(concertId)) return res.status(400).json({ error: 'Invalid concert id' });

  const concert = await prisma.concert.findUnique({ where: { id: concertId } });
  if (!concert) return res.status(404).json({ error: 'Concert not found' });

  await prisma.$transaction([
    prisma.concertBandReference.deleteMany({ where: { concert: concertId } }),
    prisma.concertAttendance.deleteMany({ where: { concert_id: concertId } }),
    prisma.concert.delete({ where: { id: concertId } }),
  ]);

  res.json({ deleted: concertId });
});

module.exports = router;
