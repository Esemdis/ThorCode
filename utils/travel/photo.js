/**
 * The one check every stored travel photo passes: gear photos and trip-review
 * photos are both kept as data URLs inside the row.
 *
 * Before this, a trip-review photo could be any string, and a gear photo
 * anything starting `data:image/`. That let through `data:image/svg+xml`, which
 * runs script when the image is opened on its own, plain URLs that make every
 * viewer's browser fetch a stranger's address, and strings with `)` in them:
 * travel-bag's PackModeDeck puts the photo unquoted into CSS `url(...)`, so a
 * `)` there could add further `url()`s. travel-bag only ever sends JPEG base64
 * (its utils/photos.js and PhotoCropModal re-encode every pick), so allowing
 * three raster types and nothing but base64 after them costs the client nothing.
 *
 * The pattern has no nested quantifier, so a 700,000-character near-miss is
 * checked in one pass rather than backtracking. Padding and length modulo 4 are
 * not checked: an ill-padded payload is at worst an image that does not decode.
 */

const PHOTO_DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]*={0,2}$/;

// Gear photos are cropped to 384x384 at q0.8 (~27k-80k characters); the cap is
// about four times that and was already the limit. Trip-review photos keep a
// 1024-pixel longest edge at q0.75, which reaches ~540k characters for a busy
// scene; 700,000 leaves room for that while nine photos stay under 6.3 MB.
const GEAR_PHOTO_MAX_LENGTH = 300000;
const TRIP_PHOTO_MAX_LENGTH = 700000;

// Its own answer, not undefined, so a caller can tell "compress it" from
// "this is not a photo" in the sentence it sends back.
const PHOTO_TOO_LARGE = Symbol('photo too large');

/**
 * The data URL to store, null for "no photo", undefined for "not a JPEG, PNG or
 * WebP base64 data URL", or PHOTO_TOO_LARGE above `max` characters.
 */
function photoDataUrl(value, max) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return undefined;
  // Length first: it is free, and it bounds the regex's work.
  if (value.length > max) return PHOTO_TOO_LARGE;
  return PHOTO_DATA_URL.test(value) ? value : undefined;
}

module.exports = {
  photoDataUrl, PHOTO_TOO_LARGE, GEAR_PHOTO_MAX_LENGTH, TRIP_PHOTO_MAX_LENGTH,
};
