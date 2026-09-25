/**
 * What happens to photographs when the concert behind them goes away.
 *
 * ConcertAttendance rows are deleted in four places, and only one of them is
 * the user saying "I did not go to this". The other three are cleanup: an admin
 * deleting a concert, and two orphan sweeps after a band is unlinked or
 * rewritten. Those have every right to remove the concert record and no right
 * at all to remove the only copy of a photograph.
 *
 * So the foreign key restricts, and cleanup calls this first: the show folder
 * moves to _detached, its sidecar intact, and the index rows go. The bytes are
 * still on the share and still sync to Drive. The rebuild script skips
 * _detached, because those sidecars name a concert_id that no longer exists.
 */

const path = require('node:path');
const { mkdir, rename, access } = require('node:fs/promises');
const { archiveRoot, resolveArchivePath, DETACHED_DIR } = require('./mediaPaths');

async function countMediaForAttendances(prisma, attendanceIds) {
  if (!attendanceIds.length) return 0;
  return prisma.concertMedia.count({ where: { attendance_id: { in: attendanceIds } } });
}

/**
 * Which of these concerts a cleanup sweep may actually delete.
 *
 * A concert with no bands left is an orphan and gets swept. A concert someone
 * ATTENDED is not an orphan whatever its bands say — it is a record of a night
 * that happened, and the bands on it are a detail of that record rather than
 * the reason it exists.
 *
 * This is the rule that was missing. Deleting a band unlinks it from every
 * concert and then sweeps whatever is left band-less, with no date filter and
 * no thought for attendance — so a gig someone had been to, and had uploaded a
 * night's photographs to, was swept as debris. The bytes survived, because
 * `detachAttendances` moves the folder to `_detached` rather than deleting it,
 * but the attendance, the concert and every ConcertMedia row went, and the
 * gallery was empty with nothing on screen to say why. The rebuild cannot put
 * it back either: it skips `_detached` by design, and the sidecar in there names
 * a concert_id that no longer exists.
 *
 * A band-less attended concert is a slightly poorer record — its lineup shows
 * only what the scraped metadata remembers. That is a far smaller loss than the
 * night itself, and the next enrich pass can put a lineup back.
 *
 * Deliberately NOT applied to an admin deleting one concert on purpose. That is
 * an instruction rather than a side effect, and `detachAttendances` preserving
 * the bytes is the documented answer to it.
 *
 * @param {object} prisma - client or transaction
 * @param {number[]} concertIds - candidates, already narrowed to the sweep's scope
 * @returns {Promise<number[]>} the subset safe to delete
 */
async function sweepableConcertIds(prisma, concertIds) {
  if (!concertIds.length) return [];
  const rows = await prisma.concert.findMany({
    where: {
      id: { in: concertIds },
      bands: { none: {} },
      attendances: { none: {} },
    },
    select: { id: true },
  });
  return rows.map((c) => c.id);
}

const exists = (p) => access(p).then(() => true, () => false);

// Never overwrite. A repeated detach of a rebuilt row would otherwise destroy
// the folder this function exists to preserve.
async function freeDetachedPath(detachedDir, folderName) {
  const first = path.join(detachedDir, folderName);
  if (!(await exists(first))) return first;
  for (let n = 2; ; n++) {
    const candidate = path.join(detachedDir, `${folderName} (${n})`);
    if (!(await exists(candidate))) return candidate;
  }
}

/**
 * Move every show folder these attendances touch, then drop the rows.
 *
 * Order matters and is not arbitrary: rows are deleted only after every move
 * has succeeded. Deleting the index while the files are still where the index
 * says they are is recoverable by running the rebuild script. Deleting it after
 * a half-finished move is not.
 */
