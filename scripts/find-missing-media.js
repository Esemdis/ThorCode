/**
 * Report indexed files that are not in the archive.
 *
 * The gallery shows a tile for every row in the index and asks the byte routes
 * for the picture. When the file behind a row is absent those routes answer 404
 * and the tile is simply blank — no error, nothing in the log, and an archive
 * that looks empty rather than broken. This says which rows those are and, more
 * usefully, which of the two causes each one has:
 *
 *   folder missing  the show was never in THIS archive. `dev` and `prd` share
 *                   one database with different MEDIA_ROOTs, so a night
 *                   uploaded from a workstation cannot be served from the
 *                   container. The bytes have to be copied across; a rebuild
 *                   cannot invent them.
 *   file missing    the show folder is here and one file in it is not. Drift
 *                   inside an archive this deployment owns, which is what
 *                   scripts/rebuild-media-index.js exists to reconcile.
 *
 *   doppler run -- node scripts/find-missing-media.js
 *   doppler run -- node scripts/find-missing-media.js --json
 *
 * It only reports. Deleting a row is a separate, deliberate act — the app's own
 * DELETE route removes the file, the sidecar entry and the row together, and a
 * row deleted here would leave the record of truth still claiming it.
 *
 * Exits non-zero when it finds any, so it is usable from a cron that should
 * complain rather than one that should be ignored.
 */

const fs = require('node:fs/promises');

const prisma = require('../prisma/client');
const { archiveRoot, resolveArchivePath } = require('../utils/mediaPaths');
const { archiveStatus } = require('../utils/mediaHealth');
const { groupMissing, showDir, showLabel } = require('../utils/mediaMissing');

const asJson = process.argv.includes('--json');

/**
 * The absolute path for one archive-relative path, or null when it has none.
 *
 * resolveArchivePath throws on anything that would escape the archive, and that
 * refusal must not take the whole audit down: such a row is the finding, not an
 * excuse to stop looking at the rest.
 */
function safeResolve(relPath) {
  try {
    return resolveArchivePath(relPath);
  } catch {
    return null;
  }
}

const exists = async (absPath) => {
  if (!absPath) return false;
  try {
    await fs.stat(absPath);
    return true;
  } catch {
    return false;
  }
};

async function main() {
  // Asked before anything is counted. With the share unmounted every row in the
  // index is "missing", and a report of four thousand orphans is a wrong answer
  // to the question the operator actually has.
  const archive = await archiveStatus();
  if (!archive.readable || archive.reason === 'empty') {
    console.error(
      `no usable archive at ${archive.root ?? '(MEDIA_ROOT unset)'} (${archive.reason})`
      + ' — is the media share mounted? Nothing is missing until it is.',
    );
    process.exitCode = 1;
    return;
  }

  const rows = await prisma.concertMedia.findMany({
    select: {
      id: true, attendance_id: true, sha256: true, rel_path: true,
      filename: true, bytes: true, kind: true,
      attendance_rel: {
        select: {
          wishlist_rel: { select: { user_id: true } },
          concert_rel: { select: { concert_date: true, venue: true, city: true } },
        },
      },
    },
    orderBy: { id: 'asc' },
  });

  // One stat per folder rather than per file: a festival night is forty rows in
  // one directory, and the answer for all of them is the same.
  const folders = [...new Set(rows.map((row) => showDir(row.rel_path)))];
  const folderPresence = new Map(
    await Promise.all(folders.map(async (dir) => [
      dir,
      await exists(safeResolve(dir)),
    ])),
  );

  const annotated = await Promise.all(rows.map(async (row) => ({
    ...row,
    folderExists: folderPresence.get(showDir(row.rel_path)) === true,
    fileExists: await exists(safeResolve(row.rel_path)),
  })));

  const report = groupMissing(annotated);

  if (asJson) {
    console.log(JSON.stringify({ archive, ...report }, null, 2));
    process.exitCode = report.missing ? 1 : 0;
    return;
  }

  if (!report.missing) {
    console.log(`all ${report.present} indexed files are in ${archiveRoot()}`);
    return;
  }

  const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
  console.log(
    `${report.missing} of ${report.missing + report.present} indexed files are not in`
    + ` ${archiveRoot()} — ${mb(report.bytes)} MB across`
    + ` ${report.shows.length} show${report.shows.length === 1 ? '' : 's'}\n`,
  );

  for (const group of report.shows) {
    const first = group.rows[0];
    const owner = first.attendance_rel?.wishlist_rel?.user_id ?? 'unknown owner';
    const what = group.kind === 'folder_missing'
      ? 'show folder is not in this archive'
      : 'folder is here, these files are not';
    console.log(`${showLabel(first)} — ${group.rows.length} file${group.rows.length === 1 ? '' : 's'},`
      + ` ${mb(group.bytes)} MB — ${what}`);
    console.log(`  owner ${owner}`);
    console.log(`  ${group.dir || '(archive root)'}`);
    for (const row of group.rows) {
      console.log(`    id ${row.id}  ${row.filename}  ${row.kind}`);
    }
    console.log('');
  }

  const stranded = report.shows.filter((g) => g.kind === 'folder_missing');
  const drifted = report.shows.filter((g) => g.kind === 'file_missing');
  if (stranded.length) {
    console.log(
      `${stranded.length} show${stranded.length === 1 ? '' : 's'} not in this archive at all:`
      + ' copy the folder across from whichever MEDIA_ROOT was used to upload it,'
      + ' sidecar and .posters/ included. A rebuild cannot recover these.',
    );
  }
  if (drifted.length) {
    console.log(
      `${drifted.length} show${drifted.length === 1 ? '' : 's'} with drift inside a folder`
      + ' this archive owns: run scripts/rebuild-media-index.js --dry-run.',
    );
  }

  process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
