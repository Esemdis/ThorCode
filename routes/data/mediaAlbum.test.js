import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';
import {
  jpegWithGpsTho894, minimalJpegTho894, mp4WithLocationTho894,
  pixelMotionPhotoTho899, samsungMotionPhotoTho899, iptcApp13Tho899,
} from '../../test/exifFixture.js';

// Sharing a whole night by public link (THO-892). Its own file rather than
// more of media.test.js: every behaviour here is about one stateful table, and
// that file's fake is rebuilt around uploads.

const ownerTho892 = { id: 'user-1', role: 'USER' };
const strangerTho892 = { id: 'someone-else', role: 'USER' };

// attendance id → who it belongs to.
const attendanceOwnersTho892 = { 1: 'user-1', 2: 'user-1', 9: 'someone-else' };
const concertTho892 = {
  concert_date: new Date('2026-06-12T19:00:00Z'), venue: 'Sentrum Scene', city: 'Oslo', country: 'NO',
  bands: [{ setlist: null, band_rel: { id: 92, name: 'Gojira' } }],
};

// THO-895: two more of the owner's attendances, and the concert behind any
// attendance a test has moved to another night (a scraper's date correction).
const attendanceOwnersTho895 = { 3: 'user-1', 4: 'user-1' };
let concertByAttendanceTho895;

let albumLinks;
let mediaRows;
let root;

const hasSome = (list, wanted) => wanted.some((id) => list.includes(id));
// The subset of Prisma's where these routes use, so a query that forgot to
// scope by user or by liveness finds rows the real one would too.
const matchesAlbumWhere = (l, where) => (where.user_id === undefined || l.user_id === where.user_id)
  && (where.revoked_at === undefined || l.revoked_at === where.revoked_at)
  && (where.expires_at === undefined || l.expires_at > where.expires_at.gt)
  && (where.attendance_ids?.hasSome === undefined || hasSome(l.attendance_ids, where.attendance_ids.hasSome))
  && (where.attendance_ids?.has === undefined || l.attendance_ids.includes(where.attendance_ids.has));

const prisma = installFakePrisma({});
const router = (await import('./media.js')).default ?? (await import('./media.js'));
const app = () => buildApp(router, '/data/concerts');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'album-route-'));
  process.env.MEDIA_ROOT = root;
  process.env.MEDIA_URL_SECRET = 'test-media-secret';
  process.env.CALLBACK_URL = 'https://api.example.com';

  albumLinks = [];
  mediaRows = [];
  concertByAttendanceTho895 = {};
  // Newest first, ties by id: two links minted in the same millisecond.
  const newestAlbumLinks = (where) => albumLinks
    .filter((l) => matchesAlbumWhere(l, where))
    .sort((a, b) => b.created_at - a.created_at || b.id - a.id);
  prisma.mediaAlbumShareLink = {
    findFirst: vi.fn(async ({ where }) => newestAlbumLinks(where)[0] ?? null),
    findMany: vi.fn(async ({ where }) => newestAlbumLinks(where)),
    findUnique: vi.fn(async ({ where }) => albumLinks.find((l) => l.token === where.token) ?? null),
    create: vi.fn(async ({ data }) => {
      const link = { id: albumLinks.length + 1, created_at: new Date(), revoked_at: null, ...data };
      albumLinks.push(link);
      return link;
    }),
    update: vi.fn(async ({ where, data }) => Object.assign(albumLinks.find((l) => l.id === where.id), data)),
    updateMany: vi.fn(async ({ where, data }) => {
      const hit = albumLinks.filter((l) => matchesAlbumWhere(l, where));
      hit.forEach((l) => Object.assign(l, data));
      return { count: hit.length };
    }),
  };
  prisma.concertAttendance = {
    findMany: vi.fn(async ({ where }) => where.id.in
      .filter((id) => (attendanceOwnersTho892[id] ?? attendanceOwnersTho895[id]) === where.wishlist_rel.user_id)
      .map((id) => ({ id, concert_rel: concertByAttendanceTho895[id] ?? concertTho892 }))),
  };
  prisma.band = { findMany: vi.fn(async ({ where }) => where.id.in.map((id) => ({ id, name: `Band ${id}` }))) };
  prisma.concertMedia = {
    findMany: vi.fn(async ({ where }) => mediaRows.filter((m) => where.attendance_id.in.includes(m.attendance_id))),
    findUnique: vi.fn(async ({ where }) => mediaRows.find((m) => m.id === where.id) ?? null),
  };
});

