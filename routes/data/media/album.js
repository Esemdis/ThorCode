/**
 * Sharing a whole night by public link (THO-892): minting and revoking the
 * link, and the listing a recipient's page is drawn from. The bytes of each
 * file are served with the other byte routes, in ./bytes.js.
 *
 * Under /album-shares rather than /media/albums: DELETE /media/:id is
 * registered before this router, and would take "albums" for an id.
 */
const express = require('express');

const auth = require('../../../auth/verifyJWT');
const roleCheck = require('../../../middlewares/roleCheck');
const prisma = require('../../../prisma/client');
const {
  fail, badRequest, notFound, success,
} = require('../../../utils/apiResponse');
const { serialise } = require('../../../utils/serialQueue');
const { rateLimiter } = require('../../../utils/rateLimiter');
const { generateShareToken } = require('../../../utils/mediaShareToken');
const {
  albumExpiry, normaliseAttendanceIds, sameIds, unionIds, albumNightKey, albumLinkForNight, albumPayload,
  parsePicksOnly, albumMediaWhere,
} = require('../../../utils/mediaAlbumShare');
const { liveAlbumLink } = require('./shared');

const router = express.Router();

// The night each of these attendances of the owner's is, as albumNightKey
// reads it. Scoped to the owner, as every read of a link's ids is.
const nightsOf = (userId, ids) => prisma.concertAttendance.findMany({
  where: { id: { in: ids }, wishlist_rel: { user_id: userId } },
  select: { id: true, concert_rel: { select: { concert_date: true, city: true } } },
});

// A live link of this user's that takes in any of these attendances, of the
// one kind asked for: the picks and the whole night are separate links.
const liveFor = (userId, ids, picksOnly, now = new Date()) => ({
  user_id: userId,
  revoked_at: null,
  expires_at: { gt: now },
  attendance_ids: { hasSome: ids },
  picks_only: picksOnly,
});

/**
 * Get-or-create the public link to a night.
 *
 * Idempotent, like the single-file link: while a link to the night is live,
 * asking again hands it back, which is also how the app shows a link made on
 * an earlier visit.
 *
 * A night can grow — a second stage of a festival day gets attended after the
 * first was shared. Asking then widens the live link to take in the
 * attendances named now and keeps its token, rather than minting a second:
 * the person holding the first URL sees the whole night.
 *
 * Widens, never narrows. The same night can be asked for as fewer attendances
 * than it was shared as — one stage's row opened on its own — and replacing
 * the list then took the other stages' files out of a URL already sent.
 *
 * Widening keeps the link's expiry. A stage added on the link's last day is
 * shared for that day, not a fresh week: pushing the date out would also keep
 * every file already sent open longer, without the owner having asked for
 * that. The app shows the real date, and Stop then Share mints a new week.
 *
 * Two stages shared separately before they folded are two live links, and the
 * newest is the one widened; the other goes on showing its own stage until it
 * runs out. Stop sharing ends both.
 *
 * Only a link to the same night is handed back or widened, read from the
 * concerts' dates and cities as they are now, not from any one attendance the
 * link shares with the request (THO-895, see albumLinkForNight): a corrected
 * date moves an attendance into another night, and sharing that night widened
 * the first one's link into it.
 *
 * Answers the token, not a URL. The page a recipient opens is the frontend's,
 * and only the frontend knows its own origin.
 *
 * `picks_only: true` asks for a link to the night's picks instead (THO-849):
 * the files the owner marked, not every one. It is a link of its own beside a
 * whole-night link, found, widened and expired by the same rules, so a URL
 * already sent never turns from one into the other. Left out, it is the whole
 * night, as it was before picks could be shared.
 */
router.post(
  '/album-shares',
  [auth, roleCheck(['ADMIN', 'USER'])],
  async (req, res) => {
    try {
      const ids = normaliseAttendanceIds(req.body?.attendance_ids);
      if (!ids) return badRequest(res, 'attendance_ids must be a list of attendance ids');
      const picksAsked = parsePicksOnly(req.body?.picks_only);
      if (picksAsked === null) return badRequest(res, 'picks_only must be true or false');
      const picksOnly = picksAsked ?? false;

      // Every one of them the caller's, or nothing is shared. Not found for
      // somebody else's as for one that does not exist: which attendance ids
      // exist is not the caller's to learn.
      const owned = await nightsOf(req.user.id, ids);
      if (owned.length !== ids.length) return notFound(res, 'Attendance not found');
      const nightById = new Map(owned.map((a) => [a.id, albumNightKey(a.concert_rel)]));

      // One find-or-create at a time per user, for the reason the single-file
      // route gives: two devices asking at once must not each mint a link.
      const link = await serialise(`album-share:${req.user.id}`, async () => {
        const now = new Date();
        const candidates = await prisma.mediaAlbumShareLink.findMany({
          where: liveFor(req.user.id, ids, picksOnly, now),
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        });
        // The nights of the other attendances those links name, to tell
        // whether a link and this request are still one night.
        const others = [...new Set(candidates.flatMap((l) => l.attendance_ids))].filter((id) => !nightById.has(id));
        if (others.length) {
          for (const a of await nightsOf(req.user.id, others)) nightById.set(a.id, albumNightKey(a.concert_rel));
        }
        const live = albumLinkForNight(candidates, ids, nightById);
        if (!live) {
          return prisma.mediaAlbumShareLink.create({
            data: {
              user_id: req.user.id,
              attendance_ids: ids,
              picks_only: picksOnly,
              token: generateShareToken(),
              expires_at: albumExpiry(now),
            },
          });
        }
        const widened = unionIds(live.attendance_ids, ids);
        if (sameIds(live.attendance_ids, widened)) return live;
        return prisma.mediaAlbumShareLink.update({ where: { id: live.id }, data: { attendance_ids: widened } });
      });

      return success(res, 200, { token: link.token, expires_at: link.expires_at, picks_only: link.picks_only });
    } catch (err) {
      return fail(res, err, { context: 'POST /album-shares' });
    }
  },
);

