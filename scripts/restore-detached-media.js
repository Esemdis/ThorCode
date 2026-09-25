/**
 * Put back a show folder a cleanup sweep moved into `_detached`.
 *
 * `detachAttendances` moves a show folder to `_detached` and drops its index
 * rows, so the bytes survive a concert going away. What it cannot do is put the
 * night back: the rebuild skips `_detached` by design, because the sidecar in
 * there names a concert_id that no longer exists. Nothing else in the archive
 * knows those folders are supposed to come back.
 *
 * So this reads each detached sidecar — which the design has always insisted
 * is the record of truth, and which carries the concert's date, venue, city and
 * country precisely so that "a restore needs nothing but the folder" is true —
 * recreates the concert and attendance it names, and moves the folder back
 * where the index expects it.
 *
 *   doppler run -- node scripts/restore-detached-media.js --dry-run
 *   doppler run -- node scripts/restore-detached-media.js
 *   doppler run -- node scripts/restore-detached-media.js --only "2026-06-12 Oslo - Gojira"
 *
 * It does NOT write ConcertMedia rows. Turning sidecars into rows is
 * `rebuild-media-index.js`'s job and it is the tested path for it, so this
 * stops at the point that script can see the folder, and says so.
 *
 * The concert it recreates is a new row with a new id, not the id the sidecar
 * remembers — the old one is gone and ids are not reusable. The sidecar is
 * rewritten to name the new concert, which is what lets the rebuild match it.
 */

const path = require('node:path');
const { readdir, rename, access } = require('node:fs/promises');

const prisma = require('../prisma/client');
const { archiveRoot, DETACHED_DIR } = require('../utils/mediaPaths');
const { archiveStatus } = require('../utils/mediaHealth');
const { readSidecar, writeSidecar } = require('../utils/mediaSidecar');

const dryRun = process.argv.includes('--dry-run');
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt === -1 ? null : process.argv[onlyAt + 1];

const exists = (p) => access(p).then(() => true, () => false);

