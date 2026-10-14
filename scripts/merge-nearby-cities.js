/**
 * Merge City rows that are one place under several names (THO-316).
 *
 * Ingest now files a show under a stored City in its country within 15 km
 * (utils/cityMatch.js). This does the same for the rows stored before that:
 * "Greater London" into "London", "Wien" into "Vienna", "Johanneshov" into
 * "Stockholm". The busiest row of a group stays and keeps its name.
 *
 * A dry run by default. It prints every merge it would make, farthest first,
 * since the farthest are the likeliest to be two towns: read them, and veto
 * one by giving its loser's id to --skip.
 *
 *   DATABASE_URL=... node scripts/merge-nearby-cities.js
 *   DATABASE_URL=... node scripts/merge-nearby-cities.js --skip 41,57
 *   DATABASE_URL=... node scripts/merge-nearby-cities.js --apply [--skip ...]
 *
 * --apply makes each merge in its own transaction: concerts, watches and home
 * cities move to the row that stays, then the other is deleted. A failed merge
 * is reported and the rest carry on. Run it after the ingest change is
 * deployed: the old ingest recreates a deleted spelling on its next show.
 */

const prisma = require('../prisma/client');
const { planCityMerges, mergeCity } = require('../utils/cityMatch');

const apply = process.argv.includes('--apply');
const skipAt = process.argv.indexOf('--skip');
const skip = new Set(skipAt < 0 ? [] : (process.argv[skipAt + 1] ?? '').split(',').filter(Boolean).map(Number));

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function main() {
  const [rows, homeRows] = await Promise.all([
    prisma.city.findMany({
      select: {
        id: true, name: true, country: true, latitude: true, longitude: true,
        _count: { select: { concerts: true, notification_subscriptions: true } },
      },
    }),
    prisma.$queryRaw`
      SELECT settings->>'homeCityId' AS id, count(*)::int AS n FROM "User"
      WHERE settings->>'homeCityId' IS NOT NULL GROUP BY 1`,
  ]);
  const homes = new Map(homeRows.map((r) => [Number(r.id), r.n]));
  const cities = rows.map(({ _count, ...c }) => ({
    ...c, concerts: _count.concerts, watches: _count.notification_subscriptions, homes: homes.get(c.id) ?? 0,
  }));

  const merges = planCityMerges(cities)
    .filter((m) => !skip.has(m.loser.id))
    .sort((a, b) => b.km - a.km);

  console.log(`${plural(merges.length, 'merge')} among ${plural(cities.length, 'city', 'cities')}${skip.size ? `, ${skip.size} skipped` : ''}`
    + `${apply ? '' : ' (dry run: nothing changed, --apply to make them)'}\n`);
  for (const { loser, winner, km } of merges) {
    console.log(`${km.toFixed(1).padStart(5)} km  ${loser.country}  ${loser.name} #${loser.id} -> ${winner.name} #${winner.id}`
      + `   moves ${plural(loser.concerts, 'concert')}, ${plural(loser.watches, 'watch', 'watches')}, ${plural(loser.homes, 'home city', 'home cities')}`);
  }
  if (!apply) return;

  console.log('');
  let failed = 0;
  for (const { loser, winner } of merges) {
    try {
      const moved = await prisma.$transaction((tx) => mergeCity(tx, loser.id, winner.id));
      console.log(`merged #${loser.id} into #${winner.id}: ${JSON.stringify(moved)}`);
    } catch (err) {
      failed++;
      console.error(`FAILED #${loser.id} into #${winner.id}: ${err.message}`);
    }
  }
  console.log(`\n${merges.length - failed} merged, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
