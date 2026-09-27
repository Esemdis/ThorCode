/**
 * Reading the archive: one night's files with its bill, and one band's files
 * across every show of theirs the caller saw.
 *
 * Split out of routes/data/media.js, which had grown to 1715 lines and
 * fourteen endpoints. media.js mounts this and its siblings in their
 * original declaration order — the manifest test in media.test.js pins
 * the resulting surface.
 */
const express = require('express');
const { param, validationResult } = require('express-validator');

const auth = require('../../../auth/verifyJWT');
const roleCheck = require('../../../middlewares/roleCheck');
const prisma = require('../../../prisma/client');
const {
  fail, badRequest, notFound, forbidden, success,
} = require('../../../utils/apiResponse');
const { signMediaToken, mediaUrls } = require('../../../utils/mediaTokens');
const { bandMediaOverview } = require('../../../utils/mediaOverview');
const { billForConcert } = require('../../../utils/concertBill');
const { dateOnly, ownAttendance } = require('./shared');

const router = express.Router();

/**
 * When each of these files stops being shared: the latest expiry among its
 * public links to the whole file that are neither revoked nor expired. A file
 * with none is absent from the map.
 *
 * Links to a moment of a video are not counted. What the lightbox does with
 * this is offer the file's link again, by asking POST /media/:id/share with no
 * range — which hands back a live link to the whole file, and mints a new one
 * when the only live links are to moments. Counted here, a video with one
 * moment out would show as shared, and asking for "its" link would put a
 * second, whole-file link out in the world.
 *
 * One query for the whole listing rather than one per file, since a festival's
 * gallery is hundreds of tiles.
 *
 * @param {number[]} mediaIds
 * @returns {Promise<Map<number, string>>} media id to an ISO timestamp
 */
async function sharedUntil(mediaIds) {
  if (!mediaIds.length) return new Map();
  const links = await prisma.mediaShareLink.findMany({
    where: {
      media_id: { in: mediaIds },
      revoked_at: null,
      expires_at: { gt: new Date() },
      // The whole file, as normaliseRange stores it.
      start_ms: null,
      end_ms: null,
    },
    select: { media_id: true, expires_at: true },
  });
  const latest = new Map();
  for (const link of links) {
    const at = new Date(link.expires_at);
    const known = latest.get(link.media_id);
    if (!known || at > known) latest.set(link.media_id, at);
  }
  return new Map([...latest].map(([id, at]) => [id, at.toISOString()]));
}

// Signed URLs for a batch, minted once per response rather than per row: the
// secret lookup and the HMAC are cheap, but the base URL check is not free and
// a festival's worth of tiles would repeat it a hundred times.
function urlMinter(userId) {
  const base = process.env.CALLBACK_URL;
  return (mediaId) => mediaUrls(base, mediaId, signMediaToken({ mediaId, userId }));
}

router.get(
  '/attendances/:attendanceId/media',
  [auth, roleCheck(['ADMIN', 'USER']), param('attendanceId').isInt()],
  async (req, res) => {
    try {
      if (!validationResult(req).isEmpty()) return badRequest(res, 'Validation failed');
      const attendanceId = parseInt(req.params.attendanceId, 10);
      const { row, owned } = await ownAttendance(attendanceId, req.user.id);
      if (!row) return notFound(res, 'Attendance not found');
      if (!owned) return forbidden(res, 'Forbidden');

      const mint = urlMinter(req.user.id);
      const rows = await prisma.concertMedia.findMany({
        where: { attendance_id: attendanceId },
        // The night in the order it happened, not the order it was uploaded.
        // Ordered here rather than on the client because everything downstream
        // inherits it: the grid, the shift-click range, and the clips the
        // lightbox reasons about to guess which song it is looking at.
        //
        // Nulls last, and there will be some: a photograph whose EXIF has no
        // capture time, a clip whose container had none, and every file
        // uploaded before either was read. They keep upload order among
        // themselves and sit after everything that can be placed, which is the
        // honest arrangement — an unknown time is not the same as a late one.
        orderBy: [
          { taken_at: { sort: 'asc', nulls: 'last' } },
          { id: 'asc' },
        ],
      });

      // The untagged count is the gig view's progress bar, and it is counted
      // here rather than derived on the client because the client may be
      // looking at a filtered subset of the files it was sent.
      const untagged = rows.filter((m) => m.band_id === null).length;

      // The bill travels with the response so the tagging picker offers exactly
      // the artists who played that night, with no second request — and their
      // setlists with it, for the same reason, so the song picker on a video
      // has something to offer the moment a band is chosen.
      //
      // Spelled out field by field rather than spread from band_rel, which
      // carries a `setlist` of its own: a spread would silently put the band's
      // most recent setlist in the field meaning "what they played that night".
      //
      // And whether you saw each of them. The night's rail is where an act you
      // did not catch is marked, so it has to know which ones already are.
      const missed = new Set((await prisma.attendanceMissedBand.findMany({
        where: { attendance_id: attendanceId },
        select: { band_id: true },
      })).map((m) => m.band_id));
      const bands = billForConcert({
        bands: row.concert_rel.bands.map((b) => ({
          id: b.band_rel.id,
          name: b.band_rel.name,
          setlist: b.setlist ?? null,
          recent_setlist: b.band_rel.setlist ?? null,
          missed: missed.has(b.band_rel.id),
        })),
        metadata: row.concert_rel.metadata,
      });

      // shared_until is when the file's public link stops working, or null
      // when nothing of it is shared, so a tile can say so without asking.
      const shared = await sharedUntil(rows.map((m) => m.id));

      return success(res, 200, {
        files: rows.map((m) => ({ ...m, ...mint(m.id), shared_until: shared.get(m.id) ?? null })),
        untagged,
        bands,
        // Which show this is. A festival day is one show per stage, so this is
        // what the upload dialog names the stage a file is going to by. No
        // date rather than dateOnly's 1970 for a show that has none yet.
        concert: {
          id: row.concert_rel.id,
          date: row.concert_rel.concert_date ? dateOnly(row.concert_rel.concert_date) : null,
          venue: row.concert_rel.venue,
          city: row.concert_rel.city,
        },
      });
    } catch (err) {
      return fail(res, err, { context: 'GET /attendances/:attendanceId/media' });
    }
  },
);

