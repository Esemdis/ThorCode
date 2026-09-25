/**
 * Moving a photograph to the show it is actually of.
 *
 * A festival day arrives as several concert rows — Bandsintown is artist-
 * centric and stores one per act — and an upload that names no band lands on
 * whichever of them it was made from. A file lives in exactly one show's
 * folder, and both the band view and a rebuild reach it only through that
 * show, so a file whose show's bill does not name its band is a file the band
 * view cannot find. That is why tagging one used to be refused, and why the
 * sweep said "other show" for every act but the one whose row the night's
 * photographs happened to be uploaded to.
 *
 * Tagging moves the file instead: into the folder of the caller's own show, on
 * the same day in the same city, whose bill does name the band — exactly where
 * picking that band at upload time would have put it.
 */

const path = require('node:path');
const { access, mkdir, rename } = require('node:fs/promises');
const { resolveArchivePath, posterPath, webRenditionPath } = require('./mediaPaths');

const dateOnly = (d) => new Date(d).toISOString().slice(0, 10);
const exists = (p) => access(p).then(() => true, () => false);

/**
 * The show a file tagged with a band belongs in when its own bill lacks the
 * band: one of the caller's attendances on the same calendar day in the same
 * city whose bill has it. Day and city are what the client folds a festival
 * into one night by, so every show in a night is a candidate for every other.
 *
 * Most specific bill first, then lowest id — the rule the client's dayBill
 * routes an upload by, so a file tagged later lands where picking the band at
 * upload would have put it.
 *
 * @param {object} concert - the file's own show: { concert_date, city }
 * @param {object[]} candidates - attendances whose bill has the band, each with
 *   concert_rel: { concert_date, city, bands }
 * @returns {object|null}
 */
function festivalSibling(concert, candidates) {
  if (!concert?.concert_date) return null;
  const day = dateOnly(concert.concert_date);
  const city = concert.city ?? '';
  const sameNight = candidates.filter((a) => a.concert_rel.concert_date
    && dateOnly(a.concert_rel.concert_date) === day
    && (a.concert_rel.city ?? '') === city);
  sameNight.sort((a, b) => (a.concert_rel.bands?.length ?? 0) - (b.concert_rel.bands?.length ?? 0)
    || a.id - b.id);
  return sameNight[0] ?? null;
}

/** Put renames back, newest first. Best effort: logged, never thrown. */
async function undoRenames(done) {
  for (const { from, to } of [...done].reverse()) {
    await rename(to, from).catch((err) => console.error(`[media] could not move ${to} back to ${from}`, err));
  }
}

/**
 * Rename one file into another show's folder, and a video's companions with
 * it. The poster matters most: nothing on this server can make another, so one
 * left behind is lost. The web rendition is only CPU to remake, but a 1 GB clip
 * is minutes of it, so it travels too. Photo thumbnails are keyed by checksum,
 * not path, and need nothing.
 *
 * All-or-nothing for the one file: a companion that fails to move takes the
 * original back with it.
 *
 * @returns {Promise<Array<{from: string, to: string}>>} the renames done, for undoRenames
 */
async function moveFileBytes({ fromRelPath, toRelPath, kind }) {
  const from = resolveArchivePath(fromRelPath);
  const to = resolveArchivePath(toRelPath);
  const done = [];
  try {
    try {
      await rename(from, to);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const missing = new Error(`${path.basename(from)} is no longer in the archive`);
      missing.code = 'MISSING_SOURCE';
      throw missing;
    }
    done.push({ from, to });

    if (kind === 'VIDEO') {
      const companions = [
        [posterPath(fromRelPath), posterPath(toRelPath)],
        [webRenditionPath(from), webRenditionPath(to)],
      ];
      for (const [a, b] of companions) {
        // Checked first rather than caught, so a clip with no poster does not
        // leave an empty .posters folder behind in the show it moved to.
        if (!(await exists(a))) continue;
        await mkdir(path.dirname(b), { recursive: true });
        await rename(a, b);
        done.push({ from: a, to: b });
      }
    }
    return done;
  } catch (err) {
    await undoRenames(done);
    throw err;
  }
}

module.exports = { festivalSibling, moveFileBytes, undoRenames };
