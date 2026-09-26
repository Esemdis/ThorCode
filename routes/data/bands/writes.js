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
const { pythonServicePost, pythonServiceFailure } = require('../../../utils/pythonService');
const { error: sendError } = require('../../../utils/apiResponse');
const { haversineKm, stringSimilarity, venueContains, deduplicateByCoords } = require('../../../utils/concertDedup');
const { backlinkBandToConcerts } = require('../../../utils/bandBacklink');
// Called through the module rather than destructured, so a test can stand in
// for band creation (which reaches MusicBrainz) on the router's own copy.
const bandCreate = require('../../../utils/bandCreate');
const { isMbid } = require('../../../utils/setlistFm');
const { detachAttendances, withDetach, sweepableConcertIds } = require('../../../utils/mediaDetach');
const auth = require('../../../auth/verifyJWT');
const roleCheck = require('../../../middlewares/roleCheck');
const { rateLimiter } = require('../../../utils/rateLimiter');
const prisma = require('../../../prisma/client');

// 10 requests a minute per IP — rateLimiter's defaults.
const rateLimit = rateLimiter({
  message:
    'Too many requests to the Ticketmaster data route, please try again later.',
});

// A wishlist id arriving in a request body is a claim, not a fact. Wishlist
// .user_id is unique — one wishlist per account — and ids are sequential
// autoincrement ints, so an unchecked id here let any signed-in caller count
// up from 1 and plant a band on every account in the system. That is not only
// an edit to someone else's list: utils/wishlists/notify.js fans a wishlist
// band's new concerts out to that wishlist's Discord webhook, so the injected
// band starts posting into a stranger's channel.
//
// Returns the parsed id when it is the caller's, or null when there is
// nothing to link. Throws nothing — callers answer 403 themselves, so the
// refusal reads the same from both routes.
async function ownWishlistId(raw, userId) {
  if (raw === undefined || raw === null || raw === '') return { id: null, owned: true };
  // parseInt('3anything', 10) is 3. An id has to be the whole positive integer
  // the caller supplied, otherwise an invalid reference could silently attach
  // a global band to a real wishlist.
  const text = String(raw);
  if (!/^\d+$/.test(text)) return { id: null, owned: false, invalid: true };
  const id = Number(text);
  if (!Number.isSafeInteger(id) || id < 1) return { id: null, owned: false, invalid: true };
  const wishlist = await prisma.wishlist.findFirst({
    where: { id, user_id: userId },
    select: { id: true },
  });
  return { id, owned: Boolean(wishlist) };
}