const shareNight = (ids, as = ownerTho892) => request(app())
  .post('/data/concerts/album-shares').set(...authHeader(as)).send({ attendance_ids: ids });
const stopNight = (ids, as = ownerTho892) => request(app())
  .delete(`/data/concerts/album-shares?attendance_ids=${ids.join(',')}`).set(...authHeader(as));
const openAlbum = (token) => request(app()).get(`/data/concerts/album-shares/${token}`);

// A media row with its bytes on disk, the way the archive holds them. A real
// JPEG by default: a public route serves only what it can scrub (THO-894), and
// text in a .jpg is refused.
async function fileInAlbumTho892({
  id = 1, attendanceId = 1, userId = 'user-1', bytes = minimalJpegTho894, filename = 'IMG_1.jpg', kind = 'PHOTO',
} = {}) {
  const rel = `${userId}/2026-06-12 Oslo - Gojira/${filename}`;
  const dir = join(root, 'archive', userId, '2026-06-12 Oslo - Gojira');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), bytes);
  const row = {
    id, attendance_id: attendanceId, band_id: 92, kind, filename, rel_path: rel, sha256: `sha${id}`,
    bytes: bytes.length, taken_at: null,
    attendance_rel: { wishlist_rel: { user_id: userId } },
  };
  mediaRows.push(row);
  return row;
}

