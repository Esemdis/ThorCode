/**
 * Turning an archive back into an index.
 *
 * Postgres holds a convenience copy of what the sidecars already say. This
 * plans the writes that reconstruct it, and — just as importantly — reports the
 * kinds of drift a restore can surface, because an archive that silently
 * disagrees with its index is worse than one that says so.
 *
 * Split from the script so the decisions are testable without a filesystem or a
 * database. collectArchive is the walk, planRebuild is the thinking, and
 * applyUpserts is the write — the last one lives here rather than in the script
 * because what it does with a row Postgres refuses is a decision too, and the
 * script is not something the suite can import without running it.
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

  // An archive root that is not there is an ordinary state, not a crash: the
  // rebuild may be running before the first upload, or — the case that
  // matters — against a share that failed to mount. An operator staring at a
  // stack trace has to work out that "there is nothing here, check the mount"
  // is what it meant. Only ENOENT is swallowed; a permission error is a real
  // fault and still throws.
  let users;
  try {
    users = await dirsIn(rootAbs);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return { sidecars, filesOnDisk, noSidecar, archiveMissing: true };
  }

  for (const user of users) {
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

  return { sidecars, filesOnDisk, noSidecar, archiveMissing: false };
}

/**
 * Why this entry cannot become a row, or null if it can.
 *
 * The sidecar is a text file the spec deliberately invites a human to read and
 * touch, which makes its fields exactly as untrusted as request input. An entry
 * with a quoted number or a deleted `kind` used to be passed through verbatim
 * and rejected by Prisma at insert time — on restore day, the only day this
 * script runs — where it stopped the upsert loop and left every show after it
 * in walk order unindexed, under a stack trace.
 *
 * The columns are checked against the schema, not against taste: `kind` is a
 * non-null enum, `bytes` and `sha256` are non-null, and width/height/duration
 * are nullable integers.
 */
const numberOrAbsent = (v) => v === undefined || v === null
  || (typeof v === 'number' && Number.isFinite(v));

function entryProblem(f) {
  if (typeof f.name !== 'string' || f.name.trim() === '') return 'name is not a non-empty string';
  if (f.kind !== 'PHOTO' && f.kind !== 'VIDEO') return `kind is ${JSON.stringify(f.kind)}, not PHOTO or VIDEO`;
  if (typeof f.bytes !== 'number' || !Number.isFinite(f.bytes)) return 'bytes is not a finite number';
  if (typeof f.sha256 !== 'string' || f.sha256 === '') return 'sha256 is not a non-empty string';
  for (const key of ['width', 'height', 'duration_ms']) {
    if (!numberOrAbsent(f[key])) return `${key} is neither a finite number nor null`;
  }
  return null;
}

function planRebuild({ sidecars, filesOnDisk, attendanceIds }) {
  const upserts = [];
  const missingFiles = [];
  const unlistedFiles = [];
  const unknownConcerts = [];
  const mismatchedUsers = [];
  const malformedEntries = [];

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
      // Checked before anything else about the entry: a bad one is bad whether
      // or not its file is on disk, and reporting it as a missing file would
      // send the operator looking for the wrong thing.
      const problem = entryProblem(f);
      if (problem) {
        malformedEntries.push({ relDir, name: f.name, reason: problem });
        continue;
      }
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
        // `|| null` rather than `?? null`: every sidecar written before songs
        // existed has no key here at all, and an undefined reaching Prisma
        // means "leave it alone" on an update rather than "no song".
        song: f.song || null,
        taken_at: f.taken_at ? new Date(f.taken_at) : null,
      });
    }

    // Listed by name regardless of whether the entry validated: a file a
    // malformed entry names is accounted for, and reporting it a second time
    // as unlisted would be two complaints about one problem.
    const listed = new Set(data.files.map((f) => f.name));
    for (const name of present) {
      if (name === SIDECAR_NAME || listed.has(name)) continue;
      // A photo that is safely backed up and completely invisible in the app.
      unlistedFiles.push(`${relDir}/${name}`);
    }
  }

  return { upserts, missingFiles, unlistedFiles, unknownConcerts, mismatchedUsers, malformedEntries };
}

/**
 * Write the plan, and keep going when a row will not go in.
 *
 * A bare `for ... await` let one rejected row propagate out of the script's
 * main(), which stopped the loop and left every show after it in walk order
 * unindexed. That is a partial index plus a stack trace on restore day — the
 * only day this runs — and it is strictly worse than an index that is complete
 * apart from the rows it names.
 */
async function applyUpserts(prisma, upserts) {
  const rejected = [];
  for (const row of upserts) {
    try {
      await prisma.concertMedia.upsert({
        where: { attendance_id_filename: { attendance_id: row.attendance_id, filename: row.filename } },
        create: row,
        update: row,
      });
    } catch (err) {
      rejected.push({ rel_path: row.rel_path, reason: err.message });
    }
  }
  return { indexed: upserts.length - rejected.length, rejected };
}

module.exports = { attendanceKey, collectArchive, planRebuild, applyUpserts };
