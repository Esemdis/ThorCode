/**
 * Taking files out of the archive for good.
 *
 * A photograph is one file on disk. A video is up to four: the original, the
 * poster its uploading browser drew, the web rendition the rendition service
 * made of it, and the marker the service leaves instead when ffmpeg could not
 * read it. All four live inside the show's folder, in the archive that syncs
 * offsite, so any one left behind outlives the video it belonged to — with
 * nothing pointing at it and nothing that will ever remove it.
 *
 * File, then sidecar, then row. A failure partway leaves the index pointing at
 * something that is gone, which the rebuild script reports and repairs. The
 * reverse order leaves a file nothing knows about, which is invisible until
 * someone happens to run a rebuild. That is why this removes files and sidecar
 * entries and leaves the rows to the caller: a row may go only once both of
 * the others have.
 */

const path = require('node:path');
const { unlink } = require('node:fs/promises');
const { resolveArchivePath, posterPath, webRenditionPath } = require('./mediaPaths');
const { FAILED_SUFFIX } = require('./renditionPlan');
const { updateSidecar, removeFile } = require('./mediaSidecar');

// Already gone is the outcome we wanted. Anything else is not.
async function unlinkIfThere(absPath) {
  try {
    await unlink(absPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/**
 * Everything on disk that belongs to one row, the original first.
 *
 * First because it is the file that matters. If a companion then refuses to
 * go, the row stays and a retry finishes the job; a poster removed ahead of an
 * original that would not go is a poster lost for a video that is still there,
 * and nothing on this server can make another.
 */
function filesOf(row) {
  const original = resolveArchivePath(row.rel_path);
  if (row.kind !== 'VIDEO') return [original];
  const rendition = webRenditionPath(original);
  return [original, posterPath(row.rel_path), rendition, `${rendition}${FAILED_SUFFIX}`];
}

// What the client is told. The error's own message names the absolute path on
// this container, so it goes to the log and only the code goes back.
const reason = (what, err) => (err?.code ? `${what} (${err.code})` : what);

/**
 * Remove these rows' files from the archive and their entries from the
 * sidecars.
 *
 * Every row is attempted, and one that fails does not stop the others: a bulk
 * delete refused halfway would leave the caller unable to tell which files had
 * already gone. The rows themselves are the caller's to delete, and only the
 * ones in `removed`.
 *
 * @param {Array<{id: number, rel_path: string, filename: string, kind: string}>} rows
 * @param {{ update?: typeof updateSidecar }} [deps] - replaceable so a test can
 *   count the sidecar writes
 * @returns {Promise<{removed: number[], failed: Array<{id: number, error: string}>}>}
 *   both in the order the rows were given
 */
async function removeMediaFiles(rows, { update = updateSidecar } = {}) {
  const errors = new Map();
  const byDir = new Map();

  for (const row of rows) {
    try {
      const files = filesOf(row);
      for (const file of files) await unlinkIfThere(file);
      const dir = path.dirname(files[0]);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(row);
    } catch (err) {
      console.error(`[media] could not remove the files of ${row.id}`, err);
      errors.set(row.id, reason('Could not remove the file from the archive', err));
    }
  }

  // One write per show folder rather than one per file. Deleting a night's
  // worth is dozens of files in one folder, and each write reads, rewrites and
  // resyncs the whole sidecar.
  for (const [absDir, dirRows] of byDir) {
    try {
      await update(absDir, (sidecar) => (sidecar
        ? dirRows.reduce((next, r) => removeFile(next, r.filename), sidecar)
        : null));
    } catch (err) {
      // The files are gone, but the sidecar still lists them, so the rows stay
      // too: the index and the record of truth then agree on a file that is
      // missing, which a rebuild reports, and a retry of the delete finishes.
      console.error(`[media] could not update the sidecar in ${absDir}`, err);
      for (const r of dirRows) {
        errors.set(r.id, reason('Removed from the archive, but its show\'s sidecar could not be updated', err));
      }
    }
  }

  return {
    removed: rows.filter((r) => !errors.has(r.id)).map((r) => r.id),
    failed: rows.filter((r) => errors.has(r.id)).map((r) => ({ id: r.id, error: errors.get(r.id) })),
  };
}

module.exports = { removeMediaFiles };