describe('POST /album-shares', () => {
  it('needs a signed-in user', async () => {
    await request(app()).post('/data/concerts/album-shares').send({ attendance_ids: [1] }).expect(401);
  });

  it('refuses a list that is not attendance ids, without asking the database', async () => {
    await shareNight([]).expect(400);
    await shareNight(['1abc']).expect(400);
    await request(app()).post('/data/concerts/album-shares').set(...authHeader(ownerTho892)).send({}).expect(400);
    expect(prisma.concertAttendance.findMany).not.toHaveBeenCalled();
  });

  it('shares nothing when one of the attendances is someone else\'s', async () => {
    // 404 as for an id that does not exist: which ids exist is not theirs to learn.
    await shareNight([1, 9]).expect(404);
    await shareNight([1, 404]).expect(404);
    expect(albumLinks).toEqual([]);
  });

  it('mints a link to the night that lasts a week', async () => {
    const before = Date.now();
    const res = await shareNight([2, 1]).expect(200);
    expect(res.body.data.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const lasts = Date.parse(res.body.data.expires_at) - before;
    expect(lasts).toBeGreaterThan(7 * 24 * 3600e3 - 5000);
    expect(lasts).toBeLessThan(7 * 24 * 3600e3 + 5000);
    expect(albumLinks[0]).toMatchObject({ user_id: 'user-1', attendance_ids: [1, 2] });
  });

  it('hands back the live link when asked again, in any order and at the same moment', async () => {
    const first = await shareNight([1, 2]).expect(200);
    const again = await shareNight([2, 1]).expect(200);
    expect(again.body.data.token).toBe(first.body.data.token);
    albumLinks.length = 0;
    const [a, b] = await Promise.all([shareNight([1]), shareNight([1])]);
    expect(a.body.data.token).toBe(b.body.data.token);
    expect(albumLinks).toHaveLength(1);
  });

  it('widens the live link, keeping its token, when the night has grown a stage', async () => {
    // The person already holding the URL sees the whole night, and there is
    // still one link to stop.
    const first = await shareNight([1]).expect(200);
    const grown = await shareNight([1, 2]).expect(200);
    expect(grown.body.data.token).toBe(first.body.data.token);
    expect(albumLinks).toHaveLength(1);
    expect(albumLinks[0].attendance_ids).toEqual([1, 2]);
    // And keeps its expiry: a fresh week would keep the files already sent
    // open longer than the owner chose (see the route's comment).
    expect(grown.body.data.expires_at).toBe(first.body.data.expires_at);
  });

  it('never narrows a link already sent, when the night is asked for as fewer attendances', async () => {
    // One stage's row opened on its own and "Show link" pressed. Replacing the
    // list took the other stage's files out of a URL someone already held.
    const first = await shareNight([1, 2]).expect(200);
    const narrower = await shareNight([1]).expect(200);
    expect(narrower.body.data.token).toBe(first.body.data.token);
    expect(albumLinks[0].attendance_ids).toEqual([1, 2]);
    expect(prisma.mediaAlbumShareLink.update).not.toHaveBeenCalled();
  });

  describe('once a show\'s date was corrected after its night was shared (THO-895)', () => {
    // The day after night A, in the same city: where a scraper's correction
    // moves the concert behind attendance 2.
    const nightBConcertTho895 = { ...concertTho892, concert_date: new Date('2026-06-13T19:00:00Z') };
    const correctDateTho895 = () => {
      concertByAttendanceTho895[2] = nightBConcertTho895;
      concertByAttendanceTho895[3] = nightBConcertTho895;
    };

    it('mints a link to the other night rather than widening this one\'s through the show that moved', async () => {
      // Night A (1 and 2) sent to a friend; 2's concert moves to the 13th,
      // where it makes night B with 3. Widening A's link put night B in front
      // of the friend, and handed the owner A's token and expiry for B.
      await fileInAlbumTho892({ id: 1, attendanceId: 1 });
      await fileInAlbumTho892({ id: 2, attendanceId: 2, filename: 'IMG_2.jpg' });
      await fileInAlbumTho892({ id: 3, attendanceId: 3, filename: 'IMG_3.jpg' });
      const nightA = await shareNight([1, 2]).expect(200);
      correctDateTho895();

      const nightB = await shareNight([2, 3]).expect(200);

      expect(nightB.body.data.token).not.toBe(nightA.body.data.token);
      expect(albumLinks.map((l) => l.attendance_ids)).toEqual([[1, 2], [2, 3]]);
      // And A's URL keeps every file it was sent with: never narrowed.
      const sent = await openAlbum(nightA.body.data.token).expect(200);
      expect(sent.body.data.files.map((f) => f.id)).toEqual([1, 2]);
    });

    it('does not hand the moved show\'s new night a link that already names it with another night', async () => {
      // Night B is only attendance 2 now. A's link takes it in without
      // widening, but it is still night A's link.
      const nightA = await shareNight([1, 2]).expect(200);
      concertByAttendanceTho895[2] = nightBConcertTho895;

      const nightB = await shareNight([2]).expect(200);

      expect(nightB.body.data.token).not.toBe(nightA.body.data.token);
      expect(albumLinks[0].attendance_ids).toEqual([1, 2]);
    });

    it('reads a night as its city as well as its date', async () => {
      const first = await shareNight([1]).expect(200);
      concertByAttendanceTho895[3] = { ...concertTho892, city: 'Bergen' };
      const elsewhere = await shareNight([1, 3]).expect(200);
      expect(elsewhere.body.data.token).not.toBe(first.body.data.token);
      expect(albumLinks[0].attendance_ids).toEqual([1]);
    });

    it('still widens a link to the same night, and hands back an exact match whatever the dates', async () => {
      correctDateTho895();
      const nightB = await shareNight([2]).expect(200);
      expect((await shareNight([2, 3]).expect(200)).body.data.token).toBe(nightB.body.data.token);
      expect(albumLinks.map((l) => l.attendance_ids)).toEqual([[2, 3]]);
      // A list the client sent as one night that the server reads as two is
      // still the same link when asked for again, not a new one per press.
      const mixed = await shareNight([1, 4]).expect(200);
      concertByAttendanceTho895[4] = nightBConcertTho895;
      expect((await shareNight([4, 1]).expect(200)).body.data.token).toBe(mixed.body.data.token);
    });
  });

  it('mints a fresh link once the last one was stopped or ran out', async () => {
    const first = await shareNight([1]).expect(200);
    await stopNight([1]).expect(204);
    const second = await shareNight([1]).expect(200);
    expect(second.body.data.token).not.toBe(first.body.data.token);
    albumLinks[1].expires_at = new Date(Date.now() - 1000);
    const third = await shareNight([1]).expect(200);
    expect(third.body.data.token).not.toBe(second.body.data.token);
  });
});

describe('DELETE /album-shares', () => {
  it('needs a signed-in user and a list of ids', async () => {
    await request(app()).delete('/data/concerts/album-shares?attendance_ids=1').expect(401);
    await request(app()).delete('/data/concerts/album-shares').set(...authHeader(ownerTho892)).expect(400);
  });

  it('stops the link from any one of the night\'s attendances', async () => {
    const { body } = await shareNight([1, 2]).expect(200);
    await stopNight([2]).expect(204);
    await openAlbum(body.data.token).expect(404);
  });

  it('is a quiet no-op with nothing live, and never touches another user\'s link', async () => {
    await stopNight([1]).expect(204);
    const { body } = await shareNight([1]).expect(200);
    await stopNight([1], strangerTho892).expect(204);
    await openAlbum(body.data.token).expect(200);
  });
});

describe('GET /album-shares/:token', () => {
  it('lists the night for a request with no Authorization header at all', async () => {
    await fileInAlbumTho892({ id: 1, attendanceId: 1 });
    await fileInAlbumTho892({ id: 2, attendanceId: 2, filename: 'IMG_2.jpg' });
    const { body } = await shareNight([1, 2]).expect(200);
    const { token } = body.data;

    const res = await openAlbum(token).expect(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body.data.night).toMatchObject({ date: '2026-06-12', city: 'Oslo', venues: ['Sentrum Scene'] });
    expect(res.body.data.bands).toEqual([{ id: 92, name: 'Gojira', setlist: null }]);
    expect(res.body.data.files.map((f) => f.id)).toEqual([1, 2]);
    expect(res.body.data.files[0].file)
      .toBe(`https://api.example.com/data/concerts/album-shares/${token}/media/1/file`);
    // Where the archive keeps it names the owner's account.
    expect(JSON.stringify(res.body)).not.toContain('rel_path');
  });

  it('names the act of a file filed under one that is on none of the night\'s bills', async () => {
    const row = await fileInAlbumTho892({ id: 1 });
    row.band_id = 7;
    const { body } = await shareNight([1]).expect(200);
    const res = await openAlbum(body.data.token).expect(200);
    expect(res.body.data.bands.map((b) => b.id)).toEqual([92, 7]);
    expect(prisma.band.findMany.mock.calls[0][0].where).toEqual({ id: { in: [7] } });
  });

  it('does not ask for acts when every file is filed under one on the bill', async () => {
    await fileInAlbumTho892({ id: 1 });
    const { body } = await shareNight([1]).expect(200);
    await openAlbum(body.data.token).expect(200);
    expect(prisma.band.findMany).not.toHaveBeenCalled();
  });

  it('is live: a file added to the night after sharing is in the album', async () => {
    const { body } = await shareNight([1]).expect(200);
    expect((await openAlbum(body.data.token).expect(200)).body.data.files).toEqual([]);
    await fileInAlbumTho892({ id: 5 });
    expect((await openAlbum(body.data.token).expect(200)).body.data.files.map((f) => f.id)).toEqual([5]);
  });

  it('answers 404 for a token never issued, a stopped link and an expired one alike', async () => {
    await openAlbum('not-a-real-token').expect(404);
    const { body } = await shareNight([1]).expect(200);
    albumLinks[0].expires_at = new Date(Date.now() - 1000);
    await openAlbum(body.data.token).expect(404);
  });

  it('answers 404 when none of its attendances is the owner\'s any more', async () => {
    // The ids on the link are plain numbers; this read is what checks them.
    albumLinks.push({
      id: 50, user_id: 'user-1', attendance_ids: [9], token: 'points-elsewhere',
      created_at: new Date(), expires_at: new Date(Date.now() + 3600e3), revoked_at: null,
    });
    await openAlbum('points-elsewhere').expect(404);
  });
});

// The body as a Buffer whatever its type: superagent leaves a video's undefined.
const rawBytesTho894 = (req) => req.buffer(true).parse((res, done) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => done(null, Buffer.concat(chunks)));
});

