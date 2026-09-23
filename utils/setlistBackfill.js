/**
 * Re-running Setlist.fm enrichment for attended shows still missing a
 * setlist for one of their bands, for the cron job.
 *
 * The route-time call (routes/data/wishlists/attendance.js, both the ordinary
 * "mark attended" and the from-setlist import) is fire-and-forget and tried
 * exactly once. The ordinary case — a show marked attended while it's still
 * upcoming, which is most of them, since "Going" and "Attended" are the same
 * table split by date — searches Setlist.fm before the show has even
 * happened, so it can only ever come back empty. Nothing else ever asks
 * again once the real setlist exists. This closes that gap.
 */

const { Prisma } = require("@prisma/client");
const prisma = require("../prisma/client");
const { enrichConcertBands } = require("./setlistEnrich");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Not documented by Setlist.fm as a hard per-key limit, but comfortably under
// it and consistent with the spacing already used for other third-party API
// sweeps in this codebase (see bandSourceUrls.js).
const SEARCH_SPACING_MS = 1100;

/**
 * @param {{ limit?: number, enrich?: Function, gapMs?: number }} [options] - `enrich` is
 *   injectable for tests.
 * @returns {Promise<{ checked: number, updated: number }>}
 */
async function backfillSetlists({ limit = 50, enrich = enrichConcertBands, gapMs = SEARCH_SPACING_MS } = {}) {
  const concerts = await prisma.concert.findMany({
    where: {
      concert_date: { lt: new Date() },
      attendances: { some: {} },
      // Only a band with an MBID can ever be matched, so a show whose only
      // gap is a band without one would be fetched every day for nothing.
      bands: { some: { setlist: { equals: Prisma.DbNull }, band_rel: { MBID: { not: null } } } },
    },
    select: { id: true, concert_date: true, venue: true, city: true },
    // Never-checked first, then least recently checked. Ordering by date alone
    // meant the fifty newest shows still missing a setlist — often because a
    // support act simply has none on setlist.fm — were retried every day and
    // every older show behind them was never reached. Among equals, recent
    // shows first: they are the likeliest to have gained a setlist.
    orderBy: [{ setlist_checked_at: { sort: "asc", nulls: "first" } }, { concert_date: "desc" }],
    take: limit,
  });

  let updated = 0;
  for (const concert of concerts) {
    // Setlist.fm's search wants the venue's own date, not a UTC instant —
    // same derivation the route uses when it first tries this at attend time.
    const d = new Date(concert.concert_date);
    const date = `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;
    const { updated: bandsUpdated } = await enrich(concert.id, date, concert.venue, concert.city);
    if (bandsUpdated > 0) updated += 1;
    await prisma.concert.update({ where: { id: concert.id }, data: { setlist_checked_at: new Date() } });
    if (gapMs) await sleep(gapMs);
  }

  return { checked: concerts.length, updated };
}

module.exports = { backfillSetlists };
