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
const { pythonServicePost, pythonServiceFailure } = require('../../../utils/pythonService');
const { error: sendError } = require('../../../utils/apiResponse');
const { matchBandToSpotify, backfillSpotifyIds, warmBandImages } = require('../../../utils/bandSpotifyMatch');
const auth = require('../../../auth/verifyJWT');
const roleCheck = require('../../../middlewares/roleCheck');
const prisma = require('../../../prisma/client');
const { Prisma } = require('@prisma/client');
const { detachAttendances } = require('../../../utils/mediaDetach');

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

/**
 * Put photos on the artist overview now, rather than waiting for the cron.
 *
 * The same two steps the nightly job runs, in the same order and for the same
 * reason: a band with no `spotify_id` can never resolve a photo, so matching
 * has to happen before warming or the bands you actually notice missing are
 * the ones warming skips.
 *
 * Warming is the step that matters. The overview reads the image cache and
 * never fetches — see resolveArtistImages' `cacheOnly` — so before this
 * existed a cold cache meant monograms until the nightly job came round, with
 * no way to hurry it.
 *
 * Photos cannot be synced once and left. Spotify's terms cap image caching at
 * 24 hours and the CDN urls rotate, so this refreshes entries that are about to
 * expire; it does not make them permanent.
 *
 * Matching is capped per run and resumable, so hitting the cap just means
 * running it again. Warming always covers every matched band.
 */
router.post('/bands/sync-photos', auth, roleCheck(['ADMIN']), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const { searched, matched, remaining } = await backfillSpotifyIds({ limit });
    const { bands, withPhoto } = await warmBandImages();
    res.json({ status: 'success', searched, matched, remaining, bands, withPhoto });
  } catch (error) {
    console.error('Error syncing artist photos:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/bands/sync-all', auth, roleCheck(['ADMIN']), async (_req, res) => {
  try {
    const syncResponse = await pythonServicePost(`/trigger`);
    res.status(200).json({ status: 'success', ...syncResponse.data });
  } catch (err) {
    console.error('Error triggering full sync:', err.message);
    const { status, message } = pythonServiceFailure(err);
    sendError(res, status, message);
  }
});

// POST /sync-weather — proxy to Python weather sync (ADMIN only)
router.post('/sync-weather', auth, roleCheck(['ADMIN']), async (_req, res) => {
  try {
    await pythonServicePost(`/sync-weather`, {}, { timeout: 300000 });
    res.status(200).json({ status: 'success' });
  } catch (err) {
    console.error('Error triggering weather sync:', err.message);
    const { status, message } = pythonServiceFailure(err);
    sendError(res, status, message);
  }
});

// POST /bands/sync-setlists — proxy to Python setlist sync (ADMIN only)
router.post('/bands/sync-setlists', auth, roleCheck(['ADMIN']), async (_req, res) => {
  try {
    await pythonServicePost(`/sync-setlists`, {}, { timeout: 300000 });
    res.status(200).json({ status: 'success' });
  } catch (err) {
    console.error('Error triggering setlist sync:', err.message);
    const { status, message } = pythonServiceFailure(err);
    sendError(res, status, message);
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

  // Detach and delete now share one interactive transaction rather than
  // running detach ahead of an array-form $transaction. The array form has no
  // tx to detach through, but doing the detach on the global client first was
  // worse than doing nothing: if the deleteMany/delete batch then failed, the
  // show folders were already moved and the ConcertMedia rows already
  // committed-deleted, while the concert and its attendances survived the
  // rollback — and the rebuild script deliberately skips _detached, so nothing
  // would have noticed or repaired it. Detaching inside the transaction means
  // a failed delete rolls the row deletion back too; only the folder rename
  // (which cannot be transactional) stays done, which is the recoverable
  // direction — files misplaced, rows intact.
  //
  // 30s, not the 5s default: the work inside includes a folder rename per
  // attendee's worth of media on an SMB-mounted share.
  await prisma.$transaction(async (tx) => {
    const doomed = await tx.concertAttendance.findMany({
      where: { concert_id: concertId },
      select: { id: true },
    });
    await detachAttendances(tx, doomed.map((a) => a.id));
    await tx.concertBandReference.deleteMany({ where: { concert: concertId } });
    await tx.concertAttendance.deleteMany({ where: { concert_id: concertId } });
    await tx.concert.delete({ where: { id: concertId } });
  }, { timeout: 30000 });

  res.json({ deleted: concertId });
});

module.exports = router;
