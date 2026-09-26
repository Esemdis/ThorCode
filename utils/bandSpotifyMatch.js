/**
 * Matching bands to Spotify artists, and remembering that we tried.
 *
 * Split out of the bands route so the cron job and the admin route run exactly
 * the same matching — the route used to own this, and a second copy in the
 * scheduler would have been free to drift on the one decision that matters
 * here: what counts as a match (see `exactArtistMatch`).
 */

const prisma = require('../prisma/client');
// Through the module rather than destructured, so a test can stand in for
// Spotify on this file's own copy of it.
const spotify = require('./spotify');
const { getCache, setCache } = require('./cache');
const { exactArtistMatch, resolveArtistImages } = require('./bandImages');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Spaced rather than parallel: this is a search per band against an endpoint
// that rate-limits, and nothing is waiting on the result.
const SEARCH_SPACING_MS = 200;

/**
 * Match one band to a Spotify artist and store the answer.
 *
 * `spotify_checked_at` is stamped whether or not a match was found: a band
 * Spotify has nothing for under its exact name — a local support act, a
 * misspelling in a scraped lineup — would otherwise cost a search on every
 * single request for the rest of its life. Clearing that column is how you ask
 * for a band to be looked at again.
 *
 * @returns {Promise<string|null>} The artist id, or null when there is no match.
 */
async function matchBandToSpotify(band) {
  if (band.spotify_id) return band.spotify_id;
  if (band.spotify_checked_at) return null;

  let match = null;
  try {
    match = exactArtistMatch(await spotify.searchArtists(band.name), band.name);
  } catch (error) {
    // Not stamped: Spotify being down is not evidence the band is unmatchable,
    // so the next run should try again.
    console.error(`[spotify] Artist match failed for "${band.name}":`, error.response?.data ?? error.message);
    return null;
  }

  try {
    await prisma.band.update({
      where: { id: band.id },
      data: { spotify_id: match?.id ?? null, spotify_checked_at: new Date() },
    });
  } catch (error) {
    // A unique index guards spotify_id, so two bands whose names both resolve
    // to one artist collide here. The row is worth keeping either way, so the
    // clash costs the photo and nothing else — but the search still happened,
    // and has to be recorded as having happened. The update failing whole left
    // spotify_checked_at empty, so the band was searched again on every visit
    // to its page and by every nightly run, for good.
    console.error(`[spotify] Could not store artist id for "${band.name}":`, error.message);
    if (error.code === 'P2002') {
      await prisma.band.update({
        where: { id: band.id },
        data: { spotify_checked_at: new Date() },
      }).catch((e) => console.error(`[spotify] Could not mark "${band.name}" as searched:`, e.message));
    }
  }

  return match?.id ?? null;
}

/**
 * Match every band that has never been searched, up to a limit.
 *
 * Resumable by design: each band is stamped as it goes, so a run that is capped,
 * interrupted or killed leaves the rest for the next one. That is what makes it
 * safe to schedule daily — once the queue is empty a run costs a single count
 * query.
 */
async function backfillSpotifyIds({ limit = 100 } = {}) {
  const bands = await prisma.band.findMany({
    where: { spotify_checked_at: null },
    select: { id: true, name: true, spotify_id: true, spotify_checked_at: true },
    orderBy: { name: 'asc' },
    take: limit,
  });

  let matched = 0;
  for (const band of bands) {
    if (await matchBandToSpotify(band)) matched += 1;
    await sleep(SEARCH_SPACING_MS);
  }

  return {
    searched: bands.length,
    matched,
    remaining: await prisma.band.count({ where: { spotify_checked_at: null } }),
  };
}

/**
 * Pull every matched band's photo url into the cache.
 *
 * The band overview reads the cache and never fetches, so this is what actually
 * puts photos on the page. Run daily: the entries live slightly less than a day
 * (Spotify's terms cap image caching at 24 hours), so each run replaces the set
 * that is about to expire.
 *
 * Returns counts rather than throwing on a partial failure — resolveArtistImages
 * already degrades per batch, and a run that warmed most of the list is a good
 * run.
 */
async function warmBandImages() {
  const bands = await prisma.band.findMany({
    where: { spotify_id: { not: null } },
    select: { spotify_id: true },
  });

  const images = await resolveArtistImages(
    bands.map((b) => b.spotify_id),
    { getCache, setCache, getArtists: spotify.getArtists },
  );

  return { bands: bands.length, withPhoto: Object.keys(images).length };
}

module.exports = { matchBandToSpotify, backfillSpotifyIds, warmBandImages, SEARCH_SPACING_MS };
