import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, authHeader, installFakePrisma, routeManifest } from '../../test/routeApp.js';
import { signMediaToken } from '../../utils/mediaTokens.js';

let root;

const attendanceRow = {
  id: 1,
  wishlist_id: 5,
  concert_id: 8417,
  wishlist_rel: { user_id: 'user-1' },
  concert_rel: {
    id: 8417, concert_date: new Date('2026-06-12T19:00:00Z'),
    venue: 'Sentrum Scene', city: 'Oslo', country: 'NO',
    bands: [{ band: 92, band_rel: { id: 92, name: 'Gojira' } }],
  },
};

// Seeded and imported once, at module load — not inside beforeEach. Every route
// test file in this repo does it this way (see wishlists.test.js): prisma/client.js
// resolves `prisma` to a `const` the first time anything requires it, so a second
// installFakePrisma() after that first import reassigns globalThis.prisma but never
// reaches the router, which is still holding the very first fake. Re-running
// installFakePrisma and the dynamic import inside beforeEach, as a first draft of
// this file did, made every test after the first append to a stranded mock object
// that mock.calls[0] never saw.
const prisma = installFakePrisma({
  concertAttendance: { findUnique: vi.fn(async () => attendanceRow) },
  concertMedia: {
    findMany: vi.fn(async () => []),
    create: vi.fn(async ({ data }) => ({ id: 1, ...data })),
  },
});
const router = (await import('./media.js')).default ?? (await import('./media.js'));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'media-route-'));
  process.env.MEDIA_ROOT = root;
  process.env.MEDIA_URL_SECRET = 'test-media-secret';
  process.env.CALLBACK_URL = 'https://api.example.com';

  // Fresh mock functions on the same fake object each test, rather than a new
  // fake object, for the reason above: the router already holds a reference to
  // this object and reads `.create`/`.findMany` off it at call time, so replacing
  // the methods here reaches it; replacing the object would not.
  prisma.concertAttendance.findUnique = vi.fn(async () => attendanceRow);
  prisma.concertMedia.findMany = vi.fn(async () => []);
  prisma.concertMedia.create = vi.fn(async ({ data }) => ({ id: 1, ...data }));
});

const app = () => buildApp(router, '/data/concerts');
const jpeg = () => Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

