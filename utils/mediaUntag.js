/**
 * Taking a deleted band's tag off the files that carried it, in the sidecars.
 *
 * Deleting a band SET NULLs band_id on its media rows, but the sidecars — the
 * record of truth, which the index is rebuilt from — kept the old band_id and
 * band_name. The index and the archive then disagreed, and the next rebuild
 * wrote the dead id back and had the whole row refused by the foreign key.
 */

const path = require('node:path');
const { resolveArchivePath } = require('./mediaPaths');
const { updateSidecar } = require('./mediaSidecar');

/**
 * @param {string[]} relPaths - rel_path of every file that was tagged with the band
 * @param {number} bandId
 * @param {{ update?: typeof updateSidecar }} [deps]
 * @returns {Promise<Array<{ dir: string, error: string }>>} the folders that could
 *   not be updated; a rebuild reports and repairs those
 */
async function untagBandInSidecars(relPaths, bandId, { update = updateSidecar } = {}) {
  const dirs = [...new Set(relPaths.map((p) => path.posix.dirname(p)))];
  const failed = [];
  for (const dir of dirs) {
    try {
      await update(resolveArchivePath(dir), (current) => {
        // Gone — a show detached in the same delete, say. Nothing to write.
        if (!current) return null;
        let changed = false;
        const files = current.files.map((f) => {
          if (f.band_id !== bandId) return f;
          changed = true;
          // A song names nobody without its band, so it goes with it.
          return { ...f, band_id: null, band_name: null, song: null };
        });
        return changed ? { ...current, files } : null;
      });
    } catch (err) {
      console.error(`[media] could not untag band ${bandId} in ${dir}`, err);
      failed.push({ dir, error: err.message });
    }
  }
  return failed;
}

module.exports = { untagBandInSidecars };
