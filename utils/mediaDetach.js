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
async function detachAttendances(prisma, attendanceIds, { fs = { mkdir, rename } } = {}) {
  if (!attendanceIds.length) return { detached: 0, folders: [] };

  const rows = await prisma.concertMedia.findMany({
    where: { attendance_id: { in: attendanceIds } },
    select: { rel_path: true },
  });
  if (!rows.length) return { detached: 0, folders: [] };

  // rel_path is '<user>/<show folder>/<file>'. The folder is what moves.
  const showDirs = [...new Set(rows.map((r) => path.posix.dirname(r.rel_path)))];

  const folders = [];
  for (const relDir of showDirs) {
    const absDir = resolveArchivePath(relDir);
    const userSegment = relDir.split('/')[0];
    const folderName = path.posix.basename(relDir);
    const detachedDir = path.join(archiveRoot(), userSegment, DETACHED_DIR);
    await fs.mkdir(detachedDir, { recursive: true });
    const target = await freeDetachedPath(detachedDir, folderName);
    await fs.rename(absDir, target);
    folders.push(target);
  }

  await prisma.concertMedia.deleteMany({ where: { attendance_id: { in: attendanceIds } } });
  return { detached: rows.length, folders };
}

module.exports = { countMediaForAttendances, detachAttendances };
