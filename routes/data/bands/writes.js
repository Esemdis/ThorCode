/**
 * Creating bands and pulling their concerts in.
 *
 * Split out of routes/data/bands.js, which had grown to 1571 lines and
 * twenty-six endpoints. bands.js now mounts this and its siblings in the
 * order they were declared in, so the routing surface is unchanged — see
 * the manifest test in bands.test.js.
 */
const express = require('express');
const router = express.Router();
const { validationResult, body } = require('express-validator');
const axios = require('axios');
const { pythonServicePost, pythonServiceFailure } = require('../../../utils/pythonService');
const { error: sendError } = require('../../../utils/apiResponse');
const { haversineKm, stringSimilarity, venueContains, deduplicateByCoords } = require('../../../utils/concertDedup');
const { findSourceUrls } = require('../../../utils/bandSourceUrls');
const auth = require('../../../auth/verifyJWT');
const roleCheck = require('../../../middlewares/roleCheck');
const { rateLimiter } = require('../../../utils/rateLimiter');
const prisma = require('../../../prisma/client');

// Defaults to 5 requests per 15 minutes per IP
const rateLimit = rateLimiter({
  message:
    'Too many requests to the Ticketmaster data route, please try again later.',
});

router.post(
  '/bands/:bandId/sync-concerts',
  rateLimit,
  auth,
  roleCheck(['ADMIN', 'SYSTEM']),
  async (req, res) => {
    const { bandId } = req.params;
    try {
      // Fetch the band from the database
      const band = await prisma.band.findUnique({
        where: { id: parseInt(bandId) },
        select: { id: true, name: true, songkick_url: true, bandsintown_url: true },
      });

      if (!band) {
        return res.status(404).json({ error: 'Band not found' });
      }

      if (!band.songkick_url && !band.bandsintown_url) {
        return res.status(400).json({ error: 'No Songkick or Bandsintown URL set for this band' });
      }

      // Call the Python service to sync concerts for this band
      const syncResponse = await pythonServicePost(`/sync/${band.id}`,
        // ticketmaster_id is deliberately not sent: the scraper only polls
        // Ticketmaster when it receives one, and it was 1.1% of the concerts.
        { songkick_url: band.songkick_url ?? null, bandsintown_url: band.bandsintown_url ?? null, band_name: band.name },
      );

      res.status(200).json({
        status: 'success',
        message: 'Band concerts synced successfully',
        bandId: band.id,
        syncDetails: syncResponse.data,
      });
    } catch (error) {
      if (error.response?.status === 404) {
        return res.status(404).json({ error: 'Band or sync endpoint not found' });
      } else if (error.response?.status === 429) {
        return res.status(429).json({ error: 'Too many requests, please try again later.' });
      }
      console.error('Error syncing concerts:', error.message);
      const { status, message } = pythonServiceFailure(error);
      sendError(res, status, message);
    }
  },
);

