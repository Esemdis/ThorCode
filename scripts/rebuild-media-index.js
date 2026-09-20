/**
 * Rebuild the media index from the archive.
 *
 * Postgres holds a convenience copy of what the sidecars already say, so this
 * script is what makes "the database is disposable" a property you can test
 * rather than a claim in a design document. Run it after a restore, after a
 * manual edit to the share, or whenever the gallery and the folder disagree.
 *
 *   doppler run -- node scripts/rebuild-media-index.js --dry-run
 *   doppler run -- node scripts/rebuild-media-index.js
 *
 * Exits non-zero when it finds drift, so it is usable from a cron that should
 * complain rather than one that should be ignored.
 */

const prisma = require('../prisma/client');
const { archiveRoot } = require('../utils/mediaPaths');
const { attendanceKey, collectArchive, planRebuild } = require('../utils/mediaRebuild');

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const { sidecars, filesOnDisk, noSidecar } = await collectArchive(archiveRoot());

  // wishlist_rel.user_id is what routes/data/media.js authorises byte access
  // from, so the map used to place a restore's rows has to be built from the
  // same field — a map keyed on concert_id alone can only pick one of several
  // attendees at random.
  const attendances = await prisma.concertAttendance.findMany({
    select: { id: true, concert_id: true, wishlist_rel: { select: { user_id: true } } },
  });
  const attendanceIds = new Map(
    attendances.map((a) => [attendanceKey(a.wishlist_rel.user_id, a.concert_id), a.id]),
  );

  const plan = planRebuild({ sidecars, filesOnDisk, attendanceIds });

  console.log(`${sidecars.length} shows, ${plan.upserts.length} files to index`);
  for (const dir of noSidecar) console.warn(`show with files but no sidecar: ${dir}`);
  for (const [label, list] of [
    ['sidecar entry with no file', plan.missingFiles],
    ['file no sidecar mentions', plan.unlistedFiles],
    ['sidecar whose concert has no attendance', plan.unknownConcerts],
    ['folder owner disagrees with its own sidecar', plan.mismatchedUsers],
  ]) {
    for (const item of list) console.warn(`${label}: ${JSON.stringify(item)}`);
  }

  if (!dryRun) {
    for (const row of plan.upserts) {
      await prisma.concertMedia.upsert({
        where: { attendance_id_filename: { attendance_id: row.attendance_id, filename: row.filename } },
        create: row,
        update: row,
      });
    }
    console.log(`indexed ${plan.upserts.length} files`);
  }

  const drift = noSidecar.length + plan.missingFiles.length + plan.unlistedFiles.length
    + plan.unknownConcerts.length + plan.mismatchedUsers.length;
  process.exitCode = drift > 0 ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