// Revokes every live link that takes in any of the named attendances. The ids
// travel in the query because a DELETE's body is not something every client
// and proxy carries. Nothing live is a quiet no-op, and so is an attendance
// that is not the caller's: the where clause is scoped to their own links.
//
// `picks_only=1` stops only the picks link and `picks_only=0` only the
// whole-night one (THO-849). Left out, it stops both: that is what Stop
// sharing meant to an app that knew of one link per night, and ending more
// than asked is the safe way for a stop to be wrong.
router.delete(
  '/album-shares',
  [auth, roleCheck(['ADMIN', 'USER'])],
  async (req, res) => {
    try {
      const ids = normaliseAttendanceIds(req.query.attendance_ids);
      if (!ids) return badRequest(res, 'attendance_ids must be a list of attendance ids');
      const picksOnly = parsePicksOnly(req.query.picks_only);
      if (picksOnly === null) return badRequest(res, 'picks_only must be 1 or 0');

      // Under the same queue as the find-or-create, so a link minted while
      // this runs is either revoked here or made after the owner stopped.
      await serialise(`album-share:${req.user.id}`, () => prisma.mediaAlbumShareLink.updateMany({
        where: {
          user_id: req.user.id,
          revoked_at: null,
          attendance_ids: { hasSome: ids },
          ...(picksOnly !== undefined && { picks_only: picksOnly }),
        },
        data: { revoked_at: new Date() },
      }));
      return res.status(204).end();
    } catch (err) {
      return fail(res, err, { context: 'DELETE /album-shares' });
    }
  },
);

const albumLimiter = rateLimiter({
  message: 'Too many requests for this album, please try again later.',
  windowMs: 60 * 60 * 1000,
  max: 300,
});

/**
 * The night behind a link, for someone with no account: where and when, who
 * played, and every file with the URLs its bytes are at.
 *
 * Unknown, revoked and expired all answer 404 — the single-file link's rule.
 * no-store, so a revoked album is not redrawn from a browser's cache.
 */
router.get('/album-shares/:token', albumLimiter, async (req, res) => {
  try {
    const link = await liveAlbumLink(req.params.token);
    if (!link) return notFound(res, 'Album not found');

    // Re-checked against the owner on every read. The ids on the link are
    // plain numbers with no foreign key, so this is what keeps an attendance
    // that has since gone, or is not this user's, out of the album.
    const attendances = await prisma.concertAttendance.findMany({
      where: { id: { in: link.attendance_ids }, wishlist_rel: { user_id: link.user_id } },
      select: {
        id: true,
        concert_rel: {
          select: {
            concert_date: true, venue: true, city: true, country: true,
            bands: { select: { setlist: true, band_rel: { select: { id: true, name: true } } } },
          },
        },
      },
      orderBy: { id: 'asc' },
    });
    if (!attendances.length) return notFound(res, 'Album not found');

    // A picks link lists only what is picked now (THO-849): picking a file
    // after sharing puts it in, unpicking takes it out.
    const media = await prisma.concertMedia.findMany({
      where: albumMediaWhere(link, attendances.map((a) => a.id)),
      // The night in the order it happened, as the owner's own view has it.
      orderBy: [{ taken_at: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    });

    // The acts files are filed under that none of these bills has: a file
    // tagged with an act from another stage of the day. Named, so the page
    // can head them; asked for only when there are some.
    const onBill = new Set(attendances.flatMap((a) => a.concert_rel.bands.map((b) => b.band_rel.id)));
    const strays = [...new Set(media.map((m) => m.band_id).filter((id) => id != null && !onBill.has(id)))];
    const otherBands = strays.length
      ? await prisma.band.findMany({ where: { id: { in: strays } }, select: { id: true, name: true } })
      : [];

    res.set('Cache-Control', 'private, no-store');
    return success(res, 200, albumPayload({
      link, attendances, media, otherBands, baseUrl: process.env.CALLBACK_URL,
    }));
  } catch (err) {
    return fail(res, err, { context: 'GET /album-shares/:token' });
  }
});

module.exports = router;
