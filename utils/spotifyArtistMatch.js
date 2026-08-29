// Attaching Spotify artist data to Ticketmaster search results.
//
// The two APIs share no identifier, so the join is by name, and it is exact on
// a canonical key rather than fuzzy. A stringSimilarity fallback was measured
// first and abandoned: Architects/Architect scores 0.941 while The
// Anthrax/Anthrax scores 0.800, so no threshold admits the right bands without
// admitting wrong ones. Bigram overlap rewards character similarity, but the
// same band spelled two ways differs by whole words while two different bands
// differ by one character. See the design doc for the full measurement.
//
// Nothing here is persisted, which is what makes a wrong match cheap: it is one
// render of the wrong genres, never a bad row.

const { canonicalBandName } = require('./lineupNames');

// Ticketmaster and Spotify disagree about the article often enough to matter,
// and it is a rule rather than a guess, so it belongs in the key.
const LEADING_ARTICLE = /^\s*(?:the|a|an)\s+/i;

function matchKey(name) {
  if (typeof name !== 'string') return '';
  return canonicalBandName(name.replace(LEADING_ARTICLE, ''));
}

function enrichmentFrom(artist) {
  return {
    genres: Array.isArray(artist.genres) ? artist.genres : [],
    followers: artist.followers?.total ?? null,
    image: artist.images?.[0]?.url ?? null,
    spotifyUrl: artist.external_urls?.spotify ?? null,
    matchedName: artist.name ?? '',
  };
}

/**
 * Merge a Spotify artist search into a Ticketmaster attraction list.
 *
 * @param {object[]} attractions - Ticketmaster rows, in relevance order.
 * @param {object[]|null} artists - Spotify artists, or null when Spotify did
 *   not answer. Null is a supported input, not a bug: enrichment is decoration
 *   and the search must survive Spotify being down or unconfigured.
 * @returns {object[]} The attractions, each with a `spotify` key.
 */
function enrichAttractions(attractions, artists) {
  const byKey = new Map();
  for (const artist of artists ?? []) {
    const key = matchKey(artist?.name);
    // First Spotify result wins a key: they arrive in relevance order, so the
    // first is the one a person searching that name meant.
    if (key && !byKey.has(key)) byKey.set(key, artist);
  }

  return (attractions ?? []).map((attraction) => {
    const key = matchKey(attraction?.name);
    const artist = key ? byKey.get(key) : undefined;
    if (!artist) return { ...attraction, spotify: null };
    // Consumed, so a duplicate Ticketmaster row does not show the same
    // follower count twice as though it were a second band.
    byKey.delete(key);
    return { ...attraction, spotify: enrichmentFrom(artist) };
  });
}

module.exports = { enrichAttractions };
