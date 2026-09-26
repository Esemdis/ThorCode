/**
 * Deleting files: one from the lightbox, or a selection from the grid.
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
  fail, badRequest, conflict, success,
} = require('../../../utils/apiResponse');
const { removeMediaFiles } = require('../../../utils/mediaRemove');
const { isClip, removeClip } = require('../../../utils/mediaClips');
const { refuseRows, lockShows, withOwner } = require('./shared');

const router = express.Router();

router.delete(
  '/media/:id',
  [auth, roleCheck(['ADMIN', 'USER']), param('id').isInt()],
  async (req, res) => {
    let locked = null;
    try {
      if (!validationResult(req).isEmpty()) return badRequest(res, 'Validation failed');
      const id = parseInt(req.params.id, 10);
      const readRow = async () => {
        const found = await prisma.concertMedia.findUnique({ where: { id }, include: withOwner });
        return found ? [found] : [];
      };
      const firstRead = await readRow();
      if (refuseRows(res, firstRead, [id], req.user.id, 'Media not found')) return undefined;

      // The show's lock, the one the upload route and PATCH take, and the row
      // read again under it. Without it a delete could land in the middle of a
      // tag moving this same file: unlinking it where it had been while the
      // move carried it, sidecar entry and all, into the next show — where it
      // then outlived its row.
      locked = await lockShows(firstRead, readRow, (rows) => rows.map((r) => r.attendance_id));
      if (!locked) return conflict(res, 'That file changed while it was being deleted — try again');
      if (refuseRows(res, locked.rows, [id], req.user.id, 'Media not found')) return undefined;

      // Read before the row goes: the cascade takes these rows with it, and a
      // moment not yet cut would otherwise sit in cache/clips for the service
      // to find, fail on a source that is gone, and only clear on its own
      // expiry up to twelve hours later.
      const clipLinks = (await prisma.mediaShareLink.findMany({
        where: { media_id: id },
        select: { id: true, start_ms: true, end_ms: true },
      })).filter(isClip);

      // File, then sidecar, then row; see utils/mediaRemove.js for why, and
      // for everything besides the original that a video leaves in the
      // archive.
      const { failed } = await removeMediaFiles(locked.rows);
      // Logged in full already. The row stays, so a retry can finish the job.
      if (failed.length) return fail(res, new Error(failed[0].error), { context: 'DELETE /media/:id' });

      await prisma.concertMedia.delete({ where: { id } });
      for (const link of clipLinks) await removeClip(link.id);
      return success(res, 200, { deleted: true });
    } catch (err) {
      return fail(res, err, { context: 'DELETE /media/:id' });
    } finally {
      if (locked) locked.release();
    }
  },
);

/**
 * Delete many files at once, for the grid's multi-select. The client sends
 * them in chunks of up to two hundred.
 *
 * Refused whole, as PATCH is, when any id is missing or any file is someone
 * else's. Past that, each file is its own outcome: one that cannot be removed
 * from the archive keeps its row and is named in `failed`, and the rest go.
 * Undoing the whole batch over one stubborn file is not possible — a removed
 * file cannot be put back — and a refusal after half of them had gone would
 * leave the caller unable to tell which half.
 */
router.delete(
  '/media',
  [
    auth, roleCheck(['ADMIN', 'USER']),
    body('ids').isArray({ min: 1, max: 200 }),
    body('ids.*').isInt(),
  ],
  async (req, res) => {
    let locked = null;
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return badRequest(res, 'Validation failed');

      // Deduped as PATCH dedupes: {ids:[5,5]} is one file asked for twice.
      const ids = [...new Set(req.body.ids.map((n) => parseInt(n, 10)))];
      const readRows = () => prisma.concertMedia.findMany({ where: { id: { in: ids } }, include: withOwner });
      const firstRead = await readRows();
      if (refuseRows(res, firstRead, ids, req.user.id)) return undefined;

      // Every show the files are in, locked as the single delete locks one.
      locked = await lockShows(firstRead, readRows, (rows) => rows.map((r) => r.attendance_id));
      if (!locked) return conflict(res, 'Those files changed while they were being deleted — try again');
      if (refuseRows(res, locked.rows, ids, req.user.id)) return undefined;

      // Read before the cascade removes these rows; see the single delete.
      const clipLinks = await prisma.mediaShareLink.findMany({
        where: { media_id: { in: ids } },
        select: { id: true, media_id: true, start_ms: true, end_ms: true },
      });

      // In the order they were asked for, so `deleted` and `failed` read back
      // in it too.
      const byId = new Map(locked.rows.map((r) => [r.id, r]));
      const { removed, failed } = await removeMediaFiles(ids.map((id) => byId.get(id)));
      // Only the rows whose files and sidecar entries are gone. The others
      // keep describing files that are still there.
      if (removed.length) await prisma.concertMedia.deleteMany({ where: { id: { in: removed } } });
      const removedSet = new Set(removed);
      for (const link of clipLinks.filter((l) => removedSet.has(l.media_id) && isClip(l))) {
        await removeClip(link.id);
      }
      return success(res, 200, { deleted: removed, failed });
    } catch (err) {
      return fail(res, err, { context: 'DELETE /media' });
    } finally {
      if (locked) locked.release();
    }
  },
);

module.exports = router;
