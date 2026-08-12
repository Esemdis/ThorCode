// Turning a concert's setlists into a playlist's worth of tracks.
//
// The songs come from setlist.fm and are stored in two places. A concert that
// has already happened and been logged carries the set that was actually played
// on ConcertBandReference.setlist; every other concert has only the band's most
// recent set, on Band.setlist. The first is a record, the second a prediction,
// and the difference is worth carrying through to the UI rather than flattening.
//
// Two flags on each song decide what a track search should ask for:
//
//   tape  — music played over the PA. Walk-on and outro tracks nobody performed,
//           which Setlist.jsx already hides from the displayed set. Left in, a
//           playlist opens with someone's intro tape.
//   cover — names the artist who wrote it. Poppy playing "Take Me Home, Country
//           Roads" is John Denver's song, and searching for it under Poppy finds
//           nothing at all.
//
// Everything here is pure so the decisions can be tested without a Spotify
// token: the network half lives in utils/spotify.js.

const { canonicalBandName, cleanLineupNames } = require('./lineupNames');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A concert date as a plain calendar day, read in UTC.
 *
 * Concert dates are days, not instants — reading one in local time slides it
 * backwards for anyone west of UTC and puts the wrong date in the playlist name.
 *
 * @param {Date|string|null|undefined} value
 * @returns {string} '' when there is no usable date.
 */
