/**
 * Read capture times out of photographs already in the archive.
 *
 * Uploads have read EXIF since the gallery started showing a night in the order
 * it happened, but every photograph stored before that carries `taken_at: null`
 * and sorts to the end. The bytes still hold the answer — EXIF travels inside
 * the JPEG — so this is a read of files that are already there, not a repair of
 * anything lost.
 *
 *   doppler run -- node scripts/backfill-media-taken-at.js --dry-run
 *   doppler run -- node scripts/backfill-media-taken-at.js
 *
 * Photographs only. A clip's time comes out of its MP4 container and is read by
 * the uploading browser; there is no decoder here, which is the same reason
 * posters cannot be regenerated on this server.
 *
 * It writes the sidecar as well as the row, and that is the point rather than a
 * courtesy: `concert-media.json` is the record of truth and Postgres is a
 * disposable index of it, so a time written only to the database is one the next
 * rebuild throws away.
 */

const prisma = require('../prisma/client');
const { resolveArchivePath } = require('../utils/mediaPaths');
const { archiveStatus } = require('../utils/mediaHealth');
const { exifCapturedAtOfFile } = require('../utils/exifCapturedAt');
const { capturedAtFor } = require('../utils/mediaCapture');
const { updateSidecar, upsertFile } = require('../utils/mediaSidecar');
const { showDir } = require('../utils/mediaMissing');

const dryRun = process.argv.includes('--dry-run');

async function main() {
  // Asked first. With the share unmounted every file is unreadable and the run
  // would report the whole archive as having no EXIF, which is a lie that looks
  // like a finding.
  const archive = await archiveStatus();
  if (!archive.readable || archive.reason === 'empty') {
    console.error(
      `no usable archive at ${archive.root ?? '(MEDIA_ROOT unset)'} (${archive.reason})`
      + ' — is the media share mounted?',
    );
    process.exitCode = 1;
    return;
  }

  const rows = await prisma.concertMedia.findMany({
    where: { kind: 'PHOTO', taken_at: null },
    select: {
      id: true, rel_path: true, filename: true,
      attendance_rel: { select: { concert_rel: { select: { concert_date: true } } } },
    },
    orderBy: { id: 'asc' },
  });

  if (!rows.length) {
    console.log('every photograph in the index already has a capture time');
    return;
  }

  console.log(`${rows.length} photograph${rows.length === 1 ? '' : 's'} with no capture time\n`);

  const found = [];
  const noExif = [];
  const implausible = [];
  const unreadable = [];

  for (const row of rows) {
    let absPath;
    try {
      absPath = resolveArchivePath(row.rel_path);
    } catch {
      // A rel_path that would escape the archive is a much worse finding than a
      // missing stamp, and find-missing-media.js is where it gets reported.
      unreadable.push(row);
      continue;
    }

    // Sequential rather than in parallel: this walks an SMB share a file at a
    // time, and forty concurrent header reads over a home connection is slower
    // than doing them in order as well as harder to interrupt.
    const read = await exifCapturedAtOfFile(absPath);
    if (!read) { noExif.push(row); continue; }

    // The same window the upload applies, for the same reason: a camera whose
    // clock was never set writes a plausible-looking date years away, and
    // believed it would drag that photograph to one end of every gallery.
    const iso = capturedAtFor(read.iso, 'PHOTO', row.attendance_rel?.concert_rel?.concert_date);
    if (!iso) { implausible.push({ row, read }); continue; }

    found.push({ row, iso, zoned: read.zoned });
  }

  for (const item of implausible) {
    console.warn(`refused, contradicts its show: id ${item.row.id} ${item.row.filename} — ${item.read.iso}`);
  }
  for (const row of unreadable) {
    console.error(`refused, path outside the archive: id ${row.id} ${row.rel_path}`);
  }

  // Said out loud because it is the one inaccuracy in the result. Without
  // OffsetTimeOriginal the stamp is read as UTC and may be out by the venue's
  // offset — a constant shift per device per night, so it never reorders that
  // camera's own photographs, only their placing against another device's.
  const unzoned = found.filter((f) => !f.zoned).length;
  console.log(
    `${found.length} readable, ${noExif.length} with no usable EXIF,`
    + ` ${implausible.length} refused by the window, ${unreadable.length} unresolvable`
    + (unzoned ? `\n${unzoned} of the readable carried no timezone and were taken as UTC` : ''),
  );

  if (dryRun) {
    for (const { row, iso } of found.slice(0, 20)) {
      console.log(`  would set id ${row.id} ${row.filename} → ${iso}`);
    }
    if (found.length > 20) console.log(`  … and ${found.length - 20} more`);
    return;
  }

  // Grouped by show so each sidecar is opened once rather than once per file.
  const byShow = new Map();
  for (const item of found) {
    const dir = showDir(item.row.rel_path);
    const group = byShow.get(dir);
    if (group) group.push(item); else byShow.set(dir, [item]);
  }

  let written = 0;
  let sidecarsMissing = 0;

  for (const [dir, items] of byShow) {
    // The row first: a sidecar entry whose row disagrees is drift the rebuild
    // will silently correct back, whereas a row whose sidecar has not caught up
    // is corrected the next time this runs.
    await prisma.$transaction(items.map(({ row, iso }) => prisma.concertMedia.update({
      where: { id: row.id },
      data: { taken_at: new Date(iso) },
    })));
    written += items.length;

    const times = new Map(items.map(({ row, iso }) => [row.filename, iso]));
    const result = await updateSidecar(resolveArchivePath(dir), (current) => {
      // No sidecar to update means the show folder is not what the index thinks
      // it is, which is find-missing-media.js's finding rather than this one's.
      if (!current) return null;
      let next = current;
      for (const entry of current.files) {
        const iso = times.get(entry.name);
        if (iso) next = upsertFile(next, { ...entry, taken_at: iso });
      }
      return next;
    });
    if (!result) sidecarsMissing += 1;
  }

  console.log(`\nwrote ${written} capture time${written === 1 ? '' : 's'} across ${byShow.size} show${byShow.size === 1 ? '' : 's'}`);
  if (sidecarsMissing) {
    console.warn(
      `${sidecarsMissing} show${sidecarsMissing === 1 ? '' : 's'} had no sidecar to update:`
      + ' the rows are written but a rebuild would discard them. Run'
      + ' scripts/find-missing-media.js.',
    );
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
