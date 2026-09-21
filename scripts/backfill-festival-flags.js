// Corrects the festival flag on concerts already stored, using the signal no
// single scraped page could carry.
//
// The scrapers set festival from the bill length on the one event page they
// saw (len(lineup) > 6). Bandsintown publishes a festival as one page per
// artist, so a stage-specific "Slipknot @ Graspop Metal Meeting 2025" page
// lists one act and the rule never fires — Graspop's rows sit at
// festival: false, and the history view, which folds a day's venues together
// only once something that day is flagged, keeps rendering one festival as a
// row per stage name.
//
// detectFestivalCluster is the same function the ingest path now runs, so a
// row backfilled here and a row arriving tomorrow are judged identically:
// concerts sharing a real event name, in the same area, within a week of each
// other, are a festival once they span more than one calendar day or their
// bands add up past five. Rows whose only name is the scraper's "<band> @
// <venue>" fallback are left alone — that name says nothing about an event.
//
// Every id it flips is written to a JSON file first, so the run can be undone:
//
//   doppler run -c prd -- node scripts/restore-festival-flags.js scripts/festival-backfill-<stamp>.json
//
//   doppler run -c prd -- node scripts/backfill-festival-flags.js --dry-run
//   doppler run -c prd -- node scripts/backfill-festival-flags.js

const fs = require('fs');
const path = require('path');
const prisma = require('../prisma/client');
const { detectFestivalCluster } = require('../utils/concertDedup');

const WINDOW_DAYS = 7;
const oneDayMs = 24 * 60 * 60 * 1000;

const dayKey = (date) => new Date(date).toISOString().slice(0, 10);

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const concerts = await prisma.concert.findMany({
    where: { concert_date: { not: null } },
    select: {
      id: true, name: true, venue: true, city: true, concert_date: true,
      festival: true, latitude: true, longitude: true,
      // Names as well as ids: detectFestivalCluster rejects a row titled after
      // one of its own acts, which is what a touring band's rows look like.
      bands: { select: { band: true, band_rel: { select: { name: true } } } },
    },
    orderBy: { id: 'asc' },
  });

  console.log(`Read ${concerts.length} dated concerts.`);

  // Bucketed by calendar day so each concert only compares against the fortnight
  // around it rather than the whole table.
  const byDay = new Map();
  for (const c of concerts) {
    const key = dayKey(c.concert_date);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(c);
  }

  const candidatesAround = (concert) => {
    const start = new Date(concert.concert_date).getTime();
    const out = [];
    for (let offset = -WINDOW_DAYS; offset <= WINDOW_DAYS; offset++) {
      const bucket = byDay.get(dayKey(start + offset * oneDayMs));
      if (!bucket) continue;
      for (const c of bucket) if (c.id !== concert.id) out.push(c);
    }
    return out;
  };

  // A concert is flagged if its own cluster qualifies, or if it is a match
  // inside someone else's qualifying cluster — the stage rows are usually the
  // latter, since alone they carry neither the days nor the bands.
  const toFlag = new Map();
  for (const concert of concerts) {
    const bandIds = concert.bands.map((b) => b.band);
    const bandNames = concert.bands.map((b) => b.band_rel?.name).filter(Boolean);
    const { isFestival, matches } = detectFestivalCluster(concert, bandIds, candidatesAround(concert), bandNames);
    if (!isFestival) continue;
    for (const row of [concert, ...matches]) {
      if (!row.festival) toFlag.set(row.id, row);
    }
  }

  if (toFlag.size === 0) {
    console.log('No concert needs its festival flag corrected.');
    return;
  }

  for (const row of [...toFlag.values()].sort((a, b) => a.id - b.id)) {
    console.log(`[${row.id}] ${dayKey(row.concert_date)}  ${row.name ?? '?'} — ${row.venue ?? '?'}, ${row.city ?? '?'}`);
  }

  const ids = [...toFlag.keys()];

  if (dryRun) {
    console.log(`\nWould flag ${ids.length} concert${ids.length === 1 ? '' : 's'} as a festival.`);
    return;
  }

  // Written before the update, not after: a crash mid-write leaves a file
  // listing more ids than were flipped, which is recoverable, where the
  // reverse would leave flipped rows with no record of them.
  const undoFile = path.join(__dirname, `festival-backfill-${Date.now()}.json`);
  fs.writeFileSync(undoFile, JSON.stringify({ flippedToTrue: ids }, null, 2));
  console.log(`\nUndo list written to ${undoFile}`);

  const { count } = await prisma.concert.updateMany({
    where: { id: { in: ids } },
    data: { festival: true },
  });

  console.log(`Flagged ${count} concert${count === 1 ? '' : 's'} as a festival.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