// POST /bands/:bandId/reconcile
// Called after a single-band sync. Compares fresh scraped concerts (source of truth)
// against future DB concerts for this band. For any DB concert with no match in the
// fresh data, unlinks this band from it (rather than deleting outright) and returns
// the other participating bands for re-sync. Those bands' own reconcile pass decides
// whether the concert is legitimate for them; if no bands remain it becomes an orphan
// and is deleted.
router.post(
  '/bands/:bandId/reconcile',
  auth,
  roleCheck(['ADMIN', 'SYSTEM']),
  async (req, res) => {
    const bandId = parseInt(req.params.bandId, 10);
    if (Number.isNaN(bandId)) return res.status(400).json({ error: 'Invalid band id' });

    const { upcoming } = req.body;
    if (!Array.isArray(upcoming)) return res.status(400).json({ error: 'upcoming must be an array' });

    // If scraper returned nothing, skip — likely a scrape failure, not a genuinely empty schedule
    if (upcoming.length === 0) {
      return res.json({ stale_removed: 0, resync_bands: [], skipped: true, reason: 'empty_upcoming' });
    }

    const now = new Date();
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const toUtcDay = (d) => { const x = new Date(d); return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()); };

    const freshByEventId = new Map(upcoming.filter((c) => c.event_id).map((c) => [c.event_id, c]));

    const dbConcerts = await prisma.concert.findMany({
      where: {
        concert_date: { gt: now },
        bands: { some: { band: bandId } },
      },
      include: {
        bands: {
          include: {
            band_rel: {
              select: { id: true, name: true, songkick_url: true, bandsintown_url: true },
            },
          },
        },
      },
    });

    const staleIds = [];
    const resyncBandMap = new Map();

    for (const dbConcert of dbConcerts) {
      if (dbConcert.event_id && freshByEventId.has(dbConcert.event_id)) continue;

      const dbDay = toUtcDay(dbConcert.concert_date);
      const dbLat = parseFloat(dbConcert.latitude);
      const dbLng = parseFloat(dbConcert.longitude);
      const dayWindow = dbConcert.festival ? 3 : 2;

      const hasMatch = upcoming.some((fresh) => {
        if (!fresh.concert_date) return false;
        if (Math.abs(toUtcDay(fresh.concert_date) - dbDay) / ONE_DAY_MS > dayWindow) return false;

        // When both sides have venue names, require venue similarity — area alone is not
        // enough (e.g. two different venues in the same city would otherwise match).
        // 5km fallback handles same venue with a localised name on one side.
        if (dbConcert.venue && fresh.venue) {
          if (stringSimilarity(dbConcert.venue, fresh.venue) >= 0.7 || venueContains(dbConcert.venue, fresh.venue)) return true;
          const freshLat = parseFloat(fresh.latitude);
          const freshLng = parseFloat(fresh.longitude);
          if (!isNaN(dbLat) && !isNaN(dbLng) && !isNaN(freshLat) && !isNaN(freshLng)) {
            if (haversineKm(dbLat, dbLng, freshLat, freshLng) <= 8) return true;
          }
          return false;
        }

        // No venue on one side — fall back to coordinates or city name
        const freshLat = parseFloat(fresh.latitude);
        const freshLng = parseFloat(fresh.longitude);
        if (!isNaN(dbLat) && !isNaN(dbLng) && !isNaN(freshLat) && !isNaN(freshLng)) {
          if (haversineKm(dbLat, dbLng, freshLat, freshLng) <= 8) return true;
        }

        return dbConcert.city && fresh.city && stringSimilarity(dbConcert.city, fresh.city) >= 0.7;
      });

      if (!hasMatch) {
        staleIds.push(dbConcert.id);
        for (const ref of dbConcert.bands) {
          if (ref.band_rel.id !== bandId) resyncBandMap.set(ref.band_rel.id, ref.band_rel);
        }
      }
    }

    if (staleIds.length === 0) return res.json({ stale_removed: 0, resync_bands: [] });

    // Unlink this band from stale concerts rather than deleting immediately.
    // The participating bands' own reconcile pass will decide if the concert is
    // valid for them; any concert left with no bands after unlinking is an orphan.
    await prisma.$transaction(async (tx) => {
      await tx.concertBandReference.deleteMany({ where: { concert: { in: staleIds }, band: bandId } });
      const orphans = await tx.concert.findMany({
        where: { id: { in: staleIds }, bands: { none: {} } },
        select: { id: true },
      });
      if (orphans.length > 0) {
        const orphanIds = orphans.map((c) => c.id);
        await tx.concertAttendance.deleteMany({ where: { concert_id: { in: orphanIds } } });
        await tx.concert.deleteMany({ where: { id: { in: orphanIds } } });
      }
    });

    const resyncBands = [...resyncBandMap.values()].map((b) => ({
      id: b.id, name: b.name,
      songkick_url: b.songkick_url, bandsintown_url: b.bandsintown_url,
    }));

    console.log(`[reconcile] Band ${bandId}: removed ${staleIds.length} stale concert(s), re-syncing: ${resyncBands.map((b) => b.name).join(', ') || 'none'}`);

    return res.json({ stale_removed: staleIds.length, resync_bands: resyncBands });
  },
);

