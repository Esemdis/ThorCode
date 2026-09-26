/**
 * Minting and revoking the public link to one file, or to one moment of a
 * video. The link itself is served with the other byte routes, in ./bytes.js.
 *
 * Split out of routes/data/media.js, which had grown to 1715 lines and
 * fourteen endpoints. media.js mounts this and its siblings in their
 * original declaration order — the manifest test in media.test.js pins
 * the resulting surface.
 */
const express = require('express');
const { param, body, validationResult } = require('express-validator');

const auth = require('../../../auth/verifyJWT');
const roleCheck = require('../../../middlewares/roleCheck');
const prisma = require('../../../prisma/client');
const {
  fail, badRequest, notFound, forbidden, success,
} = require('../../../utils/apiResponse');
const { serialise } = require('../../../utils/serialQueue');
const { generateShareToken, shareExpiry, shareUrl } = require('../../../utils/mediaShareToken');
const {
  isClip, normaliseRange, prepareClip, removeClip,
} = require('../../../utils/mediaClips');
const { INT32_MAX, withOwner } = require('./shared');

const router = express.Router();

// Answers the response itself and returns null when the caller may not share
// this file, so both share routes stop at the same place for the same reasons.
async function ownedMediaForShare(req, res) {
  const row = await prisma.concertMedia.findUnique({
    where: { id: parseInt(req.params.id, 10) },
    include: withOwner,
  });
  if (!row) { notFound(res, 'Media not found'); return null; }
  if (row.attendance_rel.wishlist_rel.user_id !== req.user.id) { forbidden(res, 'Forbidden'); return null; }
  return row;
}

/**
 * Get-or-create the public link to one file, or to one moment of a video.
 *
 * Idempotent per range: while a link to the same stretch of the same file is
 * live, asking again hands back that link rather than minting a second — which
 * is also how the lightbox polls a moment that is still being cut. A different
 * moment of the same video is a different link, so several can be out at once.
 *
 * A moment is cut by the rendition service, so its link reports `preparing`
 * until the clip exists. The whole file is always `ready`.
 */
router.post(
  '/media/:id/share',
  [
    auth, roleCheck(['ADMIN', 'USER']), param('id').isInt(),
    body('start_ms').optional({ nullable: true }).isInt({ min: 0, max: INT32_MAX }).toInt(),
    body('end_ms').optional({ nullable: true }).isInt({ min: 1, max: INT32_MAX }).toInt(),
  ],
  async (req, res) => {
    try {
      if (!validationResult(req).isEmpty()) return badRequest(res, 'Validation failed');
      const media = await ownedMediaForShare(req, res);
      if (!media) return undefined;

      const asked = { start_ms: req.body?.start_ms ?? null, end_ms: req.body?.end_ms ?? null };
      if ((asked.start_ms != null || asked.end_ms != null) && media.kind !== 'VIDEO') {
        return badRequest(res, 'Only a video can be shared as a moment');
      }
      const { range, error } = normaliseRange(asked, { durationMs: media.duration_ms });
      if (error) return badRequest(res, error);

      // One find-or-create at a time per file. Two devices asking at once for
      // the same stretch each found nothing live and each minted a link,
      // putting two URLs to it out in the world — the thing this route
      // promises never happens.
      const link = await serialise(`share:${media.id}`, async () => {
        const now = new Date();
        const live = await prisma.mediaShareLink.findFirst({
          where: { media_id: media.id, revoked_at: null, expires_at: { gt: now }, ...range },
          orderBy: { created_at: 'desc' },
        });
        if (live) return live;
        return prisma.mediaShareLink.create({
          data: {
            media_id: media.id, token: generateShareToken(), expires_at: shareExpiry(now), ...range,
          },
        });
      });

      return success(res, 200, {
        url: shareUrl(process.env.CALLBACK_URL, link.token),
        expires_at: link.expires_at,
        start_ms: link.start_ms ?? null,
        end_ms: link.end_ms ?? null,
        status: isClip(link) ? await prepareClip(link, media) : 'ready',
      });
    } catch (err) {
      return fail(res, err, { context: 'POST /media/:id/share' });
    }
  },
);

// Revokes every live link to the file, moments included, and deletes their
// clips. Nothing live is a quiet no-op rather than a 404.
router.delete(
  '/media/:id/share',
  [auth, roleCheck(['ADMIN', 'USER']), param('id').isInt()],
  async (req, res) => {
    try {
      if (!validationResult(req).isEmpty()) return badRequest(res, 'Invalid media id');
      const media = await ownedMediaForShare(req, res);
      if (!media) return undefined;

      // Under the same per-file queue as the share route's find-or-create.
      // Outside it, a link minted between this read and the revoke below was
      // revoked without its clip being swept, or — the other order — minted
      // just after, leaving a live link out once the owner had stopped sharing.
      const live = await serialise(`share:${media.id}`, async () => {
        const links = await prisma.mediaShareLink.findMany({
          where: { media_id: media.id, revoked_at: null },
          select: { id: true, start_ms: true, end_ms: true },
        });
        await prisma.mediaShareLink.updateMany({
          where: { media_id: media.id, revoked_at: null },
          data: { revoked_at: new Date() },
        });
        return links;
      });
      // After the revoke, so a failure here leaves disk to the service's sweep
      // and never leaves a link working. A clip mid-cut is caught by the
      // service, which finds its request gone.
      for (const link of live.filter(isClip)) await removeClip(link.id);
      return res.status(204).end();
    } catch (err) {
      return fail(res, err, { context: 'DELETE /media/:id/share' });
    }
  },
);

module.exports = router;
