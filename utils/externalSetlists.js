// Setlists for bands that are not in the Band table.
//
// A concert's full bill lives in concert.metadata as plain names — most of them
// support acts nobody has added to a wishlist, so they have no Band row and no
// stored setlist. setlist.fm has them anyway: of the four names on the Fållan
// bill, three are unknown to us and all three have hundreds of setlists there.
//
// The danger is the lookup, not the data. Searching setlist.fm for "thistle."
// returns Jake Thistle, a singer-songwriter with no connection to the band, and
// nothing about the response says so. So a result is only accepted when the
// artist it came back with canonically matches the name we asked for — the same
// guard that stops Alestorm being filed as Halestorm.

const axios = require('axios');
const { canonicalBandName } = require('./lineupNames');

const SEARCH_URL = 'https://api.setlist.fm/rest/1.0/search/setlists';

// Deliberately an in-process Map rather than the Redis helpers in utils/cache.js.
// With Redis unreachable a single getCache takes twelve seconds to give up
// rather than failing fast, so caching there turned a four-band bill into a
// minute of waiting — the opposite of what a cache is for. A Map costs nothing,
// needs no infrastructure to be up, and still saves the lookup on every repeat
// build for as long as the process lives. It does not survive a restart; if that
// starts to matter, this belongs in Postgres, not in a cache that can be down.
const cache = new Map();
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 1000;

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) { cache.delete(key); return undefined; }
  return entry.value;
}

function cacheSet(key, value) {
  // Oldest-first eviction. Map keeps insertion order, so the first key is the
  // one that has been in longest.
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

// setlist.fm asks for one request per second. Sequential lookups with this gap
// keep us inside that without needing a limiter.
const REQUEST_GAP_MS = 1100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Flatten a setlist.fm setlist into the song shape used everywhere else here:
 * `{ name, tape, cover }`, matching what services/setlist.py stores on Band.
 */
function songsFrom(setlist) {
  const sets = setlist?.sets?.set ?? [];
  const songs = [];
  for (const s of sets) {
    for (const song of s?.song ?? []) {
      if (!song?.name) continue;
      songs.push({
        name: song.name,
        cover: song.cover?.name ?? null,
        tape: song.tape ?? false,
      });
    }
  }
  return songs;
}

/**
 * Choose which of setlist.fm's results is the band that was asked for, if any.
 *
 * This is the whole safety story of the lookup, kept pure so it can be tested
 * without the network: searching for "thistle." returns Jake Thistle, a
 * singer-songwriter with no connection to the band, and nothing in the response
 * says so. Only an artist whose name canonically matches is accepted, and only
 * a setlist with songs somebody actually played.
 *
 * @param {string} name - The name as billed.
 * @param {object[]} setlists - `setlist` from a search response.
 * @returns {{ songs: object[], artist: string, url: string|null }|null}
 */
function pickSetlistFor(name, setlists) {
  const canonical = canonicalBandName(name);
  if (!canonical) return null;

  for (const setlist of setlists ?? []) {
    const artist = setlist?.artist?.name ?? '';
    if (canonicalBandName(artist) !== canonical) continue;
    const songs = songsFrom(setlist);
    // A cancelled show logged with only walk-on music is not a setlist.
    if (!songs.some((s) => !s.tape)) continue;
    return { songs, artist, url: setlist.url ?? null };
  }
  return null;
}

/**
 * The most recent setlist for a band name, or null.
 *
 * Null covers every way this can come up empty — no API key, no match, a match
 * for the wrong artist, a band with no setlists, an outage — because to the
 * caller they are the same thing: no songs to add for this act.
 *
 * @param {string} name
 * @returns {Promise<{ songs: object[], artist: string, url: string|null }|null>}
 */
async function fetchSetlistByName(name) {
  const canonical = canonicalBandName(name);
  if (!canonical) return null;
  if (!process.env.SETLIST_API_KEY) return null;

  // Misses are remembered too, so a band setlist.fm does not have is not looked
  // up again on every playlist build.
  const cached = cacheGet(canonical);
  if (cached !== undefined) return cached;

  let data;
  try {
    ({ data } = await axios.get(SEARCH_URL, {
      headers: { 'x-api-key': process.env.SETLIST_API_KEY, Accept: 'application/json' },
      params: { artistName: name, p: 1 },
      timeout: 15000,
    }));
  } catch (error) {
    // 404 is setlist.fm's answer for "no setlists", which is not an error worth
    // logging on every festival bill.
    if (error.response?.status !== 404) {
      console.error(`[setlistfm] Lookup failed for ${name}:`, error.response?.status ?? error.message);
    }
    return null;
  }

  const picked = pickSetlistFor(name, data?.setlist);
  cacheSet(canonical, picked);
  return picked;
}

/**
 * Look several names up, one at a time so setlist.fm's rate limit is respected,
 * stopping after `budget` network calls.
 *
 * The budget is what keeps a 57-band festival from turning one click into a
 * minute of waiting: the bands beyond it simply contribute nothing this time,
 * and land in the cache on a later build rather than blocking this one.
 *
 * @param {string[]} names
 * @param {{ budget?: number, fetchOne?: Function }} [options] - `fetchOne` is
 *   injectable so the budget and cache behaviour can be tested without the
 *   network; vitest externalises node_modules, so axios itself cannot be mocked.
 * @returns {Promise<Map<string, object>>} Canonical name → setlist.
 */
async function fetchSetlistsForNames(names, { budget = 8, fetchOne = fetchSetlistByName } = {}) {
  const found = new Map();
  let spent = 0;

  for (const name of names) {
    const canonical = canonicalBandName(name);
    if (!canonical || found.has(canonical)) continue;

    const cached = cacheGet(canonical);
    if (cached !== undefined) {
      if (cached) found.set(canonical, cached);
      continue;
    }

    if (spent >= budget) continue;
    if (spent > 0) await sleep(REQUEST_GAP_MS);
    spent++;

    const setlist = await fetchOne(name);
    if (setlist) found.set(canonical, setlist);
  }

  return found;
}

module.exports = { fetchSetlistByName, fetchSetlistsForNames, pickSetlistFor, songsFrom };
