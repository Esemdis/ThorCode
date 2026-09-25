/**
 * Upload photos and video from a show you attended.
 *
 * One route: multipart files land in the archive under the caller's own
 * subtree, get indexed in Postgres, and are recorded in the show's sidecar.
 * No band is attached unless the caller sends one — tagging is a separate
 * bulk sweep from a later view, because a multi-band bill can't be honestly
 * described by one band picked before the files are even looked at.
 */

const express = require('express');
const multer = require('multer');
const crypto = require('node:crypto');
const path = require('node:path');
const { createReadStream } = require('node:fs');
const { mkdir, readdir, rename, unlink, stat, readFile } = require('node:fs/promises');
const { param, body, validationResult } = require('express-validator');

const auth = require('../../auth/verifyJWT');
const roleCheck = require('../../middlewares/roleCheck');
const prisma = require('../../prisma/client');
const {
  fail, badRequest, notFound, forbidden, conflict, success,
} = require('../../utils/apiResponse');
const {
  uniqueFilename, resolveArchivePath, slugSegment, posterPath,
} = require('../../utils/mediaPaths');
const { showDirForAttendance } = require('../../utils/mediaShowDir');
const { capturedAtFor } = require('../../utils/mediaCapture');
const { exifCapturedAtOfFile } = require('../../utils/exifCapturedAt');
const {
  emptySidecar, upsertFile, removeFile, readSidecar, updateSidecar,
} = require('../../utils/mediaSidecar');
const {
  kindForMime, posterProblem, MAX_FILE_BYTES, MAX_FILES_PER_REQUEST,
} = require('../../utils/mediaTypes');
const { uploadErrors } = require('../../utils/uploadErrors');
const { storePoster, ensureThumb } = require('../../utils/mediaThumbs');
const { playableFor } = require('../../utils/mediaRenditions');
const { bandMediaOverview } = require('../../utils/mediaOverview');
const { billForConcert } = require('../../utils/concertBill');
const { canonicalBandName } = require('../../utils/lineupNames');
const { acquire } = require('../../utils/serialQueue');
const { festivalSibling, moveFileBytes, undoRenames } = require('../../utils/mediaRehome');
const { signMediaToken, verifyMediaToken, mediaUrls } = require('../../utils/mediaTokens');
const {
  generateShareToken, shareExpiry, shareUrl, isActiveShareLink,
} = require('../../utils/mediaShareToken');
const { rateLimiter } = require('../../utils/rateLimiter');

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
const INT32_MAX = 2147483647;
const asInt = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > INT32_MAX) return null;
  return Math.round(n);
};

// SMB — the protocol the archive share is actually mounted over — rejects
// several characters ext4 would allow, which is why every other path segment
// in this archive already goes through slugSegment. A browser-supplied
// filename is exactly as untrusted as a venue name and gets the same
// treatment before it becomes one. The extension is kept as-is and out of the
// slug so MAX_SEGMENT truncating a long stem can never eat into it.
function slugFilename(originalName) {
  const ext = path.extname(originalName);
  const stem = originalName.slice(0, originalName.length - ext.length);
  return `${slugSegment(stem)}${ext}`;
}

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
          // The scraped lineup. Support acts nobody has ever wishlisted live
          // only here, as plain strings, and on a festival that is most of
          // the bill.
          metadata: true,
          // Both setlists: `setlist` is what this band played at this show,
          // `band_rel.setlist` the most recent one we have for them anywhere.
          // The upload route shares this helper and needs neither, but a
          // handful of song lists alongside a multi-megabyte upload is not a
          // cost worth a second query to avoid.
          bands: {
            select: {
              band: true,
              setlist: true,
              band_rel: { select: { id: true, name: true, setlist: true } },
            },
          },
        },
      },
    },
  });
  if (!row) return { row: null, owned: false };
  return { row, owned: row.wishlist_rel.user_id === userId };
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

      const attendanceId = parseInt(req.params.attendanceId, 10);
      const { row, owned } = await ownAttendance(attendanceId, req.user.id);
      if (!row) { await cleanup(); return notFound(res, 'Attendance not found'); }
      if (!owned) { await cleanup(); return forbidden(res, 'Forbidden'); }

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

      const bandId = req.body.band_id ? parseInt(req.body.band_id, 10) : null;
      const onBill = new Map(row.concert_rel.bands.map((b) => [b.band_rel.id, b.band_rel.name]));
      // A band that was not on the bill would file a photo under a show the
      // user never saw them at, and the band view would then assert it.
      if (bandId !== null && !onBill.has(bandId)) {
        await cleanup();
        return badRequest(res, 'That band is not on this bill');
      }

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

      const sidecarSeed = {
        concertId: row.concert_rel.id,
        userId: row.wishlist_rel.user_id,
        concert: {
          date: show.date, venue: row.concert_rel.venue,
          city: row.concert_rel.city, country: row.concert_rel.country,
        },
      };
      // Read here only to seed `taken` below. The entries this request adds go
      // onto a fresh read inside updateSidecar, because a second upload to the
      // same show can land between these two points.
      const sidecar = (await readSidecar(absDir)) ?? emptySidecar(sidecarSeed);

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
            let next = current ?? emptySidecar(sidecarSeed);
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

      success(res, 201, { created, duplicates });

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
      const bands = billForConcert({
        bands: row.concert_rel.bands.map((b) => ({
          id: b.band_rel.id,
          name: b.band_rel.name,
          setlist: b.setlist ?? null,
          recent_setlist: b.band_rel.setlist ?? null,
        })),
        metadata: row.concert_rel.metadata,
      });

      return success(res, 200, {
        files: rows.map((m) => ({ ...m, ...mint(m.id) })),
        untagged,
        bands,
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
        media,
        urlFor: urlMinter(req.user.id),
      });

      return success(res, 200, payload);
    } catch (err) {
      return fail(res, err, { context: 'GET /bands/:bandId/media' });
    }
  },
);

