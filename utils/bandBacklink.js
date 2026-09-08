const { canonicalBandName } = require('./lineupNames');

/**
 * Concert ids whose stored lineup names this band but which are not linked to it.
 *
 * A concert carries its bill twice: as ConcertBandReference rows for bands that
 * existed when it was ingested, and as plain strings in `metadata` for everyone
 * else. /bulk links the two at ingest time against a snapshot of the band table,
 * so a band added later stays a loose string on every bill already stored.
 *
 * That gap is not only cosmetic. `checkDuplicateConcert` leans on a shared band
 * to tell one gig from two, and without it the venue and name rules are on their
 * own: "SWG3 Garden" against "Galvanizers SWG3" scores 0.348 where 0.70 is
 * needed, so the support act's own scraped listing was filed as a second concert
 * 139 m from the headline show it belongs to.
 *
 * Matching is canonical-exact rather than by similarity, for the reason spelled
 * out in lineupNames.js: 0.75 reads "Nothing" as "Nothing More".
 *
 * @param {object} params
 * @param {number} params.bandId
 * @param {unknown} params.bandName
 * @param {{id: number, metadata: string|null, bands: {band: number}[]}[]} params.concerts
 * @returns {number[]}
 */
function unlinkedConcertsNamingBand({ bandId, bandName, concerts }) {
  const key = canonicalBandName(bandName);
  if (!key) return [];

  const ids = [];
  for (const concert of concerts ?? []) {
    if ((concert.bands ?? []).some((ref) => ref.band === bandId)) continue;

    let names;
    try {
      names = JSON.parse(concert.metadata || '[]');
    } catch {
      continue;
    }
    if (!Array.isArray(names)) continue;

    if (names.some((name) => canonicalBandName(name) === key)) ids.push(concert.id);
  }
  return ids;
}

/**
 * Link a band to the upcoming concerts whose stored lineup already names it.
 *
 * Called when a band row is created, which is the moment the gap opens: /bulk
 * links lineup names against the bands that exist at ingest time, and nothing
 * revisits a bill after a band it names is added.
 *
 * Only concerts still to come are considered. The point is to stop a second row
 * being filed for a gig that has not happened yet; rewriting who played a past
 * show is a different decision, and nothing is asking for it.
 *
 * @param {object} params
 * @param {number} params.bandId
 * @param {unknown} params.bandName
 * @param {import('@prisma/client').PrismaClient} params.prisma
 * @returns {Promise<number[]>} The concert ids that were linked.
 */
async function backlinkBandToConcerts({ bandId, bandName, prisma }) {
  if (!canonicalBandName(bandName)) return [];

  const concerts = await prisma.concert.findMany({
    where: { metadata: { not: null }, concert_date: { gte: new Date() } },
    select: { id: true, metadata: true, bands: { select: { band: true } } },
  });

  const ids = unlinkedConcertsNamingBand({ bandId, bandName, concerts });
  if (ids.length === 0) return [];

  // (concert, band) is unique, and a scrape can link the same pair in the gap
  // between the read above and this write. Without skipDuplicates that rejects
  // the whole batch, losing the links that were not duplicates.
  await prisma.concertBandReference.createMany({
    data: ids.map((concert) => ({ concert, band: bandId })),
    skipDuplicates: true,
  });
  return ids;
}

module.exports = { unlinkedConcertsNamingBand, backlinkBandToConcerts };
