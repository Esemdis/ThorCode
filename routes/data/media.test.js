import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

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
});
