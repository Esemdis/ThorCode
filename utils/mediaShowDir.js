/**
 * Which folder a show's uploads land in.
 *
 * Kept out of mediaPaths.js because this one reads the disk: it has to look at
 * a candidate folder's sidecar before it can say whether that folder belongs to
 * this show. Everything in mediaPaths is pure name arithmetic and is worth
 * keeping that way.
 *
 * Two rules, and both exist because the folder used to be re-derived from
 * mutable data on every single write:
 *
 * 1. A show that already has media keeps the folder its first upload chose.
 *    The derived name is built from the date, the city and the first band on
 *    the bill, and every one of those moves. Adding a support act reorders an
 *    unordered relation read, so the same night's next upload landed in
 *    '2026-06-12 Oslo - Alcest' beside its own '2026-06-12 Oslo - Gojira' —
 *    one gig, two half-full folders in the file browser, and a split that grew
 *    every time the bill or the city string changed.
 *
 * 2. A derived name that already belongs to a different concert gets a ' (n)'
 *    suffix. The name carries no venue on purpose (the spec's ruling: the
 *    folder name is never parsed, so a venue renamed upstream cannot break the
 *    index), which means two attended concerts on one date, in one city, with
 *    one headliner — a duplicate Concert row, or an early and a late show —
 *    derived the *same* folder. The sidecar holds a single scalar concert_id,
 *    so the second show's files were filed under the first at write time and a
 *    rebuild reattributed them with every drift channel empty. The information
 *    was destroyed before the rebuild ever saw it.
 *
 * The ' (n)' idiom is uniqueFilename's, deliberately: a human reading the
 * archive meets the same convention for a second folder as for a second file.
 */

const path = require('node:path');
const { showFolderName, slugSegment, resolveArchivePath } = require('./mediaPaths');
const { readSidecar } = require('./mediaSidecar');

/**
 * A folder is free to adopt when it has no sidecar at all — it may not exist,
 * or it may be a folder someone made by hand. That matches how the upload route
 * already treats a missing sidecar: it writes a fresh one. readSidecar returns
 * null for both cases and throws only on a sidecar it cannot understand, which
 * must not be adopted silently.
 */
async function sidecarOwnerOf(relDir) {
  const data = await readSidecar(resolveArchivePath(relDir));
  return data === null ? null : data.concert_id;
}

/**
 * The directory this attendance's next upload belongs in, relative to the
 * archive root.
 *
 * @param {object} args
 * @param {string|null} args.existingRelPath - rel_path of any file this
 *   attendance already has. Its directory wins outright: the folder is settled
 *   by the first upload and never recomputed.
 * @param {string} args.userId
 * @param {number} args.concertId
 * @param {object} args.show - { date, city, headliner }, as showFolderName takes.
 */
async function showDirForAttendance({ existingRelPath, userId, concertId, show }) {
  if (existingRelPath) return path.posix.dirname(existingRelPath);

  const userSegment = slugSegment(userId);
  const base = showFolderName(show);
  // Unbounded like uniqueFilename's loop, and it terminates for the same
  // reason: a candidate that does not exist yet has no sidecar and is taken.
  for (let n = 1; ; n++) {
    const relDir = path.posix.join(userSegment, n === 1 ? base : `${base} (${n})`);
    const owner = await sidecarOwnerOf(relDir);
    if (owner === null || owner === concertId) return relDir;
  }
}

module.exports = { showDirForAttendance };