describe('POST /attendances/:id/media', () => {
  it('exposes exactly the expected routes, with auth in front of every one of them', () => {
    // The handler count is part of this on purpose: dropping `auth` or
    // `roleCheck` while touching this file would shrink a number silently
    // otherwise. GET /media/:id/file and /thumb are the exception — they carry
    // their own auth via a signed URL token instead of this middleware, so
    // their count is 1: just the handler, no `auth` or `roleCheck` in front.
    expect(routeManifest(router)).toEqual([
      'POST /attendances/:attendanceId/media [5]',
      'GET /attendances/:attendanceId/media [4]',
      'GET /bands/:bandId/media [4]',
      'PATCH /media [7]',
      'DELETE /media/:id [4]',
      'GET /media/:id/file [1]',
      'GET /media/:id/thumb [1]',
    ]);
  });

  it('rejects an unauthenticated upload', async () => {
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(401);
  });

  it('refuses an attendance that belongs to someone else', async () => {
    // Attendance carries the owner. Without this check, knowing an integer is
    // enough to write into another account's archive.
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'someone-else' }))
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(403);
  });

  it('writes the file into the show folder under the caller subtree', async () => {
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .field('band_id', '92')
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(201);

    const dir = join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');
    expect(await readdir(dir)).toContain('IMG_1.jpg');
  });

  it('writes a sidecar naming the concert and the band', async () => {
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .field('band_id', '92')
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(201);

    const sidecar = JSON.parse(await readFile(
      join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira', 'concert-media.json'), 'utf8'));
    expect(sidecar).toMatchObject({ concert_id: 8417, user_id: 'user-1' });
    expect(sidecar.files[0]).toMatchObject({ name: 'IMG_1.jpg', band_id: 92, band_name: 'Gojira' });
  });

  it('indexes the file in Postgres with its checksum', async () => {
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .field('band_id', '92')
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(201);

    const { data } = prisma.concertMedia.create.mock.calls[0][0];
    expect(data).toMatchObject({
      attendance_id: 1, band_id: 92, filename: 'IMG_1.jpg', kind: 'PHOTO',
    });
    expect(data.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('lands files untagged when no band is sent, which is the normal case', async () => {
    // A four-band bill cannot be described by one band picked before the files
    // are looked at. Tagging is a separate sweep from the gig view.
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(201);

    expect(prisma.concertMedia.create.mock.calls[0][0].data.band_id).toBeNull();

    const sidecar = JSON.parse(await readFile(
      join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira', 'concert-media.json'), 'utf8'));
    expect(sidecar.files[0]).toMatchObject({ band_id: null, band_name: null });
  });

  it('refuses a band that is not on the bill', async () => {
    // Otherwise a typo files a Gojira photo under a band that was not there,
    // and the band view quietly shows a show the user never saw them at.
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .field('band_id', '999')
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(400);
  });

  it('refuses a file type no browser renders', async () => {
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .field('band_id', '92')
      .attach('files', Buffer.from('pdf'), { filename: 'a.pdf', contentType: 'application/pdf' })
      .expect(400);
  });

  it('stores the poster the browser sent with a video', async () => {
    const poster = await (await import('sharp')).default(
      { create: { width: 1920, height: 1080, channels: 3, background: '#222' } }).jpeg().toBuffer();

    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .field('band_id', '92')
      .field('meta', JSON.stringify({ 'VID_1.mp4': { width: 1920, height: 1080, duration_ms: 24000 } }))
      .attach('files', Buffer.from('fake mp4'), { filename: 'VID_1.mp4', contentType: 'video/mp4' })
      .attach('posters', poster, { filename: 'VID_1.mp4.webp', contentType: 'image/webp' })
      .expect(201);

    const dir = join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');
    expect(await readdir(join(dir, '.posters'))).toContain('VID_1.mp4.webp');
  });

  it('takes duration and dimensions from the browser, since there is no ffprobe', async () => {
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .field('band_id', '92')
      .field('meta', JSON.stringify({ 'VID_1.mp4': { width: 1920, height: 1080, duration_ms: 24000 } }))
      .attach('files', Buffer.from('fake mp4'), { filename: 'VID_1.mp4', contentType: 'video/mp4' })
      .expect(201);

    expect(prisma.concertMedia.create.mock.calls[0][0].data)
      .toMatchObject({ kind: 'VIDEO', width: 1920, height: 1080, duration_ms: 24000 });
  });

  it('stores a video with no poster rather than refusing the upload', async () => {
    // Extraction can fail in the browser. Refusing the file would mean losing
    // it to protect a thumbnail, which is exactly backwards for a backup.
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .field('band_id', '92')
      .attach('files', Buffer.from('fake mp4'), { filename: 'VID_1.mp4', contentType: 'video/mp4' })
      .expect(201);

    expect(prisma.concertMedia.create).toHaveBeenCalled();
  });

  it('ignores a duration the client made up', async () => {
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .field('band_id', '92')
      .field('meta', JSON.stringify({ 'VID_1.mp4': { duration_ms: 'banana', width: -5 } }))
      .attach('files', Buffer.from('fake mp4'), { filename: 'VID_1.mp4', contentType: 'video/mp4' })
      .expect(201);

    expect(prisma.concertMedia.create.mock.calls[0][0].data)
      .toMatchObject({ duration_ms: null, width: null });
  });

  it('does not overwrite a file of the same name already in the show', async () => {
    prisma.concertMedia.findMany.mockResolvedValue([{ filename: 'IMG_1.jpg' }]);
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .field('band_id', '92')
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(201);

    expect(prisma.concertMedia.create.mock.calls[0][0].data.filename).toBe('IMG_1 (2).jpg');
  });

  it('keeps a poster attached to its video when the name collides', async () => {
    // The stored name gets a ' (2)' suffix while the poster still carries the
    // original. Pairing after the fact by stored name loses the poster and says
    // nothing about it.
    prisma.concertMedia.findMany.mockResolvedValue([{ filename: 'VID_1.mp4' }]);
    const poster = await (await import('sharp')).default(
      { create: { width: 1920, height: 1080, channels: 3, background: '#333' } }).jpeg().toBuffer();

    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .field('band_id', '92')
      .attach('files', Buffer.from('fake mp4'), { filename: 'VID_1.mp4', contentType: 'video/mp4' })
      .attach('posters', poster, { filename: 'VID_1.mp4.webp', contentType: 'image/webp' })
      .expect(201);

    expect(prisma.concertMedia.create.mock.calls[0][0].data.filename).toBe('VID_1 (2).mp4');
    const dir = join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');
    expect(await readdir(join(dir, '.posters'))).toContain('VID_1 (2).mp4.webp');
  });

  it('accepts several files in one request', async () => {
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .field('band_id', '92')
      .attach('files', jpeg(), 'IMG_1.jpg')
      .attach('files', jpeg(), 'IMG_2.jpg')
      .expect(201);

    expect(prisma.concertMedia.create).toHaveBeenCalledTimes(2);
  });

  it('suffixes the second of two identically-named files in the same request', async () => {
    // Pinning this because it is easy to get backwards: `taken` has to grow as
    // the batch is processed, not just be seeded once from what already
    // existed before the request arrived.
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .field('band_id', '92')
      .attach('files', jpeg(), 'IMG_1.jpg')
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(201);

    expect(prisma.concertMedia.create.mock.calls[0][0].data.filename).toBe('IMG_1.jpg');
    expect(prisma.concertMedia.create.mock.calls[1][0].data.filename).toBe('IMG_1 (2).jpg');

    const dir = join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');
    const files = await readdir(dir);
    expect(files).toContain('IMG_1.jpg');
    expect(files).toContain('IMG_1 (2).jpg');
  });

  it('leaves the archive untouched when a file partway through the batch is unsupported', async () => {
    // Probed directly: before the batch was validated up front, a bad third
    // file of four still left the first two renamed into the show folder and
    // inserted into Postgres, because the loop only discovered the bad type
    // when it got there. Validating every file's type before the first rename
    // is what keeps a rejected batch from partially landing.
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .field('band_id', '92')
      .attach('files', jpeg(), 'IMG_1.jpg')
      .attach('files', jpeg(), 'IMG_2.jpg')
      .attach('files', Buffer.from('pdf'), { filename: 'bad.pdf', contentType: 'application/pdf' })
      .attach('files', jpeg(), 'IMG_4.jpg')
      .expect(400);

    expect(prisma.concertMedia.create).not.toHaveBeenCalled();
    // The show folder is never created for a batch that is rejected outright.
    await expect(readdir(join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira')))
      .rejects.toThrow();
  });

  it('refuses a request whose meta field is not valid JSON, rather than 500ing on it', async () => {
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .field('band_id', '92')
      .field('meta', '{not json')
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(400);

    expect(prisma.concertMedia.create).not.toHaveBeenCalled();
  });

  it('keeps the sidecar in step with disk when a later file in the batch fails to insert', async () => {
    // Probed directly: forcing the second file's insert to throw used to leave
    // its bytes renamed into the show folder and the first file's row in
    // Postgres with no sidecar written at all, because writeSidecar only ran
    // after the whole loop finished. A sidecar-trusting rebuild would have
    // silently dropped the first file and never known about the second.
    prisma.concertMedia.create
      .mockImplementationOnce(async ({ data }) => ({ id: 1, ...data }))
      .mockImplementationOnce(async () => { throw new Error('insert failed'); });

    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .field('band_id', '92')
      .attach('files', jpeg(), 'IMG_1.jpg')
      .attach('files', jpeg(), 'IMG_2.jpg')
      .expect(500);

    const dir = join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');
    const files = await readdir(dir);
    expect(files).toContain('IMG_1.jpg');
    expect(files).not.toContain('IMG_2.jpg');

    const sidecar = JSON.parse(await readFile(join(dir, 'concert-media.json'), 'utf8'));
    expect(sidecar.files.map((f) => f.name)).toEqual(['IMG_1.jpg']);
  });

  it('slugs a filename with characters SMB rejects before writing it', async () => {
    // The archive share is mounted over SMB, which is stricter than ext4 about
    // path characters. Every other path segment already goes through
    // slugSegment; an unslugged browser filename would write cleanly in this
    // suite's tmp dir and then fail on the real mount, taking the batch with it.
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .field('band_id', '92')
      .attach('files', jpeg(), 'a:b?c*.jpg')
      .expect(201);

    const data = prisma.concertMedia.create.mock.calls[0][0].data;
    expect(data.filename).toBe('a-b-c-.jpg');
    expect(data.rel_path.endsWith('a-b-c-.jpg')).toBe(true);

    const dir = join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');
    expect(await readdir(dir)).toContain('a-b-c-.jpg');
  });

  it('clamps a client-supplied dimension to what a 32-bit Postgres column can hold', async () => {
    // asInt already refused a negative or non-numeric value; this pins the
    // missing half of that check. Without it, a value like 9e12 sails through
    // and Postgres throws at insert time, turning a bad number into a 500 with
    // the file already renamed onto disk.
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .field('band_id', '92')
      .field('meta', JSON.stringify({ 'VID_1.mp4': { width: 9e12, duration_ms: 24000 } }))
      .attach('files', Buffer.from('fake mp4'), { filename: 'VID_1.mp4', contentType: 'video/mp4' })
      .expect(201);

    expect(prisma.concertMedia.create.mock.calls[0][0].data.width).toBe(2147483647);
  });
});

describe('GET /bands/:bandId/media', () => {
  it('rejects an unauthenticated read', async () => {
    await request(app()).get('/data/concerts/bands/92/media').expect(401);
  });

  it('returns the stats, the rail and the files for the caller only', async () => {
    prisma.concertAttendance.findMany = vi.fn(async ({ where, select }) => {
      // The route must scope by the caller's own wishlist. A band's shows are
      // not global information: Band rows are shared across every account.
      expect(where.wishlist_rel.user_id).toBe('user-1');
      // Asserted on the query itself, not just the fixture below: this fake
      // client returns whatever a test hands it regardless of `select`, so
      // checking only the response would keep passing even if the real
      // query stopped asking for `bands` — the rail needs it for the tagging
      // picker's choices, and only the query shape can prove it is asked for.
      expect(select.concert_rel.select.bands).toBeTruthy();
      return [{ id: 1, concert_rel: {
        id: 8417, concert_date: new Date('2026-06-12T19:00:00Z'), venue: 'Sentrum Scene', city: 'Oslo',
        bands: [{ band_rel: { id: 92, name: 'Gojira' } }],
      } }];
    });
    prisma.concertMedia.findMany = vi.fn(async () => [
      { id: 5, attendance_id: 1, band_id: 92, filename: 'IMG_1.jpg', kind: 'PHOTO',
        caption: '', width: 4080, height: 3072, duration_ms: null, taken_at: null, sha256: 'h5' },
    ]);

    const res = await request(app())
      .get('/data/concerts/bands/92/media')
      .set(...authHeader({ id: 'user-1' }))
      .expect(200);

    expect(res.body.data.stats).toMatchObject({ files: 1, shows_attended: 1, shows_with_media: 1 });
    // The bill travels on the rail row too: it is what a tagging picker in
    // the band view would offer, and deleting the query's `bands` select
    // should fail this, not just look wrong in a screenshot.
    expect(res.body.data.rail[0]).toMatchObject({ attendance_id: 1, count: 1, bands: [{ id: 92, name: 'Gojira' }] });
    expect(res.body.data.files[0].thumb).toMatch(/^https:\/\/api\.example\.com\/data\/concerts\/media\/5\/thumb\?t=/);
  });

  it('does not let an unconfirmed show date corrupt the year stats', async () => {
    // dateOnly(null) does not throw — it slices a Unix-epoch string and
    // returns '1970-01-01' — so a TBD concert_date would otherwise drag
    // first_year to 1970 and inflate per_year into a decades-long gap-filled
    // series. Probed directly against the unfiltered route: this exact
    // fixture produced first_year: 1970 and a 57-entry per_year.
    prisma.concertAttendance.findMany = vi.fn(async () => [
      { id: 1, concert_rel: { id: 8417, concert_date: null, venue: 'TBD', city: 'Oslo', bands: [] } },
      { id: 2, concert_rel: {
        id: 8418, concert_date: new Date('2026-06-12T19:00:00Z'), venue: 'Sentrum Scene', city: 'Oslo',
        bands: [{ band_rel: { id: 92, name: 'Gojira' } }],
      } },
    ]);
    // A photo tied to the dateless attendance too, so the fix is proven by
    // the whole show dropping out cleanly rather than by there being nothing
    // to drop.
    prisma.concertMedia.findMany = vi.fn(async () => [
      { id: 9, attendance_id: 1, band_id: 92, filename: 'ghost.jpg', kind: 'PHOTO', sha256: 'h9' },
      { id: 5, attendance_id: 2, band_id: 92, filename: 'IMG_1.jpg', kind: 'PHOTO', sha256: 'h5' },
    ]);

    const res = await request(app())
      .get('/data/concerts/bands/92/media')
      .set(...authHeader({ id: 'user-1' }))
      .expect(200);

    expect(res.body.data.stats).toMatchObject({ first_year: 2026, last_year: 2026 });
    expect(res.body.data.rail).toHaveLength(1);
    expect(res.body.data.files).toHaveLength(1);
  });

  it('returns an empty overview for a band with no attended shows', async () => {
    prisma.concertAttendance.findMany = vi.fn(async () => []);
    prisma.concertMedia.findMany = vi.fn(async () => []);
    const res = await request(app())
      .get('/data/concerts/bands/92/media')
      .set(...authHeader({ id: 'user-1' }))
      .expect(200);
    expect(res.body.data).toMatchObject({ rail: [], files: [] });
    expect(res.body.data.stats.files).toBe(0);
  });
});

describe('GET /attendances/:id/media', () => {
  it('reports how many of the show\'s files still have no band', async () => {
    // This count is the gig view's progress bar: it ticks down as a sweep tags
    // files, and an empty pile is the done state.
    prisma.concertMedia.findMany = vi.fn(async () => [
      { id: 1, attendance_id: 1, band_id: null, filename: 'a.jpg', kind: 'PHOTO', sha256: 'h1' },
      { id: 2, attendance_id: 1, band_id: 92, filename: 'b.jpg', kind: 'PHOTO', sha256: 'h2' },
      { id: 3, attendance_id: 1, band_id: null, filename: 'c.jpg', kind: 'PHOTO', sha256: 'h3' },
    ]);
    const res = await request(app())
      .get('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .expect(200);

    expect(res.body.data.untagged).toBe(2);
    expect(res.body.data.files).toHaveLength(3);
  });

  it('sends the night\'s bill, so the tagging picker needs no second request', async () => {
    prisma.concertMedia.findMany = vi.fn(async () => []);
    const res = await request(app())
      .get('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .expect(200);

    expect(res.body.data.bands).toEqual([{ id: 92, name: 'Gojira' }]);
  });

  it('refuses a show that is not the caller\'s', async () => {
    await request(app())
      .get('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'someone-else' }))
      .expect(403);
  });
});

describe('PATCH /media', () => {
  it('sets the band on several files at once', async () => {
    // The grid multi-selects, so this takes a list. One request per tile would
    // be forty requests to fix a festival import.
    const dir = join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');
    await mkdir(dir, { recursive: true });

    prisma.concertMedia.findMany = vi.fn(async () => [
      { id: 5, attendance_id: 1, rel_path: 'user-1/2026-06-12 Oslo - Gojira/IMG_1.jpg', filename: 'IMG_1.jpg',
        kind: 'PHOTO', sha256: 'h5', bytes: 1234, width: 4080, height: 3072, duration_ms: null,
        caption: null, taken_at: null, band_id: null,
        attendance_rel: {
          wishlist_rel: { user_id: 'user-1' },
          concert_rel: {
            id: 8417, concert_date: new Date('2026-06-12T19:00:00Z'), venue: 'Sentrum Scene', city: 'Oslo', country: 'NO',
            bands: [{ band_rel: { id: 92, name: 'Gojira' } }],
          },
        } },
    ]);
    prisma.concertMedia.update = vi.fn(async ({ data }) => ({ id: 5, ...data }));
    prisma.$transaction = vi.fn(async (fns) => Promise.all(fns.map((f) => (typeof f === 'function' ? f() : f))));

    await request(app())
      .patch('/data/concerts/media')
      .set(...authHeader({ id: 'user-1' }))
      .send({ ids: [5], band_id: 92, caption: 'stage dive' })
      .expect(200);

    expect(prisma.concertMedia.update).toHaveBeenCalled();
    const sidecar = JSON.parse(await readFile(join(dir, 'concert-media.json'), 'utf8'));
    expect(sidecar.files[0]).toMatchObject({ band_id: 92, band_name: 'Gojira', caption: 'stage dive' });
  });

  it('refuses to touch a file that is not the caller\'s', async () => {
    prisma.concertMedia.findMany = vi.fn(async () => [
      { id: 5, attendance_id: 1, rel_path: 'x/y/z.jpg', filename: 'z.jpg',
        attendance_rel: { wishlist_rel: { user_id: 'someone-else' }, concert_rel: { bands: [] } } },
    ]);
    await request(app())
      .patch('/data/concerts/media')
      .set(...authHeader({ id: 'user-1' }))
      .send({ ids: [5], caption: 'nope' })
      .expect(403);
  });

  it('refuses everything when only the second of two rows belongs to someone else', async () => {
    // A `rows.some(...)` check over the whole list looks the same as a
    // first-row-only check when every test sends one row. This sends two, with
    // the offending row second, so a check that only inspects rows[0] would
    // wrongly let this through and start updating the caller's own file.
    prisma.concertMedia.findMany = vi.fn(async () => [
      { id: 5, attendance_id: 1, rel_path: 'user-1/showA/IMG_1.jpg', filename: 'IMG_1.jpg',
        attendance_rel: { wishlist_rel: { user_id: 'user-1' }, concert_rel: { bands: [{ band_rel: { id: 92, name: 'Gojira' } }] } } },
      { id: 6, attendance_id: 2, rel_path: 'someone-else/showB/IMG_2.jpg', filename: 'IMG_2.jpg',
        attendance_rel: { wishlist_rel: { user_id: 'someone-else' }, concert_rel: { bands: [] } } },
    ]);
    prisma.concertMedia.update = vi.fn(async ({ data }) => ({ id: 5, ...data }));

    await request(app())
      .patch('/data/concerts/media')
      .set(...authHeader({ id: 'user-1' }))
      .send({ ids: [5, 6], caption: 'nope' })
      .expect(403);

    expect(prisma.concertMedia.update).not.toHaveBeenCalled();
  });

  it('refuses a band that is only on the first of two selected shows\' bills, and updates neither', async () => {
    // Same shape of gap as the ownership check above: a `rows.every(...)`
    // that only ever sees one row in the tests would let a bill mismatch on
    // the second show through silently.
    prisma.concertMedia.findMany = vi.fn(async () => [
      { id: 5, attendance_id: 1, rel_path: 'user-1/showA/IMG_1.jpg', filename: 'IMG_1.jpg',
        attendance_rel: { wishlist_rel: { user_id: 'user-1' }, concert_rel: { bands: [{ band_rel: { id: 92, name: 'Gojira' } }] } } },
      { id: 6, attendance_id: 2, rel_path: 'user-1/showB/IMG_2.jpg', filename: 'IMG_2.jpg',
        attendance_rel: { wishlist_rel: { user_id: 'user-1' }, concert_rel: { bands: [{ band_rel: { id: 7, name: 'Mastodon' } }] } } },
    ]);
    prisma.concertMedia.update = vi.fn(async ({ data }) => ({ id: 5, ...data }));

    await request(app())
      .patch('/data/concerts/media')
      .set(...authHeader({ id: 'user-1' }))
      .send({ ids: [5, 6], band_id: 92 })
      .expect(400);

    expect(prisma.concertMedia.update).not.toHaveBeenCalled();
  });

  it('treats a repeated id as one file, not a missing one', async () => {
    // {ids:[5,5]} asks for the same file twice. Comparing the raw request
    // array's length against the rows Postgres returned for the deduplicated
    // id set would read the repeat as "one id came back missing" and 404 a
    // file that exists and belongs to the caller.
    const dir = join(root, 'archive', 'user-1', 'showA');
    await mkdir(dir, { recursive: true });

    prisma.concertMedia.findMany = vi.fn(async () => [
      { id: 5, attendance_id: 1, rel_path: 'user-1/showA/IMG_1.jpg', filename: 'IMG_1.jpg',
        kind: 'PHOTO', sha256: 'h5', bytes: 1234, width: 4080, height: 3072, duration_ms: null,
        caption: null, taken_at: null, band_id: null,
        attendance_rel: {
          wishlist_rel: { user_id: 'user-1' },
          concert_rel: {
            id: 8417, concert_date: new Date('2026-06-12T19:00:00Z'), venue: 'Sentrum Scene', city: 'Oslo', country: 'NO',
            bands: [{ band_rel: { id: 92, name: 'Gojira' } }],
          },
        } },
    ]);
    prisma.concertMedia.update = vi.fn(async ({ data }) => ({ id: 5, ...data }));
    prisma.$transaction = vi.fn(async (fns) => Promise.all(fns.map((f) => (typeof f === 'function' ? f() : f))));

    const res = await request(app())
      .patch('/data/concerts/media')
      .set(...authHeader({ id: 'user-1' }))
      .send({ ids: [5, 5], caption: 'twice' })
      .expect(200);

    expect(res.body.data.updated).toBe(1);
    expect(prisma.concertMedia.update).toHaveBeenCalledTimes(1);
  });

  it('creates the sidecar when a retag lands on a show that never got one', async () => {
    // Postgres is explicitly a disposable index rebuilt from sidecars, so a
    // tag that reaches only the database is a tag that vanishes the next time
    // anything rebuilds. Probed directly against the pre-fix route: this
    // fixture returned 200 with no concert-media.json ever written.
    const dir = join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');
    await mkdir(dir, { recursive: true });

    prisma.concertMedia.findMany = vi.fn(async () => [
      { id: 5, attendance_id: 1, rel_path: 'user-1/2026-06-12 Oslo - Gojira/IMG_1.jpg', filename: 'IMG_1.jpg',
        kind: 'PHOTO', sha256: 'h5', bytes: 1234, width: 4080, height: 3072, duration_ms: null,
        caption: null, taken_at: null, band_id: null,
        attendance_rel: {
          wishlist_rel: { user_id: 'user-1' },
          concert_rel: {
            id: 8417, concert_date: new Date('2026-06-12T19:00:00Z'), venue: 'Sentrum Scene', city: 'Oslo', country: 'NO',
            bands: [{ band_rel: { id: 92, name: 'Gojira' } }],
          },
        } },
    ]);
    prisma.concertMedia.update = vi.fn(async ({ data }) => ({ id: 5, ...data }));
    prisma.$transaction = vi.fn(async (fns) => Promise.all(fns.map((f) => (typeof f === 'function' ? f() : f))));

    await request(app())
      .patch('/data/concerts/media')
      .set(...authHeader({ id: 'user-1' }))
      .send({ ids: [5], band_id: 92 })
      .expect(200);

    const sidecar = JSON.parse(await readFile(join(dir, 'concert-media.json'), 'utf8'));
    expect(sidecar).toMatchObject({ concert_id: 8417, user_id: 'user-1' });
    expect(sidecar.files[0]).toMatchObject({ name: 'IMG_1.jpg', band_id: 92, band_name: 'Gojira' });
  });

  it('adds a sidecar entry built from the database row when the sidecar exists but never recorded this file', async () => {
    // Same failure, narrower trigger: the sidecar file is there, but this
    // particular filename has no entry in it. Probed directly: the pre-fix
    // route silently skipped this row too and still answered 200.
    const dir = join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'concert-media.json'), JSON.stringify({
      version: 1, concert_id: 8417, user_id: 'user-1',
      concert: { date: '2026-06-12', venue: 'Sentrum Scene', city: 'Oslo', country: 'NO' },
      files: [],
    }));

    prisma.concertMedia.findMany = vi.fn(async () => [
      { id: 5, attendance_id: 1, rel_path: 'user-1/2026-06-12 Oslo - Gojira/IMG_1.jpg', filename: 'IMG_1.jpg',
        kind: 'PHOTO', sha256: 'h5', bytes: 1234, width: 4080, height: 3072, duration_ms: null,
        caption: null, taken_at: null, band_id: null,
        attendance_rel: {
          wishlist_rel: { user_id: 'user-1' },
          concert_rel: {
            id: 8417, concert_date: new Date('2026-06-12T19:00:00Z'), venue: 'Sentrum Scene', city: 'Oslo', country: 'NO',
            bands: [{ band_rel: { id: 92, name: 'Gojira' } }],
          },
        } },
    ]);
    prisma.concertMedia.update = vi.fn(async ({ data }) => ({ id: 5, ...data }));
    prisma.$transaction = vi.fn(async (fns) => Promise.all(fns.map((f) => (typeof f === 'function' ? f() : f))));

    await request(app())
      .patch('/data/concerts/media')
      .set(...authHeader({ id: 'user-1' }))
      .send({ ids: [5], band_id: 92 })
      .expect(200);

    const sidecar = JSON.parse(await readFile(join(dir, 'concert-media.json'), 'utf8'));
    expect(sidecar.files[0]).toMatchObject({ name: 'IMG_1.jpg', band_id: 92, band_name: 'Gojira', sha256: 'h5' });
  });
});

describe('DELETE /media/:id', () => {
  it('removes the row, the sidecar entry and the file together', async () => {
    // All three or none. A row without a file is a broken tile; a file without
    // a row is invisible until the next rebuild.
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .field('band_id', '92')
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(201);

    const dir = join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');
    prisma.concertMedia.findUnique = vi.fn(async () => ({
      id: 1, attendance_id: 1, filename: 'IMG_1.jpg',
      rel_path: 'user-1/2026-06-12 Oslo - Gojira/IMG_1.jpg',
      attendance_rel: { wishlist_rel: { user_id: 'user-1' } },
    }));
    prisma.concertMedia.delete = vi.fn(async () => ({ id: 1 }));

    await request(app())
      .delete('/data/concerts/media/1')
      .set(...authHeader({ id: 'user-1' }))
      .expect(200);

    expect(await readdir(dir)).not.toContain('IMG_1.jpg');
    const sidecar = JSON.parse(await readFile(join(dir, 'concert-media.json'), 'utf8'));
    expect(sidecar.files).toHaveLength(0);
  });

  it('removes a video\'s poster frame along with the video', async () => {
    // The poster is not derived from the video — there is no ffmpeg here to
    // decode one — so it lives in the archive beside it and does not get
    // regenerated. Left behind, it is a frame from a video that no longer
    // exists, syncing to Drive forever with nothing to point it at.
    const poster = await (await import('sharp')).default(
      { create: { width: 1920, height: 1080, channels: 3, background: '#222' } }).jpeg().toBuffer();

    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .field('band_id', '92')
      .attach('files', Buffer.from('fake mp4'), { filename: 'VID_1.mp4', contentType: 'video/mp4' })
      .attach('posters', poster, { filename: 'VID_1.mp4.webp', contentType: 'image/webp' })
      .expect(201);

    const dir = join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');
    expect(await readdir(join(dir, '.posters'))).toContain('VID_1.mp4.webp');

    prisma.concertMedia.findUnique = vi.fn(async () => ({
      id: 1, attendance_id: 1, filename: 'VID_1.mp4', kind: 'VIDEO',
      rel_path: 'user-1/2026-06-12 Oslo - Gojira/VID_1.mp4',
      attendance_rel: { wishlist_rel: { user_id: 'user-1' } },
    }));
    prisma.concertMedia.delete = vi.fn(async () => ({ id: 1 }));

    await request(app())
      .delete('/data/concerts/media/1')
      .set(...authHeader({ id: 'user-1' }))
      .expect(200);

    expect(await readdir(join(dir, '.posters'))).not.toContain('VID_1.mp4.webp');
  });
});

describe('GET /media/:id/file', () => {
  const uploadOne = async () => {
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .field('band_id', '92')
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(201);
    prisma.concertMedia.findUnique = vi.fn(async () => ({
      id: 1, kind: 'PHOTO', sha256: 'h1', filename: 'IMG_1.jpg',
      rel_path: 'user-1/2026-06-12 Oslo - Gojira/IMG_1.jpg',
      attendance_rel: { wishlist_rel: { user_id: 'user-1' } },
    }));
  };

  it('serves the bytes to a request carrying a valid token and no header', async () => {
    // No Authorization header anywhere in this test, on purpose. That is the
    // whole reason the token exists.
    await uploadOne();
    const t = signMediaToken({ mediaId: 1, userId: 'user-1' });
    const res = await request(app()).get(`/data/concerts/media/1/file?t=${t}`).expect(200);
    expect(res.headers['content-type']).toMatch(/image\/jpeg/);
  });

  it('refuses a request with no token', async () => {
    await uploadOne();
    await request(app()).get('/data/concerts/media/1/file').expect(401);
  });

  it('refuses a token minted for a different file', async () => {
    await uploadOne();
    const t = signMediaToken({ mediaId: 999, userId: 'user-1' });
    await request(app()).get(`/data/concerts/media/1/file?t=${t}`).expect(401);
  });

  it('refuses a token whose user no longer owns the file', async () => {
    await uploadOne();
    const t = signMediaToken({ mediaId: 1, userId: 'someone-else' });
    await request(app()).get(`/data/concerts/media/1/file?t=${t}`).expect(403);
  });

  it('answers a range request with a partial body, so video can seek', async () => {
    await uploadOne();
    const t = signMediaToken({ mediaId: 1, userId: 'user-1' });
    const res = await request(app())
      .get(`/data/concerts/media/1/file?t=${t}`)
      .set('Range', 'bytes=0-9')
      .expect(206);
    expect(res.headers['content-range']).toMatch(/^bytes 0-9\//);
  });
});

describe('GET /media/:id/thumb', () => {
  it('generates the thumbnail on a cache miss rather than 404ing', async () => {
    // The cache directory is safe to delete at any time precisely because of
    // this. It is also what lets the upload skip thumbnails on failure.
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .field('band_id', '92')
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(201);

    const created = prisma.concertMedia.create.mock.calls[0][0].data;
    prisma.concertMedia.findUnique = vi.fn(async () => ({
      id: 1, kind: 'PHOTO', sha256: created.sha256, filename: 'IMG_1.jpg',
      rel_path: created.rel_path,
      attendance_rel: { wishlist_rel: { user_id: 'user-1' } },
    }));

    const t = signMediaToken({ mediaId: 1, userId: 'user-1' });
    const res = await request(app()).get(`/data/concerts/media/1/thumb?t=${t}`).expect(200);
    expect(res.headers['content-type']).toMatch(/image\/webp/);
  });
});
