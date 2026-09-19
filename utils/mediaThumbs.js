/**
 * Thumbnails, so the grid is not a wall of full-size phone photos.
 *
 * This matters more here than in most galleries: the archive is served from a
 * home connection, and a grid of forty untouched originals would take long
 * enough to look broken. That is why the thumbnail tier is not optional.
 *
 * Two paths that look alike and are not:
 *
 *   A photo thumbnail is derived from the original, so it is disposable. It is
 *   keyed by the checksum of what it depicts, which means an entry can never be
 *   stale for its key and the whole cache directory can be deleted at any time.
 *
 *   A video poster arrives from the browser that uploaded the video, because
 *   there is no ffmpeg here to decode one. It is therefore NOT reproducible, so
 *   it lives in the archive beside the video and is backed up with it. Deleting
 *   it means losing it.
 *
 * The absence of ffmpeg is deliberate. It would add roughly 250 MB to an image
 * that also serves the travel app, paid on every Watchtower pull, to answer a
 * question the browser had already answered by playing the file.
 */

const { mkdir, rename, unlink, access } = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { thumbPath, thumbCacheRoot, posterPath } = require('./mediaPaths');

// Twice the widest the grid renders a tile, so it stays sharp on a retina
// screen without storing something close to the original.
const THUMB_WIDTH = 480;

const exists = (p) => access(p).then(() => true, () => false);

// Written to a temp name and renamed, for the same reason the sidecar is: a
// half-written image at the final path would be served forever, because neither
// the cache nor the poster folder re-examines a path it already has.
async function writeWebp(bufferOrPath, target) {
  const temp = `${target}.${process.pid}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await sharp(bufferOrPath)
      .rotate()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 78 })
      .toFile(temp);
    await rename(temp, target);
    return target;
  } catch (err) {
    await unlink(temp).catch(() => {});
    throw err;
  }
}

/**
 * Keep the poster frame the browser extracted.
 *
 * The canvas hands over a full-resolution frame, so it is downscaled here
 * rather than stored as-is: at 1920 wide it would put more bytes into the
 * backup than the thumbnail it exists to be.
 */
async function storePoster({ relPath, buffer }) {
  return writeWebp(buffer, posterPath(relPath));
}

/**
 * The thumbnail for one row.
 *
 * A photo generates on demand and caches. A video returns its stored poster and
 * never generates, because there is nothing here that can decode video. A video
 * whose poster extraction failed in the browser throws, and the grid draws a
 * placeholder tile for it rather than waiting on an image that is never coming.
 */
async function ensureThumb({ absPath, kind, sha256, relPath }) {
  if (kind === 'VIDEO') {
    const poster = posterPath(relPath);
    if (await exists(poster)) return poster;
    throw new Error(`no poster stored for ${relPath}`);
  }

  const target = thumbPath(sha256);
  if (await exists(target)) return target;
  await mkdir(thumbCacheRoot(), { recursive: true });
  return writeWebp(absPath, target);
}

module.exports = { THUMB_WIDTH, storePoster, ensureThumb };
