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
const prisma = require("../prisma/client");

/**
 * Search Setlist.fm for a show and attach any songs found to the bands on
 * that bill we already have in our own Band table, matched by MBID.
 *
 * Never creates a new Band — only bands already linked to this concert (or
 * whose MBID we already track) can gain a setlist here. Errors are logged and
 * swallowed rather than thrown: this is always called without an await'd
 * result, so a rejection here would otherwise become an unhandled rejection.
 *
 * @param {number} concertId
 * @param {string} date - dd-MM-yyyy, Setlist.fm's own search format
 * @param {string} venue
 * @param {string} city
 * @returns {Promise<{ updated: number }>} how many bands got setlist data
 *   from this call — 0 doesn't distinguish "nothing on Setlist.fm yet" from
 *   "no API key configured", but both mean there's nothing more to do here.
 */
async function enrichConcertBands(concertId, date, venue, city) {
  if (!process.env.SETLIST_API_KEY) return { updated: 0 };
  try {
    const res = await axios.get("https://api.setlist.fm/rest/1.0/search/setlists", {
      headers: { "x-api-key": process.env.SETLIST_API_KEY, Accept: "application/json" },
      params: { date, venueName: venue, cityName: city, p: 1 },
      timeout: 15000,
    });
    const setlists = res.data?.setlist ?? [];
    const mbids = [...new Set(setlists.map((s) => s.artist?.mbid).filter(Boolean))];
    if (!mbids.length) return { updated: 0 };

    const bands = await prisma.band.findMany({
      where: { MBID: { in: mbids } },
      select: { id: true, MBID: true },
    });

    // Build mbid -> songs map from search results
    const mbidSongs = new Map();
    for (const s of setlists) {
      const mbid = s.artist?.mbid;
      if (!mbid || mbidSongs.has(mbid)) continue;
      const songs = (s.sets?.set ?? []).flatMap((set) =>
        (set.song ?? []).map((song) => ({
          name: song.name || '',
          cover: song.cover?.name ?? null,
          tape: song.tape ?? false,
        })),
      );
      if (songs.length) mbidSongs.set(mbid, songs);
    }

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
