/**
 * Re-running `findSourceUrls` against the database, for the cron job.
 *
 * Separated from `bandSourceUrls.js` because this file needs `prisma/client`,
 * which requires a real `DATABASE_URL` at import time — pulling it into the
 * lookup module would make that module's pure logic untestable without a
 * database.
 */

const prisma = require('../prisma/client');
const { findSourceUrls, SEARCH_SPACING_MS, STALE_DAYS_DEFAULT, sleep } = require('./bandSourceUrls');

/**
 * Re-attempt Songkick/Bandsintown discovery for bands still missing one or
 * both, up to `limit` per run.
 *
 * Unlike the Spotify match, "checked once" is not a permanent answer here:
 * MusicBrainz relationships are added by volunteers over time, so a band with
 * nothing at creation can gain a match weeks later. `staleDays` re-queues a
 * band instead of skipping it forever once `source_urls_checked_at` ages out,
 * and a band is only ever filled in, never overwritten — a URL fixed by hand
 * through the admin PATCH route is left alone.
 *
 * @param {{ limit?: number, staleDays?: number }} [options]
 * @returns {Promise<{ checked: number, updated: number }>}
 */
async function backfillSourceUrls({ limit = 100, staleDays = STALE_DAYS_DEFAULT } = {}) {
  const staleBefore = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);
  const bands = await prisma.band.findMany({
    where: {
      AND: [
        { OR: [{ songkick_url: null }, { bandsintown_url: null }] },
        { OR: [{ source_urls_checked_at: null }, { source_urls_checked_at: { lt: staleBefore } }] },
      ],
    },
    select: { id: true, name: true, MBID: true, songkick_url: true, bandsintown_url: true },
    orderBy: { name: 'asc' },
    take: limit,
  });

  let updated = 0;
  for (const band of bands) {
    try {
      const [songkickUrl, bandsintownUrl] = await findSourceUrls(band.name, band.MBID);
      const data = { source_urls_checked_at: new Date() };
      if (songkickUrl && !band.songkick_url) data.songkick_url = songkickUrl;
      if (bandsintownUrl && !band.bandsintown_url) data.bandsintown_url = bandsintownUrl;
      await prisma.band.update({ where: { id: band.id }, data });
      if (data.songkick_url || data.bandsintown_url) updated += 1;
    } catch (e) {
      // Not stamped: MusicBrainz being unreachable is not evidence the URLs
      // don't exist, so this band is picked up again on the next sweep.
      console.error(`[bandSourceUrlBackfill] Failed for "${band.name}":`, e.message);
    }
    await sleep(SEARCH_SPACING_MS);
  }

  return { checked: bands.length, updated };
}

module.exports = { backfillSourceUrls };
