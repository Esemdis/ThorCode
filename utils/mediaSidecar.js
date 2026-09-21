/**
 * The tags, stored next to the photos they describe.
 *
 * Postgres is an index that can be dropped and rebuilt. This file is the record
 * of truth, and it travels to Google Drive with the media it describes, so a
 * restore needs nothing but the folder. That is why band_name sits alongside
 * band_id and the concert's date, venue and city are copied in: a restore that
 * can only tell you "band 92" is not a restore.
 */

const { readFile, writeFile, rename, unlink } = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const path = require('node:path');

const SIDECAR_NAME = 'concert-media.json';
const SIDECAR_VERSION = 1;

function emptySidecar({ concertId, userId, concert }) {
  return {
    version: SIDECAR_VERSION,
    concert_id: concertId,
    user_id: userId,
    concert: {
      date: concert.date,
      venue: concert.venue,
      city: concert.city,
      country: concert.country,
    },
    files: [],
  };
}

// Sorted on every write. rclone compares contents, so entries appearing in
// upload order would rewrite and resync a show's sidecar whenever anything in
// it changed position.
const sortFiles = (files) => [...files].sort((a, b) => a.name.localeCompare(b.name));

function upsertFile(sidecar, entry) {
  const rest = sidecar.files.filter((f) => f.name !== entry.name);
  return { ...sidecar, files: sortFiles([...rest, entry]) };
}

function removeFile(sidecar, filename) {
  return { ...sidecar, files: sidecar.files.filter((f) => f.name !== filename) };
}

async function readSidecar(showDirAbs) {
  let raw;
  try {
    raw = await readFile(path.join(showDirAbs, SIDECAR_NAME), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const parsed = JSON.parse(raw);
  // Reading a shape we do not understand and writing rows from it is worse than
  // refusing: a rebuild would overwrite good rows with half-read ones.
  if (parsed.version > SIDECAR_VERSION) {
    throw new Error(`${SIDECAR_NAME} is version ${parsed.version}, this build understands ${SIDECAR_VERSION}`);
  }
  return parsed;
}

/**
 * Write via a temp file and a rename.
 *
 * rename is atomic within a filesystem, so a crash or a full disk leaves either
 * the old sidecar or the new one, never a truncated file. Truncating this
 * particular file loses the tags for a whole show.
 */
async function writeSidecar(showDirAbs, sidecar) {
  const target = path.join(showDirAbs, SIDECAR_NAME);
  // Unique per write, not one name per folder. Deleting eleven files from a
  // show fires eleven requests at once, and with a shared name the first
  // rename moved the temp file out from under the others — six of eleven came
  // back ENOENT, and the rename that did land carried whichever writer's copy
  // happened to be on disk rather than its own.
  const temp = path.join(showDirAbs, `.${SIDECAR_NAME}.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(temp, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
  try {
    await rename(temp, target);
  } catch (err) {
    await unlink(temp).catch(() => {});
    throw err;
  }
}

/**
 * Read, change and write a show's sidecar as one step, serialised per folder.
 *
 * Unique temp names stop the rename collision but not the lost update
 * underneath it: two deletes of the same show both read the file before
 * either writes, so whichever writes last silently reverts the other. The
 * sidecar is the record of truth — Postgres is rebuilt from it — so a lost
 * update here is a photo that the archive still claims exists.
 *
 * The queue is per directory and in-process, which covers the API because it
 * runs as one Node process. A second process writing the same folder at the
 * same time (the rebuild script, say) is still outside it; those are run by
 * hand, not concurrently with a sweep.
 *
 * @param {string} showDirAbs
 * @param {(sidecar: object|null) => object|null} mutate - returning null writes nothing
 */
const tails = new Map();

async function updateSidecar(showDirAbs, mutate) {
  // Chained off the previous holder settling either way. Chaining on success
  // alone would let one failed write wedge every later write to that show.
  const prev = tails.get(showDirAbs) ?? Promise.resolve();
  const result = prev.then(() => {}, () => {}).then(async () => {
    const current = await readSidecar(showDirAbs);
    const next = await mutate(current);
    if (next) await writeSidecar(showDirAbs, next);
    return next;
  });

  const tail = result.then(() => {}, () => {});
  tails.set(showDirAbs, tail);
  // Dropped once this is the last write for the folder, so a long-running
  // process does not accumulate an entry per show it has ever touched.
  tail.then(() => { if (tails.get(showDirAbs) === tail) tails.delete(showDirAbs); });
  return result;
}

module.exports = {
  SIDECAR_NAME, SIDECAR_VERSION,
  emptySidecar, upsertFile, removeFile, readSidecar, writeSidecar, updateSidecar,
};
