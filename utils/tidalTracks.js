// Reading Tidal's answers, and choosing from them, without a token.
//
// The same split as setlistPlaylist.js and spotify.js: everything here is pure
// (or takes its one network call as an argument) so it can be tested, and the
// network half lives in utils/tidal.js.
//
// Tidal speaks JSON:API. A search answers with one `searchResults` resource
// whose `tracks` relationship lists the hits in order, and the tracks
// themselves arrive alongside it in `included`. A track's artists are a
// relationship of their own, and not one a search will fill in, so unlike a
// Spotify result a Tidal one does not say who recorded it.

const { comparable } = require('./setlistPlaylist');

// The most tracks whose artists are fetched to settle one song. Each is a
// request, and past the first few of a search the right recording is rarely
// still to come.
const MAX_ARTIST_LOOKUPS = 3;

/**
 * The search string for a song. Free text only: Tidal has nothing like
 * Spotify's `track:"…" artist:"…"` fields to scope it with.
 *
 * @param {{ title: string, artist: string }} track
 * @returns {string|null}
 */
function searchQuery(track) {
  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const title = clean(track?.title);
  if (!title) return null;
  const artist = clean(track?.artist);
  // The API refuses a query over 256 characters.
  return (artist ? `${title} ${artist}` : title).slice(0, 256);
}

/**
 * The tracks a search found, in the order it ranked them.
 *
 * @param {object} doc - The body of GET /searchResults?include=tracks.
 * @returns {{ id: string, title: string, version: string|null }[]}
 */
function searchedTracks(doc) {
  const result = Array.isArray(doc?.data) ? doc.data[0] : doc?.data;
  const included = (doc?.included ?? []).filter((r) => r?.type === 'tracks' && r.id);
  const byId = new Map(included.map((r) => [r.id, r]));
  const order = result?.relationships?.tracks?.data;
  // The relationship carries the ranking. Without it, `included` is the next
  // best thing: it is in the order the server put it.
  const ranked = Array.isArray(order) && order.length
    ? order.map(({ id }) => byId.get(id)).filter(Boolean)
    : included;
  return ranked.map((r) => ({
    id: String(r.id),
    title: r.attributes?.title ?? '',
    version: r.attributes?.version || null,
  }));
}

/**
 * The names of the resources of one type in a document's `included`, in the
 * order its `data` lists them.
 *
 * @param {object} doc - A relationship document fetched with its include.
 * @param {string} type - e.g. 'artists'.
 * @returns {string[]}
 */
function includedNames(doc, type) {
  const byId = new Map((doc?.included ?? []).filter((r) => r?.type === type).map((r) => [r.id, r]));
  const order = Array.isArray(doc?.data) ? doc.data : [];
  return order
    .map(({ id }) => byId.get(id)?.attributes?.name)
    .filter(Boolean);
}

/**
 * The URL to open a created playlist at.
 *
 * Tidal says to treat ids as opaque, so the link it gives is used where there
 * is one. The constructed one is the form its own share links take, kept so a
 * missing link costs the button its target rather than the playlist.
 *
 * @param {object} resource - A `playlists` resource.
 * @returns {string|null}
 */
function playlistUrl(resource) {
  const links = resource?.attributes?.externalLinks ?? [];
  const shared = links.find((l) => l?.meta?.type === 'TIDAL_SHARING') ?? links[0];
  if (shared?.href) return shared.href;
  return resource?.id ? `https://tidal.com/playlist/${encodeURIComponent(resource.id)}` : null;
}

/**
 * Choose which of a search's tracks is the song asked for — pickBestTrack's
 * rules, for results that do not name their artists.
 *
 * A title match wins over the first hit, and among title matches one by the
 * right artist wins. The artists are fetched only when they could change the
 * answer, which is when two tracks share the title, so most songs cost the
 * one search.
 *
 * Tidal keeps a recording's version ("Live", "2011 Remaster") apart from its
 * title, so a live take ties with the album cut on name. Unversioned tracks
 * go first among the ties, which is the album cut when there is one.
 *
 * @param {{ id: string, title: string, version: string|null }[]} candidates
 * @param {{ title: string, artist: string }} track
 * @param {(id: string) => Promise<string[]>} artistsOf - A track's artist names.
 * @returns {Promise<object|null>} One of the candidates.
 */
async function chooseTrack(candidates, track, artistsOf) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const wantTitle = comparable(track?.title);
  const wantArtist = comparable(track?.artist);

  const titleMatches = candidates.filter((c) => comparable(c.title) === wantTitle);
  if (titleMatches.length === 0) return candidates[0];
  const ties = [
    ...titleMatches.filter((c) => !c.version),
    ...titleMatches.filter((c) => c.version),
  ];
  if (ties.length === 1 || !wantArtist) return ties[0];

  for (const candidate of ties.slice(0, MAX_ARTIST_LOOKUPS)) {
    const names = await artistsOf(candidate.id);
    if (names.some((name) => comparable(name) === wantArtist)) return candidate;
  }
  return ties[0];
}

module.exports = {
  MAX_ARTIST_LOOKUPS,
  searchQuery,
  searchedTracks,
  includedNames,
  playlistUrl,
  chooseTrack,
};
