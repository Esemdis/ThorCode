/**
 * Sharing a whole night, or its picks (THO-849), by public link (THO-892)
 * against Postgres.
 *
 * The unit tests fake Prisma, and the fake answers `has` and `hasSome` on the
 * attendance_ids array with a few lines of JavaScript written to agree with
 * the route. This is the only place those filters meet the database that has
 * to honour them — and where a link's reach is checked against real rows of
 * two real users.
 *
 * Skipped unless INTEGRATION_DATABASE_URL is set; see regressions.test.js.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { minimalJpegTho894 } from '../exifFixture.js';

const url = process.env.INTEGRATION_DATABASE_URL;
const require = createRequire(import.meta.url);

describe.skipIf(!url)('album share links', () => {
  let prisma;
  let app;
  let root;
  const RUN = `as${Date.now()}`;
  const COUNTRY = 'XA';
  const bearer = (id) => `Bearer ${require('../../auth/signJWT.js')({ user: { id, role: 'USER' } })}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.JWT_SECRET ||= 'integration-secret';
    process.env.MEDIA_URL_SECRET ||= 'integration-media-secret';
    process.env.CALLBACK_URL = 'https://api.example.test';
    root = await mkdtemp(join(tmpdir(), 'album-int-'));
    process.env.MEDIA_ROOT = root;
    prisma = require('../../prisma/client.js');
    app = express().use(express.json()).use('/data/concerts', require('../../routes/data/media.js'));
  });

  afterAll(async () => {
    const mine = { wishlist_rel: { user_id: { startsWith: RUN } } };
    await prisma.mediaAlbumShareLink.deleteMany({ where: { user_id: { startsWith: RUN } } });
    await prisma.concertMedia.deleteMany({ where: { attendance_rel: mine } });
    await prisma.concertAttendance.deleteMany({ where: mine });
    await prisma.wishlist.deleteMany({ where: { user_id: { startsWith: RUN } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
    await prisma.concertBandReference.deleteMany({ where: { concert_rel: { country: COUNTRY } } });
    await prisma.concert.deleteMany({ where: { country: COUNTRY } });
    await prisma.band.deleteMany({ where: { name: { startsWith: RUN } } });
    await prisma.$disconnect();
  });

  const makeAlbumUser = async (tag) => {
    const user = await prisma.user.create({ data: { id: `${RUN}-${tag}`, email: `${RUN}-${tag}@example.test` } });
    const wishlist = await prisma.wishlist.create({ data: { name: 'Mine', user_id: user.id } });
    return { user, wishlist };
  };

  const makeAlbumShow = (venue) => prisma.concert.create({
    data: {
      country: COUNTRY, city: `${RUN} Oslo`, venue, created_at: new Date(), on_sale: false,
      concert_date: new Date('2026-06-12T19:00:00Z'),
    },
  });

  // A media row with its bytes where the archive keeps them. A real JPEG and a
  // hex checksum, as an upload writes them: the album's /file is a scrubbed
  // copy named by the checksum (THO-894), and text in a .jpg is refused.
  const makeAlbumFile = async ({ attendanceId, userId, filename, bandId = null, bytes = minimalJpegTho894 }) => {
    const dir = join(root, 'archive', userId, 'night');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), bytes);
    return prisma.concertMedia.create({
      data: {
        attendance_id: attendanceId, band_id: bandId, rel_path: `${userId}/night/${filename}`, filename,
        kind: 'PHOTO', bytes: bytes.length, sha256: createHash('sha256').update(`${RUN}-${filename}`).digest('hex'),
      },
    });
  };

  const share = (userId, ids) => request(app)
    .post('/data/concerts/album-shares').set('Authorization', bearer(userId)).send({ attendance_ids: ids });
  const stop = (userId, ids) => request(app)
    .delete(`/data/concerts/album-shares?attendance_ids=${ids.join(',')}`).set('Authorization', bearer(userId));
  const open = (token) => request(app).get(`/data/concerts/album-shares/${token}`);
  const listing = (userId, attendanceId) => request(app)
    .get(`/data/concerts/attendances/${attendanceId}/media`).set('Authorization', bearer(userId));

  it('shares a night of two stages, widens and never narrows, and stops from either stage', async () => {
    const owner = await makeAlbumUser('owner');
    const other = await makeAlbumUser('other');
    const main = await makeAlbumShow('Main Stage');
    const tent = await makeAlbumShow('Tent');
    const band = await prisma.band.create({ data: { name: `${RUN} Gojira` } });
    const stray = await prisma.band.create({ data: { name: `${RUN} Alcest` } });
    await prisma.concertBandReference.create({
      data: { concert: main.id, band: band.id, setlist: { songs: [{ name: 'Stranded' }] } },
    });
    const a1 = await prisma.concertAttendance.create({ data: { wishlist_id: owner.wishlist.id, concert_id: main.id } });
    const a2 = await prisma.concertAttendance.create({ data: { wishlist_id: owner.wishlist.id, concert_id: tent.id } });
    const theirs = await prisma.concertAttendance.create({ data: { wishlist_id: other.wishlist.id, concert_id: main.id } });
    const f1 = await makeAlbumFile({ attendanceId: a1.id, userId: owner.user.id, filename: 'IMG_1.jpg', bandId: band.id });
    const f2 = await makeAlbumFile({ attendanceId: a2.id, userId: owner.user.id, filename: 'IMG_2.jpg', bandId: stray.id });
    const f3 = await makeAlbumFile({ attendanceId: theirs.id, userId: other.user.id, filename: 'IMG_3.jpg' });

    // Someone else's attendance in the list shares nothing at all.
    await share(owner.user.id, [a1.id, theirs.id]).expect(404);
    expect(await prisma.mediaAlbumShareLink.count({ where: { user_id: owner.user.id } })).toBe(0);

    // One stage first. The array comes back from Postgres as it went in.
    const first = await share(owner.user.id, [a1.id]).expect(200);
    const { token } = first.body.data;
    expect((await open(token).expect(200)).body.data.files.map((f) => f.id)).toEqual([f1.id]);

    // `has`: each show of the night reports the link only once it takes it in.
    expect((await listing(owner.user.id, a1.id).expect(200)).body.data.album_shared_until)
      .toBe(first.body.data.expires_at);
    expect((await listing(owner.user.id, a2.id).expect(200)).body.data.album_shared_until).toBeNull();
    // And never to another user, whose attendance is of the very same show.
    expect((await listing(other.user.id, theirs.id).expect(200)).body.data.album_shared_until).toBeNull();

    // `hasSome`: the night grown to two stages finds the live link and widens it.
    const grown = await share(owner.user.id, [a2.id, a1.id]).expect(200);
    expect(grown.body.data.token).toBe(token);
    // Asked for as one stage again, it keeps both.
    expect((await share(owner.user.id, [a2.id]).expect(200)).body.data.token).toBe(token);
    const row = await prisma.mediaAlbumShareLink.findUnique({ where: { token } });
    expect(row.attendance_ids).toEqual([a1.id, a2.id].sort((x, y) => x - y));
    expect(await prisma.mediaAlbumShareLink.count({ where: { user_id: owner.user.id } })).toBe(1);

    const album = (await open(token).expect(200)).body.data;
    expect(album.files.map((f) => f.id).sort((x, y) => x - y)).toEqual([f1.id, f2.id].sort((x, y) => x - y));
    expect(album.night).toMatchObject({ date: '2026-06-12', venues: ['Main Stage', 'Tent'], country: COUNTRY });
    // The bill's act with its setlist, then the act a file is filed under
    // that is on neither bill.
    expect(album.bands).toEqual([
      { id: band.id, name: band.name, setlist: { songs: [{ name: 'Stranded' }] } },
      { id: stray.id, name: stray.name, setlist: null },
    ]);

    // The bytes: the night's own files as downloads, nobody else's.
    const bytesAt = (id) => request(app).get(`/data/concerts/album-shares/${token}/media/${id}/file`);
    const sent = await bytesAt(f2.id).expect(200);
    expect(sent.headers['content-disposition']).toMatch(/attachment; filename="IMG_2\.jpg"/);
    await bytesAt(f3.id).expect(404);
    await bytesAt(2147483647).expect(404);

    // Another user's stop does not reach it; the owner's, from one stage, does.
    await stop(other.user.id, [a1.id, a2.id]).expect(204);
    await open(token).expect(200);
    await stop(owner.user.id, [a2.id]).expect(204);
    await open(token).expect(404);
    await bytesAt(f1.id).expect(404);
    expect((await listing(owner.user.id, a1.id).expect(200)).body.data.album_shared_until).toBeNull();

    // And a fresh link after the stop is a new one.
    const again = await share(owner.user.id, [a1.id, a2.id]).expect(200);
    expect(again.body.data.token).not.toBe(token);
  });

  it('shares a night\'s picks as a link of its own, listing and serving only picked files (THO-849)', async () => {
    // The new column and the `picked` filter against the real table: a picks
    // link and a whole-night link to the same night are told apart by
    // picks_only, and an unpicked file is outside the picks link's reach.
    const owner = await makeAlbumUser('picks');
    const show = await makeAlbumShow('Picks Stage');
    const att = await prisma.concertAttendance.create({ data: { wishlist_id: owner.wishlist.id, concert_id: show.id } });
    const picked = await makeAlbumFile({ attendanceId: att.id, userId: owner.user.id, filename: 'PICK_1.jpg' });
    const unpicked = await makeAlbumFile({ attendanceId: att.id, userId: owner.user.id, filename: 'PICK_2.jpg' });
    await prisma.concertMedia.update({ where: { id: picked.id }, data: { picked: true } });

    const sharePicks = () => request(app)
      .post('/data/concerts/album-shares').set('Authorization', bearer(owner.user.id))
      .send({ attendance_ids: [att.id], picks_only: true });
    const night = await share(owner.user.id, [att.id]).expect(200);
    const picks = await sharePicks().expect(200);
    expect(picks.body.data.token).not.toBe(night.body.data.token);
    expect((await sharePicks().expect(200)).body.data.token).toBe(picks.body.data.token);

    const listed = (await open(picks.body.data.token).expect(200)).body.data;
    expect(listed.picks_only).toBe(true);
    expect(listed.files.map((f) => f.id)).toEqual([picked.id]);
    const bytesAt = (id) => request(app).get(`/data/concerts/album-shares/${picks.body.data.token}/media/${id}/file`);
    await bytesAt(picked.id).expect(200);
    await bytesAt(unpicked.id).expect(404);

    const mine = (await listing(owner.user.id, att.id).expect(200)).body.data;
    expect(mine.album_shared_until).toBe(night.body.data.expires_at);
    expect(mine.album_picks_shared_until).toBe(picks.body.data.expires_at);

    // Stopping the picks leaves the whole night shared.
    await request(app).delete(`/data/concerts/album-shares?attendance_ids=${att.id}&picks_only=1`)
      .set('Authorization', bearer(owner.user.id)).expect(204);
    await open(picks.body.data.token).expect(404);
    await open(night.body.data.token).expect(200);
  });
});