async function detachAttendances(prisma, attendanceIds, { fs = { mkdir, rename }, moved = [] } = {}) {
  if (!attendanceIds.length) return { detached: 0, folders: [] };

  const rows = await prisma.concertMedia.findMany({
    where: { attendance_id: { in: attendanceIds } },
    select: { rel_path: true },
  });
  if (!rows.length) return { detached: 0, folders: [] };

  // rel_path is '<user>/<show folder>/<file>'. The folder is what moves.
  const showDirs = [...new Set(rows.map((r) => path.posix.dirname(r.rel_path)))];

  // This function moves folders but only owns rows, and the two are not the
  // same set. A show folder is normally one attendance's — the upload route
  // settles a show's directory on its first upload and suffixes a name that
  // already belongs to another concert — but a folder whose sidecar was
  // removed by hand is free for the next show to adopt, and then one directory
  // holds two attendances' files. Renaming it would carry a live attendance's
  // photographs into _detached, which collectArchive is designed never to look
  // in: every tile a permanent broken image, and a rebuild reporting no drift
  // at all because it cannot see the folder it would have to complain about.
  // Refusing is loud and recoverable. Moving is silent and is not.
  const strangers = await prisma.concertMedia.findMany({
    where: {
      attendance_id: { notIn: attendanceIds },
      OR: showDirs.map((relDir) => ({ rel_path: { startsWith: `${relDir}/` } })),
    },
    select: { attendance_id: true, rel_path: true },
  });
  if (strangers.length) {
    const { rel_path: relPath, attendance_id: attendanceId } = strangers[0];
    throw new Error(
      `Refusing to detach: ${relPath} belongs to attendance ${attendanceId}, which is staying`,
    );
  }

  const folders = [];
  for (const relDir of showDirs) {
    const absDir = resolveArchivePath(relDir);
    const userSegment = relDir.split('/')[0];
    const folderName = path.posix.basename(relDir);
    const detachedDir = path.join(archiveRoot(), userSegment, DETACHED_DIR);
    await fs.mkdir(detachedDir, { recursive: true });
    const target = await freeDetachedPath(detachedDir, folderName);
    await fs.rename(absDir, target);
    // Recorded as it happens, into an array the CALLER owns, because the
    // moment this matters is the moment nothing is returned: a throw here or
    // a failed statement later in the caller's transaction both discard the
    // return value, and the renames already done are exactly what has to be
    // reversed. See undoDetach.
    moved.push({ from: absDir, to: target });
    folders.push(target);
  }

  await prisma.concertMedia.deleteMany({ where: { attendance_id: { in: attendanceIds } } });
  return { detached: rows.length, folders };
}

/**
 * Put back what a detach moved, after the transaction around it failed.
 *
 * Every caller runs detachAttendances inside an interactive transaction, and
 * deliberately so: a failed delete rolls the ConcertMedia deletion back, which
 * is the recoverable direction. Except that it was not actually recovered.
 * The renames are not transactional, so the rows came back pointing at folders
 * now sitting in _detached — every tile in that show a broken image — and
 * nothing said so, because collectArchive skips _detached by design and the
 * rebuild therefore reports no drift at all. Silent and permanent, from a
 * transaction that reported itself as safely rolled back.
 *
 * Reverse insertion order: a second folder that collided in _detached was
 * suffixed '(2)' because the first had taken the plain name, and unwinding
 * forwards would move the first home and then leave the suffixed one behind.
 *
 * Returns what it could not move rather than throwing. The caller is already
 * unwinding a failure and has its own error to rethrow; a throw here would
 * replace the cause with a symptom. Clears the list so a retry of the same
 * caller cannot move anything twice.
 */
async function undoDetach(moved, { fs = { rename } } = {}) {
  const failed = [];
  for (const { from, to } of [...moved].reverse()) {
    try {
      await fs.rename(to, from);
    } catch (err) {
      failed.push({ from, to, message: err.message });
    }
  }
  moved.length = 0;
  return failed;
}

/**
 * Run a transaction that detaches show folders, and unwind the folders if it
 * fails.
 *
 * All three callers had the same shape and the same hole in it, so the pairing
 * of detach and undo lives here rather than being re-remembered at each site.
 * `run` receives the transaction client and the array to pass detachAttendances
 * as `moved`.
 */
async function withDetach(prisma, run, options) {
  const moved = [];
  try {
    return await prisma.$transaction((tx) => run(tx, moved), options);
  } catch (err) {
    const failed = await undoDetach(moved);
    // Loud, because this is the case nothing else can see: the rows are back,
    // the folders are not, and the rebuild does not look in _detached.
    if (failed.length) {
      console.error('[media] could not put detached folders back after a failed transaction', failed);
    }
    throw err;
  }
}

module.exports = {
  countMediaForAttendances, sweepableConcertIds, detachAttendances, undoDetach, withDetach,
};
