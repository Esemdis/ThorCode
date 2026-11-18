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

/**
 * Moving a merged band's tag onto the band that survived, in the sidecars
 * (THO-999). Same reason as above: the rebuild reads band_id from here, and
 * the source's id no longer exists, so every such file would be refused by
 * the foreign key. band_name follows the id, or a restore names the old
 * spelling. The song stays: it is the same artist's song.
 *
 * @param {string[]} relPaths - rel_path of every file that was tagged with the source
 * @param {number} fromId - the merged-away band
 * @param {{ id: number, name: string }} to - the survivor
 * @param {{ update?: typeof updateSidecar }} [deps]
 * @returns {Promise<Array<{ dir: string, error: string }>>} the folders that could not be updated
 */
async function retagBandInSidecars(relPaths, fromId, to, { update = updateSidecar } = {}) {
  const dirs = [...new Set(relPaths.map((p) => path.posix.dirname(p)))];
  const failed = [];
  for (const dir of dirs) {
    try {
      await update(resolveArchivePath(dir), (current) => {
        if (!current) return null;
        let changed = false;
        const files = current.files.map((f) => {
          if (f.band_id !== fromId) return f;
          changed = true;
          return { ...f, band_id: to.id, band_name: to.name };
        });
        return changed ? { ...current, files } : null;
      });
    } catch (err) {
      console.error(`[media] could not retag band ${fromId} as ${to.id} in ${dir}`, err);
      failed.push({ dir, error: err.message });
    }
  }
  return failed;
}

module.exports = { untagBandInSidecars, retagBandInSidecars };
