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
const MAX_FILE_BYTES = 500 * 1024 * 1024;

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

module.exports = { MAX_FILE_BYTES, kindForMime };
