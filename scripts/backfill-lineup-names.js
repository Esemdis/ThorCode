// Rewrites lineups stored before the enricher and /bulk started cleaning names.
//
// Rows written by the Bandsintown lineup enricher hold the raw link text off
// the event page, so every support act carries a follower count:
// ["Counterparts266K Followers", "thrown official53.5K Followers", ...]. The
// frontend strips those at render, but the stored form never matches band.name,
// so a wishlist band on the bill was never linked to the concert.
//
// Cleaning the stored names and re-running the same exact match /bulk uses puts
// those links back. The match is deliberately exact rather than the enricher's
// 0.75 similarity: this runs unattended over every row, and a wrong link here
// is harder to notice than a missing one.
//
//   doppler run -c prd -- node scripts/backfill-lineup-names.js --dry-run
//   doppler run -c prd -- node scripts/backfill-lineup-names.js

const prisma = require('../prisma/client');
const { cleanLineupNames } = require('../utils/lineupNames');

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const concerts = await prisma.concert.findMany({
    where: { metadata: { not: null } },
    select: {
      id: true,
      name: true,
      metadata: true,
      bands: { select: { band: true } },
    },
    orderBy: { id: 'asc' },
  });

  const bands = await prisma.band.findMany({ select: { id: true, name: true } });
  const bandsByName = new Map(bands.map((b) => [b.name.toLowerCase(), b.id]));

  let cleaned = 0;
  let linked = 0;
  let skipped = 0;

  for (const concert of concerts) {
    let parsed;
    try {
      parsed = JSON.parse(concert.metadata);
    } catch {
      skipped++;
      continue;
    }
    if (!Array.isArray(parsed)) { skipped++; continue; }

    const names = cleanLineupNames(parsed);
    const changed = JSON.stringify(names) !== JSON.stringify(parsed);

    const alreadyLinked = new Set(concert.bands.map((b) => b.band));
    const toLink = [...new Set(
      names
        .map((n) => bandsByName.get(n.toLowerCase()))
        .filter((id) => id !== undefined && !alreadyLinked.has(id)),
    )];

    if (!changed && toLink.length === 0) continue;

    if (changed) {
      console.log(`[${concert.id}] ${concert.name ?? '—'}`);
      console.log(`    ${JSON.stringify(parsed)}`);
      console.log(` -> ${JSON.stringify(names)}`);
    }
    if (toLink.length > 0) {
      const linkedNames = toLink.map((id) => bands.find((b) => b.id === id).name);
      console.log(`[${concert.id}] linking ${linkedNames.join(', ')}`);
    }

    if (!dryRun) {
      if (changed) {
        await prisma.concert.update({
          where: { id: concert.id },
          data: { metadata: names.length > 0 ? JSON.stringify(names) : null },
        });
      }
      if (toLink.length > 0) {
        await prisma.concertBandReference.createMany({
          data: toLink.map((band) => ({ concert: concert.id, band })),
          skipDuplicates: true,
        });
      }
    }

    if (changed) cleaned++;
    linked += toLink.length;
  }

  console.log(
    `\n${dryRun ? 'Would clean' : 'Cleaned'} ${cleaned} lineup(s), ` +
    `${dryRun ? 'would add' : 'added'} ${linked} band link(s), ` +
    `skipped ${skipped} row(s) whose metadata was not a JSON array.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