/** Every `_detached/<folder>` in the archive, with the owner it sits under. */
async function detachedFolders() {
  const root = archiveRoot();
  const found = [];
  for (const userSegment of await readdir(root, { withFileTypes: true })) {
    if (!userSegment.isDirectory()) continue;
    const detachedDir = path.join(root, userSegment.name, DETACHED_DIR);
    if (!(await exists(detachedDir))) continue;
    for (const folder of await readdir(detachedDir, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      found.push({
        userSegment: userSegment.name,
        folderName: folder.name,
        absDir: path.join(detachedDir, folder.name),
      });
    }
  }
  return found;
}

/**
 * The concert and attendance this sidecar's night needs, created if they are
 * gone and reused if they are not.
 *
 * Matched on date plus venue rather than on the remembered concert_id: that id
 * was deleted and a new row cannot have it, and a second run of this script
 * must find the concert the first run made rather than making another.
 */
async function ensureShow(sidecar) {
  const { user_id: userId, concert } = sidecar;
  const wishlist = await prisma.wishlist.findUnique({ where: { user_id: userId } });
  if (!wishlist) return { error: `no wishlist for user ${userId}` };

  const date = new Date(concert.date);
  if (Number.isNaN(date.getTime())) return { error: `sidecar has no readable date` };

  let row = await prisma.concert.findFirst({
    where: { concert_date: date, venue: concert.venue ?? undefined },
  });
  let createdConcert = false;
  if (!row) {
    row = await prisma.concert.create({
      data: {
        // Named for what it is. The scraper's own fields — event_id, the source
        // urls, coordinates — are gone with the old row and are not inventable;
        // the enrich passes can fill them again from the venue and the date.
        name: concert.venue ?? 'Restored show',
        concert_date: date,
        // country, venue and city are NOT NULL with no default, so a sidecar
        // missing one of them has to become an empty string rather than fail
        // the whole restore. An empty venue reads poorly; a refused restore
        // leaves the night in _detached, which is worse.
        venue: concert.venue ?? '',
        city: concert.city ?? '',
        country: concert.country ?? '',
        // Required, and neither is knowable now. created_at is when this row
        // was made, which is true and is all it has ever meant; on_sale is
        // about a show in the future and this one has happened.
        created_at: new Date(),
        on_sale: false,
      },
    });
    createdConcert = true;
  }

  let attendance = await prisma.concertAttendance.findFirst({
    where: { concert_id: row.id, wishlist_id: wishlist.id },
  });
  let createdAttendance = false;
  if (!attendance) {
    attendance = await prisma.concertAttendance.create({
      data: { concert_id: row.id, wishlist_id: wishlist.id },
    });
    createdAttendance = true;
  }

  return { concert: row, attendance, createdConcert, createdAttendance };
}

async function main() {
  const archive = await archiveStatus();
  if (!archive.readable) {
    console.error(`no usable archive at ${archive.root ?? '(MEDIA_ROOT unset)'} (${archive.reason})`
      + ' — is the media share mounted?');
    process.exitCode = 1;
    return;
  }

  let folders = await detachedFolders();
  if (only) folders = folders.filter((f) => f.folderName === only);

  if (!folders.length) {
    console.log(only
      ? `nothing in _detached called ${JSON.stringify(only)}`
      : 'nothing in _detached');
    return;
  }

  console.log(`${folders.length} detached folder${folders.length === 1 ? '' : 's'}\n`);

  let restored = 0;
  for (const folder of folders) {
    let sidecar;
    try {
      sidecar = await readSidecar(folder.absDir);
    } catch (err) {
      console.error(`${folder.folderName}: sidecar cannot be read — ${err.message}`);
      process.exitCode = 1;
      continue;
    }
    // Without a sidecar there is nothing to say which night this was, and
    // guessing it from the folder name is exactly what the archive's design
    // refuses to do: the name is never parsed.
    if (!sidecar) {
      console.error(`${folder.folderName}: no sidecar, so nothing here says which show it is`);
      process.exitCode = 1;
      continue;
    }

    const target = path.join(archiveRoot(), folder.userSegment, folder.folderName);
    const files = sidecar.files?.length ?? 0;
    const label = [sidecar.concert?.date?.slice?.(0, 10), sidecar.concert?.venue]
      .filter(Boolean).join(' ');

    if (await exists(target)) {
      console.error(`${folder.folderName}: ${target} already exists — refusing to overwrite it`);
      process.exitCode = 1;
      continue;
    }

    if (dryRun) {
      console.log(`would restore ${folder.folderName} — ${label}, ${files} file${files === 1 ? '' : 's'},`
        + ` owner ${sidecar.user_id}, sidecar names concert ${sidecar.concert_id}`);
      continue;
    }

    const show = await ensureShow(sidecar);
    if (show.error) {
      console.error(`${folder.folderName}: ${show.error}`);
      process.exitCode = 1;
      continue;
    }

    // Moved before the sidecar is rewritten: a sidecar naming the new concert
    // while its folder is still in _detached is a folder the rebuild still
    // cannot see, and the next run of this script would not know it had been
    // half-done.
    await rename(folder.absDir, target);
    await writeSidecar(target, { ...sidecar, concert_id: show.concert.id });

    console.log(
      `restored ${folder.folderName} — ${label}, ${files} file${files === 1 ? '' : 's'}`
      + `\n  concert ${show.concert.id}${show.createdConcert ? ' (created)' : ' (existing)'}`
      + `, attendance ${show.attendance.id}${show.createdAttendance ? ' (created)' : ' (existing)'}`,
    );
    restored += 1;
  }

  if (dryRun) {
    console.log('\nnothing written. Run without --dry-run to restore.');
    return;
  }

  if (restored) {
    console.log(
      `\n${restored} folder${restored === 1 ? '' : 's'} back in the archive. The files are not`
      + ' indexed yet — run scripts/rebuild-media-index.js --dry-run, check it reports them,'
      + ' then run it for real.',
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
