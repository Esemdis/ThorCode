// Shaping Last.fm's artist.getInfo into the genres and scale the band search
// shows.
//
// This exists because Spotify will not supply either. Its search and its
// artist endpoints both return only name, id, images and urls for a
// Development Mode app, and /v1/artists?ids= is a 403 outright — so Spotify
// stayed as the source of the press photo and Last.fm became the source of
// everything descriptive.
//
// Everything here is pure so the decisions can be tested without a key; the
// network half lives in utils/lastfm.js.

const { canonicalBandName } = require('./lineupNames');

const DEFAULT_TAG_LIMIT = 2;

/**
 * Last.fm tags, fit to be rendered as genre chips.
 *
 * @param {string[]} tags - Tag names, most-used first.
 * @param {string} artistName - Used to drop the band's own name.
 * @param {number} limit
 */
function cleanTags(tags, artistName, limit = DEFAULT_TAG_LIMIT) {
  const own = canonicalBandName(artistName ?? '');
  const seen = new Set();
  const out = [];

  for (const raw of tags ?? []) {
    const name = String(raw ?? '').trim();
    if (!name) continue;

    // Last.fm's top tag for Metallica is "metallica". As a genre chip that
    // tells you the name of the band whose name you are already reading.
    if (own && canonicalBandName(name) === own) continue;

    // Tags are raw user input and arrive as DJENT, Progressive Metalcore, idm.
    // Lowercasing is what makes them sit together without looking broken, and
    // it matches the convention the dropdown was already built around.
    const lowered = name.toLowerCase();
    if (seen.has(lowered)) continue;

    seen.add(lowered);
    out.push(lowered);
    if (out.length === limit) break;
  }

  return out;
}

/**
 * One artist's enrichment, or null when there is nothing trustworthy to show.
 *
 * @param {object|null} payload - The raw artist.getInfo body.
 * @param {string} requestedName - The name we asked for, to catch autocorrect.
 * @returns {{ tags: string[], listeners: number|null, lastfmUrl: string|null }|null}
 */
function shapeArtistInfo(payload, requestedName) {
  // Last.fm reports "no such artist" as error 6 inside a 200 body rather than
  // as an HTTP failure, so this is a normal outcome and not an exception.
  if (!payload || payload.error) return null;

  const artist = payload.artist;
  if (!artist) return null;

  // autocorrect=1 fixes genuine typos, but a Ticketmaster attraction name is
  // rarely misspelled — so a corrected name usually means Last.fm reached for
  // a different band, and showing its genres would be exactly the mistake the
  // Spotify name matcher was built to avoid. Punctuation and case differences
  // are not a correction; canonicalBandName already ignores them.
  if (canonicalBandName(artist.name ?? '') !== canonicalBandName(requestedName ?? '')) return null;

  const listeners = Number.parseInt(artist.stats?.listeners, 10);

  return {
    tags: cleanTags((artist.tags?.tag ?? []).map((t) => t?.name), artist.name),
    listeners: Number.isFinite(listeners) ? listeners : null,
    lastfmUrl: artist.url ?? null,
  };
}

module.exports = { shapeArtistInfo, cleanTags };