function formatConcertDay(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Pick the setlist to use for one band on one concert, preferring what was
 * actually played over what the band played last time.
 *
 * @param {{ setlist?: object, band_rel?: object }} ref - A ConcertBandReference
 *   row with its band included, as the concert query returns it.
 * @returns {{ songs: object[], predicted: boolean }}
 */
function setlistForRef(ref) {
  const played = ref?.setlist?.songs;
  if (Array.isArray(played) && played.length > 0) {
    return { songs: played, predicted: false };
  }
  const recent = ref?.band_rel?.setlist?.songs;
  if (Array.isArray(recent) && recent.length > 0) {
    return { songs: recent, predicted: true };
  }
  return { songs: [], predicted: false };
}

/**
 * The whole bill, in the order it will be played, as objects shaped like the
 * ConcertBandReference rows buildPlaylistTracks already understands.
 *
 * Two things are going on here.
 *
 * The bill comes from concert.metadata, not concert.bands: `bands` holds only
 * acts with a row in the Band table, which for a four-band club show is usually
 * the one you follow. metadata has all four.
 *
 * The order is inferred, and it is worth being honest about how. Nothing in any
 * source gives a running order — no stage times, no billing field. What
 * Bandsintown gives is its lineup sorted by follower count: of 58 stored bills
 * with three or more acts, 58 were in strictly descending order of followers.
 * So the stored order is popularity, and reversing it puts the smallest act
 * first and the biggest last, which is how a club night actually runs. It is a
 * good guess, not a schedule, and the playlist description says so.
 *
 * @param {object} concert - With `metadata` and `bands` (band_rel included).
 * @param {Map<string, {songs: object[]}>} [externalByName] - Canonical name →
 *   setlist fetched for an act with no Band row.
 * @returns {object[]}
 */
function concertPerformers(concert, externalByName = new Map()) {
  const refs = Array.isArray(concert?.bands) ? concert.bands : [];
  const byCanonical = new Map();
  for (const ref of refs) {
    const key = canonicalBandName(ref?.band_rel?.name);
    if (key && !byCanonical.has(key)) byCanonical.set(key, ref);
  }

  const billed = cleanLineupNames(parseLineup(concert?.metadata));
  // No lineup stored: fall back to whatever is linked, in its existing order.
  if (billed.length === 0) return refs;

  const performers = [];
  const used = new Set();

  // Reversed: openers first, headliner last.
  for (const name of [...billed].reverse()) {
    const key = canonicalBandName(name);
    if (!key || used.has(key)) continue;

    const known = byCanonical.get(key);
    if (known) {
      used.add(key);
      performers.push(known);
      continue;
    }

    const external = externalByName.get(key);
    if (external?.songs?.length) {
      used.add(key);
      // Shaped as a reference so the rest of the pipeline cannot tell the
      // difference between an act we track and one we looked up.
      performers.push({ setlist: null, band_rel: { id: null, name, setlist: { songs: external.songs } } });
    }
  }

  // A linked band the lineup text missed still belongs on the bill. Appended
  // last because without a position in the billing there is nowhere better.
  for (const ref of refs) {
    const key = canonicalBandName(ref?.band_rel?.name);
    if (key && !used.has(key)) {
      used.add(key);
      performers.push(ref);
    }
  }

  return performers;
}

/** Band names still missing songs, so the caller knows what to go and fetch. */
function unresolvedBillNames(concert) {
  const known = new Set(
    (concert?.bands ?? [])
      .filter((ref) => ref?.setlist?.songs?.length || ref?.band_rel?.setlist?.songs?.length)
      .map((ref) => canonicalBandName(ref?.band_rel?.name)),
  );
  const seen = new Set();
  return cleanLineupNames(parseLineup(concert?.metadata)).filter((name) => {
    const key = canonicalBandName(name);
    if (!key || known.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseLineup(metadata) {
  try {
    const parsed = JSON.parse(metadata || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Every track is one Spotify search, so a bill's length is a request budget.
// A club show is around 19 tracks and costs nothing to resolve; the festivals
// are what bite — Rock im Park 2026 has 47 bands on it and comes to 330 songs,
// which is minutes of searching and a rate limit waiting at the end of it.
const DEFAULT_MAX_TRACKS = 100;

/**
 * Every track to look up for a concert, in stage order, band by band.
 *
 * A song played by two bands on the same bill — a cover both of them do, most
 * often — is looked up once.
 *
 * Over `maxTracks`, the list is taken a song at a time from each band in turn
 * rather than truncated. Cutting the tail off a festival would drop whole bands
 * from the bottom of the bill; going round the bands keeps every one of them in
 * the playlist and takes the songs each opens with, which are the ones they are
 * known for.
 *
 * @param {object[]} bandRefs - concert.bands, each with band_rel included.
 * @param {{ maxTracks?: number }} [options]
 * @returns {{ title: string, artist: string, isCover: boolean, band: string, predicted: boolean }[]}
 */
function buildPlaylistTracks(bandRefs, { maxTracks = DEFAULT_MAX_TRACKS } = {}) {
  if (!Array.isArray(bandRefs)) return [];

  const seen = new Set();
  const perBand = [];

  for (const ref of bandRefs) {
    const bandName = ref?.band_rel?.name;
    if (!bandName) continue;
    const { songs, predicted } = setlistForRef(ref);
    const bandTracks = [];

    for (const song of songs) {
      const title = typeof song?.name === 'string' ? song.name.trim() : '';
      if (!title) continue;
      if (song.tape) continue;

      const artist = typeof song.cover === 'string' && song.cover.trim()
        ? song.cover.trim()
        : bandName;

      const key = `${artist.toLowerCase()}|${title.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      bandTracks.push({ title, artist, isCover: !!song.cover, band: bandName, predicted });
    }

    if (bandTracks.length > 0) perBand.push(bandTracks);
  }

  const total = perBand.reduce((n, b) => n + b.length, 0);
  if (total <= maxTracks) return perBand.flat();

  const taken = [];
  const longest = Math.max(...perBand.map((b) => b.length));
  for (let i = 0; i < longest && taken.length < maxTracks; i++) {
    for (const bandTracks of perBand) {
      if (taken.length >= maxTracks) break;
      if (i < bandTracks.length) taken.push(bandTracks[i]);
    }
  }
  return taken;
}

/**
 * Search strings for one track, most precise first.
 *
 * The field-scoped form is what usually lands it. The loose form is the fallback
 * for songs whose stored title carries a suffix the catalogue does not use
 * ("Song - Live", featured artists in brackets), where the scoped search returns
 * nothing at all rather than something close.
 *
 * Quotes inside a title would terminate the field early, so they are dropped.
 *
 * @param {{ title: string, artist: string }} track
 * @returns {string[]}
 */
function searchQueries(track) {
  const clean = (s) => String(s ?? '').replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
  const title = clean(track?.title);
  const artist = clean(track?.artist);
  if (!title) return [];
  if (!artist) return [title];
  return [`track:"${title}" artist:"${artist}"`, `${title} ${artist}`];
}

/**
 * Reduce a title or artist to the form used to compare two of them: lowercased,
 * without a trailing parenthetical, down to letters and digits. "Song (Live at
 * Wembley)" and "Song" compare equal; "Song" and "Song II" do not.
 *
 * @param {string} value
 * @returns {string}
 */
function comparable(value) {
  return String(value ?? '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Choose which of Spotify's results is the song we asked for.
 *
 * Taking the first hit blindly is how a playlist ends up full of live versions,
 * karaoke covers and remixes: a search for a well-known song often ranks a
 * "Live" or "Sped Up" edit above the album cut. So an exact title match by the
 * right artist wins over one by anybody, which wins over whatever came first.
 *
 * @param {object[]} items - Spotify track objects.
 * @param {{ title: string, artist: string }} track
 * @returns {object|null}
 */
function pickBestTrack(items, track) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const wantTitle = comparable(track?.title);
  const wantArtist = comparable(track?.artist);

  const titleMatches = items.filter((item) => comparable(item?.name) === wantTitle);
  const byRightArtist = titleMatches.find((item) =>
    (item?.artists ?? []).some((a) => comparable(a?.name) === wantArtist));

  return byRightArtist ?? titleMatches[0] ?? items[0];
}

/**
 * Name for the created playlist, e.g. "THROWN @ Fållan — 27 Nov 2026".
 *
 * @param {object} concert
 * @returns {string}
 */
function playlistName(concert) {
  const base = concert?.name?.trim()
    || [concert?.venue, concert?.city].filter(Boolean).join(', ')
    || 'Concert';
  const day = formatConcertDay(concert?.concert_date);
  return day ? `${base} — ${day}` : base;
}

/**
 * Description for the created playlist. Says plainly when the songs are a guess
 * at what will be played rather than a record of what was.
 *
 * @param {object} concert
 * @param {object[]} tracks - Output of buildPlaylistTracks.
 * @returns {string}
 */
function playlistDescription(concert, tracks) {
  const bands = [...new Set((tracks ?? []).map((t) => t.band))];
  const who = bands.length > 0 ? bands.join(', ') : 'the lineup';
  const where = [concert?.venue, concert?.city].filter(Boolean).join(', ');
  const anyPredicted = (tracks ?? []).some((t) => t.predicted);

  const parts = [`${who}${where ? ` at ${where}` : ''}.`];
  parts.push(anyPredicted
    ? 'Based on recent setlists, ordered support-first. Both are guesses.'
    : 'The set as it was played.');
  parts.push('Built from setlist.fm data by Concert Map.');
  return parts.join(' ');
}

module.exports = {
  DEFAULT_MAX_TRACKS,
  concertPerformers,
  unresolvedBillNames,
  buildPlaylistTracks,
  setlistForRef,
  pickBestTrack,
  comparable,
  searchQueries,
  playlistName,
  playlistDescription,
  formatConcertDay,
};
