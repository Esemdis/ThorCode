/**
 * Pointing a show's sidecars at the concert its attendance was moved to
 * (THO-823).
 *
 * Moving an attendance to another concert row keeps its media rows, because
 * they hang off the attendance id. The sidecars do not: each names the
 * concert_id and the concert's date, venue and city, and mediaRebuild's
 * planRebuild matches a folder back to its attendance by (user_id,
 * concert_id). A sidecar left naming the old concert would hand every file in
 * it back to the old show — or to nobody, once the attendance has moved — on
 * the next rebuild, which is exactly the restore the sidecar exists for.
 *
 * The folders keep their names. A folder's name is chosen once by the first
 * upload (mediaShowDir) and never parsed, so a folder dated the wrong day is
 * cosmetic; renaming it would mean moving every file and companion for no
 * gain the rebuild can see.
 */

const { updateSidecar } = require('./mediaSidecar');
const { resolveArchivePath } = require('./mediaPaths');

const dateOnly = (d) => new Date(d).toISOString().slice(0, 10);

/** Put sidecars back as they were, newest first. Best effort: logged, never thrown. */
async function undoRetarget(done) {
  for (const { absDir, previous } of [...done].reverse()) {
    await updateSidecar(absDir, () => previous)
      .catch((err) => console.error(`[media] could not restore the sidecar in ${absDir}`, err));
  }
}

/**
 * Rewrite the concert in the sidecar of each folder. A folder with no sidecar
 * is left alone: there is nothing in it a rebuild would read, and writing one
 * would claim files the archive does not have. All-or-nothing: a write that
 * fails puts back the ones already done and rethrows.
 *
 * @param {object} args
 * @param {string[]} args.relDirs - archive-relative show folders
 * @param {number} args.concertId - the concert the attendance now points at
 * @param {{concert_date: Date|string, venue: string, city: string, country: string}} args.concert
 * @returns {Promise<Array<{absDir: string, previous: object}>>} what changed, for undoRetarget
 */
async function retargetSidecars({ relDirs, concertId, concert }) {
  const done = [];
  try {
    for (const relDir of relDirs) {
      const absDir = resolveArchivePath(relDir);
      let previous = null;
      await updateSidecar(absDir, (cur) => {
        if (!cur || cur.concert_id === concertId) return null;
        previous = cur;
        return {
          ...cur,
          concert_id: concertId,
          concert: {
            date: concert.concert_date ? dateOnly(concert.concert_date) : null,
            venue: concert.venue,
            city: concert.city,
            country: concert.country,
          },
        };
      });
      if (previous) done.push({ absDir, previous });
    }
  } catch (err) {
    await undoRetarget(done);
    throw err;
  }
  return done;
}

module.exports = { retargetSidecars, undoRetarget };
