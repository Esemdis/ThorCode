// Undoes a backfill-festival-flags run, setting back to false exactly the ids
// that run flipped to true.
//
// Takes the JSON file that backfill wrote before touching anything. Only ids
// listed there are changed, so a concert flagged by the scraper, by ingest, or
// by an earlier run keeps its flag.
//
//   doppler run -c prd -- node scripts/restore-festival-flags.js scripts/festival-backfill-<stamp>.json

const fs = require('fs');
const prisma = require('../prisma/client');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Pass the festival-backfill-<stamp>.json written by the backfill run.');
    process.exit(1);
  }

  const { flippedToTrue } = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(flippedToTrue) || flippedToTrue.length === 0) {
    console.log('That file lists no ids to restore.');
    return;
  }

  const { count } = await prisma.concert.updateMany({
    where: { id: { in: flippedToTrue } },
    data: { festival: false },
  });

  console.log(`Set ${count} concert${count === 1 ? '' : 's'} back to festival: false.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
