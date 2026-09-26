/**
 * Reading setlists straight from setlist.fm, by id or by artist.
 *
 * The single copy of "what a setlist looks like here" for the three routes that
 * show or import one — the band's history, a lookup by id, and importing a past
 * show as attended. The import used to take the venue, date, coordinates and
 * songs from the request body instead of from here, which let any signed-in
 * user put a concert of their own invention into the table every account reads,
 * future-dated and all, and have it mailed to other people's digests.
 */

const axios = require('axios');

const API_URL = 'https://api.setlist.fm/rest/1.0';

// setlist.fm ids are short hex strings ("63de4613"), and an MBID is a UUID.
// Both go into a URL path, so anything that could change the path — a slash, a
// dot segment, a query — is refused rather than escaped.
const SETLIST_ID = /^[A-Za-z0-9]{1,32}$/;
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isSetlistId = (id) => typeof id === 'string' && SETLIST_ID.test(id);
const isMbid = (id) => typeof id === 'string' && MBID.test(id);

function headers() {
  return { 'x-api-key': process.env.SETLIST_API_KEY, Accept: 'application/json' };
}

/**
 * One setlist, raw. Throws axios's error, so a caller can tell setlist.fm's 404
 * ("no such setlist") from it being unreachable.
 */
async function fetchSetlistById(id) {
  if (!isSetlistId(id)) throw new Error(`Not a setlist.fm id: ${id}`);
  const { data } = await axios.get(`${API_URL}/setlist/${encodeURIComponent(id)}`, {
    headers: headers(),
    timeout: 15000,
  });
  return data;
}

/** One page of an artist's setlists, raw. */
async function fetchArtistSetlists(mbid, page = 1) {
  if (!isMbid(mbid)) throw new Error(`Not an MBID: ${mbid}`);
  const { data } = await axios.get(`${API_URL}/artist/${encodeURIComponent(mbid)}/setlists`, {
    headers: headers(),
    params: { p: page },
    timeout: 15000,
  });
  return data;
}

/**
 * A setlist.fm setlist in the shape the app reads. Empty song names are kept:
 * setlist.fm uses them for a song nobody could identify, and the running order
 * is still worth having.
 */
function setlistSummary(s) {
  const venue = s?.venue || {};
  const city = venue.city || {};
  const sets = s?.sets?.set || [];
  const songs = sets.flatMap((set) => (set.song || []).map((song) => ({
    name: song.name || '',
    cover: song.cover?.name ?? null,
    tape: song.tape ?? false,
  })));
  return {
    setlistfm_id: s?.id ?? null,
    date: s?.eventDate ?? null,
    venue: venue.name ?? null,
    city: city.name ?? null,
    country: city.country?.code ?? null,
    // setlist.fm gives the venue's city coordinates, and dropping them left
    // every imported show with no position and off the map.
    latitude: city.coords?.lat ?? null,
    longitude: city.coords?.long ?? null,
    tour: s?.tour?.name ?? null,
    songs,
    url: s?.url ?? null,
  };
}

/**
 * setlist.fm's "dd-MM-yyyy" as a Date at noon UTC, or null.
 *
 * Noon rather than midnight so the calendar day reads the same in every time
 * zone the app is looked at from.
 */
function setlistDate(ddmmyyyy) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(ddmmyyyy ?? ''));
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const date = new Date(`${yyyy}-${mm}-${dd}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  // "31-02-2026" parses into March; a date that does not round-trip is not one.
  if (date.getUTCDate() !== Number(dd) || date.getUTCMonth() + 1 !== Number(mm)) return null;
  return date;
}

module.exports = {
  API_URL,
  isSetlistId,
  isMbid,
  fetchSetlistById,
  fetchArtistSetlists,
  setlistSummary,
  setlistDate,
};