router.post(
  '/bands/:bandId/sync-concerts',
  rateLimit,
  auth,
  roleCheck(['ADMIN', 'SYSTEM']),
  async (req, res) => {
    const bandId = parseInt(req.params.bandId, 10);
    if (Number.isNaN(bandId)) return res.status(400).json({ error: 'Invalid band id' });
    try {
      // Fetch the band from the database
      const band = await prisma.band.findUnique({
        where: { id: bandId },
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

    const { upcoming: raw } = req.body;
    if (!Array.isArray(raw)) return res.status(400).json({ error: 'upcoming must be an array' });
    // A null or a string among the concerts threw on the first property read,
    // after nothing had been written — a 500 for one malformed entry.
    const upcoming = raw.filter((c) => c && typeof c === 'object');

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
    // 30s, not the 5s default: detachAttendances below renames a folder per
    // orphaned show on an SMB-mounted share, and a reconcile with several
    // orphaned concerts can outrun the default before the last rename lands.
    // withDetach, not $transaction: the folder renames inside are the one
    // part of this that Postgres cannot roll back, and a rollback that leaves
    // them in _detached is invisible to the rebuild.
    await withDetach(prisma, async (tx, moved) => {
      await tx.concertBandReference.deleteMany({ where: { concert: { in: staleIds }, band: bandId } });
      // Band-less AND unattended. This pass only looks at future concerts, so a
      // gig already been to is out of its scope anyway — but the rule belongs
      // here too rather than resting on that filter, because a show marked
      // Going can have photographs uploaded to it just as easily.
      const orphanIds = await sweepableConcertIds(tx, staleIds);
      if (orphanIds.length > 0) {
        // Detach before the attendance rows go, or the restricting foreign key
        // fails the whole transaction. See utils/mediaDetach.js for why the
        // key restricts rather than cascades. Passed tx, not prisma: a
        // rollback here must not leave media rows deleted while the concert
        // this band was reconciled against survives.
        //
        // detachAttendances takes ATTENDANCE ids, not concert ids.
        // ConcertAttendance and Concert both use autoincrement ints in the
        // same database, so the ranges overlap: passing orphanIds straight
        // through either detaches nothing (and the Restrict key then rolls
        // this whole transaction back on every orphan that has real
        // attendance) or, on a collision, renames an unrelated user's show
        // folder into _detached and deletes their media rows.
        const doomed = await tx.concertAttendance.findMany({
          where: { concert_id: { in: orphanIds } },
          select: { id: true },
        });
        await detachAttendances(tx, doomed.map((a) => a.id), { moved });
        await tx.concertAttendance.deleteMany({ where: { concert_id: { in: orphanIds } } });
        await tx.concert.deleteMany({ where: { id: { in: orphanIds } } });
      }
    }, { timeout: 30000 });

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
  // Trimmed before it is checked: "   " passed notEmpty(), trimmed to "" in
  // the handler and was created as a band with no name.
  body('name')
    .optional()
    .isString()
    .trim()
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

      // Checked before the band is created, not after: a refusal that had
      // already written a global Band row would leave that row behind on
      // every rejected attempt.
      const { id: wid, owned, invalid } = await ownWishlistId(wishlistId, req.user.id);
      if (invalid) return res.status(400).json({ error: 'wishlistId must be a positive integer' });
      if (!owned) return res.status(403).json({ error: 'That wishlist is not yours' });

      if (!name) {
        return res.status(400).json({ error: "'name' must be provided" });
      }

      let created;
      try {
        created = await bandCreate.createBand(name);
      } catch (error) {
        if (error instanceof bandCreate.BandExistsError) {
          // It can be there under another name, when MusicBrainz says the two
          // are one artist; say which, or the 409 reads as wrong.
          const stored = error.band;
          return res.status(409).json({
            error: stored.name === name ? 'Band already exists.' : `Band already exists as "${stored.name}".`,
            band: { id: stored.id, name: stored.name },
          });
        }
        throw error;
      }
      const { band: newBand, songkickUrl, bandsintownUrl, warning } = created;

      // Add to wishlist if provided
      if (wid !== null) {
        await prisma.wishlistBandReference.create({
          data: {
            wishlist_id: wid,
            band_id: newBand.id,
          },
        });
      }

      // Says what was actually found. The old shape answered
      // {sync:{status:'queued'}} before the lookup had run, so "no links, no
      // concerts, no idea why" and "everything worked" were the same response —
      // which is why a band with no urls looked identical to a healthy one.
      res.status(201).json({
        status: 'success',
        band: {
          id: newBand.id,
          name: newBand.name,
          mbid: newBand.MBID,
        },
        // Always both keys, null when nothing was found, matching refresh-urls:
        // the client distinguishes "looked and found nothing" from "the call
        // failed", and an absent key reads as neither.
        songkick_url: songkickUrl ?? null,
        bandsintown_url: bandsintownUrl ?? null,
        sync: { status: 'queued' },
        ...(warning && { warning }),
      });
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
    const { wishlistId, tier } = req.body;
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }
    // The MBID arrives from the client and becomes the band's identity for
    // every account — setlist.fm lookups go by it — so it has to at least be
    // one. An absent one is fine.
    const mbid = req.body.mbid == null || req.body.mbid === '' ? null : req.body.mbid;
    if (mbid !== null && !isMbid(mbid)) {
      return res.status(400).json({ error: 'mbid must be a MusicBrainz id' });
    }

    const validTiers = ['LOVE', 'LIKE', 'FOLLOW'];
    const resolvedTier = validTiers.includes(tier) ? tier : 'FOLLOW';

    // Check this before looking up or creating the globally shared Band row.
    // A rejected request must not leave a globally visible band behind.
    const { id: wid, owned, invalid } = await ownWishlistId(wishlistId, req.user.id);
    if (invalid) return res.status(400).json({ error: 'wishlistId must be a positive integer' });
    if (!owned) return res.status(403).json({ error: 'That wishlist is not yours' });

    // By MBID first, then by name. It used to be one or the other: with an
    // MBID given, a band already stored under that name but without that MBID
    // — which is most bands, whose MBID lookup found nothing or was never run —
    // was not found, and creating it again hit the unique name as a 500.
    const select = { id: true, name: true };
    let band = (mbid && await prisma.band.findFirst({ where: { MBID: mbid }, select }))
      || await prisma.band.findFirst({ where: { name }, select });

    if (!band) {
      try {
        band = await prisma.band.create({
          data: { name, MBID: mbid, created_at: new Date() },
          select,
        });
      } catch (error) {
        // Added by someone else between the lookup and here. Use theirs.
        if (error.code !== 'P2002') throw error;
        band = (mbid && await prisma.band.findFirst({ where: { MBID: mbid }, select }))
          || await prisma.band.findFirst({ where: { name }, select });
        if (!band) throw error;
      }
      // Same reason as the create route above. Only for a band that was just
      // created: one that already existed was linked as its bills were ingested.
      try {
        await backlinkBandToConcerts({ bandId: band.id, bandName: band.name, prisma });
      } catch (backlinkError) {
        console.error(`[bands/quick-add] Back-linking existing concerts failed for ${band.name}:`, backlinkError.message);
      }
    }

    // Add to wishlist if provided (skip if already there)
    if (wid !== null) {
      await prisma.wishlistBandReference.upsert({
        where: { band_wishlist: { band_id: band.id, wishlist_id: wid } },
        create: { band_id: band.id, wishlist_id: wid, tier: resolvedTier },
        update: {},
      });
    }

    return res.status(201).json({ band });
  } catch (error) {
    console.error('[bands/quick-add] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
