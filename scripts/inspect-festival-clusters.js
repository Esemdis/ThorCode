// Read-only: prints each cluster detectFestivalCluster finds, with the day
// span and distinct band count behind it, so a threshold can be picked against
// real rows instead of guessed.
//
//   doppler run -c prd -- node scripts/inspect-festival-clusters.js
//
// With --city, dumps every stored row for that city instead, flag included,
// which is how you check why a given day is or is not folding together.
//
//   doppler run -c prd -- node scripts/inspect-festival-clusters.js --city=Dessel

const prisma = require('../prisma/client');
const { detectFestivalCluster } = require('../utils/concertDedup');

const oneDayMs = 24 * 60 * 60 * 1000;
const dayKey = (date) => new Date(date).toISOString().slice(0, 10);

async function main() {
  const concerts = await prisma.concert.findMany({
    where: { concert_date: { not: null } },
    select: {
      id: true, name: true, venue: true, city: true, concert_date: true,
      festival: true, latitude: true, longitude: true,
      bands: { select: { band: true, band_rel: { select: { name: true } } } },
    },
    orderBy: { id: 'asc' },
  });

  const cityArg = process.argv.find((a) => a.startsWith('--city='));
  if (cityArg) {
    const wanted = cityArg.slice('--city='.length).toLowerCase();
    const rows = concerts
      .filter((c) => (c.city ?? '').toLowerCase().includes(wanted))
      .sort((a, b) => new Date(a.concert_date) - new Date(b.concert_date));
    for (const r of rows) {
      const names = r.bands.map((b) => b.band_rel?.name).filter(Boolean);
      console.log(`[${r.id}] ${dayKey(r.concert_date)} festival=${String(r.festival).padEnd(5)} venue="${r.venue ?? '?'}" name="${r.name ?? '?'}" bands=[${names.join(', ')}]`);
    }
    console.log(`\n${rows.length} row(s) in cities matching "${wanted}".`);
    return;
  }

  const byDay = new Map();
  for (const c of concerts) {
    const key = dayKey(c.concert_date);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(c);
  }

  const candidatesAround = (concert) => {
    const start = new Date(concert.concert_date).getTime();
    const out = [];
    for (let offset = -7; offset <= 7; offset++) {
      const bucket = byDay.get(dayKey(start + offset * oneDayMs));
      if (!bucket) continue;
      for (const c of bucket) if (c.id !== concert.id) out.push(c);
    }
    return out;
  };

  const seen = new Set();
  for (const concert of concerts) {
    const bandIds = concert.bands.map((b) => b.band);
    const bandNames = concert.bands.map((b) => b.band_rel?.name).filter(Boolean);
    const { isFestival, matches } = detectFestivalCluster(concert, bandIds, candidatesAround(concert), bandNames);
    if (!isFestival) continue;

    const cluster = [concert, ...matches];
    const signature = cluster.map((c) => c.id).sort((a, b) => a - b).join(',');
    if (seen.has(signature)) continue;
    seen.add(signature);

    const days = new Set(cluster.map((c) => dayKey(c.concert_date)));
    const bands = new Set(cluster.flatMap((c) => c.bands.map((b) => b.band)));
    const flaggedAlready = cluster.filter((c) => c.festival).length;

    const clusterBands = [...new Set(cluster.flatMap((c) => c.bands.map((b) => b.band_rel?.name).filter(Boolean)))];
    console.log(
      `${(concert.name ?? '?').padEnd(34).slice(0, 34)} | rows ${String(cluster.length).padStart(2)} | days ${days.size} | bands ${String(bands.size).padStart(2)} | flagged ${flaggedAlready}/${cluster.length} | ${clusterBands.slice(0, 6).join(', ')}`,
    );
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
