/**
 * Report files the archive holds more than one copy of.
 *
 * Uploads were deduplicated by filename alone until the checksum check was
 * added to the upload route, so the same photograph sent twice was stored
 * again as "IMG_1 (2).jpg". This finds what that left behind.
 *
 * It only reports. Deleting is a separate, deliberate act: the app's own
 * DELETE route removes the file, the sidecar entry and the row together, in
 * that order, and is the only thing that should be doing it — a row deleted
 * here would leave bytes on disk and an entry in the record of truth.
 *
 *   doppler run -- node scripts/find-duplicate-media.js
 *   doppler run -- node scripts/find-duplicate-media.js --json
 *
 * Exits non-zero when it finds any, so it is usable from a cron that should
 * complain rather than one that should be ignored.
 */

const prisma = require('../prisma/client');
const { groupDuplicates, redundantBytes } = require('../utils/mediaDuplicates');

const asJson = process.argv.includes('--json');

async function main() {
  const rows = await prisma.concertMedia.findMany({
    select: {
      id: true, attendance_id: true, sha256: true, rel_path: true,
      filename: true, bytes: true, kind: true, created_at: true,
      band_rel: { select: { name: true } },
      attendance_rel: {
        select: { concert_rel: { select: { concert_date: true, venue: true, city: true } } },
      },
    },
    orderBy: { id: 'asc' },
  });

  const groups = groupDuplicates(rows);

  if (asJson) {
    console.log(JSON.stringify(groups, null, 2));
    process.exitCode = groups.length ? 1 : 0;
    return;
  }

  if (!groups.length) {
    console.log(`no duplicates among ${rows.length} files`);
    return;
  }

  const wasted = (redundantBytes(groups) / (1024 * 1024)).toFixed(1);
  console.log(
    `${groups.length} duplicated file${groups.length === 1 ? '' : 's'} across ${rows.length} rows`
    + ` — ${wasted} MB of redundant copies\n`,
  );

  for (const group of groups) {
    const show = group[0].attendance_rel?.concert_rel;
    // Sliced, not parsed: concert_date is a calendar day, and reading it
    // through a local Date slides it a day for anyone west of UTC.
    const when = show?.concert_date ? show.concert_date.toISOString().slice(0, 10) : 'undated';
    console.log(`${when} ${show?.venue ?? '?'}, ${show?.city ?? '?'} — ${group.length} copies`);
    for (const [i, r] of group.entries()) {
      const band = r.band_rel?.name ? ` [${r.band_rel.name}]` : '';
      // "keep" is advice, not a decision. The oldest row is the one the
      // sidecar entry and any tags are attached to.
      console.log(`  ${i === 0 ? 'keep ' : 'extra'} id=${r.id}  ${r.rel_path}${band}`);
    }
    console.log('');
  }

  process.exitCode = 1;
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
