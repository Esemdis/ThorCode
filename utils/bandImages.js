/**
 * Band photos from Spotify, without keeping the photos.
 *
 * Spotify's developer terms allow an image to be cached for at most 24 hours,
 * and the CDN urls behind them rotate, so the durable thing to store on a band
 * is the artist id — the url is resolved from it on demand and cached for less
 * than a day. Storing the url in the database instead would have gone stale
 * silently and left rows rendering broken images.
 */

const { canonicalBandName } = require('./lineupNames');
const { relevantArtists } = require('./artistSearch');

// 23 hours. The cap is 24; the hour of headroom covers the gap between writing
// the entry and the last request that reads it.
const IMAGE_TTL_SECONDS = 23 * 60 * 60;

// How many artists to look up at once. Spotify's batch endpoint is 403 for a
// Development Mode app, so getArtists issues one request per id — this is a
// concurrency window, not a payload limit, and it is small so a cold overview
// of a few hundred bands arrives as a series of short bursts instead of one
// flood that earns a 429.
const ARTIST_BATCH = 10;

// The avatar renders at 44px, so 160 is already retina; below that Spotify's
// smallest artist image is a thumbnail that visibly blurs.
const MIN_IMAGE_WIDTH = 160;

const imageCacheKey = (spotifyId) => `spotify:artist-image:${spotifyId}`;

/**
 * The artist that *is* this band, or null.
 *
 * Deliberately stricter than `relevantArtists`, which falls back to Spotify's
 * best guess when nothing matches — fine for a picker the user then chooses
 * from, wrong here, where the id is written to the band and never revisited.
 * "Architects of Chaos" must not become the photo for Architects.
 */
function exactArtistMatch(artists, bandName) {
  const wanted = canonicalBandName(bandName ?? '');
  if (!wanted) return null;

  const candidates = relevantArtists(artists, bandName);
  return candidates.find((artist) => canonicalBandName(artist?.name ?? '') === wanted) ?? null;
}

/**
 * The url of the smallest image that still looks sharp in an avatar.
 *
 * Spotify returns largest first and a band photo is 640px at the top, which is
 * a wasteful download for a 44px circle.
 */
function pickArtistImage(artist) {
  const images = artist?.images ?? [];
  if (!images.length) return null;

  // Width is optional in Spotify's payload; an image without one is kept rather
  // than dropped, since a missing width is not a small image.
  const sized = images.filter((img) => img?.url);
  if (!sized.length) return null;

  const usable = sized.filter((img) => img.width == null || img.width >= MIN_IMAGE_WIDTH);
  if (!usable.length) {
    return sized.reduce((best, img) => ((img.width ?? 0) > (best.width ?? 0) ? img : best)).url;
  }
  return usable.reduce((best, img) => ((img.width ?? Infinity) < (best.width ?? Infinity) ? img : best)).url;
}

/**
 * Current image urls for a set of Spotify artist ids, keyed by id.
 *
 * Ids with no photo are absent from the result, so a caller can spread it over
 * a row and get `undefined` rather than a null it has to guard. Failure is the
 * same shape as "no photo": the band list falls back to monograms, which is a
 * far better outcome than a 500 because Spotify was down.
 *
 * `cacheOnly` serves whatever Redis already holds and never calls Spotify. The
 * band overview uses it: that endpoint lists every band at once, so a cold cache
 * would fan out one request per band on the request path — which is exactly how
 * it came to exceed the client's 8s timeout. The cron warms the cache instead,
 * and a cold overview shows monograms for a while rather than hanging.
 *
 * @param {(string|null)[]} ids - Artist ids, nulls and duplicates allowed.
 * @param {object} deps - `getCache`, `setCache`, `getArtists`; injected so the
 *   batching and cache rules can be tested without Redis or a token.
 * @param {object} [options] - `cacheOnly` to skip Spotify entirely.
 */
async function resolveArtistImages(ids, { getCache, setCache, getArtists }, { cacheOnly = false } = {}) {
  const unique = [...new Set((ids ?? []).filter(Boolean))];
  if (!unique.length) return {};

  const found = {};
  const missing = [];

  await Promise.all(unique.map(async (id) => {
    const hit = await getCache(imageCacheKey(id));
    // Wrapped, not bare: `{ url: null }` records that we looked and Spotify has
    // no photo. A bare null is indistinguishable from a cache miss and would
    // make every request re-fetch every photoless artist.
    if (hit) {
      if (hit.url) found[id] = hit.url;
      return;
    }
    missing.push(id);
  }));

  if (cacheOnly) return found;

  for (let i = 0; i < missing.length; i += ARTIST_BATCH) {
    const batch = missing.slice(i, i + ARTIST_BATCH);
    let artists = [];
    try {
      artists = await getArtists(batch);
    } catch (error) {
      console.error('[spotify] Artist image lookup failed:', error.response?.data ?? error.message);
      continue;
    }

    const byId = new Map((artists ?? []).filter(Boolean).map((artist) => [artist.id, artist]));
    await Promise.all(batch.map(async (id) => {
      const url = pickArtistImage(byId.get(id));
      await setCache(imageCacheKey(id), { url }, IMAGE_TTL_SECONDS);
      if (url) found[id] = url;
    }));
  }

  return found;
}

module.exports = {
  IMAGE_TTL_SECONDS,
  ARTIST_BATCH,
  imageCacheKey,
  exactArtistMatch,
  pickArtistImage,
  resolveArtistImages,
};
