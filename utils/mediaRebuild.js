/**
 * Turning an archive back into an index.
 *
 * Postgres holds a convenience copy of what the sidecars already say. This
 * plans the writes that reconstruct it, and — just as importantly — reports the
 * kinds of drift a restore can surface, because an archive that silently
 * disagrees with its index is worse than one that says so.
 *
 * Split from the script so the decisions are testable without a filesystem or a
 * database. collectArchive is the walk; planRebuild is the thinking; the script
 * is just the loop that wires a real Prisma client between them.
 */

const path = require('node:path');
const { readdir } = require('node:fs/promises');
const { readSidecar, SIDECAR_NAME } = require('./mediaSidecar');
const { DETACHED_DIR, slugSegment } = require('./mediaPaths');

// user_id and concert_id together, because ConcertAttendance is
// @@unique([wishlist_id, concert_id]): a concert has one attendance row per
// user, so keying on the concert alone would hand a restore to whichever
// user's row the attendance query happened to return last, and the byte
// routes authorise from that same row's owner.
const attendanceKey = (userId, concertId) => `${userId} ${concertId}`;

const dirsIn = async (abs) =>
  (await readdir(abs, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
const filesIn = async (abs) =>
  (await readdir(abs, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);

/**
 * Walk the archive on disk. Takes the root as an argument, rather than calling
 * archiveRoot() itself, so a test can point it at a temp directory instead of
 * requiring MEDIA_ROOT and a real share.
 */
async function collectArchive(rootAbs) {
  const sidecars = [];
  const filesOnDisk = {};
  const noSidecar = [];

  for (const user of await dirsIn(rootAbs)) {
    for (const show of await dirsIn(path.join(rootAbs, user))) {
      // _detached folders name a concert_id that no longer exists, so there is
      // nothing to re-anchor them to. They stay on disk and in the backup.
      if (show === DETACHED_DIR) continue;

      const relDir = path.posix.join(user, show);
      const absDir = path.join(rootAbs, user, show);
      const data = await readSidecar(absDir);
      // Dotfiles are never media: .concert-media.json.tmp is a write in
      // progress, and .posters holds video poster frames the sidecar doesn't
      // list by design. Counting either as drift would be noise on every run.
      const files = (await filesIn(absDir)).filter((n) => !n.startsWith('.'));
      filesOnDisk[relDir] = files;

      if (data) sidecars.push({ relDir, data });
      // A show with no files yet (a folder created but nothing uploaded) is
      // not drift, just not started.
      else if (files.length > 0) noSidecar.push(relDir);
    }
  }

  return { sidecars, filesOnDisk, noSidecar };
}

function planRebuild({ sidecars, filesOnDisk, attendanceIds }) {
  const upserts = [];
  const missingFiles = [];
  const unlistedFiles = [];
  const unknownConcerts = [];
  const mismatchedUsers = [];

  for (const { relDir, data } of sidecars) {
    // relDir is '<user_id>/<show folder>'. If the folder's owner and the
    // sidecar's own user_id disagree, the archive is internally inconsistent
    // and neither value is safe to trust for an attendance lookup.
    //
    // Compared through slugSegment because that is what showFolderRelPath ran
    // the id through to make the folder in the first place. Against the raw
    // id this matched only by luck: User.id is a String that merely defaults
    // to a uuid, and any id carrying a character the slug rewrites — a
    // federated 'auth0|…', a colon, a leading space — made every one of that
    // user's shows look corrupt and indexed none of their files, which is the
    // worst possible day for a restore to decide the archive is broken.
    if (slugSegment(relDir.split('/')[0]) !== slugSegment(data.user_id)) {
      mismatchedUsers.push({ relDir, sidecar_user: data.user_id });
      continue;
    }

    const present = new Set(filesOnDisk[relDir] ?? []);
    const attendanceId = attendanceIds.get(attendanceKey(data.user_id, data.concert_id));

    if (attendanceId === undefined) {
      // No attendance for this concert. The concert may have been deleted, or
      // this may be a restore onto a database that predates the show. Either
      // way, inventing an attendance would assert the user went somewhere.
      unknownConcerts.push({ relDir, concert_id: data.concert_id, files: data.files.length });
      continue;
    }

    for (const f of data.files) {
      if (!present.has(f.name)) {
        // A row pointing at nothing renders as a broken tile forever, and the
        // file is not coming back from here — reporting it is the only
        // useful thing left to do.
        missingFiles.push(`${relDir}/${f.name}`);
        continue;
      }
      upserts.push({
        attendance_id: attendanceId,
        band_id: f.band_id ?? null,
        rel_path: `${relDir}/${f.name}`,
        filename: f.name,
        kind: f.kind,
        bytes: f.bytes,
        sha256: f.sha256,
        width: f.width ?? null,
        height: f.height ?? null,
        duration_ms: f.duration_ms ?? null,
        caption: f.caption || null,
        taken_at: f.taken_at ? new Date(f.taken_at) : null,
      });
    }

    const listed = new Set(data.files.map((f) => f.name));
    for (const name of present) {
      if (name === SIDECAR_NAME || listed.has(name)) continue;
      // A photo that is safely backed up and completely invisible in the app.
      unlistedFiles.push(`${relDir}/${name}`);
    }
  }

  return { upserts, missingFiles, unlistedFiles, unknownConcerts, mismatchedUsers };
}

module.exports = { attendanceKey, collectArchive, planRebuild };
