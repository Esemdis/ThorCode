/**
 * Photos and video from shows you went to.
 *
 * Two of these endpoints serve bytes and do not use the JWT middleware: an
 * <img> or <video> tag issues its own request and sends no Authorization
 * header, so those carry a signed token in the query string instead. See
 * utils/mediaTokens.js.
 */

const express = require('express');
const multer = require('multer');
const crypto = require('node:crypto');
const path = require('node:path');
const { createReadStream } = require('node:fs');
const { mkdir, rename, unlink, stat, readFile } = require('node:fs/promises');
const { param, validationResult } = require('express-validator');

const auth = require('../../auth/verifyJWT');
const roleCheck = require('../../middlewares/roleCheck');
const prisma = require('../../prisma/client');
const { fail, badRequest, notFound, forbidden } = require('../../utils/apiResponse');
const {
  showFolderRelPath, uniqueFilename, resolveArchivePath,
} = require('../../utils/mediaPaths');
const {
  emptySidecar, upsertFile, readSidecar, writeSidecar,
} = require('../../utils/mediaSidecar');
const { kindForMime, MAX_FILE_BYTES } = require('../../utils/mediaTypes');
const { storePoster, ensureThumb } = require('../../utils/mediaThumbs');

const router = express.Router();

// Disk storage, not memory: a 500 MB video buffered in the heap is a container
// restart. The destination sits under MEDIA_ROOT so moving the finished file
// into the show folder is a rename within one filesystem, not a full copy.
const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      const dir = path.join(process.env.MEDIA_ROOT, 'incoming');
      try { await mkdir(dir, { recursive: true }); cb(null, dir); }
      catch (err) { cb(err); }
    },
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: MAX_FILE_BYTES },
});

const sha256File = (absPath) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  createReadStream(absPath).on('error', reject).on('data', (d) => hash.update(d))
    .on('end', () => resolve(hash.digest('hex')));
});

// Date-only, sliced rather than parsed. concert_date already carries a UTC
// instant, and toISOString always renders in UTC regardless of the server's
// local time zone, so this reads the same calendar day no matter where the
// container runs. Reformatting through a local-time path (toLocaleDateString,
// or parsing a bare "YYYY-MM-DD" and printing it back) is what slides the day
// backwards for anyone west of UTC, and would file a show under the wrong
// folder.
const dateOnly = (d) => new Date(d).toISOString().slice(0, 10);

const headlinerOf = (concert) => concert.bands?.[0]?.band_rel?.name ?? '';

/**
 * The caller's own attendance, with everything the archive path needs.
 * Returns null rather than throwing so each route decides the status code.
 */
async function ownAttendance(attendanceId, userId) {
  const row = await prisma.concertAttendance.findUnique({
    where: { id: attendanceId },
    include: {
      wishlist_rel: { select: { user_id: true } },
      concert_rel: {
        select: {
          id: true, concert_date: true, venue: true, city: true, country: true,
          bands: { select: { band: true, band_rel: { select: { id: true, name: true } } } },
        },
      },
    },
  });
  if (!row) return { row: null, owned: false };
  return { row, owned: row.wishlist_rel.user_id === userId };
}

