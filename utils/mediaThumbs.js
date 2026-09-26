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
 * A photo's display copy — what the lightbox shows — is the first kind again,
 * only bigger: derived, keyed by checksum, and just as safe to delete.
 *
 * The absence of ffmpeg is deliberate. It would add roughly 250 MB to an image
 * that also serves the travel app, paid on every Watchtower pull, to answer a
 * question the browser had already answered by playing the file.
 */

const { mkdir, rename, unlink, access } = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const {
  thumbPath, thumbCacheRoot, posterPath, slugSegment,
} = require('./mediaPaths');

// Twice the widest the grid renders a tile, so it stays sharp on a retina
// screen without storing something close to the original.
const THUMB_WIDTH = 480;

const THUMB_OUTPUT = { resize: { width: THUMB_WIDTH, withoutEnlargement: true }, quality: 78 };

// The long edge of the copy the lightbox shows. A phone original is 12 to 50
// megapixels and several megabytes — most of a second per photograph over a
// home uplink, and the lightbox is paged through quickly — for detail no screen
// shows at once. 2048 fills a large desktop monitor. Fitted inside a square
// rather than capped on width alone, so a portrait shot is bounded by its
// height, and a notch above the thumbnail's quality because this one is looked
// at up close.
const DISPLAY_EDGE = 2048;

const DISPLAY_OUTPUT = {
  resize: { width: DISPLAY_EDGE, height: DISPLAY_EDGE, fit: 'inside', withoutEnlargement: true },
  quality: 82,
};

// In the same disposable cache as the thumbnails, beside them, and keyed the
// same way: by the checksum of the photograph it depicts.
function displayPath(sha256) {
  return path.join(path.dirname(thumbCacheRoot()), 'display', `${slugSegment(sha256)}.webp`);
}

const exists = (p) => access(p).then(() => true, () => false);

// Tagged so a byte route can tell a photograph that is no longer on disk apart
// from every other failure; see ensureThumb for why that one gets a 404.
function missingOriginal(absPath) {
  const err = new Error(`no original at ${absPath}`);
  err.code = 'NO_SOURCE';
  return err;
}

// Written to a temp name and renamed, for the same reason the sidecar is: a
// half-written image at the final path would be served forever, because neither
// the cache nor the poster folder re-examines a path it already has. The pid
// alone is not enough to make the temp name unique: a retrying upload client
// on a flaky home connection can produce two concurrent calls for the same
// key from the same process, and a shared temp path means the loser's rename
// throws ENOENT after the winner already moved it. The random nonce is what
// keeps two concurrent writes of the same key from colliding on one temp path.
//
// rotate() with no angle applies the EXIF orientation, which a phone uses to
// store a portrait shot as landscape pixels. The output carries no EXIF, so
// without it every such photograph would be served lying on its side.
async function writeWebp(bufferOrPath, target, { resize, quality } = THUMB_OUTPUT) {
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await sharp(bufferOrPath)
      .rotate()
      .resize(resize)
      .webp({ quality })
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
 *
 * `source` is a Buffer or a path, whichever the caller has. The upload route
 * passes a path so a batch of posters never lands in the heap at once.
 */
async function storePoster({ relPath, source }) {
  return writeWebp(source, posterPath(relPath));
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
    // Tagged so the thumb route can tell "no poster, draw a placeholder" apart
    // from every other failure — an archive-escape refusal must not be
    // swallowed as this one expected case.
    const err = new Error(`no poster stored for ${relPath}`);
    err.code = 'NO_POSTER';
    throw err;
  }

  const target = thumbPath(sha256);
  if (await exists(target)) return target;
  // Tagged like NO_POSTER above, and for the same reason. An original that has
  // gone missing is ordinary archive drift, not a server fault: the file route
  // already answers it with a bare 404, and the thumb route said 500 with
  // sharp's own "Input file is missing: <absolute path>" as the message. That
  // path only escapes to the client outside production, but the status is
  // wrong everywhere, and a normal state that logs as a 500 buries the ones
  // that are not.
  if (!await exists(absPath)) throw missingOriginal(absPath);
  await mkdir(thumbCacheRoot(), { recursive: true });
  return writeWebp(absPath, target);
}

/**
 * The copy of a photograph the lightbox shows, made on first request and
 * cached like a thumbnail.
 *
 * Photographs only. A video's viewing copy is its web rendition, which the
 * rendition service makes and nothing here can.
 *
 * An original that is gone throws NO_SOURCE, as ensureThumb does, so the route
 * answers it the same way.
 */
async function ensureDisplay({ absPath, sha256 }) {
  const target = displayPath(sha256);
  if (await exists(target)) return target;
  if (!await exists(absPath)) throw missingOriginal(absPath);
  return writeWebp(absPath, target, DISPLAY_OUTPUT);
}

module.exports = {
  THUMB_WIDTH, DISPLAY_EDGE, storePoster, ensureThumb, ensureDisplay,
};