router.post(
  '/bands',
  rateLimit,
  auth,
  roleCheck(['ADMIN', 'USER']),
  body('name')
    .optional()
    .isString()
    .notEmpty()
    .withMessage('Band name must be a non-empty string'),
  body('wishlistId')
    .optional()
    .isInt()
    .withMessage('Wishlist ID must be an integer'),
  async (req, res) => {
    try {

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, wishlistId } = req.body;

      if (!name) {
        return res.status(400).json({ error: "'name' must be provided" });
      }

      const bandName = name.trim();

      const existingBand = await prisma.band.findUnique({ where: { name: bandName } });
      if (existingBand) {
        return res.status(409).json({ error: 'Band already exists.' });
      }

      // No Ticketmaster lookup. It used to resolve the name here and 404 with
      // "No band found." for anything its catalogue lacked, which is the only
      // reason such a band could not be added — MusicBrainz and findSourceUrls
      // below both key off the name, and they are what produce concerts.
      // Fetch MBID from MusicBrainz
      let mbid = null;
      try {
        const mbResponse = await axios.get(
          'https://musicbrainz.org/ws/2/artist/',
          {
            params: { query: `artist:"${bandName}"`, limit: 1, fmt: 'json' },
            headers: {
              'User-Agent': `${process.env.APP_NAME}/${process.env.APP_VERSION} (${process.env.APP_CONTACT})`,
            },
          },
        );
        mbid = mbResponse.data?.artists?.[0]?.id ?? null;
      } catch (mbError) {
        console.error('Error fetching MBID from MusicBrainz:', mbError.message);
      }
      // Create band in database
      const newBand = await prisma.band.create({
        data: {
          name: bandName,
          created_at: new Date(),
          MBID: mbid,
        },
      });

      // Add to wishlist if provided
      if (wishlistId) {
        await prisma.wishlistBandReference.create({
          data: {
            wishlist_id: wishlistId,
            band_id: newBand.id,
          },
        });
      }

      // Respond immediately — sync happens in the background after URL discovery
      res.status(201).json({
        status: 'success',
        band: {
          id: newBand.id,
          name: newBand.name,
          mbid: newBand.MBID,
        },
        sync: { status: 'queued' },
      });

      // Discover Songkick + Bandsintown URLs, save them, THEN trigger sync so all
      // three sources are available in one pass — avoids the race where sync fires
      // before URLs are known.
      findSourceUrls(newBand.name, mbid).then(async ([songkickUrl, bandsintownUrl]) => {
        console.log(`[findSourceUrl] ${newBand.name} → songkick: ${songkickUrl}, bandsintown: ${bandsintownUrl}`);
        await prisma.band.update({
          where: { id: newBand.id },
          data: {
            ...(songkickUrl    && { songkick_url:    songkickUrl }),
            ...(bandsintownUrl && { bandsintown_url: bandsintownUrl }),
            source_urls_checked_at: new Date(),
          },
        }).catch((e) => console.error(`[findSourceUrl] DB update failed for ${newBand.name}:`, e.message));
        return [songkickUrl, bandsintownUrl];
      }, (e) => {
        // Not stamped: MusicBrainz being unreachable is not evidence the URLs
        // don't exist, so the cron backfill retries this band on its next sweep.
        console.error(`[findSourceUrl] MusicBrainz lookup failed for ${newBand.name}:`, e.message);
        return [null, null];
      }).then(async ([songkickUrl, bandsintownUrl]) => {
        await pythonServicePost(`/sync/${newBand.id}`,
          { songkick_url: songkickUrl || null, bandsintown_url: bandsintownUrl || null, band_name: newBand.name },
        );
        console.log(`[findSourceUrl] Sync queued for ${newBand.name}`);
      }).catch((e) => console.error(`[findSourceUrl] Background sync failed for ${newBand.name}:`, e.message));
    } catch (error) {
      console.error('Error creating band:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// POST /bands/quick-add
// Minimal band creation from known name + MBID (e.g. from Setlist.fm).
// Does not do Ticketmaster lookup — adds straight to DB and optionally to a wishlist.
router.post('/bands/quick-add', auth, async (req, res) => {
  try {
    const { name, mbid, wishlistId, tier } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    const validTiers = ['LOVE', 'LIKE', 'FOLLOW'];
    const resolvedTier = validTiers.includes(tier) ? tier : 'FOLLOW';

    // Check for existing band by MBID or name
    const existing = await prisma.band.findFirst({
      where: mbid ? { MBID: mbid } : { name: name.trim() },
      select: { id: true, name: true },
    });

    let band = existing;
    if (!band) {
      band = await prisma.band.create({
        data: { name: name.trim(), MBID: mbid ?? null, created_at: new Date() },
        select: { id: true, name: true },
      });
    }

    // Add to wishlist if provided (skip if already there)
    if (wishlistId) {
      const wid = parseInt(wishlistId, 10);
      if (!Number.isNaN(wid)) {
        await prisma.wishlistBandReference.upsert({
          where: { band_wishlist: { band_id: band.id, wishlist_id: wid } },
          create: { band_id: band.id, wishlist_id: wid, tier: resolvedTier },
          update: {},
        });
      }
    }

    return res.status(201).json({ band });
  } catch (error) {
    console.error('[bands/quick-add] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
