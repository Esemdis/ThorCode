// Keeping a Spotify artist search to the artists you were actually looking for.
//
// Spotify's /search is a recommendation engine, not a name match. "architects"
// comes back with Bad Omens, Arch Enemy and Spiritbox behind Architects, and
// "nine inch nails" comes back with Marilyn Manson and Johnny Cash. That is
// useful for discovery and wrong for a picker, where a row you did not ask for
// is a band you might add by mistake.

const { canonicalBandName } = require('./lineupNames');

/**
 * The artists whose name contains what was typed, in Spotify's order.
 *
 * Matching is on the canonical form, so punctuation, spacing, diacritics and
 * case do not matter — "blink 182" finds "Blink-182" — and it is a substring
 * rather than a prefix so the list narrows sensibly while you are still typing.
 *
 * @param {object[]} artists - Spotify artist objects, most relevant first.
 * @param {string} query - What the user typed.
 * @returns {object[]} The matching artists, or all of them when none match.
 */
function relevantArtists(artists, query) {
  const rows = artists ?? [];
  const q = canonicalBandName(query ?? '');
  if (!q) return rows;

  const matching = rows.filter((artist) => canonicalBandName(artist?.name ?? '').includes(q));

  // An abbreviation — "bmth" — matches no name at all, but Spotify put Bring Me
  // The Horizon first for a reason. An empty list is worse than its best guess.
  return matching.length > 0 ? matching : rows;
}

module.exports = { relevantArtists };
