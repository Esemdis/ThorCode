/**
 * Pointing a show's folders at the concert it has been moved to (THO-823).
 *
 * Correcting the date of an attended show re-points its attendance at another
 * Concert row; the attendance id, and so every media row, stays. The folders
 * do not move and are not renamed: a folder is chosen once by the first upload
 * and its name is never parsed (utils/mediaShowDir.js). But each folder's
 * sidecar names the concert, and the sidecar is the record of truth that
 * Postgres is rebuilt from. mediaRebuild matches a folder to its attendance by
 * (user_id, concert_id), so a sidecar still naming the old concert would hand
 * every file back to the old show, or to nobody, on the next rebuild.
 */
const { resolveArchivePath } = require('./mediaPaths');
const { updateSidecar } = require('./mediaSidecar');

// Sliced, not reformatted: the same calendar day the upload seeds a sidecar
// with (routes/data/media/shared.js dateOnly).
const dateOnly = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * Rewrite concert_id and the concert block in each folder's sidecar.
 *
 * A folder with no sidecar is left alone: there is nothing in it a rebuild
 * would attach, and writing a fresh one here would claim a folder for a
 * concert with an empty file list. A sidecar already naming the concert is
 * left alone too, so a retry writes nothing twice.
 *
 * Stops at the first failure and throws, with what it had already rewritten
 * on the error as `undo`, so the caller can put those back before it answers.
 *
 * @param {object} args
 * @param {string[]} args.relDirs - folders relative to the archive root
 * @param {number} args.concertId
 * @param {object} args.concert - { concert_date, venue, city, country }
 * @returns {Promise<Array<{absDir: string, previous: object}>>} the undo list
 */
async function retargetSidecars({ relDirs, concertId, concert }) {
  const undo = [];
  try {
    for (const relDir of relDirs) {
      const absDir = resolveArchivePath(relDir);
      let previous = null;
      await updateSidecar(absDir, (current) => {
        if (!current || current.concert_id === concertId) return null;
        previous = current;
        return {
          ...current,
          concert_id: concertId,
          concert: {
            date: concert.concert_date ? dateOnly(concert.concert_date) : null,
            venue: concert.venue,
            city: concert.city,
            country: concert.country,
          },
        };
      });
      if (previous) undo.push({ absDir, previous });
    }
  } catch (err) {
    err.undo = undo;
    throw err;
  }
  return undo;
}

/**
 * Put sidecars back as they were, newest first. Best effort: logged, never
 * thrown, because it runs while the caller is already answering a failure.
 *
 * Only concert_id and the concert block are restored, onto whatever the
 * sidecar holds now: an upload that landed in between keeps its file entry.
 */
async function undoRetarget(undo) {
  for (const { absDir, previous } of [...undo].reverse()) {
    await updateSidecar(absDir, (current) => ({
      ...(current ?? previous), concert_id: previous.concert_id, concert: previous.concert,
    })).catch((err) => console.error(`[media] could not restore the sidecar in ${absDir}`, err));
  }
}

module.exports = { retargetSidecars, undoRetarget };