router.post(
  '/attendances/:attendanceId/media',
  [auth, roleCheck(['ADMIN', 'USER']), param('attendanceId').isInt()],
  upload.fields([{ name: 'files', maxCount: 50 }, { name: 'posters', maxCount: 50 }]),
  async (req, res) => {
    // req.files is keyed by field once upload.fields is used, so both lists
    // have to be swept on failure or a rejected batch leaks its temp files.
    const allTemp = () => [...(req.files?.files ?? []), ...(req.files?.posters ?? [])];
    const cleanup = () => Promise.all(allTemp().map((f) => unlink(f.path).catch(() => {})));
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) { await cleanup(); return badRequest(res, 'Validation failed'); }

      const attendanceId = parseInt(req.params.attendanceId, 10);
      const { row, owned } = await ownAttendance(attendanceId, req.user.id);
      if (!row) { await cleanup(); return notFound(res, 'Attendance not found'); }
      if (!owned) { await cleanup(); return forbidden(res, 'Forbidden'); }
      const incoming = req.files?.files ?? [];
      if (!incoming.length) { await cleanup(); return badRequest(res, 'No files uploaded'); }

      // Posters are named for the video they belong to, so a batch mixing
      // photos and video pairs them up without depending on array order.
      const posters = new Map();
      for (const poster of req.files?.posters ?? []) {
        posters.set(poster.originalname.replace(/\.webp$/, ''), { buffer: await readFile(poster.path) });
        await unlink(poster.path).catch(() => {});
      }

      const bandId = req.body.band_id ? parseInt(req.body.band_id, 10) : null;
      const onBill = new Map(row.concert_rel.bands.map((b) => [b.band_rel.id, b.band_rel.name]));
      // A band that was not on the bill would file a photo under a show the
      // user never saw them at, and the band view would then assert it.
      if (bandId !== null && !onBill.has(bandId)) {
        await cleanup();
        return badRequest(res, 'That band is not on this bill');
      }

      const show = {
        date: dateOnly(row.concert_rel.concert_date),
        city: row.concert_rel.city,
        headliner: headlinerOf(row.concert_rel),
      };
      const relDir = showFolderRelPath(row.wishlist_rel.user_id, show);
      const absDir = resolveArchivePath(relDir);
      await mkdir(absDir, { recursive: true });

      let sidecar = (await readSidecar(absDir)) ?? emptySidecar({
        concertId: row.concert_rel.id,
        userId: row.wishlist_rel.user_id,
        concert: {
          date: show.date, venue: row.concert_rel.venue,
          city: row.concert_rel.city, country: row.concert_rel.country,
        },
      });

      const existing = await prisma.concertMedia.findMany({
        where: { attendance_id: attendanceId }, select: { filename: true },
      });
      const taken = new Set([...existing.map((e) => e.filename), ...sidecar.files.map((f) => f.name)]);

      const created = [];
      const pairedPosters = [];
      for (const file of incoming) {
        const kind = kindForMime(file.mimetype);
        // A file still in the batch when this one is refused would otherwise
        // sit in MEDIA_ROOT/incoming forever: the loop stops here and nothing
        // downstream would ever unlink it.
        if (!kind) { await cleanup(); return badRequest(res, `${file.originalname}: unsupported type`); }

        // Dimensions and duration come from the browser, which read them off
        // the same video element it pulled the poster frame from. There is no
        // ffprobe here to check them against, and for a single-user archive a
        // client that lies only misinforms itself. Parsed defensively all the
        // same, so a malformed field cannot reach the database.
        const meta = JSON.parse(req.body.meta ?? '{}')[file.originalname] ?? {};
        const asInt = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null);
        const probe = {
          width: asInt(meta.width),
          height: asInt(meta.height),
          duration_ms: kind === 'VIDEO' ? asInt(meta.duration_ms) : null,
        };

        const filename = uniqueFilename([...taken], file.originalname);
        taken.add(filename);
        const absPath = path.join(absDir, filename);
        await rename(file.path, absPath);

        const sha256 = await sha256File(absPath);
        const { size } = await stat(absPath);

        const entry = {
          name: filename, kind, band_id: bandId, band_name: bandId ? onBill.get(bandId) : null,
          caption: '', sha256, bytes: size,
          width: probe.width, height: probe.height,
          duration_ms: probe.duration_ms, taken_at: null,
        };
        sidecar = upsertFile(sidecar, entry);

        // Paired by the name the browser sent, not the name we stored: a
        // collision suffixes the video to 'VID_1 (2).mp4' while its poster is
        // still keyed 'VID_1.mp4', and looking it up afterwards by the stored
        // name would drop the poster without a word.
        const mediaRow = await prisma.concertMedia.create({
          data: {
            attendance_id: attendanceId, band_id: bandId,
            rel_path: path.posix.join(relDir, filename), filename,
            kind, bytes: size, sha256,
            width: probe.width, height: probe.height, duration_ms: probe.duration_ms,
          },
        });
        created.push(mediaRow);
        if (kind === 'VIDEO') pairedPosters.push([mediaRow, posters.get(file.originalname)]);
      }

      await writeSidecar(absDir, sidecar);

      // Posters are written before the response, not after: they arrived with
      // the request and cannot be recreated later, so losing one to a crash in
      // a background task would lose it for good.
      for (const [m, poster] of pairedPosters) {
        if (!poster) continue;
        try {
          await storePoster({ relPath: m.rel_path, buffer: poster.buffer });
        } catch (err) {
          // A bad frame is not worth failing the upload the video already
          // survived. The grid draws a placeholder for a video with no poster.
          console.error(`[media] poster for ${m.filename} rejected`, err);
        }
      }

      // Photo thumbnails after the response, best effort. Twenty files should
      // not leave the browser waiting on image processing, and a missing photo
      // thumbnail is regenerated by the thumb route on first request anyway.
      res.status(201).json({ success: true, data: { created } });
      for (const m of created.filter((r) => r.kind === 'PHOTO')) {
        ensureThumb({ absPath: resolveArchivePath(m.rel_path), kind: m.kind, sha256: m.sha256, relPath: m.rel_path })
          .catch((err) => console.error(`[media] thumbnail for ${m.id} failed`, err));
      }
      return undefined;
    } catch (err) {
      await cleanup();
      return fail(res, err, { context: 'POST /attendances/:attendanceId/media' });
    }
  },
);

module.exports = router;
