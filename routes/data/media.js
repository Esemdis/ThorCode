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
const { fail, badRequest, notFound, forbidden, success } = require('../../utils/apiResponse');
const {
  uniqueFilename, resolveArchivePath, slugSegment, posterPath,
} = require('../../utils/mediaPaths');
const { showDirForAttendance } = require('../../utils/mediaShowDir');
const {
  emptySidecar, upsertFile, removeFile, readSidecar, updateSidecar,
} = require('../../utils/mediaSidecar');
const { kindForMime, MAX_FILE_BYTES } = require('../../utils/mediaTypes');
const { storePoster, ensureThumb } = require('../../utils/mediaThumbs');
const { bandMediaOverview } = require('../../utils/mediaOverview');
const { signMediaToken, verifyMediaToken, mediaUrls } = require('../../utils/mediaTokens');

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
      const posters = new Map();
      for (const poster of req.files?.posters ?? []) {
        posters.set(poster.originalname.replace(/\.webp$/, ''), { buffer: await readFile(poster.path) });
        await unlink(poster.path).catch(() => {});
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
      const existing = await prisma.concertMedia.findMany({
        where: { attendance_id: attendanceId },
        select: { filename: true, rel_path: true },
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
      const pairedPosters = [];
      try {
        for (const file of incoming) {
          const kind = kindForMime(file.mimetype);
          const fileMeta = meta[file.originalname] ?? {};
          const probe = {
            width: asInt(fileMeta.width),
            height: asInt(fileMeta.height),
            duration_ms: kind === 'VIDEO' ? asInt(fileMeta.duration_ms) : null,
          };

          const filename = uniqueFilename([...taken], slugFilename(file.originalname));
          taken.add(filename);
          const absPath = path.join(absDir, filename);
          await rename(file.path, absPath);

          try {
            const sha256 = await sha256File(absPath);
            const { size } = await stat(absPath);

            // taken_at is reserved, not populated. The column, this field and
            // planRebuild's date branch all exist for a later phase that reads
            // EXIF; nothing writes it today, so a null here means "not read
            // yet", never "this photo has no capture time". Reading EXIF is
            // out of scope for this phase — only EXIF *location* is out of
            // scope in the spec, so the field is worth keeping.
            const entry = {
              name: filename, kind, band_id: bandId, band_name: bandId ? onBill.get(bandId) : null,
              // Always present, always null: a fresh upload has no song, and an
              // entry whose shape depends on when it was written is the kind
              // of thing that makes the record of truth hard to read by hand.
              caption: '', song: null, sha256, bytes: size,
              width: probe.width, height: probe.height,
              duration_ms: probe.duration_ms, taken_at: null,
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

      success(res, 201, { created });

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
        orderBy: { id: 'asc' },
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
      const bands = row.concert_rel.bands.map((b) => ({
        id: b.band_rel.id,
        name: b.band_rel.name,
        setlist: b.setlist ?? null,
        recent_setlist: b.band_rel.setlist ?? null,
      }));

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

      if (bandId != null) {
        const onEveryBill = rows.every((r) =>
          r.attendance_rel.concert_rel.bands.some((b) => b.band_rel.id === bandId));
        if (!onEveryBill) return badRequest(res, 'That band is not on every selected show\'s bill');
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

      // Postgres first here, sidecar second — the opposite order from DELETE
      // below, and deliberately so, not an inconsistency. DELETE is
      // irreversible: if its sidecar write failed after the file and the row
      // were already gone, nothing could reconstruct either. A retag is not:
      // if the sidecar write below fails after this transaction commits,
      // Postgres says "tagged" and the sidecar still says the old value, and
      // the next rebuild-from-sidecars simply reverts the tag to what the
      // sidecar remembers. That is a lost edit the caller can redo by
      // retrying the request, not a lost photo.
      await prisma.$transaction(rows.map((r) =>
        prisma.concertMedia.update({ where: { id: r.id }, data: patch })));

      const billName = (r, id) => (id == null ? null
        : r.attendance_rel.concert_rel.bands.find((b) => b.band_rel.id === id)?.band_rel.name ?? null);

      // The sidecar is the record of truth — Postgres is rebuilt from it, never
      // the other way round — so a tag that reaches the database but not here
      // is a tag that silently vanishes on the next rebuild. Rewritten once per
      // affected show rather than once per file, and made from scratch (an
      // absent sidecar file, or a sidecar with no entry yet for this filename)
      // rather than skipped, because a skip here is exactly the kind of write
      // that looks like it worked and was never real.
      const byDir = new Map();
      for (const r of rows) byDir.set(path.posix.dirname(r.rel_path), []);
      for (const r of rows) byDir.get(path.posix.dirname(r.rel_path)).push(r);

      for (const [relDir, dirRows] of byDir) {
        const absDir = resolveArchivePath(relDir);
        const concert = dirRows[0].attendance_rel.concert_rel;
        await updateSidecar(absDir, (current) => {
          let sidecar = current ?? emptySidecar({
            concertId: concert.id,
            userId: dirRows[0].attendance_rel.wishlist_rel.user_id,
            concert: {
              date: dateOnly(concert.concert_date), venue: concert.venue,
              city: concert.city, country: concert.country,
            },
          });
          for (const r of dirRows) {
            // Built from the database row when the sidecar never recorded this
            // file: everything a fresh entry needs — checksum, dimensions,
            // whatever tag it already carried — is already on the row that the
            // upload route itself wrote there.
            const entry = sidecar.files.find((f) => f.name === r.filename) ?? {
              name: r.filename, kind: r.kind,
              band_id: r.band_id, band_name: billName(r, r.band_id),
              caption: r.caption ?? '', song: r.song ?? null, sha256: r.sha256, bytes: r.bytes,
              width: r.width, height: r.height, duration_ms: r.duration_ms,
              taken_at: r.taken_at,
            };
            sidecar = upsertFile(sidecar, {
              ...entry,
              ...(bandId !== undefined && { band_id: bandId, band_name: billName(r, bandId) }),
              ...(req.body.caption !== undefined && { caption: req.body.caption || '' }),
              ...(song !== undefined && { song }),
              ...(bandId === null && { song: null }),
            });
          }
          return sidecar;
        });
      }

      return success(res, 200, { updated: rows.length });
    } catch (err) {
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

    // Resolved before the thumb/poster branch, and outside its try: an
    // archive-escape refusal here is the single most important thing these
    // routes can produce and must reach the outer catch and get logged, not
    // be caught below and mistaken for "this video has no poster".
    const archivePath = resolveArchivePath(row.rel_path);

    let absPath;
    if (which === 'thumb') {
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

    // Immutable: both paths are keyed by content that never changes in place.
    // A replaced photo is a new row with a new id.
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    return res.sendFile(absPath, sendOpts, (err) => {
      if (!err) return;
      // send's ENOENT carries a 404 status, and the global handler keeps an
      // error's message for any status under 500 even in production — which
      // would otherwise hand an absolute archive path on this container back
      // to the browser. The caller is already the verified owner, so this is
      // closing a filesystem-layout leak, not a data leak.
      if (err.code === 'ENOENT') return res.status(404).end();
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
        console.error(`[${new Date().toISOString()}] GET /media/:id/${which} aborted mid-body`, err);
        return res.destroy();
      }
      return fail(res, err, { context: `GET /media/:id/${which}` });
    });
  } catch (err) {
    return fail(res, err, { context: `GET /media/:id/${which}` });
  }
}

router.get('/media/:id/file', (req, res) => serveMedia(req, res, 'file'));
router.get('/media/:id/thumb', (req, res) => serveMedia(req, res, 'thumb'));

module.exports = router;
