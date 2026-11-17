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

// One render per target at a time (THO-979). Without it every request that
// arrived before the first render finished started its own full decode of a 12
// to 50 MP original, and an album share link, which needs no account, could
// send hundreds at once: the album limiter bounds the rate (5000 an hour per
// IP), not the concurrency. Keyed by the target path, so a thumbnail and a
// display copy of one photo are separate renders.
const inFlight = new Map();

// How many renders may run at once, across all photos. A decode runs on
// libuv's four-thread pool, the same one sendFile reads every photo and video
// through, so unbounded renders stall all media serving, not just thumbnails.
// Only a real render takes a slot: a cached copy, a video poster, a missing
// original or a remembered failure is answered without waiting for one.
// Separate from the scrub slots in mediaPublicCopy.js, which bound memory
// rather than threads.
const MAX_CONCURRENT_RENDERS = 2;
let rendersRunning = 0;
const renderQueue = [];

async function withRenderSlot(work) {
  if (rendersRunning < MAX_CONCURRENT_RENDERS) rendersRunning += 1;
  else await new Promise((resolve) => { renderQueue.push(resolve); });
  try {
    return await work();
  } finally {
    // Handed straight to the next in line, so the count never dips and lets a
    // newcomer in ahead of it.
    const next = renderQueue.shift();
    if (next) next();
    else rendersRunning -= 1;
  }
}

// A photo sharp cannot decode was decoded again on every request, each a 500
// (THO-979): one broken file was a free decode per request for anyone holding
// the link. Remembered for ten minutes, long enough to blunt a loop and short
// enough that a replaced file is picked up without a restart, and the original
// error is thrown again so the route answers exactly as before. Bounded, oldest
// first, because the keys come from whatever a stranger asks for. In memory
// only: a restart forgets, which costs one decode per broken file.
const RENDER_FAILURE_TTL_MS = 10 * 60 * 1000;
const MAX_REMEMBERED_FAILURES = 500;
const failedRenders = new Map();

// Errors that came out of sharp's own pipeline. Only these say something about
// the file; a mkdir or rename failure is the server's, and remembering it would
// hide a good photo for ten minutes.
const decodeFailures = new WeakSet();

function rememberedFailure(target) {
  const entry = failedRenders.get(target);
  if (!entry) return null;
  if (Date.now() < entry.until) return entry.err;
  failedRenders.delete(target);
  return null;
}

function rememberFailure(target, err) {
  // Deleted first so a re-remembered key moves to the newest end of the
  // insertion order, which is what eviction reads as age.
  failedRenders.delete(target);
  failedRenders.set(target, { err, until: Date.now() + RENDER_FAILURE_TTL_MS });
  while (failedRenders.size > MAX_REMEMBERED_FAILURES) {
    failedRenders.delete(failedRenders.keys().next().value);
  }
}

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
// In-process callers for one cached copy now share a single render (renderOnce),
// but storePoster and a second process still can race.
//
// The timeout is what keeps a decode that hangs from holding a render slot
// forever; it rejects like any decode failure and is remembered as one.
//
// rotate() with no angle applies the EXIF orientation, which a phone uses to
// store a portrait shot as landscape pixels. The output carries no EXIF, so
// without it every such photograph would be served lying on its side.
async function writeWebp(bufferOrPath, target, { resize, quality } = THUMB_OUTPUT) {
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  try {
    try {
      await sharp(bufferOrPath)
        .timeout({ seconds: 60 })
        .rotate()
        .resize(resize)
        .webp({ quality })
        .toFile(temp);
    } catch (err) {
      if (err && typeof err === 'object') decodeFailures.add(err);
      throw err;
    }
    await rename(temp, target);
    return target;
  } catch (err) {
    await unlink(temp).catch(() => {});
    throw err;
  }
}

/**
 * Make one cached copy of a photo, sharing the render with every concurrent
 * caller for the same target (THO-979).
 *
 * The get and the set below have no await between them, and come before any
 * existence check. Checking first would let all fifty callers see "not there
 * yet" before the first had registered its flight, and each would start one.
 */
function renderOnce(target, absPath, output) {
  const joined = inFlight.get(target);
  if (joined) return joined;
  const flight = (async () => {
    if (await exists(target)) return target;
    if (!await exists(absPath)) throw missingOriginal(absPath);
    const remembered = rememberedFailure(target);
    if (remembered) throw remembered;
    try {
      return await withRenderSlot(() => writeWebp(absPath, target, output));
    } catch (err) {
      if (decodeFailures.has(err)) rememberFailure(target, err);
      throw err;
    }
  })().finally(() => {
    // Only this flight's own entry: a later call must never join one that has
    // already settled, and must never be dropped by one that has.
    if (inFlight.get(target) === flight) inFlight.delete(target);
  });
  inFlight.set(target, flight);
  return flight;
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

  // Tagged like NO_POSTER above, and for the same reason. An original that has
  // gone missing is ordinary archive drift, not a server fault: the file route
  // already answers it with a bare 404, and the thumb route said 500 with
  // sharp's own "Input file is missing: <absolute path>" as the message. That
  // path only escapes to the client outside production, but the status is
  // wrong everywhere, and a normal state that logs as a 500 buries the ones
  // that are not. renderOnce throws it before taking a render slot.
  return renderOnce(thumbPath(sha256), absPath, THUMB_OUTPUT);
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
  return renderOnce(displayPath(sha256), absPath, DISPLAY_OUTPUT);
}

module.exports = {
  THUMB_WIDTH, DISPLAY_EDGE, storePoster, ensureThumb, ensureDisplay, displayPath,
  MAX_CONCURRENT_RENDERS, MAX_REMEMBERED_FAILURES,
};
