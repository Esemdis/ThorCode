/**
 * Upload photos and video from a show you attended.
 *
 * One route: multipart files land in the archive under the caller's own
 * subtree, get indexed in Postgres, and are recorded in the show's sidecar.
 * No band is attached unless the caller sends one — tagging is a separate
 * bulk sweep from a later view, because a multi-band bill can't be honestly
 * described by one band picked before the files are even looked at.
 *
 * Split out of routes/data/media.js, which had grown to 1715 lines and
 * fourteen endpoints. media.js mounts this and its siblings in their
 * original declaration order — the manifest test in media.test.js pins
 * the resulting surface.
 */

const express = require('express');
const multer = require('multer');
const crypto = require('node:crypto');
const path = require('node:path');
const { createReadStream } = require('node:fs');
const { mkdir, readdir, rename, unlink, stat } = require('node:fs/promises');
const { param, body, validationResult } = require('express-validator');

const auth = require('../../../auth/verifyJWT');
const roleCheck = require('../../../middlewares/roleCheck');
const prisma = require('../../../prisma/client');
const {
  fail, badRequest, notFound, forbidden, success,
} = require('../../../utils/apiResponse');
const {
  uniqueFilename, resolveArchivePath, slugSegment, safeExtension,
} = require('../../../utils/mediaPaths');
const { showDirForAttendance } = require('../../../utils/mediaShowDir');
const { capturedAtFor } = require('../../../utils/mediaCapture');
const { exifCapturedAtOfFile } = require('../../../utils/exifCapturedAt');
const { emptySidecar, upsertFile, readSidecar, updateSidecar } = require('../../../utils/mediaSidecar');
const {
  kindForMime, posterProblem, MAX_FILE_BYTES, MAX_FILES_PER_REQUEST,
} = require('../../../utils/mediaTypes');
const { uploadErrors } = require('../../../utils/uploadErrors');
const { storePoster, ensureThumb } = require('../../../utils/mediaThumbs');
const { acquire } = require('../../../utils/serialQueue');
const { festivalSibling } = require('../../../utils/mediaRehome');
const {
  dateOnly, headlinerOf, INT32_MAX, sidecarSeed, ownAttendance, billCandidates,
} = require('./shared');

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
    // The temp file sits on the same SMB share, so its extension gets the same
    // cleaning as the stored one — raw, a `:` in it failed the upload.
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${safeExtension(file.originalname)}`),
  }),
  limits: { fileSize: MAX_FILE_BYTES },
});

const sha256File = (absPath) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  createReadStream(absPath).on('error', reject).on('data', (d) => hash.update(d))
    .on('end', () => resolve(hash.digest('hex')));
});

// width/height/duration_ms are a 32-bit Postgres Int column. Bounding sign and
// finiteness is not enough: a client-supplied 9e12 passes both checks and then
// fails at insert time, turning a bad number into a 500 with the file already
// renamed onto disk.
//
// Out of range returns null rather than INT32_MAX, which is the same answer
// this function already gives every other unusable value. Clamping served the
// no-500 purpose equally well and cost something the archive cannot afford:
// duration_ms: 1e300 was stored as 2147483647 and read back out of the sidecar
// as a genuine 24.9-day video. The sidecar is the record of truth, and this
// was the only place in the feature knowingly writing something false into it.
const asInt = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > INT32_MAX) return null;
  return Math.round(n);
};

// SMB — the protocol the archive share is actually mounted over — rejects
// several characters ext4 would allow, which is why every other path segment
// in this archive already goes through slugSegment. A browser-supplied
// filename is exactly as untrusted as a venue name and gets the same
// treatment before it becomes one. The extension is cleaned on its own and
// kept out of the slug so MAX_SEGMENT truncating a long stem can never eat
// into it.
function slugFilename(originalName) {
  const stem = originalName.slice(0, originalName.length - path.extname(originalName).length);
  return `${slugSegment(stem)}${safeExtension(originalName)}`;
}

// Admin-only. Everyone signed in can look at the archive; only an admin adds
// to it. Enforced here and not merely by hiding the button, because the dialog
// is a convenience and this is the lock.
router.post(
  '/attendances/:attendanceId/media',
  [auth, roleCheck(['ADMIN']), param('attendanceId').isInt()],
  upload.fields([
    { name: 'files', maxCount: MAX_FILES_PER_REQUEST },
    { name: 'posters', maxCount: MAX_FILES_PER_REQUEST },
  ]),
  // After multer, not with the middleware above: this is a multipart request,
  // so there is no req.body to validate until the uploader has parsed it. Run
  // in front, the check silently passed on an empty body every time.
  //
  // It has to be a number before the bill check sees it. The client sent the
  // string "null" for a support act with no Band row — truthy, so it was
  // appended — and parseInt made it NaN, which is on no bill, so a malformed
  // field came back as a confident answer about the band.
  body('band_id').optional({ nullable: true, checkFalsy: true }).isInt(),
  // Sits between the uploader and the handler because that is the only place
  // it can: multer refuses a file by calling next(err), which skips the
  // handler's own try/catch entirely.
  uploadErrors,
  async (req, res) => {
    // req.files is keyed by field once upload.fields is used, so both lists
    // have to be swept on failure or a rejected batch leaks its temp files.
    const allTemp = () => [...(req.files?.files ?? []), ...(req.files?.posters ?? [])];
    const cleanup = () => Promise.all(allTemp().map((f) => unlink(f.path).catch(() => {})));
    // Declared out here so the finally below can release it whichever way the
    // handler leaves.
    let releaseShow = null;
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) { await cleanup(); return badRequest(res, 'Validation failed'); }

      let attendanceId = parseInt(req.params.attendanceId, 10);
      const posted = await ownAttendance(attendanceId, req.user.id);
      if (!posted.row) { await cleanup(); return notFound(res, 'Attendance not found'); }
      if (!posted.owned) { await cleanup(); return forbidden(res, 'Forbidden'); }

      // Which show the files are of. The one posted to, unless the band sent
      // with them is not on its bill: then the caller's show on the same day
      // in the same city that has the band, which on a festival day is the
      // stage the act played. That is the rule the tag sweep moves a file by
      // (see utils/mediaRehome.js), so a band picked at upload and the same
      // band picked afterwards file a photograph in the same place. Settled
      // first, because everything below is about this show: its date, its
      // folder, its sidecar, its lock.
      //
      // A band on none of that day's bills is still refused. Filed anywhere,
      // it would put a photograph under a show the user never saw them at, and
      // the band view would then assert it.
      const bandId = req.body.band_id ? parseInt(req.body.band_id, 10) : null;
      let { row } = posted;
      if (bandId !== null && !row.concert_rel.bands.some((b) => b.band_rel.id === bandId)) {
        const home = festivalSibling(row.concert_rel, await billCandidates(req.user.id, bandId));
        const sibling = home ? await ownAttendance(home.id, req.user.id) : null;
        if (!sibling?.row || !sibling.owned) {
          await cleanup();
          return badRequest(res, 'That band is not on the bill of any show you saw that day');
        }
        attendanceId = home.id;
        row = sibling.row;
      }

      // GET /bands/:bandId/media filters null-dated attendances out on purpose:
      // dateOnly(null) is the epoch, and a 1970 show wrecks first_year and the
      // sparkline. The upload route has to make the same call, because without
      // it these files landed in '1970-01-01 Oslo - Gojira', indexed cleanly,
      // and were then permanently invisible on the feature's main surface —
      // filed fifty-six years wrong in the record of truth.
      if (!row.concert_rel.concert_date) {
        await cleanup();
        return badRequest(res, 'This show has no confirmed date yet');
      }

      const incoming = req.files?.files ?? [];
      if (!incoming.length) { await cleanup(); return badRequest(res, 'No files uploaded'); }

      // The whole batch is validated before the first rename or insert. A
      // batch is all-or-nothing: if the third of four files is unsupported,
      // the first two must never have moved into the archive or gained a
      // Postgres row, or a retry re-uploads them as "(2)" duplicates of
      // themselves. See task-9-report.md for the probe that found otherwise.
      for (const file of incoming) {
        if (!kindForMime(file.mimetype)) {
          await cleanup();
          return badRequest(res, `${file.originalname}: unsupported type`);
        }
      }

      let meta;
      try {
        meta = JSON.parse(req.body.meta ?? '{}');
      } catch {
        await cleanup();
        return badRequest(res, 'meta is not valid JSON');
      }

      // The bill of the show the files land in, which by now has the band.
      const onBill = new Map(row.concert_rel.bands.map((b) => [b.band_rel.id, b.band_rel.name]));

      // Posters are named for the video they belong to, so a batch mixing
      // photos and video pairs them up without depending on array order.
      //
      // The temp path is kept, not the bytes. Reading every poster here put
      // the whole batch in the heap at once, before a single file had been
      // written anywhere — the one place this route abandoned the streaming
      // rule its disk storage exists to enforce. sharp takes a path as
      // happily as a Buffer, so the frames stay on disk until the one that
      // needs decoding is decoded.
      const posters = new Map();
      for (const poster of req.files?.posters ?? []) {
        const problem = posterProblem(poster);
        if (problem) {
          // Not fatal, and deliberately so: the video is the thing worth
          // keeping. Logged because a tile that silently draws a placeholder
          // is otherwise impossible to explain.
          console.error(`[media] poster ${poster.originalname} ignored: ${problem}`);
          continue;
        }
        posters.set(poster.originalname.replace(/\.webp$/, ''), { source: poster.path });
      }

      const show = {
        date: dateOnly(row.concert_rel.concert_date),
        city: row.concert_rel.city,
        headliner: headlinerOf(row.concert_rel),
      };
      // Read before the folder is chosen rather than after, because the
      // earliest row's rel_path is what chooses it. Ordered by id so that
      // "earliest" means something: an unordered read of an attendance whose
      // files are already split across two folders would pick a different one
      // from request to request and keep the split alive.
      // Everything from here to the sidecar write is one critical section per
      // show. The filename is chosen from a snapshot — existing rows, readdir
      // and the sidecar — and the rename onto it is an unconditional
      // overwrite, so two requests that both read before either wrote picked
      // the same name: the second replaced the first's bytes, then failed its
      // insert on @@unique([attendance_id, filename]) and unlinked the file it
      // had just written over. No bytes on disk, a row and a sidecar entry
      // both claiming the photograph exists, and the first client told 201.
      //
      // Not hypothetical: a retrying client on a flaky home connection
      // produces exactly two concurrent calls for one file, which is the case
      // utils/mediaThumbs.js already names. The checksum dedup cannot help —
      // it reads the same stale snapshot.
      //
      // Cheap to hold: multer has already received every byte by the time this
      // handler runs, so what is serialised is hashing and bookkeeping, not
      // the upload itself.
      releaseShow = await acquire(`attendance:${attendanceId}`);

      const existing = await prisma.concertMedia.findMany({
        where: { attendance_id: attendanceId },
        select: { filename: true, rel_path: true, sha256: true },
        orderBy: { id: 'asc' },
      });

      const relDir = await showDirForAttendance({
        existingRelPath: existing[0]?.rel_path ?? null,
        userId: row.wishlist_rel.user_id,
        concertId: row.concert_rel.id,
        show,
      });
      const absDir = resolveArchivePath(relDir);
      await mkdir(absDir, { recursive: true });

      const seed = sidecarSeed(row.concert_rel, row.wishlist_rel.user_id);
      // Read here only to seed `taken` below. The entries this request adds go
      // onto a fresh read inside updateSidecar, because a second upload to the
      // same show can land between these two points.
      const sidecar = (await readSidecar(absDir)) ?? emptySidecar(seed);

      // Seeded from the directory itself, not only from the two indexes. A
      // file that is on disk but in neither of them was invisible to
      // uniqueFilename, and the rename below then overwrote it without a word.
      // Decision 1 says the folder must be usable in a file browser by someone
      // who has never heard of this app, so dropping files into a show folder
      // is the sanctioned way to use it — and is exactly what armed that.
      //
      // This is also why concert-media.json is no longer named here: it is
      // always on disk, so the readdir covers it. It used to need seeding by
      // name because a client picks both the filename and the MIME type of a
      // part, so an upload called concert-media.json declaring image/jpeg
      // landed at 201 and wrote its bytes straight over the record of truth.
      const onDisk = await readdir(absDir);
      const taken = new Set([
        ...onDisk, ...existing.map((e) => e.filename), ...sidecar.files.map((f) => f.name),
      ]);

      const created = [];
      const added = [];
      const duplicates = [];
      const pairedPosters = [];

      // The checksums this show already holds. Every upload has always
      // computed one and stored it, but nothing ever compared them, so a
      // second upload of a photograph already in the archive was filed again
      // as "IMG_1 (2).jpg" — a second copy on disk, a second row, a second
      // sidecar entry and a second file synced to Drive, silently.
      //
      // Scoped to this show, not the whole archive: one photograph cannot
      // honestly belong to two nights, and a global check would refuse a file
      // on the grounds that it exists somewhere the caller may not even be
      // able to see.
      const knownHashes = new Set(existing.map((e) => e.sha256).filter(Boolean));
      try {
        for (const file of incoming) {
          const kind = kindForMime(file.mimetype);
          const fileMeta = meta[file.originalname] ?? {};
          // Two roads to one fact. A clip's time is read out of its MP4
          // container by the uploading browser, which is also where its poster
          // and duration come from. A photograph's is read out of its own EXIF
          // here, off the temp file multer has already written — never from
          // what the browser claims, because the only thing the browser could
          // offer for a still is `File.lastModified`, and that was measured on
          // a gig out of Google Photos and found to be the download time.
          const claimedAt = kind === 'VIDEO'
            ? fileMeta.captured_at
            : (await exifCapturedAtOfFile(file.path))?.iso ?? null;
          const probe = {
            width: asInt(fileMeta.width),
            height: asInt(fileMeta.height),
            duration_ms: kind === 'VIDEO' ? asInt(fileMeta.duration_ms) : null,
            captured_at: capturedAtFor(claimedAt, kind, row.concert_rel.concert_date),
          };

          // Hashed off the temp file, before anything is moved into the show
          // folder. Hashing after the rename — which is what this did, for
          // the thumbnail key — means a duplicate has already been written
          // into the archive by the time it is recognised as one.
          const sha256 = await sha256File(file.path);
          if (knownHashes.has(sha256)) {
            // Named, not dropped quietly. And the temp file goes with it: a
            // skipped upload that still left bytes anywhere would surface in
            // the next rebuild as a file no sidecar mentions, which is drift
            // manufactured by the check meant to prevent it.
            await unlink(file.path).catch(() => {});
            duplicates.push(file.originalname);
            continue;
          }
          // Added before the row is written, so the same bytes arriving twice
          // under two names in ONE request are caught too — the database has
          // nothing to compare the second against yet. The client dedupes on
          // name and size, so a photograph re-exported under a new name
          // reaches here as two parts of one upload.
          knownHashes.add(sha256);

          const filename = uniqueFilename([...taken], slugFilename(file.originalname));
          taken.add(filename);
          const absPath = path.join(absDir, filename);
          await rename(file.path, absPath);

          try {
            const { size } = await stat(absPath);

            // Read from the MP4 container by the browser, which is also where
            // the poster and duration come from. Videos only: a still takes no
            // song, so it needs no place in the running order, and reading
            // EXIF off photographs remains its own later phase — a null on a
            // photo still means "not read yet".
            const entry = {
              name: filename, kind, band_id: bandId, band_name: bandId ? onBill.get(bandId) : null,
              // Always present, always null: a fresh upload has no song, and an
              // entry whose shape depends on when it was written is the kind
              // of thing that makes the record of truth hard to read by hand.
              caption: '', song: null, sha256, bytes: size,
              width: probe.width, height: probe.height,
              duration_ms: probe.duration_ms, taken_at: probe.captured_at,
            };

            // Paired by the name the browser sent, not the name we stored: a
            // collision suffixes the video to 'VID_1 (2).mp4' while its poster
            // is still keyed 'VID_1.mp4', and looking it up afterwards by the
            // stored name would drop the poster without a word.
            const mediaRow = await prisma.concertMedia.create({
              data: {
                attendance_id: attendanceId, band_id: bandId,
                rel_path: path.posix.join(relDir, filename), filename,
                kind, bytes: size, sha256,
                width: probe.width, height: probe.height, duration_ms: probe.duration_ms,
                taken_at: probe.captured_at ? new Date(probe.captured_at) : null,
              },
            });
            added.push(entry);
            created.push(mediaRow);
            if (kind === 'VIDEO') pairedPosters.push([mediaRow, posters.get(file.originalname)]);
          } catch (err) {
            // The Postgres row is what makes this file real. If inserting it
            // fails, the bytes already renamed onto disk must not survive as
            // an orphan with no row and no sidecar entry — exactly the drift a
            // sidecar-trusting rebuild would never notice.
            await unlink(absPath).catch(() => {});
            throw err;
          }
        }
      } finally {
        // Written for whatever actually landed, even when the loop above threw
        // partway through: disk, Postgres and the sidecar must agree at every
        // exit, not only the one where every file made it.
        if (added.length) {
          await updateSidecar(absDir, (current) => {
            let next = current ?? emptySidecar(seed);
            for (const e of added) next = upsertFile(next, e);
            return next;
          });
        }
      }

      // Posters are written before the response, not after: they arrived with
      // the request and cannot be recreated later, so losing one to a crash in
      // a background task would lose it for good.
      try {
        for (const [m, poster] of pairedPosters) {
          if (!poster) continue;
          try {
            await storePoster({ relPath: m.rel_path, source: poster.source });
          } catch (err) {
            // A bad frame is not worth failing the upload the video already
            // survived. The grid draws a placeholder for a video with no poster.
            console.error(`[media] poster for ${m.filename} rejected`, err);
          }
        }
      } finally {
        // Every poster, not just the paired ones: an ignored or unmatched
        // poster is still a temp file, and now that the bytes are no longer
        // read at parse time this sweep is the only thing removing them.
        await Promise.all((req.files?.posters ?? [])
          .map((f) => unlink(f.path).catch(() => {})));
      }

      // attendance_id says where the files landed, which is not the show in
      // the URL when the band sent with them played another stage that day.
      success(res, 201, { created, duplicates, attendance_id: attendanceId });

      // Photo thumbnails after the response, best effort. Twenty files should
      // not leave the browser waiting on image processing, and a missing photo
      // thumbnail is regenerated by the thumb route on first request anyway.
      for (const m of created.filter((r) => r.kind === 'PHOTO')) {
        ensureThumb({ absPath: resolveArchivePath(m.rel_path), kind: m.kind, sha256: m.sha256, relPath: m.rel_path })
          .catch((err) => console.error(`[media] thumbnail for ${m.id} failed`, err));
      }
      return undefined;
    } catch (err) {
      await cleanup();
      return fail(res, err, { context: 'POST /attendances/:attendanceId/media' });
    } finally {
      // Must run on every path. A lock that is taken and not handed back
      // wedges that show's uploads for the life of the process.
      if (releaseShow) releaseShow();
    }
  },
);

module.exports = router;
