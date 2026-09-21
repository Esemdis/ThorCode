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
 * @param {{ limit?: number }} [options]
 * @returns {Promise<{ checked: number, updated: number }>}
 */
async function backfillSetlists({ limit = 50 } = {}) {
  const concerts = await prisma.concert.findMany({
    where: {
      concert_date: { lt: new Date() },
      attendances: { some: {} },
      bands: { some: { setlist: { equals: Prisma.DbNull } } },
    },
    select: { id: true, concert_date: true, venue: true, city: true },
    // Recently attended shows first: a show nobody has looked at in years is
    // less likely to gain a setlist than one from last month.
    orderBy: { concert_date: "desc" },
    take: limit,
  });

  let updated = 0;
  for (const concert of concerts) {
    // Setlist.fm's search wants the venue's own date, not a UTC instant —
    // same derivation the route uses when it first tries this at attend time.
    const d = new Date(concert.concert_date);
    const date = `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;
    const { updated: bandsUpdated } = await enrichConcertBands(concert.id, date, concert.venue, concert.city);
    if (bandsUpdated > 0) updated += 1;
    await sleep(SEARCH_SPACING_MS);
  }

  return { checked: concerts.length, updated };
}

module.exports = { backfillSetlists };
