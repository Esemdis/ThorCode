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
  const temp = path.join(showDirAbs, `.${SIDECAR_NAME}.tmp`);
  await writeFile(temp, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
  try {
    await rename(temp, target);
  } catch (err) {
    await unlink(temp).catch(() => {});
    throw err;
  }
}

module.exports = {
  SIDECAR_NAME, SIDECAR_VERSION,
  emptySidecar, upsertFile, removeFile, readSidecar, writeSidecar,
};