router.get(
  '/bands/:bandId/media',
  [auth, roleCheck(['ADMIN', 'USER']), param('bandId').isInt()],
  async (req, res) => {
    try {
      if (!validationResult(req).isEmpty()) return badRequest(res, 'Validation failed');
      const bandId = parseInt(req.params.bandId, 10);

      // Scoped to the caller's own wishlist. Band rows are shared across every
      // account in this schema, so an unscoped query here would list other
      // people's shows.
      // A concert with no confirmed date (concert_date is nullable) has no
      // calendar day to file it under. dateOnly(null) does not throw — it
      // slices a Unix-epoch string and returns '1970-01-01' — so a dateless
      // show would otherwise land silently in 1970, dragging first_year down
      // and inflating per_year into a 57-entry gap-filled series. Excluded
      // here rather than patched in the date math, since a TBD show has
      // nothing honest to put in a sparkline keyed by year either way.
      const attendances = (await prisma.concertAttendance.findMany({
        where: {
          wishlist_rel: { user_id: req.user.id },
          concert_rel: { bands: { some: { band: bandId } } },
        },
        select: {
          id: true,
          concert_rel: {
            select: {
              id: true, concert_date: true, venue: true, city: true,
              // Setlists for the whole bill, not just the band being viewed:
              // the rail's lightbox can retag a file to any artist on that
              // night's bill, and a song picker that went empty on the switch
              // would look broken. The payload concern that forced the
              // per-band dedup in wishlists/reads.js does not apply at this
              // scale — that is a week of every wishlist band's concerts,
              // this is one band's own gigs.
              bands: {
                select: {
                  setlist: true,
                  band_rel: { select: { id: true, name: true, setlist: true } },
                },
              },
            },
          },
        },
      })).filter((a) => a.concert_rel.concert_date != null);

      const media = attendances.length
        ? await prisma.concertMedia.findMany({
            where: { band_id: bandId, attendance_id: { in: attendances.map((a) => a.id) } },
          })
        : [];
      // As on the gig view: when each file's public link stops working, if it
      // has one. Carried on the row, which bandMediaOverview passes through.
      const shared = await sharedUntil(media.map((m) => m.id));

      const payload = bandMediaOverview({
        attendances: attendances.map((a) => ({
          id: a.id,
          concert: {
            id: a.concert_rel.id,
            date: dateOnly(a.concert_rel.concert_date),
            venue: a.concert_rel.venue,
            city: a.concert_rel.city,
            // Belt-and-suspenders, not load-bearing: the select two lines up
            // always asks for `bands`, and Prisma always returns a selected
            // relation, so this can't be empty against the real database.
            // It only guards a caller (or a test's hand-built row) that
            // constructs this shape without it — and the rail below does
            // need the bill, to offer the tagging picker's choices.
            bands: (a.concert_rel.bands ?? []).map((b) => ({
              id: b.band_rel.id,
              name: b.band_rel.name,
              setlist: b.setlist ?? null,
              recent_setlist: b.band_rel.setlist ?? null,
            })),
          },
        })),
        media: media.map((m) => ({ ...m, shared_until: shared.get(m.id) ?? null })),
        urlFor: urlMinter(req.user.id),
      });

      return success(res, 200, payload);
    } catch (err) {
      return fail(res, err, { context: 'GET /bands/:bandId/media' });
    }
  },
);

module.exports = router;
