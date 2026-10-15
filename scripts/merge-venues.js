/**
 * Merge Venue rows that are one building under several names (THO-346).
 *
 * The migration that made the Venue table folded only spellings that are the
 * same words ("Rockefeller" / "ROCKEFELLER "). This proposes the looser ones,
 * within one City: names that mostly agree ("Rockefeller" / "Rockefeller Music
 * Hall"), and rows standing within 200 m of each other ("The O2" / "O2
 * Arena"). The busiest row of a group stays and keeps its name. See
 * utils/venueMatch.js for the rule.
 *
 * A dry run by default. Two rooms in one building (Rockefeller and John Dee)
 * stand at one spot too, so read every line, and veto one by giving its
 * loser's id to --skip.
 *
 *   DATABASE_URL=... node scripts/merge-venues.js
 *   DATABASE_URL=... node scripts/merge-venues.js --skip 41,57
 *   DATABASE_URL=... node scripts/merge-venues.js --apply [--skip ...]
 *
 * --apply makes each merge in its own transaction: concerts move to the row
 * that stays, then the other is deleted. Each concert keeps its own venue text.
 * A failed merge is reported and the rest carry on.
 */

const prisma = require('../prisma/client');
const { planVenueMerges, mergeVenue } = require('../utils/venueMatch');

const apply = process.argv.includes('--apply');
const skipAt = process.argv.indexOf('--skip');
const skip = new Set(skipAt < 0 ? [] : (process.argv[skipAt + 1] ?? '').split(',').filter(Boolean).map(Number));

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function main() {
  const rows = await prisma.venue.findMany({
    select: {
      id: true, name: true, city_id: true, latitude: true, longitude: true,
      city_rel: { select: { name: true, country: true } },
      _count: { select: { concerts: true } },
    },
  });
  const venues = rows.map(({ _count, ...v }) => ({ ...v, concerts: _count.concerts }));

  // Distance-only proposals first, as they are the likeliest to be two rooms.
  const merges = planVenueMerges(venues)
    .filter((m) => !skip.has(m.loser.id))
    .sort((a, b) => a.name - b.name || (b.km ?? -1) - (a.km ?? -1));

  console.log(`${plural(merges.length, 'merge')} among ${plural(venues.length, 'venue')}${skip.size ? `, ${skip.size} skipped` : ''}`
    + `${apply ? '' : ' (dry run: nothing changed, --apply to make them)'}\n`);
  for (const { loser, winner, name, km } of merges) {
    const where = `${loser.city_rel.name}, ${loser.city_rel.country}`;
    const how = `names ${name.toFixed(2)}${km == null ? '' : `, ${Math.round(km * 1000)} m apart`}`;
    console.log(`${where}: ${loser.name} #${loser.id} -> ${winner.name} #${winner.id}   (${how}) moves ${plural(loser.concerts, 'concert')}`);
  }
  if (!apply) return;

  console.log('');
  let failed = 0;
  for (const { loser, winner } of merges) {
    try {
      const moved = await prisma.$transaction((tx) => mergeVenue(tx, loser.id, winner.id));
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
