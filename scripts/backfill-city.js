/**
 * One-time backfill: create City records for all existing concerts and link city_id.
 *
 * Run from ThorCode/: node scripts/backfill-city.js
 */
const prisma = require('../prisma/client');

async function main() {
  const concerts = await prisma.concert.findMany({
    where: { city_id: null },
    select: {
      id: true,
      city: true,
      country: true,
      latitude: true,
      longitude: true,
      reachable: true,
    },
    orderBy: { id: 'asc' },
  });

  console.log(`Backfilling city_id for ${concerts.length} concert(s)...`);

  const cityCache = new Map(); // "city|||country" → city_id

  let linked = 0;
  let skipped = 0;

  for (const c of concerts) {
    if (!c.city || !c.country) {
      skipped++;
      continue;
    }

    const key = `${c.city}|||${c.country}`;

    if (!cityCache.has(key)) {
      const city = await prisma.city.upsert({
        where: { name_country: { name: c.city, country: c.country } },
        create: {
          name: c.city,
          country: c.country,
          latitude:  c.latitude  ? parseFloat(c.latitude)  : null,
          longitude: c.longitude ? parseFloat(c.longitude) : null,
          reachable: c.reachable ?? null,
        },
        update: {
          // Backfill lat/lng if the city record doesn't have them yet
          ...(c.latitude  && { latitude:  parseFloat(c.latitude)  }),
          ...(c.longitude && { longitude: parseFloat(c.longitude) }),
          ...(c.reachable && { reachable: c.reachable }),
        },
      });
      cityCache.set(key, city.id);
    }

    await prisma.concert.update({
      where: { id: c.id },
      data: { city_id: cityCache.get(key) },
    });

    linked++;
  }

  console.log(
    `Done. Linked ${linked} concert(s) to ${cityCache.size} unique city/ies. Skipped ${skipped} (no city/country).`
  );
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
