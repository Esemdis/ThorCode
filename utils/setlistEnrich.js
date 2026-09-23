/**
 * Finding a concert's setlists on Setlist.fm and linking them to bands we
 * already track.
 *
 * Split out of routes/data/wishlists/attendance.js so the route's
 * fire-and-forget call and the cron backfill (see setlistBackfill.js) run
 * exactly the same lookup — the backfill exists precisely because the
 * route-time attempt happens exactly once and is often too early to find
 * anything.
 */

const axios = require("axios");
const { Prisma } = require("@prisma/client");
const prisma = require("../prisma/client");
const { songsFrom } = require("./externalSetlists");

const SEARCH_URL = "https://api.setlist.fm/rest/1.0/search/setlists";

// Same spacing as the other setlist.fm sweeps; this makes several calls per
// concert now, and the backfill's own spacing only sits between concerts.
const REQUEST_GAP_MS = 1100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function searchSetlists(params) {
  try {
    const res = await axios.get(SEARCH_URL, {
      headers: { "x-api-key": process.env.SETLIST_API_KEY, Accept: "application/json" },
      params: { ...params, p: 1 },
      timeout: 15000,
    });
    return res.data?.setlist ?? [];
  } catch (e) {
    // setlist.fm answers a search with no results as a 404, not an empty list.
    if (e.response?.status === 404) return [];
    throw e;
  }
}

/**
 * Search Setlist.fm for a show and attach any songs found to the bands on
 * that bill we already have in our own Band table, matched by MBID.
 *
 * Two lookups. The venue search finds every tracked band that played that
 * night, including ones not yet linked to this concert — but it depends on our
 * venue and city names matching setlist.fm's, and scraped rows often don't
 * ("Tele2 Arena" vs "Tele2 Arena, Stockholm", "Göteborg" vs "Gothenburg"), in
 * which case it quietly finds nothing and the show never gets a setlist. So
 * every band already on the bill that is still missing one is then looked up
 * by its own MBID and the date, which needs no names at all.
 *
 * Never creates a new Band. Errors are logged and swallowed rather than
 * thrown: the route calls this without awaiting it, so a rejection here would
 * otherwise become an unhandled rejection.
 *
 * @param {number} concertId
 * @param {string} date - dd-MM-yyyy, Setlist.fm's own search format
 * @param {string} venue
 * @param {string} city
 * @param {{ search?: Function, gapMs?: number }} [options] - `search` is
 *   injectable for tests; vitest externalises node_modules, so axios itself
 *   cannot be mocked.
 * @returns {Promise<{ updated: number }>} how many bands got setlist data
 *   from this call — 0 doesn't distinguish "nothing on Setlist.fm yet" from
 *   "no API key configured", but both mean there's nothing more to do here.
 */
async function enrichConcertBands(concertId, date, venue, city, { search = searchSetlists, gapMs = REQUEST_GAP_MS } = {}) {
  if (!process.env.SETLIST_API_KEY && search === searchSetlists) return { updated: 0 };

  // Every artist seen that night, with songs where setlist.fm has them. An
  // artist with none is still linked to the concert — they played it.
  const seen = new Set();
  const mbidSongs = new Map();
  const collect = (setlists) => {
    for (const s of setlists) {
      const mbid = s.artist?.mbid;
      if (!mbid) continue;
      seen.add(mbid);
      if (mbidSongs.has(mbid)) continue;
      const songs = songsFrom(s);
      if (songs.length) mbidSongs.set(mbid, songs);
    }
  };

  try {
    // Venue search. A failure here must not stop the per-band lookups below,
    // which are the ones that don't depend on names matching.
    try {
      collect(await search({ date, venueName: venue, cityName: city }));
    } catch (e) {
      console.error("[enrichConcertBands] Venue search failed:", e.message);
    }

    const linked = await prisma.concertBandReference.findMany({
      where: { concert: concertId, setlist: { equals: Prisma.DbNull }, band_rel: { MBID: { not: null } } },
      select: { band_rel: { select: { MBID: true } } },
    });
    for (const { band_rel } of linked) {
      if (mbidSongs.has(band_rel.MBID)) continue;
      if (gapMs) await sleep(gapMs);
      collect(await search({ date, artistMbid: band_rel.MBID }));
    }

    if (!seen.size) return { updated: 0 };

    const bands = await prisma.band.findMany({
      where: { MBID: { in: [...seen] } },
      select: { id: true, MBID: true },
    });

    let updated = 0;
    for (const band of bands) {
      const songs = mbidSongs.get(band.MBID);
      const setlistData = songs ? { songs } : undefined;
      await prisma.concertBandReference.upsert({
        where: { concert_band: { concert: concertId, band: band.id } },
        create: { concert: concertId, band: band.id, setlist: setlistData },
        update: { ...(setlistData ? { setlist: setlistData } : {}) },
      });
      if (setlistData) updated += 1;
    }
    return { updated };
  } catch (e) {
    console.error("[enrichConcertBands] Error:", e.message);
    return { updated: 0 };
  }
}

module.exports = { enrichConcertBands };
