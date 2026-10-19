/**
 * The named clips of a video: marks on the file, played by seeking, never cut
 * into a file of their own (the share dialog still makes a real cut, from
 * utils/mediaClips.js). Everyone signed in reads them with the listing; only
 * an admin sets them, as the whole list for one video at a time.
 */
const express = require('express');
const path = require('node:path');
const { param, body, validationResult } = require('express-validator');

const auth = require('../../../auth/verifyJWT');
const roleCheck = require('../../../middlewares/roleCheck');
const prisma = require('../../../prisma/client');
const {
  fail, badRequest, success,
} = require('../../../utils/apiResponse');
const { resolveArchivePath } = require('../../../utils/mediaPaths');
const { emptySidecar, upsertFile, updateSidecar } = require('../../../utils/mediaSidecar');
const { namedClips } = require('../../../utils/namedClips');
const { sidecarSeed, refuseRows, lockShows } = require('./shared');

const router = express.Router();

router.put(
  '/media/:id/clips',
  [auth, roleCheck(['ADMIN']), param('id').isInt(), body('clips').isArray()],
  async (req, res) => {
    let locked = null;
    try {
      if (!validationResult(req).isEmpty()) return badRequest(res, 'Validation failed');
      const id = parseInt(req.params.id, 10);
      const readRows = () => prisma.concertMedia.findMany({
        where: { id },
        include: {
          attendance_rel: {
            include: {
              wishlist_rel: { select: { user_id: true } },
              concert_rel: {
                select: {
                  id: true, concert_date: true, venue: true, city: true, country: true,
                  bands: { select: { band_rel: { select: { id: true, name: true } } } },
                },
              },
            },
          },
        },
      });
      // The show's lock, so a tag moving this file to another stage cannot
      // interleave with the sidecar write below.
      const first = await readRows();
      if (refuseRows(res, first, [id], req.user.id)) return undefined;
      locked = await lockShows(first, readRows, (rows) => rows.map((r) => r.attendance_id));
      if (!locked) return badRequest(res, 'That file changed while its clips were being saved — try again');
      if (refuseRows(res, locked.rows, [id], req.user.id)) return undefined;
      const [media] = locked.rows;
      if (media.kind !== 'VIDEO') return badRequest(res, 'Only a video has clips');

      const { clips, error } = namedClips(req.body.clips, { durationMs: media.duration_ms });
      if (error) return badRequest(res, error);

      // Postgres first, sidecar second, as a retag does: a sidecar write that
      // fails after this commits costs a rebuild its newest edit, not a file.
      await prisma.$transaction([
        prisma.mediaClip.deleteMany({ where: { media_id: id } }),
        prisma.mediaClip.createMany({ data: clips.map((c) => ({ ...c, media_id: id })) }),
      ]);

      const concert = media.attendance_rel.concert_rel;
      const bandName = concert.bands.find((b) => b.band_rel.id === media.band_id)?.band_rel.name ?? null;
      await updateSidecar(resolveArchivePath(path.posix.dirname(media.rel_path)), (current) => {
        const sidecar = current ?? emptySidecar(sidecarSeed(concert, media.attendance_rel.wishlist_rel.user_id));
        // Built from the row when the sidecar never recorded the file, as the
        // tag sweep does.
        const recorded = sidecar.files.find((f) => f.name === media.filename) ?? {
          name: media.filename, kind: media.kind,
          band_id: media.band_id, band_name: bandName,
          caption: media.caption ?? '', song: media.song ?? null, sha256: media.sha256, bytes: media.bytes,
          width: media.width, height: media.height, duration_ms: media.duration_ms,
          picked: media.picked ?? false,
          moment_start_ms: media.moment_start_ms ?? null, moment_end_ms: media.moment_end_ms ?? null,
          taken_at: media.taken_at,
        };
        return upsertFile(sidecar, { ...recorded, clips });
      });

      return success(res, 200, { clips });
    } catch (err) {
      return fail(res, err, { context: 'PUT /media/:id/clips' });
    } finally {
      if (locked) locked.release();
    }
  },
);

module.exports = router;