describe('GET /album-shares/:token/media/:id/:which', () => {
  const bytesAt = (token, id, which) => request(app())
    .get(`/data/concerts/album-shares/${token}/media/${id}/${which}`);

  it('sends the archive master as a download under its own name', async () => {
    await fileInAlbumTho892({ id: 1, filename: 'IMG_1.jpg' });
    const { body } = await shareNight([1]).expect(200);

    const res = await bytesAt(body.data.token, 1, 'file').expect(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="IMG_1\.jpg"/);
    expect(res.headers['cache-control']).toBe('private, no-store');
    // A master with nothing to strip goes out exactly as it is.
    expect(Buffer.compare(res.body, minimalJpegTho894)).toBe(0);
  });

  it('hands a shared night\'s original out without the place it was taken', async () => {
    // The original keeps it — the owner may want a map of where photographs
    // were taken — but a stranger holding the link, or anyone it was
    // forwarded to, could read the owner's home out of it.
    const { jpeg, tiffAt, at } = jpegWithGpsTho894();
    await fileInAlbumTho892({ id: 1, bytes: jpeg });
    const { body } = await shareNight([1]).expect(200);

    const res = await bytesAt(body.data.token, 1, 'file').expect(200);
    const served = res.body;
    expect(served.length).toBe(jpeg.length);
    expect(served.readUInt16LE(tiffAt + at.gpsIfd)).toBe(0);
    expect(served.subarray(tiffAt + at.serial, tiffAt + at.serial + 14).equals(Buffer.alloc(14))).toBe(true);
    // The picture itself, from the first scan on, byte for byte.
    const scan = (b) => b.subarray(b.indexOf(Buffer.from([0xff, 0xda])));
    expect(scan(served).equals(scan(jpeg))).toBe(true);
    // Made once, kept in the cache like a thumbnail.
    expect(await readdir(join(root, 'cache', 'public'))).toEqual(['sha1.jpg', 'sha1.jpg.stamp']);
  });

  it('strips the location from a shared night\'s video', async () => {
    const mp4 = mp4WithLocationTho894();
    await fileInAlbumTho892({ id: 1, bytes: mp4, filename: 'VID_1.mp4', kind: 'VIDEO' });
    const { body } = await shareNight([1]).expect(200);

    for (const which of ['file', 'view']) {
      const res = await rawBytesTho894(bytesAt(body.data.token, 1, which)).expect(200);
      expect(res.body.length).toBe(mp4.length);
      expect(res.body.includes(Buffer.from('+59.9139+010.7522'))).toBe(false);
      expect(res.body.includes(Buffer.from('iPhone 15 Pro'))).toBe(false);
    }
  });

  it('strips the location from the video inside a shared motion photo, and the IPTC city from a photo', async () => {
    // THO-899: a Pixel motion photo appends its clip after the JPEG, a Samsung
    // one keeps it in its SEF trailer beside the mobile country code, and a
    // Lightroom export keeps the city in APP13. None of them was reached.
    const { jpeg } = jpegWithGpsTho894();
    const files = [
      pixelMotionPhotoTho899().file,
      samsungMotionPhotoTho899().file,
      Buffer.concat([jpeg.subarray(0, 2), iptcApp13Tho899(), jpeg.subarray(2)]),
    ];
    for (const [i, bytes] of files.entries()) {
      await fileInAlbumTho892({ id: i + 1, bytes, filename: `PXL_${i + 1}.MP.jpg` });
    }
    const { body } = await shareNight([1]).expect(200);

    for (const [i, original] of files.entries()) {
      const res = await rawBytesTho894(bytesAt(body.data.token, i + 1, 'file')).expect(200);
      expect(res.body.length).toBe(original.length);
      for (const gone of ['+59.9139+010.7522', 'iPhone 15 Pro', 'SN-1234567890', 'MCC_Data242', 'IPTC-City']) {
        expect(res.body.includes(Buffer.from(gone, 'latin1'))).toBe(false);
      }
    }
    // The video is still there, frames and all, for whoever wants to play it.
    const pixel = await rawBytesTho894(bytesAt(body.data.token, 1, 'file')).expect(200);
    expect(pixel.body.includes(Buffer.from('frame-data-that-must-never-change'.repeat(4)))).toBe(true);
  });

  it('answers 404, not the original, for a file it cannot strip', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fileInAlbumTho892({ id: 1, bytes: 'not a photograph at all' });
    const { body } = await shareNight([1]).expect(200);

    const res = await bytesAt(body.data.token, 1, 'file').expect(404);
    expect(res.headers['cache-control']).toBeUndefined();
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).toMatch(/media 1/);
    warn.mockRestore();
  });

  it('a shared night\'s thumbnail and viewing copy carry no EXIF at all', async () => {
    const sharp = (await import('sharp')).default;
    const base = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#334155' } }).jpeg().toBuffer();
    const { jpeg } = jpegWithGpsTho894(base);
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    await fileInAlbumTho892({ id: 1, bytes: jpeg });
    const { body } = await shareNight([1]).expect(200);

    for (const which of ['thumb', 'view']) {
      const res = await rawBytesTho894(bytesAt(body.data.token, 1, which)).expect(200);
      expect((await sharp(res.body).metadata()).exif).toBeUndefined();
    }
  });

  it('refuses a file that is not part of the night, exactly as one that does not exist', async () => {
    // The token is for attendance 1. Media 2 is the same owner's, from another
    // night; media 3 sits under attendance 1's id but belongs to someone else.
    await fileInAlbumTho892({ id: 1, attendanceId: 1 });
    await fileInAlbumTho892({ id: 2, attendanceId: 2, filename: 'IMG_2.jpg' });
    await fileInAlbumTho892({ id: 3, attendanceId: 1, userId: 'someone-else', filename: 'IMG_3.jpg' });
    const { body } = await shareNight([1]).expect(200);

    await bytesAt(body.data.token, 2, 'file').expect(404);
    await bytesAt(body.data.token, 3, 'file').expect(404);
    await bytesAt(body.data.token, 404, 'file').expect(404);
    await bytesAt(body.data.token, 1, 'file').expect(200);
  });

  it('serves only the copies an album has, and only for a real id', async () => {
    await fileInAlbumTho892({ id: 1 });
    const { body } = await shareNight([1]).expect(200);
    await bytesAt(body.data.token, 1, 'play').expect(404);
    await bytesAt(body.data.token, '1abc', 'file').expect(404);
    // Past a 32-bit Int, which the database client throws on: 404, not a 500
    // a stranger with a token can produce at will.
    prisma.concertMedia.findUnique.mockClear();
    await bytesAt(body.data.token, '99999999999', 'file').expect(404);
    await bytesAt(body.data.token, '2147483648', 'file').expect(404);
    expect(prisma.concertMedia.findUnique).not.toHaveBeenCalled();
  });

  it('stops serving the moment the link is stopped', async () => {
    await fileInAlbumTho892({ id: 1 });
    const { body } = await shareNight([1]).expect(200);
    await bytesAt(body.data.token, 1, 'file').expect(200);
    await stopNight([1]).expect(204);
    await bytesAt(body.data.token, 1, 'file').expect(404);
    await bytesAt('not-a-real-token', 1, 'file').expect(404);
  });
});

