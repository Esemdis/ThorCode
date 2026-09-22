/**
 * What the archive will take.
 *
 * The rule is not "what can we store" — any bytes can be stored — but "what
 * will render in a browser later". A file that imports cleanly and then shows
 * a broken icon in the gallery reads as a bug in the app, and by the time it is
 * noticed the original may be off the phone.
 */

// A long clip off a phone, with room to spare. Large enough that the cap is
// never hit by accident, small enough that one bad request cannot fill the
// share.
//
// Raised from 500 MB, which a full-set recording off a modern phone passes
// without trying: 4K60 runs around 400 MB a minute. Two gigabytes is double
// the largest file the archive has had to take so far, so the cap is a
// backstop rather than something to plan around.
//
// This is not the only limit in the path. Whatever proxies the API has its own
// body cap, and it is the lower of the two that decides — see the note on
// LIMIT_FILE_SIZE in utils/uploadErrors.js.
//
// INT32_MAX exactly, one byte under a round 2 GiB, because ConcertMedia.bytes
// is an Int column. Busboy fires `limit` only when a file EXCEEDS fileSize, so
// a cap of 2147483648 accepted a file of exactly that size — which is
// INT32_MAX + 1 — and the insert then failed with "value out of range for
// type integer" after the whole upload had already been received.
const MAX_FILE_BYTES = 2147483647;

// One drag-and-drop of a whole night's photographs, and a ceiling on how much
// one request can ask the disk for. Lives here rather than inline in the route
// so the number the uploader enforces and the number the refusal quotes cannot
// drift apart.
const MAX_FILES_PER_REQUEST = 50;

// A poster is one frame the upload dialog drew on a canvas and encoded, so it
// is an image at roughly thumbnail scale and never anything near a video.
//
// It needs its own cap because the posters field shares the route's multer
// fileSize limit, which is MAX_FILE_BYTES — sized for a full-set recording.
// Posters are the one thing the upload route does not stream: sharp has to
// read the frame to downscale it, so fifty posters at the video limit is a
// heap the container does not have. Eight megabytes is far more than a canvas
// frame needs and still small enough that a full batch is bounded.
const MAX_POSTER_BYTES = 8 * 1024 * 1024;

const MIME_KINDS = new Map([
  ['image/jpeg', 'PHOTO'],
  ['image/png', 'PHOTO'],
  ['image/webp', 'PHOTO'],
  ['video/mp4', 'VIDEO'],
]);

// Deliberately absent: image/heic and image/heif. No browser decodes them.

// No codec list lives here. An mp4 is a container, not a codec: a Pixel writes
// H.264 by default but can be switched to HEVC for 4K60 and HDR, and that file
// passes every mime check and then plays in nothing. Matching codec names
// against a list was only ever a proxy for "will a browser play this", and the
// upload dialog answers that question directly by decoding a frame before it
// sends anything.

function kindForMime(mime) {
  const normalised = String(mime ?? '').split(';')[0].trim().toLowerCase();
  return MIME_KINDS.get(normalised) ?? null;
}

/**
 * Why a poster upload should be turned away, or null to accept it.
 *
 * Posters deliberately skip kindForMime: they never become a ConcertMedia row,
 * and a poster that cannot be decoded costs a placeholder tile rather than the
 * recording it arrived with. But skipping that gate entirely left the posters
 * field as the only one in the route accepting arbitrary bytes at the video
 * size limit, which then had to be decoded to find that out.
 *
 * Returns a reason rather than a boolean so the caller can log which poster it
 * dropped and why — a silently missing thumbnail is otherwise unexplainable.
 */
function posterProblem({ mimetype, size } = {}) {
  const normalised = String(mimetype ?? '').split(';')[0].trim().toLowerCase();
  if (normalised !== 'image/webp') {
    return `expected image/webp, got ${normalised || 'nothing'}`;
  }
  if (size > MAX_POSTER_BYTES) {
    return `larger than the ${Math.round(MAX_POSTER_BYTES / 1024 / 1024)} MB poster limit`;
  }
  return null;
}

module.exports = {
  MAX_FILE_BYTES, MAX_POSTER_BYTES, MAX_FILES_PER_REQUEST, kindForMime, posterProblem,
};
