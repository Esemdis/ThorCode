/**
 * Adding a band to the one table every account shares.
 *
 * Both routes that add a band by name use this: POST /bands, and adding one to
 * a wishlist. The wishlist route used to reach it by calling this API over HTTP
 * at CALLBACK_URL, forwarding the caller's token — so a stale CALLBACK_URL
 * broke it, and every user's band adds arrived from the server's own address
 * and shared one rate-limit bucket between them.
 *
 * Called through the module object by the routes, so a test can stand in for
 * it on the router's own copy.
 */

const prisma = require('../prisma/client');
const { findSourceUrls } = require('./bandSourceUrls');
const { backlinkBandToConcerts } = require('./bandBacklink');
const { pythonServicePost } = require('./pythonService');

class BandExistsError extends Error {
  constructor(band) {
    super('Band already exists.');
    this.name = 'BandExistsError';
    this.band = band;
  }
}

const UNIQUE_VIOLATION = 'P2002';

/**
 * Create a band by name: its MusicBrainz id and Songkick/Bandsintown pages
 * looked up first, its name linked into bills already stored, and a scrape of
 * its concerts started in the background.
 *
 * @param {string} name - already trimmed and non-empty
 * @returns {Promise<{ band: object, songkickUrl: string|null, bandsintownUrl: string|null, warning: string|null }>}
 * @throws {BandExistsError} when a band by that name is already there
 */
async function createBand(name) {
  const existing = await prisma.band.findUnique({ where: { name } });
  if (existing) throw new BandExistsError(existing);

  // No Ticketmaster lookup. It used to resolve the name here and 404 with
  // "No band found." for anything its catalogue lacked, which is the only
  // reason such a band could not be added — MusicBrainz and findSourceUrls
  // both key off the name, and they are what produce concerts.
  //
  // One guarded lookup does both jobs: the MBID and the source urls. A second,
  // unguarded `artist:"name"` search used to run here as well and stored
  // MusicBrainz's closest guess for an unlisted band as that band's identity.
  //
  // Awaited rather than left in the background: what this finds is the only
  // thing that produces concerts, and a background failure could reach nobody.
  // It costs one MusicBrainz call plus the mandatory 1.1s of spacing.
  let songkickUrl = null;
  let bandsintownUrl = null;
  let mbid = null;
  let lookupReachedMusicBrainz = true;
  try {
    [songkickUrl, bandsintownUrl, mbid] = await findSourceUrls(name);
  } catch (lookupError) {
    lookupReachedMusicBrainz = false;
    console.error(`[bands] MusicBrainz lookup failed for ${name}:`, lookupError.message);
  }

  let band;
  try {
    band = await prisma.band.create({
      data: {
        name,
        created_at: new Date(),
        MBID: mbid,
        ...(songkickUrl && { songkick_url: songkickUrl }),
        ...(bandsintownUrl && { bandsintown_url: bandsintownUrl }),
        // Stamped only when MusicBrainz actually answered. Unreachable is not
        // evidence the urls do not exist, so the band stays queued for the
        // next backfill sweep — same rule as refresh-urls and the backfill.
        ...(lookupReachedMusicBrainz && { source_urls_checked_at: new Date() }),
      },
    });
  } catch (error) {
    // Someone added the same band during the lookup above. Theirs stands.
    if (error.code !== UNIQUE_VIOLATION) throw error;
    const winner = await prisma.band.findUnique({ where: { name } });
    if (winner) throw new BandExistsError(winner);
    throw error;
  }

  // A band is usually added because it was seen on a bill already stored,
  // where its name sits in metadata as a loose string: /bulk links lineup
  // names against the bands existing at ingest time, and this band did not
  // exist yet. Left unlinked it shows grey on that bill, and the next scrape
  // of the band files its own copy of the gig — checkDuplicateConcert needs
  // a shared band to recognise the two as one show.
  //
  // Never fails the request: the band is created either way, and a missing
  // link is recoverable by hand.
  try {
    await backlinkBandToConcerts({ bandId: band.id, bandName: name, prisma });
  } catch (backlinkError) {
    console.error(`[bands] Back-linking existing concerts failed for ${name}:`, backlinkError.message);
  }

  // The scrape itself stays in the background: it is long-running, and unlike
  // the lookup above there is a retry path for it — the band now has its urls
  // stored, so an admin re-sync or the cron picks it up.
  pythonServicePost(`/sync/${band.id}`,
    { songkick_url: songkickUrl || null, bandsintown_url: bandsintownUrl || null, band_name: band.name },
  ).then(
    () => console.log(`[bands] Sync queued for ${band.name}`),
    (e) => console.error(`[bands] Background sync failed for ${band.name}:`, e.message),
  );

  return {
    band,
    songkickUrl,
    bandsintownUrl,
    warning: lookupReachedMusicBrainz
      ? null
      : 'Could not reach MusicBrainz, so no Songkick or Bandsintown links were found yet. The nightly backfill will retry this band.',
  };
}

module.exports = { createBand, BandExistsError };