// A link to the night's picks rather than every file of it (THO-849).
describe('sharing a night\'s picks', () => {
  // The fakes above know nothing of either column; these add them, so a query
  // that forgot to ask for one kind of link, or for picked files, finds rows
  // the real one would not.
  const picksMatchTho849 = (l, where) => where.picks_only === undefined || Boolean(l.picks_only) === where.picks_only;
  beforeEach(() => {
    prisma.mediaAlbumShareLink.findFirst = vi.fn(async ({ where }) => albumLinks
      .filter((l) => matchesAlbumWhere(l, where) && picksMatchTho849(l, where))
      .sort((a, b) => b.created_at - a.created_at)[0] ?? null);
    // The POST reads every candidate since THO-895, to pick the one that is
    // still this night's; the kind must filter that read too.
    prisma.mediaAlbumShareLink.findMany = vi.fn(async ({ where }) => albumLinks
      .filter((l) => matchesAlbumWhere(l, where) && picksMatchTho849(l, where))
      .sort((a, b) => b.created_at - a.created_at || b.id - a.id));
    prisma.mediaAlbumShareLink.updateMany = vi.fn(async ({ where, data }) => {
      const hit = albumLinks.filter((l) => matchesAlbumWhere(l, where) && picksMatchTho849(l, where));
      hit.forEach((l) => Object.assign(l, data));
      return { count: hit.length };
    });
    prisma.concertMedia.findMany = vi.fn(async ({ where }) => mediaRows.filter((m) => where.attendance_id.in.includes(m.attendance_id)
      && (where.picked === undefined || Boolean(m.picked) === where.picked)));
  });

  const sharePicksTho849 = (ids, body = { picks_only: true }) => request(app())
    .post('/data/concerts/album-shares').set(...authHeader(ownerTho892)).send({ attendance_ids: ids, ...body });
  const stopKindTho849 = (ids, kind) => request(app())
    .delete(`/data/concerts/album-shares?attendance_ids=${ids.join(',')}${kind === undefined ? '' : `&picks_only=${kind}`}`)
    .set(...authHeader(ownerTho892));
  const pickedFileTho849 = async (id, picked, over = {}) => {
    const row = await fileInAlbumTho892({ id, filename: `IMG_${id}.jpg`, ...over });
    row.picked = picked;
    return row;
  };

  it('mints a link of its own beside the whole night\'s, and hands it back when asked again', async () => {
    const night = await shareNight([1]).expect(200);
    const picks = await sharePicksTho849([1]).expect(200);
    expect(picks.body.data.token).not.toBe(night.body.data.token);
    expect(picks.body.data.picks_only).toBe(true);
    expect(night.body.data.picks_only).toBe(false);
    expect((await sharePicksTho849([1]).expect(200)).body.data.token).toBe(picks.body.data.token);
    expect((await shareNight([1]).expect(200)).body.data.token).toBe(night.body.data.token);
    expect(albumLinks.map((l) => l.picks_only)).toEqual([false, true]);
  });

  it('never hands back or widens a picks link for a whole-night request of the same night, nor the reverse', async () => {
    // Since THO-895 the POST picks among every live candidate for the night.
    // If the kind dropped out of that read, sharing the whole night would
    // widen the picks link (or a picks request the whole night's), and a URL
    // already sent would change what it shows.
    const picks = await sharePicksTho849([1]).expect(200);
    const night = await shareNight([1, 2]).expect(200);
    expect(night.body.data.token).not.toBe(picks.body.data.token);
    expect(night.body.data.picks_only).toBe(false);
    expect(prisma.mediaAlbumShareLink.findMany.mock.calls.at(-1)[0].where.picks_only).toBe(false);

    const morePicks = await sharePicksTho849([1, 2, 3]).expect(200);
    expect(morePicks.body.data.token).toBe(picks.body.data.token);
    expect(prisma.mediaAlbumShareLink.findMany.mock.calls.at(-1)[0].where.picks_only).toBe(true);

    // Each link widened only by its own kind.
    expect(albumLinks.map((l) => [l.picks_only, l.attendance_ids])).toEqual([[true, [1, 2, 3]], [false, [1, 2]]]);
  });

  it('refuses a picks_only it cannot read rather than sharing the whole night', async () => {
    await sharePicksTho849([1], { picks_only: 'yes' }).expect(400);
    await sharePicksTho849([1], { picks_only: 1 }).expect(400);
    expect(albumLinks).toEqual([]);
  });

  it('lists only what is picked, says so, and follows picking after it was sent', async () => {
    await pickedFileTho849(1, true);
    const unpicked = await pickedFileTho849(2, false);
    const { body } = await sharePicksTho849([1]).expect(200);

    const first = (await openAlbum(body.data.token).expect(200)).body.data;
    expect(first.picks_only).toBe(true);
    expect(first.files.map((f) => f.id)).toEqual([1]);
    expect(first.bands).toEqual([{ id: 92, name: 'Gojira', setlist: null }]);
    // Whether a file is picked is the owner's business, as on the whole night.
    expect(Object.keys(first.files[0])).not.toContain('picked');

    unpicked.picked = true;
    expect((await openAlbum(body.data.token).expect(200)).body.data.files.map((f) => f.id)).toEqual([1, 2]);
    mediaRows[0].picked = false;
    expect((await openAlbum(body.data.token).expect(200)).body.data.files.map((f) => f.id)).toEqual([2]);
  });

  it('opens a picked file\'s bytes and refuses an unpicked one of the same night, as one that does not exist', async () => {
    // The ids are sequential: the file beside a picked one is a guess away.
    await pickedFileTho849(1, true);
    await pickedFileTho849(2, false);
    const picks = (await sharePicksTho849([1]).expect(200)).body.data.token;
    const night = (await shareNight([1]).expect(200)).body.data.token;
    const bytesAt = (token, id, which) => request(app()).get(`/data/concerts/album-shares/${token}/media/${id}/${which}`);

    for (const which of ['thumb', 'view', 'file']) {
      await bytesAt(picks, 1, which).expect(200);
      await bytesAt(picks, 2, which).expect(404);
      await bytesAt(night, 2, which).expect(200);
    }
  });

  // #52: an album thumbnail was cached for an hour without asking, so a file
  // unpicked from a picks link stayed on that link's page through its cached
  // thumbnail. Revalidated every time, it is 304 while picked and 404 once not.
  it('makes a picks link revalidate its thumbnails, so unpicking one takes effect at once', async () => {
    const pickedRow = await pickedFileTho849(1, true);
    const picks = (await sharePicksTho849([1]).expect(200)).body.data.token;
    const thumbRevalidateTho52 = (headers = {}) => request(app())
      .get(`/data/concerts/album-shares/${picks}/media/1/thumb`).set(headers);

    const first = await thumbRevalidateTho52().expect(200);
    expect(first.headers['cache-control']).toBe('private, no-cache');
    expect(first.headers.etag).toBeTruthy();
    await thumbRevalidateTho52({ 'If-None-Match': first.headers.etag }).expect(304);

    pickedRow.picked = false;
    await thumbRevalidateTho52({ 'If-None-Match': first.headers.etag }).expect(404);
  });

  it('hands a picked original out without the place it was taken', async () => {
    // Through the same scrubbed copy as the whole night (THO-894), never a
    // path of its own to the original.
    const { jpeg, tiffAt, at } = jpegWithGpsTho894();
    await pickedFileTho849(1, true, { bytes: jpeg });
    const { body } = await sharePicksTho849([1]).expect(200);
    const res = await request(app()).get(`/data/concerts/album-shares/${body.data.token}/media/1/file`).expect(200);
    expect(res.body.readUInt16LE(tiffAt + at.gpsIfd)).toBe(0);
  });

  it('stops one kind of link or the other, and both when not told which', async () => {
    const tokens = async () => ({
      night: (await shareNight([1]).expect(200)).body.data.token,
      picks: (await sharePicksTho849([1]).expect(200)).body.data.token,
    });

    let t = await tokens();
    await stopKindTho849([1], 1).expect(204);
    await openAlbum(t.picks).expect(404);
    await openAlbum(t.night).expect(200);

    t = await tokens();
    await stopKindTho849([1], 0).expect(204);
    await openAlbum(t.night).expect(404);
    await openAlbum(t.picks).expect(200);

    // The app from before picks could be shared stops "the night's link":
    // ending both is the safe reading of that.
    t = await tokens();
    await stopKindTho849([1]).expect(204);
    await openAlbum(t.night).expect(404);
    await openAlbum(t.picks).expect(404);
  });

  it('refuses a picks_only on a stop that it cannot read, stopping nothing', async () => {
    const { body } = await sharePicksTho849([1]).expect(200);
    await stopKindTho849([1], 'maybe').expect(400);
    await openAlbum(body.data.token).expect(200);
  });
});
