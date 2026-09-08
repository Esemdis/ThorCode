// Links bands to upcoming bills that already name them but were ingested first.
//
// /bulk matches a concert's lineup names against the bands that exist at ingest
// time, and until utils/bandBacklink.js nothing revisited a bill after a band it
// names was added. So every band added after a gig was stored stayed a loose
// string on it: grey in the popup, and — because checkDuplicateConcert needs a
// shared band to tell one gig from two — a second concert row the next time that
// band was scraped. Dance Gavin Dance at Galvanizers SWG3 named As December
// Falls from May onward and got a duplicate 139 m away in September.
//
// Only concerts still to come, matching the runtime path: this exists to stop a
// duplicate being filed for a gig that has not happened yet.
//
//   doppler run -c prd -- node scripts/backfill-band-concert-links.js --dry-run
//   doppler run -c prd -- node scripts/backfill-band-concert-links.js

const prisma = require('../prisma/client');
const { unlinkedConcertsNamingBand } = require('../utils/bandBacklink');

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const concerts = await prisma.concert.findMany({
    where: { metadata: { not: null }, concert_date: { gte: new Date() } },
    select: { id: true, name: true, city: true, concert_date: true, metadata: true, bands: { select: { band: true } } },
    orderBy: { id: 'asc' },
  });
  const bands = await prisma.band.findMany({ select: { id: true, name: true } });

  // Per band rather than per concert, because that is the shape the runtime path
  // uses: one band, every bill that names it.
  const toLink = [];
  for (const band of bands) {
    for (const concertId of unlinkedConcertsNamingBand({ bandId: band.id, bandName: band.name, concerts })) {
      toLink.push({ concert: concertId, band: band.id, bandName: band.name });
    }
  }

  for (const link of toLink) {
    const concert = concerts.find((c) => c.id === link.concert);
    console.log(
      `[${concert.id}] ${concert.city ?? '—'} ${String(concert.concert_date).slice(0, 10)} ` +
      `"${concert.name ?? '—'}" -> ${link.bandName}`,
    );
  }

  if (!dryRun && toLink.length > 0) {
    await prisma.concertBandReference.createMany({
      data: toLink.map(({ concert, band }) => ({ concert, band })),
      skipDuplicates: true,
    });
  }

  console.log(
    `\n${dryRun ? 'Would add' : 'Added'} ${toLink.length} band link(s) ` +
    `across ${new Set(toLink.map((l) => l.concert)).size} concert(s), ` +
    `from ${concerts.length} upcoming row(s) with a lineup.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
