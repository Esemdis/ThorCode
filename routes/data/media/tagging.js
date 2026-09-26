/**
 * Tagging files: the band, the song and the caption, for a whole selection at
 * once — and moving a file to the stage its band played when its own show's
 * bill does not have them.
 *
 * Split out of routes/data/media.js, which had grown to 1715 lines and
 * fourteen endpoints. media.js mounts this and its siblings in their
 * original declaration order — the manifest test in media.test.js pins
 * the resulting surface.
 */
const express = require('express');
const path = require('node:path');
const { mkdir, readdir } = require('node:fs/promises');
const { body, validationResult } = require('express-validator');

const auth = require('../../../auth/verifyJWT');
const roleCheck = require('../../../middlewares/roleCheck');
const prisma = require('../../../prisma/client');
const {
  fail, badRequest, conflict, success,
} = require('../../../utils/apiResponse');
const { uniqueFilename, resolveArchivePath } = require('../../../utils/mediaPaths');
const { showDirForAttendance } = require('../../../utils/mediaShowDir');
const {
  emptySidecar, upsertFile, removeFile, readSidecar, updateSidecar,
} = require('../../../utils/mediaSidecar');
const { festivalSibling, moveFileBytes, undoRenames } = require('../../../utils/mediaRehome');
const { retargetClipRequests } = require('../../../utils/mediaClips');
const {
  dateOnly, headlinerOf, sidecarSeed, billCandidates, refuseRows, lockShows,
} = require('./shared');

const router = express.Router();

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
    // Declared out here so the finally below lets the shows go whichever way
    // the handler leaves.
    let locked = null;
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return badRequest(res, 'Validation failed');

      // Deduped before the count check below: {ids:[5,5]} is one file asked
      // for twice, not two files, and comparing against the raw array length
      // would read the repeat as a missing row and 404 a perfectly good id.
      const ids = [...new Set(req.body.ids.map((n) => parseInt(n, 10)))];
      const readRows = () => prisma.concertMedia.findMany({
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
      // Refused here before waiting on anyone's locks, and again below on the
      // rows read under them, which a concurrent delete may have thinned out.
      const firstRead = await readRows();
      if (refuseRows(res, firstRead, ids, req.user.id)) return undefined;

      const bandId = req.body.band_id === undefined ? undefined
        : req.body.band_id === null ? null : parseInt(req.body.band_id, 10);

      // Every show the file could be moved into, when a band is being set.
      // Read before the locks because it decides which of them to take, and
      // it does not depend on where the files are.
      const candidates = bandId != null ? await billCandidates(req.user.id, bandId) : [];

      // Every show this request can touch is locked before a row is trusted:
      // the ones the files are in, and every one they could be moved into.
      // Only the destinations used to be, and only for a move, so a
      // double-press — or tagging A then B on a festival day — ran the second
      // request against rows read before the first committed. That filed a
      // file moved into A's show under B, where B's band page never looks, or
      // put a file back into the sidecar of the show it had just left.
      locked = await lockShows(firstRead, readRows, (current) => [
        ...current.map((r) => r.attendance_id), ...candidates.map((a) => a.id),
      ]);
      if (!locked) return conflict(res, 'Those files changed while they were being tagged — try again');
      const { rows } = locked;
      if (refuseRows(res, rows, ids, req.user.id)) return undefined;

      // Where each file lives once this is done: its own show, unless the band
      // is not on that show's bill — then the caller's show on the same day in
      // the same city that has the band, which on a festival day is the stage
      // the act played. Moved rather than refused; see utils/mediaRehome.js.
      const homes = new Map();
      if (bandId != null) {
        const strays = rows.filter((r) =>
          !r.attendance_rel.concert_rel.bands.some((b) => b.band_rel.id === bandId));
        for (const r of strays) {
          const home = festivalSibling(r.attendance_rel.concert_rel, candidates);
          // Every file answered before anything moves, like ownership above.
          if (!home) return badRequest(res, 'That band is not on the bill of any show you saw that day');
          homes.set(r.id, home);
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

      const moving = rows.filter((r) => homes.has(r.id));
      const staying = rows.filter((r) => !homes.has(r.id));

      // A move is the one part of a tag that touches the disk, and the one part
      // that is not a single transaction. Each step records how to put itself
      // back, and a failure anywhere up to the database write runs them newest
      // first, so the request stays all-or-nothing.
      const undo = [];
      const placed = new Map();
      try {
        if (moving.length) {
          // Every destination is a candidate, so its lock is already held —
          // the upload route's, which matters because both choose free
          // filenames in a show.
          const homeIds = [...new Set(moving.map((r) => homes.get(r.id).id))].sort((a, b) => a - b);

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
              // A video can carry a share link whose moment has not been cut
              // yet — the request the rendition service is waiting on still
              // names the folder this file just left. Left alone, the service
              // finds nothing there and the link sits at "preparing" forever.
              if (f.r.kind === 'VIDEO') {
                await retargetClipRequests(f.r.rel_path, f.relPath);
                undo.push(() => retargetClipRequests(f.relPath, f.r.rel_path));
              }
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
      }

      // The sidecar is the record of truth — Postgres is rebuilt from it, never
      // the other way round — so a tag that reaches the database but not here
      // is a tag that silently vanishes on the next rebuild. Rewritten once per
      // affected show rather than once per file, and made from scratch (an
      // absent sidecar file, or a sidecar with no entry yet for this filename)
      // rather than skipped, because a skip here is exactly the kind of write
      // that looks like it worked and was never real.
      //
      // Still under the shows' locks, which are let go only in the finally
      // below. Released before this, a second tag could commit a move of the
      // same file in between, and this write would then list it again in the
      // sidecar of the show it had just left.
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
    } finally {
      // Every path out, refusals included. A show left locked wedges its
      // uploads and tags for the life of the process.
      if (locked) locked.release();
    }
  },
);

module.exports = router;