/**
 * Put a support act on a concert's bill so photographs can be tagged to them.
 *
 * ConcertMedia.band_id is a foreign key, so an act that exists only as a
 * string in the scraped lineup has nothing to point at. This creates the row
 * it needs — and that is why it is a separate, deliberate call rather than
 * something the tagging routes do quietly on the way past.
 *
 * Band is ONE table shared by every account. A row created here exists for
 * everyone, and the ConcertBandReference puts the act on that night's bill for
 * everyone else who attended, feeding their bands-seen counts. Two guards
 * follow from that: admin only, and only a name the scraper actually recorded
 * for this concert — otherwise one account could put any band on any bill.
 */
router.post(
  '/attendances/:attendanceId/lineup',
  [
    auth, roleCheck(['ADMIN']),
    param('attendanceId').isInt(),
    body('name').isString().isLength({ min: 1, max: 200 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return badRequest(res, 'Validation failed');

      const attendanceId = parseInt(req.params.attendanceId, 10);
      const { row, owned } = await ownAttendance(attendanceId, req.user.id);
      if (!row) return notFound(res, 'Attendance not found');
      if (!owned) return forbidden(res, 'Forbidden');

      const key = canonicalBandName(req.body.name);
      if (!key) return badRequest(res, 'That is not a name');

      const bill = billForConcert({
        bands: row.concert_rel.bands.map((b) => ({ id: b.band_rel.id, name: b.band_rel.name })),
        metadata: row.concert_rel.metadata,
      });
      const entry = bill.find((b) => canonicalBandName(b.name) === key);
      if (!entry) return badRequest(res, "That name is not on this show's scraped lineup");

      // Already has a row and is already on this bill. Answered as success
      // rather than as a conflict: the caller asked for a state that holds.
      if (entry.linked) {
        return success(res, 201, { band: { id: entry.id, name: entry.name }, created: false });
      }

      // Matched canonically against every band, the same comparison
      // enrich-lineup uses. Band.name is unique, so a second "Svalbard" is not
      // untidy but unwritable — and "Svalbard (UK)" off the scraper would be
      // exactly that attempt.
      const all = await prisma.band.findMany({ select: { id: true, name: true } });
      let band = all.find((b) => canonicalBandName(b.name) === key);
      let created = false;
      if (!band) {
        // entry.name, not req.body.name: the bill has already had the
        // scraper's "Counterparts266K Followers" cleaned off it, and this row
        // is permanent and shared.
        band = await prisma.band.create({ data: { name: entry.name, created_at: new Date() } });
        created = true;
      }

      const link = await prisma.concertBandReference.findUnique({
        where: { concert_band: { concert: row.concert_rel.id, band: band.id } },
      });
      if (!link) {
        await prisma.concertBandReference.create({
          data: { concert: row.concert_rel.id, band: band.id },
        });
      }

      return success(res, 201, { band: { id: band.id, name: band.name }, created });
    } catch (err) {
      return fail(res, err, { context: 'POST /attendances/:attendanceId/lineup' });
    }
  },
);

router.patch(
  '/media',
  [
    auth, roleCheck(['ADMIN', 'USER']),
    body('ids').isArray({ min: 1, max: 200 }),
    body('ids.*').isInt(),
    body('band_id').optional({ nullable: true }).isInt(),
    body('caption').optional({ nullable: true }).isString().isLength({ max: 500 }),
    body('song').optional({ nullable: true }).isString().isLength({ max: 200 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return badRequest(res, 'Validation failed');

      // Deduped before the count check below: {ids:[5,5]} is one file asked
      // for twice, not two files, and comparing against the raw array length
      // would read the repeat as a missing row and 404 a perfectly good id.
      const ids = [...new Set(req.body.ids.map((n) => parseInt(n, 10)))];
      const rows = await prisma.concertMedia.findMany({
        where: { id: { in: ids } },
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
      if (rows.length !== ids.length) return notFound(res, 'Some media not found');

      // Checked for every row before anything is written. A list containing one
      // row belonging to someone else must change nothing at all, rather than
      // updating the caller's rows and failing partway.
      if (rows.some((r) => r.attendance_rel.wishlist_rel.user_id !== req.user.id)) {
        return forbidden(res, 'Forbidden');
      }

      const bandId = req.body.band_id === undefined ? undefined
        : req.body.band_id === null ? null : parseInt(req.body.band_id, 10);

      // Where each file lives once this is done: its own show, unless the band
      // is not on that show's bill — then the caller's show on the same day in
      // the same city that has the band, which on a festival day is the stage
      // the act played. Moved rather than refused; see utils/mediaRehome.js.
      const homes = new Map();
      if (bandId != null) {
        const strays = rows.filter((r) =>
          !r.attendance_rel.concert_rel.bands.some((b) => b.band_rel.id === bandId));
        if (strays.length) {
          const candidates = await prisma.concertAttendance.findMany({
            where: {
              wishlist_rel: { user_id: req.user.id },
              concert_rel: { bands: { some: { band: bandId } } },
            },
            select: {
              id: true,
              concert_rel: {
                select: {
                  id: true, concert_date: true, venue: true, city: true, country: true,
                  bands: { select: { band_rel: { select: { id: true, name: true } } } },
                },
              },
            },
          });
          for (const r of strays) {
            const home = festivalSibling(r.attendance_rel.concert_rel, candidates);
            // Every file answered before anything moves, like ownership above.
            if (!home) return badRequest(res, 'That band is not on the bill of any show you saw that day');
            homes.set(r.id, home);
          }
        }
      }

      // Trimmed here rather than at the picker: ' Stranded' and 'Stranded'
      // are the same song, and a stray space would file one video away from
      // the rest of its own take. An empty string is the picker's "No song".
      const song = req.body.song === undefined ? undefined
        : (req.body.song ?? '').trim() || null;

      if (song != null) {
        // A still is not "of" a song the way a recording of one is, and the
        // alternative is a song label on every photo in a festival import.
        if (rows.some((r) => r.kind !== 'VIDEO')) {
          return badRequest(res, 'Only a video can be tagged with a song');
        }
        // A song with no artist names nobody: two bands on one bill can play
        // a song by the same title, and the band view is where a song is read.
        // The band may be arriving in this same request, which is the whole
        // point — tagging an untagged video is one action in the lightbox.
        const bandAfter = (r) => (bandId !== undefined ? bandId : r.band_id);
        if (rows.some((r) => bandAfter(r) == null)) {
          return badRequest(res, 'Tag the band before the song');
        }
      }

      const patch = {
        ...(bandId !== undefined && { band_id: bandId }),
        ...(req.body.caption !== undefined && { caption: req.body.caption || null }),
        ...(song !== undefined && { song }),
        // Clearing the band leaves a song with no artist — exactly the state
        // the guard above refuses to create, so it must not be reachable from
        // the other direction either.
        ...(bandId === null && { song: null }),
      };
      if (!Object.keys(patch).length) return badRequest(res, 'Nothing to change');

      const billName = (concert, id) => (id == null ? null
        : concert.bands.find((b) => b.band_rel.id === id)?.band_rel.name ?? null);
      // Built from the database row when the sidecar never recorded this file:
      // everything a fresh entry needs — checksum, dimensions, whatever tag it
      // already carried — is already on the row that the upload route wrote.
      const entryFor = (r, recorded) => recorded ?? {
        name: r.filename, kind: r.kind,
        band_id: r.band_id, band_name: billName(r.attendance_rel.concert_rel, r.band_id),
        caption: r.caption ?? '', song: r.song ?? null, sha256: r.sha256, bytes: r.bytes,
        width: r.width, height: r.height, duration_ms: r.duration_ms,
        taken_at: r.taken_at,
      };
      // The band's name comes from the bill of the show the file ends up in.
      const changed = (entry, concert) => ({
        ...entry,
        ...(bandId !== undefined && { band_id: bandId, band_name: billName(concert, bandId) }),
        ...(req.body.caption !== undefined && { caption: req.body.caption || '' }),
        ...(song !== undefined && { song }),
        ...(bandId === null && { song: null }),
      });
      const sidecarSeed = (concert, userId) => ({
        concertId: concert.id,
        userId,
        concert: {
          date: dateOnly(concert.concert_date), venue: concert.venue,
          city: concert.city, country: concert.country,
        },
      });

      const moving = rows.filter((r) => homes.has(r.id));
      const staying = rows.filter((r) => !homes.has(r.id));

      // A move is the one part of a tag that touches the disk, and the one part
      // that is not a single transaction. Each step records how to put itself
      // back, and a failure anywhere up to the database write runs them newest
      // first, so the request stays all-or-nothing.
      const undo = [];
      const releases = [];
      const placed = new Map();
      try {
        if (moving.length) {
          const homeIds = [...new Set(moving.map((r) => homes.get(r.id).id))].sort((a, b) => a - b);
          // The lock the upload route takes, since both choose free filenames
          // in a show. Taken in id order, so two requests moving into the same
          // two shows cannot each hold one and wait on the other.
          for (const id of homeIds) releases.push(await acquire(`attendance:${id}`));

          // Planned in full before a single byte moves, so a refusal leaves the
          // archive exactly as it was.
          const plans = [];
          for (const homeId of homeIds) {
            const group = moving.filter((r) => homes.get(r.id).id === homeId);
            const concert = homes.get(group[0].id).concert_rel;
            const existing = await prisma.concertMedia.findMany({
              where: { attendance_id: homeId },
              select: { filename: true, rel_path: true, sha256: true },
              orderBy: { id: 'asc' },
            });
            // The same photograph already in that show, from an upload to both
            // rows. Moving it would put two copies in one night, which the
            // upload route refuses for the same reason — so name them and move
            // nothing.
            const held = new Set(existing.map((e) => e.sha256).filter(Boolean));
            const clashes = [];
            for (const r of group) {
              if (r.sha256 && held.has(r.sha256)) clashes.push(r.filename);
              else if (r.sha256) held.add(r.sha256);
            }
            if (clashes.length) return conflict(res, `Already in that show: ${clashes.join(', ')}`);

            const relDir = await showDirForAttendance({
              existingRelPath: existing[0]?.rel_path ?? null,
              userId: req.user.id,
              concertId: concert.id,
              show: { date: dateOnly(concert.concert_date), city: concert.city, headliner: headlinerOf(concert) },
            });
            const absDir = resolveArchivePath(relDir);
            // Not created yet: a refusal for a later show must not leave an
            // empty folder behind for this one.
            const onDisk = await readdir(absDir).catch((err) => {
              if (err.code === 'ENOENT') return [];
              throw err;
            });
            const recorded = await readSidecar(absDir);
            const taken = new Set([
              ...onDisk, ...existing.map((e) => e.filename), ...(recorded?.files ?? []).map((f) => f.name),
            ]);
            const files = group.map((r) => {
              const filename = uniqueFilename([...taken], r.filename);
              taken.add(filename);
              return { r, filename, relPath: path.posix.join(relDir, filename) };
            });
            plans.push({ homeId, concert, absDir, files });
          }

          // Read before anything moves, so each file's entry travels with it
          // instead of being rebuilt from the row — nothing the sidecar knew
          // about it, a caption edited by hand say, is lost on the way.
          const sources = new Map();
          for (const r of moving) {
            const dir = path.posix.dirname(r.rel_path);
            if (!sources.has(dir)) sources.set(dir, await readSidecar(resolveArchivePath(dir)));
          }

          for (const plan of plans) {
            await mkdir(plan.absDir, { recursive: true });
            for (const f of plan.files) {
              const renames = await moveFileBytes({ fromRelPath: f.r.rel_path, toRelPath: f.relPath, kind: f.r.kind });
              undo.push(() => undoRenames(renames));
              placed.set(f.r.id, { attendance_id: plan.homeId, rel_path: f.relPath, filename: f.filename });
            }
          }

          // The destination's sidecar before the source's: a crash between the
          // two leaves a file both claim, which a rebuild reports, rather than
          // one neither does, which nothing would.
          for (const plan of plans) {
            await updateSidecar(plan.absDir, (current) => {
              let next = current ?? emptySidecar(sidecarSeed(plan.concert, req.user.id));
              for (const f of plan.files) {
                const recorded = sources.get(path.posix.dirname(f.r.rel_path))?.files
                  .find((e) => e.name === f.r.filename);
                next = upsertFile(next, { ...changed(entryFor(f.r, recorded), plan.concert), name: f.filename });
              }
              return next;
            });
            undo.push(() => updateSidecar(plan.absDir, (current) => (current
              ? plan.files.reduce((sc, f) => removeFile(sc, f.filename), current) : null)));
          }
          for (const dir of sources.keys()) {
            const names = moving.filter((r) => path.posix.dirname(r.rel_path) === dir).map((r) => r.filename);
            let removed = [];
            await updateSidecar(resolveArchivePath(dir), (current) => {
              if (!current) return null;
              removed = current.files.filter((e) => names.includes(e.name));
              return names.reduce((sc, name) => removeFile(sc, name), current);
            });
            undo.push(() => updateSidecar(resolveArchivePath(dir), (current) => (current
              ? removed.reduce((sc, e) => upsertFile(sc, e), current) : null)));
          }
        }

        // Postgres first for a file that stays put, sidecar second — the
        // opposite order from DELETE below, and deliberately so. DELETE is
        // irreversible: if its sidecar write failed after the file and the row
        // were already gone, nothing could reconstruct either. A retag is not:
        // if the sidecar write below fails after this transaction commits, the
        // next rebuild-from-sidecars simply reverts the tag to what the sidecar
        // remembers — a lost edit the caller can redo, not a lost photo.
        //
        // A moved file is the other way round, because its sidecar entries
        // are already written by now. If this transaction fails, the undo
        // steps put the file and both sidecars back, rather than leaving the
        // index pointing at the folder the file has just left.
        await prisma.$transaction(rows.map((r) =>
          prisma.concertMedia.update({ where: { id: r.id }, data: { ...patch, ...placed.get(r.id) } })));
      } catch (err) {
        for (const step of undo.reverse()) {
          await step().catch((e) => console.error('[media] could not undo part of a move', e));
        }
        throw err;
      } finally {
        for (const release of releases) release();
      }

      // The sidecar is the record of truth — Postgres is rebuilt from it, never
      // the other way round — so a tag that reaches the database but not here
      // is a tag that silently vanishes on the next rebuild. Rewritten once per
      // affected show rather than once per file, and made from scratch (an
      // absent sidecar file, or a sidecar with no entry yet for this filename)
      // rather than skipped, because a skip here is exactly the kind of write
      // that looks like it worked and was never real.
      const byDir = new Map();
      for (const r of staying) byDir.set(path.posix.dirname(r.rel_path), []);
      for (const r of staying) byDir.get(path.posix.dirname(r.rel_path)).push(r);

      for (const [relDir, dirRows] of byDir) {
        const concert = dirRows[0].attendance_rel.concert_rel;
        await updateSidecar(resolveArchivePath(relDir), (current) => {
          let sidecar = current
            ?? emptySidecar(sidecarSeed(concert, dirRows[0].attendance_rel.wishlist_rel.user_id));
          for (const r of dirRows) {
            const recorded = sidecar.files.find((f) => f.name === r.filename);
            sidecar = upsertFile(sidecar, changed(entryFor(r, recorded), concert));
          }
          return sidecar;
        });
      }

      return success(res, 200, { updated: rows.length, moved: placed.size });
    } catch (err) {
      // The archive lost a file the index still has. Said as what it is, not
      // as "Something went wrong": a rebuild is what repairs it.
      if (err.code === 'MISSING_SOURCE') return conflict(res, err.message);
      return fail(res, err, { context: 'PATCH /media' });
    }
  },
);

router.delete(
  '/media/:id',
  [auth, roleCheck(['ADMIN', 'USER']), param('id').isInt()],
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const row = await prisma.concertMedia.findUnique({
        where: { id },
        include: { attendance_rel: { include: { wishlist_rel: { select: { user_id: true } } } } },
      });
      if (!row) return notFound(res, 'Media not found');
      if (row.attendance_rel.wishlist_rel.user_id !== req.user.id) return forbidden(res, 'Forbidden');

      // File, then sidecar, then row. A failure partway leaves the index
      // pointing at something that is gone, which the rebuild script reports
      // and repairs. The reverse order leaves a file nothing knows about, which
      // is invisible until someone happens to run a rebuild.
      const absPath = resolveArchivePath(row.rel_path);
      await unlink(absPath).catch((err) => {
        // Already gone is the outcome we wanted. Anything else is not.
        if (err.code !== 'ENOENT') throw err;
      });

      // A video's poster lives beside it in the archive rather than in the
      // derived-thumbnail cache, because there is no ffmpeg here to make
      // another one from the video. Left behind, it is a frame from a video
      // that no longer exists, syncing to Drive forever with nothing to point
      // it at.
      if (row.kind === 'VIDEO') {
        await unlink(posterPath(row.rel_path)).catch((err) => {
          if (err.code !== 'ENOENT') throw err;
        });
      }

      const absDir = path.dirname(absPath);
      await updateSidecar(absDir, (sidecar) => (sidecar ? removeFile(sidecar, row.filename) : null));

      await prisma.concertMedia.delete({ where: { id } });
      return success(res, 200, { deleted: true });
    } catch (err) {
      return fail(res, err, { context: 'DELETE /media/:id' });
    }
  },
);

// Answers the response itself and returns null when the caller may not share
// this file, so both share routes stop at the same place for the same reasons.
async function ownedMediaForShare(req, res) {
  const row = await prisma.concertMedia.findUnique({
    where: { id: parseInt(req.params.id, 10) },
    include: { attendance_rel: { include: { wishlist_rel: { select: { user_id: true } } } } },
  });
  if (!row) { notFound(res, 'Media not found'); return null; }
  if (row.attendance_rel.wishlist_rel.user_id !== req.user.id) { forbidden(res, 'Forbidden'); return null; }
  return row;
}

/**
 * Get-or-create the public link to one file.
 *
 * Idempotent: while a link is live, asking again hands back that same link
 * rather than minting a second one, so a file never has two URLs out in the
 * world at once and there is no need for a separate "what is my link" GET.
 */
router.post(
  '/media/:id/share',
  [auth, roleCheck(['ADMIN', 'USER']), param('id').isInt()],
  async (req, res) => {
    try {
      if (!validationResult(req).isEmpty()) return badRequest(res, 'Invalid media id');
      const media = await ownedMediaForShare(req, res);
      if (!media) return undefined;

      const now = new Date();
      let link = await prisma.mediaShareLink.findFirst({
        where: { media_id: media.id, revoked_at: null, expires_at: { gt: now } },
        orderBy: { created_at: 'desc' },
      });
      if (!link) {
        link = await prisma.mediaShareLink.create({
          data: { media_id: media.id, token: generateShareToken(), expires_at: shareExpiry(now) },
        });
      }

      return success(res, 200, {
        url: shareUrl(process.env.CALLBACK_URL, link.token),
        expires_at: link.expires_at,
      });
    } catch (err) {
      return fail(res, err, { context: 'POST /media/:id/share' });
    }
  },
);

// Revokes every live link to the file. updateMany rather than one row by id,
// so revoking a file with nothing live is a quiet no-op instead of a 404.
router.delete(
  '/media/:id/share',
  [auth, roleCheck(['ADMIN', 'USER']), param('id').isInt()],
  async (req, res) => {
    try {
      if (!validationResult(req).isEmpty()) return badRequest(res, 'Invalid media id');
      const media = await ownedMediaForShare(req, res);
      if (!media) return undefined;

      await prisma.mediaShareLink.updateMany({
        where: { media_id: media.id, revoked_at: null },
        data: { revoked_at: new Date() },
      });
      return res.status(204).end();
    } catch (err) {
      return fail(res, err, { context: 'DELETE /media/:id/share' });
    }
  },
);

/**
 * The two routes that serve bytes.
 *
 * Deliberately no `auth` middleware. An <img src> and a <video src> issue their
 * own requests and cannot attach an Authorization header, so these authenticate
 * on the signed token in the query string instead. The token carries the media
 * id, so one valid URL unlocks one file and not the archive.
 *
 * res.sendFile goes through `send`, which already implements Range and
 * conditional gets. That is the whole of video seeking support.
 */
async function serveMedia(req, res, which) {
  try {
    // A plain parseInt accepts '1abc' as 1 and would serve media 1 under a
    // path meant to 404. Not exploitable on its own — the token still has to
    // be signed for that id — but the param should mean what it looks like.
    if (!/^[1-9]\d*$/.test(req.params.id)) return res.status(400).end();
    const mediaId = parseInt(req.params.id, 10);

    const verdict = verifyMediaToken(req.query.t, { mediaId });
    if (!verdict.ok) {
      console.warn(`[media] refused ${mediaId}: ${verdict.reason}`);
      return res.status(401).end();
    }

    const row = await prisma.concertMedia.findUnique({
      where: { id: mediaId },
      include: { attendance_rel: { include: { wishlist_rel: { select: { user_id: true } } } } },
    });
    if (!row) return res.status(404).end();
    // Ownership is re-checked against the database, not taken from the token.
    // A token stays valid for six hours, and the file may have changed hands or
    // been detached in that time.
    if (row.attendance_rel.wishlist_rel.user_id !== verdict.userId) return res.status(403).end();

    return await sendMediaBytes(res, row, which, `GET /media/:id/${which}`);
  } catch (err) {
    return fail(res, err, { context: `GET /media/:id/${which}` });
  }
}

/**
 * Stream one row's bytes, once the caller has been authorized by whatever
 * means its route uses. Shared by the owner-token routes above and the public
 * share route below, so both get the same confinement, caching and
 * mid-body-abort handling.
 *
 * Throws on an archive-escape refusal; the caller's catch logs it.
 *
 * `cacheControl` overrides the header below for a caller whose authorization
 * can end before the bytes change — see the share route.
 */
async function sendMediaBytes(res, row, which, context, { cacheControl } = {}) {
  // Resolved before the thumb/poster branch, and outside its try: an
  // archive-escape refusal here is the single most important thing these
  // routes can produce and must reach the outer catch and get logged, not
  // be caught below and mistaken for "this video has no poster".
  const archivePath = resolveArchivePath(row.rel_path);

  let absPath;
  // A rendition that appears later must not be masked by a year-old cached
  // original, so `immutable` is only claimed once there is nothing left to
  // supersede. See the Cache-Control below.
  let servingOriginalForPlayback = false;
  if (which === 'play') {
    const chosen = await playableFor(archivePath, row.kind);
    absPath = chosen.absPath;
    servingOriginalForPlayback = !chosen.rendition && row.kind === 'VIDEO';
  } else if (which === 'thumb') {
    try {
      absPath = await ensureThumb({
        absPath: archivePath, kind: row.kind, sha256: row.sha256, relPath: row.rel_path,
      });
    } catch (err) {
      if (err.code !== 'NO_POSTER' && err.code !== 'NO_SOURCE') throw err;
      // A video whose poster extraction failed in the browser has none, and
      // nothing here can decode one. NO_SOURCE is the same answer for a
      // photo whose original is gone, which is what the file route already
      // says about the same row. 404 so the grid draws its placeholder
      // rather than retrying an image that is never coming.
      return res.status(404).end();
    }
  } else {
    absPath = archivePath;
  }

  // `send` defaults to dotfiles: 'ignore' and 404s a path with a dot segment
  // regardless of permissions. A poster lives at <show>/.posters/<name>.webp,
  // so without this every video thumb was a silent placeholder even with the
  // poster sitting right there on disk. It applies to the file route too,
  // and for a reason that has nothing to do with posters: with no `root`
  // option set, send tests every segment of the ABSOLUTE path, so a single
  // dot directory anywhere in MEDIA_ROOT turns every download in the archive
  // into a 404. resolveArchivePath has already confined the path by this
  // point, so send's dotfile heuristic guards nothing here and only breaks
  // deploys whose mount happens to sit under a hidden directory.
  const sendOpts = { dotfiles: 'allow' };

  // Immutable: these paths are keyed by content that never changes in place.
  // A replaced photo is a new row with a new id.
  //
  // Except one case. /play serves the original until the rendition service
  // reaches that clip, and then serves the rendition from the same URL — so
  // telling the browser to keep the original for a year would hide the
  // rendition behind a cache entry nothing can invalidate. Five minutes keeps
  // a scroll cheap and lets the better copy arrive.
  res.set('Cache-Control', cacheControl ?? (servingOriginalForPlayback
    ? 'private, max-age=300'
    : 'private, max-age=31536000, immutable'));
  return res.sendFile(absPath, sendOpts, (err) => {
    if (!err) return;
    // send's ENOENT carries a 404 status, and the global handler keeps an
    // error's message for any status under 500 even in production — which
    // would otherwise hand an absolute archive path on this container back
    // to the browser. The caller is already authorized for this file, so this
    // is closing a filesystem-layout leak, not a data leak.
    if (err.code === 'ENOENT') {
      // The immutable Cache-Control below is set before sendFile runs, so
      // without this it is still on the response when this 404 goes out —
      // and the browser is told to remember the miss for a year. The
      // condition that produces it is usually transient (a share that
      // dropped, or mounted late after a restart), so every tile looked at
      // during the outage stayed broken long after it ended.
      res.removeHeader('Cache-Control');
      return res.status(404).end();
    }
    // Passing a callback here opts out of Express's own next(err) handling
    // (see res.sendFile's source: "if (done) return done(err)"), so
    // anything past ENOENT has to be logged and answered here, not thrown —
    // this runs after the surrounding try/catch has already returned.
    //
    // Opting out also loses the res.headersSent guard that Express's default
    // error handler applies, and that is the half that bites. Every error
    // send reports mid-body arrives after the headers: the common one is a
    // client that closed the tab or seeked in a video, which send reports as
    // "Request aborted". Calling fail() there tried to write a second
    // response, threw ERR_HTTP_HEADERS_SENT from inside send's own callback
    // where nothing catches it, and index.js answers uncaughtException with
    // process.exit(1) — so one viewer scrubbing a video took the whole API
    // down with it, on a feature whose stated premise is a flaky home
    // connection. Once the response is committed the only honest move is to
    // log it and drop the socket.
    if (res.headersSent) {
      console.error(`[${new Date().toISOString()}] ${context} aborted mid-body`, err);
      return res.destroy();
    }
    return fail(res, err, { context });
  });
}

router.get('/media/:id/file', (req, res) => serveMedia(req, res, 'file'));
// The viewing copy: the web rendition when one has been made, the original
// until then. Separate from /file so a download always gets the master.
router.get('/media/:id/play', (req, res) => serveMedia(req, res, 'play'));
router.get('/media/:id/thumb', (req, res) => serveMedia(req, res, 'thumb'));

/**
 * A share link, opened by someone with no account.
 *
 * Unknown, revoked and expired all answer 404, never 403 — the calendar feed's
 * rule, for the same reason: a different answer would confirm the token
 * exists.
 *
 * Always the /play copy, for either kind: for a photograph that is the
 * original, and for a video it is the web rendition when there is one. The
 * link has to just work when a browser is pointed straight at it, and a 4K
 * HEVC master does not.
 *
 * no-store, not the byte routes' year-long immutable: the link is meant to
 * stop working, and a cached copy would keep opening in the recipient's
 * browser after it had been revoked.
 */
const shareLimiter = rateLimiter({
  message: 'Too many requests for this link, please try again later.',
  windowMs: 60 * 60 * 1000,
  max: 300,
});

async function servePublicShare(req, res) {
  try {
    const link = await prisma.mediaShareLink.findUnique({ where: { token: req.params.token } });
    if (!isActiveShareLink(link)) return res.status(404).end();

    const row = await prisma.concertMedia.findUnique({ where: { id: link.media_id } });
    if (!row) return res.status(404).end();

    return await sendMediaBytes(res, row, 'play', 'GET /media/share/:token', {
      cacheControl: 'private, no-store',
    });
  } catch (err) {
    return fail(res, err, { context: 'GET /media/share/:token' });
  }
}

router.get('/media/share/:token', shareLimiter, servePublicShare);

module.exports = router;
