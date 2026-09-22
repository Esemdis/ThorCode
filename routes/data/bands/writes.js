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
const { findSourceUrls } = require('../../../utils/bandSourceUrls');
const { backlinkBandToConcerts } = require('../../../utils/bandBacklink');
const { detachAttendances, withDetach } = require('../../../utils/mediaDetach');
const auth = require('../../../auth/verifyJWT');
const roleCheck = require('../../../middlewares/roleCheck');
const { rateLimiter } = require('../../../utils/rateLimiter');
const prisma = require('../../../prisma/client');

// Defaults to 5 requests per 15 minutes per IP
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
    // 30s, not the 5s default: detachAttendances below renames a folder per
    // orphaned show on an SMB-mounted share, and a reconcile with several
    // orphaned concerts can outrun the default before the last rename lands.
    // withDetach, not $transaction: the folder renames inside are the one
    // part of this that Postgres cannot roll back, and a rollback that leaves
    // them in _detached is invisible to the rebuild.
    await withDetach(prisma, async (tx, moved) => {
      await tx.concertBandReference.deleteMany({ where: { concert: { in: staleIds }, band: bandId } });
      const orphans = await tx.concert.findMany({
        where: { id: { in: staleIds }, bands: { none: {} } },
        select: { id: true },
      });
      if (orphans.length > 0) {
        const orphanIds = orphans.map((c) => c.id);
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

      // Checked before the band is created, not after: a refusal that had
      // already written a global Band row would leave that row behind on
      // every rejected attempt.
      const { id: wid, owned, invalid } = await ownWishlistId(wishlistId, req.user.id);
      if (invalid) return res.status(400).json({ error: 'wishlistId must be a positive integer' });
      if (!owned) return res.status(403).json({ error: 'That wishlist is not yours' });

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
      // both key off the name, and they are what produce concerts.
      //
      // This route used to run its own `artist:"name"` search and keep
      // artists[0].id unconditionally. That was a second copy of the search in
      // findSourceUrls with none of its protections: no isConfidentNameMatch,
      // so MusicBrainz's closest guess for an unlisted band was stored as that
      // band's identity; no retry, so the ~1-in-3 "server is currently busy"
      // 503 simply lost the id; and no rate-limit spacing, so it fired a second
      // request into a 1 req/sec API in the same instant. Worse, handing the
      // unvetted id back in as `mbid` made findSourceUrls skip the very guard
      // that would have caught it. One guarded lookup now does both jobs.
      //
      // Awaited rather than left in the background, for the same reason
      // refresh-urls was changed: what this finds is the only thing that
      // produces concerts, and a background failure could reach nobody. It
      // costs one MusicBrainz call plus the mandatory 1.1s of spacing.
      let songkickUrl = null;
      let bandsintownUrl = null;
      let mbid = null;
      let lookupReachedMusicBrainz = true;
      try {
        [songkickUrl, bandsintownUrl, mbid] = await findSourceUrls(bandName);
      } catch (lookupError) {
        lookupReachedMusicBrainz = false;
        console.error(`[bands] MusicBrainz lookup failed for ${bandName}:`, lookupError.message);
      }

      const newBand = await prisma.band.create({
        data: {
          name: bandName,
          created_at: new Date(),
          MBID: mbid,
          ...(songkickUrl    && { songkick_url:    songkickUrl }),
          ...(bandsintownUrl && { bandsintown_url: bandsintownUrl }),
          // Stamped only when MusicBrainz actually answered. Unreachable is not
          // evidence the urls do not exist, so the band stays queued for the
          // next backfill sweep — same rule as refresh-urls and the backfill.
          ...(lookupReachedMusicBrainz && { source_urls_checked_at: new Date() }),
        },
      });

      // Add to wishlist if provided
      if (wid !== null) {
        await prisma.wishlistBandReference.create({
          data: {
            wishlist_id: wid,
            band_id: newBand.id,
          },
        });
      }

      // A band is usually added because it was seen on a bill already stored,
      // where its name sits in metadata as a loose string: /bulk links lineup
      // names against the bands existing at ingest time, and this band did not
      // exist yet. Left unlinked it shows grey on that bill, and the next scrape
      // of the band files its own copy of the gig — checkDuplicateConcert needs
      // a shared band to recognise the two as one show.
      //
      // Never fails the request: the band is created either way, and a missing
      // link is recoverable by hand.
      try {
        await backlinkBandToConcerts({ bandId: newBand.id, bandName, prisma });
      } catch (backlinkError) {
        console.error(`[bands] Back-linking existing concerts failed for ${bandName}:`, backlinkError.message);
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
        ...(!lookupReachedMusicBrainz && {
          warning: 'Could not reach MusicBrainz, so no Songkick or Bandsintown links were found yet. The nightly backfill will retry this band.',
        }),
      });

      // The scrape itself stays in the background: it is long-running, and
      // unlike the lookup above there is a retry path for it — the band now has
      // its urls stored, so an admin re-sync or the cron picks it up.
      pythonServicePost(`/sync/${newBand.id}`,
        { songkick_url: songkickUrl || null, bandsintown_url: bandsintownUrl || null, band_name: newBand.name },
      ).then(
        () => console.log(`[bands] Sync queued for ${newBand.name}`),
        (e) => console.error(`[bands] Background sync failed for ${newBand.name}:`, e.message),
      );
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

    // Check this before looking up or creating the globally shared Band row.
    // A rejected request must not leave a globally visible band behind.
    const { id: wid, owned, invalid } = await ownWishlistId(wishlistId, req.user.id);
    if (invalid) return res.status(400).json({ error: 'wishlistId must be a positive integer' });
    if (!owned) return res.status(403).json({ error: 'That wishlist is not yours' });

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
