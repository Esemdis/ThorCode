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
  albumExpiry, normaliseAttendanceIds, sameIds, unionIds, albumPayload,
} = require('../../../utils/mediaAlbumShare');
const { liveAlbumLink } = require('./shared');

const router = express.Router();

// A live link of this user's that takes in any of these attendances.
const liveFor = (userId, ids, now = new Date()) => ({
  user_id: userId,
  revoked_at: null,
  expires_at: { gt: now },
  attendance_ids: { hasSome: ids },
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
 * Answers the token, not a URL. The page a recipient opens is the frontend's,
 * and only the frontend knows its own origin.
 */
router.post(
  '/album-shares',
  [auth, roleCheck(['ADMIN', 'USER'])],
  async (req, res) => {
    try {
      const ids = normaliseAttendanceIds(req.body?.attendance_ids);
      if (!ids) return badRequest(res, 'attendance_ids must be a list of attendance ids');

      // Every one of them the caller's, or nothing is shared. Not found for
      // somebody else's as for one that does not exist: which attendance ids
      // exist is not the caller's to learn.
      const owned = await prisma.concertAttendance.findMany({
        where: { id: { in: ids }, wishlist_rel: { user_id: req.user.id } },
        select: { id: true },
      });
      if (owned.length !== ids.length) return notFound(res, 'Attendance not found');

      // One find-or-create at a time per user, for the reason the single-file
      // route gives: two devices asking at once must not each mint a link.
      const link = await serialise(`album-share:${req.user.id}`, async () => {
        const now = new Date();
        const live = await prisma.mediaAlbumShareLink.findFirst({
          where: liveFor(req.user.id, ids, now),
          orderBy: { created_at: 'desc' },
        });
        if (!live) {
          return prisma.mediaAlbumShareLink.create({
            data: {
              user_id: req.user.id, attendance_ids: ids, token: generateShareToken(), expires_at: albumExpiry(now),
            },
          });
        }
        const widened = unionIds(live.attendance_ids, ids);
        if (sameIds(live.attendance_ids, widened)) return live;
        return prisma.mediaAlbumShareLink.update({ where: { id: live.id }, data: { attendance_ids: widened } });
      });

      return success(res, 200, { token: link.token, expires_at: link.expires_at });
    } catch (err) {
      return fail(res, err, { context: 'POST /album-shares' });
    }
  },
);

// Revokes every live link that takes in any of the named attendances. The ids
// travel in the query because a DELETE's body is not something every client
// and proxy carries. Nothing live is a quiet no-op, and so is an attendance
// that is not the caller's: the where clause is scoped to their own links.
router.delete(
  '/album-shares',
  [auth, roleCheck(['ADMIN', 'USER'])],
  async (req, res) => {
    try {
      const ids = normaliseAttendanceIds(req.query.attendance_ids);
      if (!ids) return badRequest(res, 'attendance_ids must be a list of attendance ids');

      // Under the same queue as the find-or-create, so a link minted while
      // this runs is either revoked here or made after the owner stopped.
      await serialise(`album-share:${req.user.id}`, () => prisma.mediaAlbumShareLink.updateMany({
        where: { user_id: req.user.id, revoked_at: null, attendance_ids: { hasSome: ids } },
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

    const media = await prisma.concertMedia.findMany({
      where: { attendance_id: { in: attendances.map((a) => a.id) } },
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
