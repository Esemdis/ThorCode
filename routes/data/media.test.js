import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { buildApp, authHeader, installFakePrisma, routeManifest } from '../../test/routeApp.js';
import { signMediaToken } from '../../utils/mediaTokens.js';
import { buildExif, jpegWithExif } from '../../test/exifFixture.js';

let root;

const attendanceRow = {
  id: 1,
  wishlist_id: 5,
  concert_id: 8417,
  wishlist_rel: { user_id: 'user-1' },
  concert_rel: {
    id: 8417, concert_date: new Date('2026-06-12T19:00:00Z'),
    venue: 'Sentrum Scene', city: 'Oslo', country: 'NO',
    // Two setlists on purpose, and they differ: `setlist` is what this band
    // played at THIS show, `band_rel.setlist` is the most recent one we have
    // for them anywhere. The song picker prefers the first and falls back to
    // the second, so a fixture where they matched could not tell them apart.
    bands: [{
      band: 92,
      setlist: { songs: [{ name: 'Stranded', tape: false, cover: null }] },
      band_rel: {
        id: 92,
        name: 'Gojira',
        setlist: { songs: [{ name: 'Flying Whales', tape: false, cover: null }] },
      },
    }],
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
  // Reset like the rest: a test that sets this and a later one that relies on
  // it being empty would otherwise pass or fail by file order.
  prisma.concertAttendance.findMany = vi.fn(async () => []);
  prisma.concertMedia.findMany = vi.fn(async () => []);
  prisma.concertMedia.create = vi.fn(async ({ data }) => ({ id: 1, ...data }));
});

const app = () => buildApp(router, '/data/concerts');
// Uploading is admin-only, so every upload here — including the ones that
// are just setup for another route's test — signs in as one.
const admin = { id: 'user-1', role: 'ADMIN' };
// `seed` makes the bytes differ while the file stays a valid JPEG — trailing
// bytes after the end-of-image marker are ignored, and nothing on the server
// decodes these anyway. Needed since uploads are deduplicated by checksum:
// a test about two files has to use two files, not the same one twice.
const jpeg = (seed = '') => Buffer.concat([baseJpeg, Buffer.from(seed)]);
// A video is not text to superagent, so it leaves res.text undefined. The tests
// that compare a video's bytes read them through this instead.
const bytesOf = (req) => req.buffer(true).parse((res, done) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => done(null, Buffer.concat(chunks).toString()));
});
const baseJpeg = Buffer.from(
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
    // /play is the same: it is what a <video> points at, and an element sends
    // no Authorization header. GET /media/share/:token is public by design —
    // the token in its path is the credential — so its 2 is the rate limiter
    // and the handler.
    expect(routeManifest(router)).toEqual([
      'POST /attendances/:attendanceId/media [7]',
      'GET /attendances/:attendanceId/media [4]',
      'GET /bands/:bandId/media [4]',
      'POST /attendances/:attendanceId/lineup [5]',
      'PATCH /media [8]',
      'DELETE /media/:id [4]',
      'POST /media/:id/share [6]',
      'DELETE /media/:id/share [4]',
      'GET /media/:id/file [1]',
      'GET /media/:id/play [1]',
      'GET /media/:id/thumb [1]',
      'GET /media/share/:token [2]',
    ]);
  });

  it('rejects an unauthenticated upload', async () => {
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(401);
  });

  it('refuses an upload from a plain user', async () => {
    // The archive is one person's. Everyone signed in can look, but only an
    // admin adds to it, and the gate is here rather than in the dialog that
    // hides the button.
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1', role: 'USER' }))
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(403);
  });

  it('refuses an attendance that belongs to someone else', async () => {
    // Attendance carries the owner. Without this check, knowing an integer is
    // enough to write into another account's archive.
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'someone-else', role: 'ADMIN' }))
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(403);
  });

  it('writes the file into the show folder under the caller subtree', async () => {
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .field('band_id', '92')
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(201);

    const dir = join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');
    expect(await readdir(dir)).toContain('IMG_1.jpg');
  });

  it('writes a sidecar naming the concert and the band', async () => {
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
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
      .set(...authHeader(admin))
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
      .set(...authHeader(admin))
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(201);

    expect(prisma.concertMedia.create.mock.calls[0][0].data.band_id).toBeNull();

    const sidecar = JSON.parse(await readFile(
      join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira', 'concert-media.json'), 'utf8'));
    expect(sidecar.files[0]).toMatchObject({ band_id: null, band_name: null, song: null });
  });

  it('refuses a band that is not on the bill', async () => {
    // Otherwise a typo files a Gojira photo under a band that was not there,
    // and the band view quietly shows a show the user never saw them at.
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .field('band_id', '999')
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(400);
  });

  it('refuses a file type no browser renders', async () => {
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .field('band_id', '92')
      .attach('files', Buffer.from('pdf'), { filename: 'a.pdf', contentType: 'application/pdf' })
      .expect(400);
  });

  it('stores the poster the browser sent with a video', async () => {
    const poster = await (await import('sharp')).default(
      { create: { width: 1920, height: 1080, channels: 3, background: '#222' } }).jpeg().toBuffer();

    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .field('band_id', '92')
      .field('meta', JSON.stringify({ 'VID_1.mp4': { width: 1920, height: 1080, duration_ms: 24000 } }))
      .attach('files', Buffer.from('fake mp4'), { filename: 'VID_1.mp4', contentType: 'video/mp4' })
      .attach('posters', poster, { filename: 'VID_1.mp4.webp', contentType: 'image/webp' })
      .expect(201);

    const dir = join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');
    expect(await readdir(join(dir, '.posters'))).toContain('VID_1.mp4.webp');
  });

  it('leaves no poster temp file behind after storing one', async () => {
    // Posters were read into the heap and unlinked at parse time, all of them
    // at once, before the first byte was written anywhere. Streaming from the
    // temp path instead means the file has to outlive the parse, so the
    // sweep that removes it afterwards is now load-bearing.
    const poster = await (await import('sharp')).default(
      { create: { width: 1920, height: 1080, channels: 3, background: '#222' } }).webp().toBuffer();

    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .field('meta', JSON.stringify({ 'VID_1.mp4': { width: 1920, height: 1080, duration_ms: 24000 } }))
      .attach('files', Buffer.from('fake mp4'), { filename: 'VID_1.mp4', contentType: 'video/mp4' })
      .attach('posters', poster, { filename: 'VID_1.mp4.webp', contentType: 'image/webp' })
      .expect(201);

    expect(await readdir(join(root, 'incoming')).catch(() => [])).toEqual([]);
  });

  it('ignores a poster that is not a webp frame, and stores the video anyway', async () => {
    // The posters field is the one upload field with no type gate on it. A
    // poster that is not an image costs a placeholder tile; refusing the
    // whole batch would cost the recording it came with.
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .field('meta', JSON.stringify({ 'VID_1.mp4': { width: 1920, height: 1080, duration_ms: 24000 } }))
      .attach('files', Buffer.from('fake mp4'), { filename: 'VID_1.mp4', contentType: 'video/mp4' })
      .attach('posters', Buffer.from('%PDF-1.4 not a frame'), { filename: 'VID_1.mp4.webp', contentType: 'application/pdf' })
      .expect(201);

    const dir = join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');
    expect(await readdir(dir)).toContain('VID_1.mp4');
    expect(await readdir(join(dir, '.posters')).catch(() => [])).toEqual([]);
    expect(await readdir(join(root, 'incoming')).catch(() => [])).toEqual([]);
  });

  it('takes duration and dimensions from the browser, since there is no ffprobe', async () => {
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
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
      .set(...authHeader(admin))
      .field('band_id', '92')
      .attach('files', Buffer.from('fake mp4'), { filename: 'VID_1.mp4', contentType: 'video/mp4' })
      .expect(201);

    expect(prisma.concertMedia.create).toHaveBeenCalled();
  });

  it('stores the capture time a video arrived with', async () => {
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .field('band_id', '92')
      .field('meta', JSON.stringify({
        'VID_1.mp4': { width: 1920, height: 1080, duration_ms: 82_536, captured_at: '2026-06-12T19:54:41.000Z' },
      }))
      .attach('files', Buffer.from('fake mp4'), { filename: 'VID_1.mp4', contentType: 'video/mp4' })
      .expect(201);

    expect(prisma.concertMedia.create.mock.calls[0][0].data)
      .toMatchObject({ taken_at: new Date('2026-06-12T19:54:41.000Z') });
  });

  it('refuses to store a capture time from a different week', async () => {
    // The client is the source of this value, so the check runs again here. A
    // time that contradicts its own show would misplace every other clip that
    // night relative to it, not only itself.
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .field('band_id', '92')
      .field('meta', JSON.stringify({ 'VID_1.mp4': { captured_at: '2026-09-20T13:57:16.000Z' } }))
      .attach('files', Buffer.from('fake mp4'), { filename: 'VID_1.mp4', contentType: 'video/mp4' })
      .expect(201);

    expect(prisma.concertMedia.create.mock.calls[0][0].data).toMatchObject({ taken_at: null });
  });

  it('writes the capture time into the sidecar as well as the row', async () => {
    // The sidecar is the record of truth a rebuild reads back, so a time that
    // reached only the database would vanish the next time the archive was
    // rebuilt from disk.
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .field('band_id', '92')
      .field('meta', JSON.stringify({ 'VID_1.mp4': { captured_at: '2026-06-12T19:54:41.000Z' } }))
      .attach('files', Buffer.from('fake mp4'), { filename: 'VID_1.mp4', contentType: 'video/mp4' })
      .expect(201);

    const sidecar = JSON.parse(await readFile(
      join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira', 'concert-media.json'), 'utf8'));
    expect(sidecar.files.find((f) => f.name === 'VID_1.mp4').taken_at)
      .toBe('2026-06-12T19:54:41.000Z');
  });

  it('believes a photograph about itself and not the browser about it', async () => {
    // The only capture time a browser could offer for a still is
    // File.lastModified, and that was measured on a gig out of Google Photos:
    // it was the download time, and the parallel download had reordered it. So
    // a client-sent time is still ignored here — the EXIF inside the file is
    // what counts, and this JPEG carries none.
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .field('band_id', '92')
      .field('meta', JSON.stringify({ 'IMG_1.jpg': { captured_at: '2026-06-12T19:54:41.000Z' } }))
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(201);

    expect(prisma.concertMedia.create.mock.calls[0][0].data).toMatchObject({ taken_at: null });
  });

  it('reads a photograph\'s capture time out of its own EXIF', async () => {
    // End to end through real sharp: a real JPEG with a real APP1 segment. The
    // stamp is local wall-clock at +02:00 and has to come back as UTC, which is
    // the whole difficulty — stored naively it would be two hours early, and
    // two hours inside a three-hour concert sorts an encore ahead of the opener.
    const withExif = jpegWithExif(jpeg(), buildExif({
      original: '2026:06:12 21:38:28', offset: '+02:00',
    }));
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .field('band_id', '92')
      .attach('files', withExif, 'IMG_2.jpg')
      .expect(201);

    expect(prisma.concertMedia.create.mock.calls[0][0].data.taken_at)
      .toEqual(new Date('2026-06-12T19:38:28.000Z'));
  });

  it('writes a photograph\'s capture time into the sidecar too', async () => {
    // The sidecar is the record of truth and the rebuild reads it back, so a
    // time that lands only in Postgres is a time the next rebuild discards.
    const withExif = jpegWithExif(jpeg(), buildExif({
      original: '2026:06:12 21:38:28', offset: '+02:00',
    }));
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .field('band_id', '92')
      .attach('files', withExif, 'IMG_3.jpg')
      .expect(201);

    const sidecar = JSON.parse(await readFile(
      join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira', 'concert-media.json'), 'utf8',
    ));
    expect(sidecar.files.find((f) => f.name === 'IMG_3.jpg').taken_at)
      .toBe('2026-06-12T19:38:28.000Z');
  });

  it('refuses an EXIF stamp that contradicts its own show', async () => {
    // A camera whose clock was never set writes a plausible-looking date years
    // away. Believed, it would drag that photograph to one end of every gallery
    // it appears in.
    const wrongClock = jpegWithExif(jpeg(), buildExif({
      original: '2019:01:01 12:00:00', offset: '+02:00',
    }));
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .field('band_id', '92')
      .attach('files', wrongClock, 'IMG_4.jpg')
      .expect(201);

    expect(prisma.concertMedia.create.mock.calls[0][0].data).toMatchObject({ taken_at: null });
  });

  it('ignores a duration the client made up', async () => {
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
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
      .set(...authHeader(admin))
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
      .set(...authHeader(admin))
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
      .set(...authHeader(admin))
      .field('band_id', '92')
      .attach('files', jpeg('a'), 'IMG_1.jpg')
      .attach('files', jpeg('b'), 'IMG_2.jpg')
      .expect(201);

    expect(prisma.concertMedia.create).toHaveBeenCalledTimes(2);
  });

  it('suffixes the second of two identically-named files in the same request', async () => {
    // Pinning this because it is easy to get backwards: `taken` has to grow as
    // the batch is processed, not just be seeded once from what already
    // existed before the request arrived.
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .field('band_id', '92')
      // Two different photographs that happen to share a name, which is
      // what two phones both writing IMG_0001.jpg looks like. Identical bytes
      // would be deduplicated instead, which is a different test.
      .attach('files', jpeg('a'), 'IMG_1.jpg')
      .attach('files', jpeg('b'), 'IMG_1.jpg')
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
      .set(...authHeader(admin))
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
      .set(...authHeader(admin))
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
      .set(...authHeader(admin))
      .field('band_id', '92')
      .attach('files', jpeg('a'), 'IMG_1.jpg')
      .attach('files', jpeg('b'), 'IMG_2.jpg')
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
      .set(...authHeader(admin))
      .field('band_id', '92')
      .attach('files', jpeg(), 'a:b?c*.jpg')
      .expect(201);

    const data = prisma.concertMedia.create.mock.calls[0][0].data;
    expect(data.filename).toBe('a-b-c-.jpg');
    expect(data.rel_path.endsWith('a-b-c-.jpg')).toBe(true);

    const dir = join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');
    expect(await readdir(dir)).toContain('a-b-c-.jpg');
  });

  it('stores nothing at all for a dimension too big for the column, rather than a plausible lie', async () => {
    // asInt already refused a negative or non-numeric value; this is the
    // missing half. A value like 9e12 sails through both checks and then fails
    // at insert time, turning a bad number into a 500 with the file already
    // renamed onto disk — so it must not reach Prisma.
    //
    // It becomes null rather than INT32_MAX because the sidecar is the record
    // of truth. Clamped, duration_ms: 1e300 was written as 2147483647 and read
    // back out as a genuine 24.9-day video that every consumer believed. null
    // is what this function already returns for every other unusable value,
    // what the schema permits, and what planRebuild round-trips.
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .field('band_id', '92')
      .field('meta', JSON.stringify({ 'VID_1.mp4': { width: 9e12, height: 1080, duration_ms: 1e300 } }))
      .attach('files', Buffer.from('fake mp4'), { filename: 'VID_1.mp4', contentType: 'video/mp4' })
      .expect(201);

    expect(prisma.concertMedia.create.mock.calls[0][0].data)
      .toMatchObject({ width: null, height: 1080, duration_ms: null });

    const sidecar = JSON.parse(await readFile(
      join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira', 'concert-media.json'), 'utf8'));
    expect(sidecar.files[0]).toMatchObject({ width: null, duration_ms: null });
  });

  it('does not overwrite a file someone put in the show folder by hand', async () => {
    // Probed: `taken` was built from the sidecar and the DB rows and never from
    // the directory, so a file in neither index was invisible to uniqueFilename
    // and the rename went straight over it — 201, no suffix, no warning.
    // Decision 1 says the folder must be usable in a file browser by someone
    // who has never heard of this app, which makes dropping a file into it the
    // sanctioned use, not an abuse.
    const dir = join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'IMG_1.jpg'), 'THE-ONLY-COPY-OF-A-PHOTOGRAPH');

    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(201);

    expect(prisma.concertMedia.create.mock.calls[0][0].data.filename).toBe('IMG_1 (2).jpg');
    expect(await readFile(join(dir, 'IMG_1.jpg'), 'utf8')).toBe('THE-ONLY-COPY-OF-A-PHOTOGRAPH');
  });

  it('refuses a show whose date is not confirmed yet instead of filing it under 1970', async () => {
    // Concert.concert_date is nullable and dateOnly(null) is the epoch, so
    // these landed in '1970-01-01 Oslo - Gojira' and indexed cleanly. GET
    // /bands/:bandId/media then filtered them straight back out — it drops
    // null-dated attendances on purpose, because 1970 wrecks first_year and
    // the sparkline — leaving them permanently invisible on the feature's main
    // surface. The two routes have to make the same call.
    prisma.concertAttendance.findUnique = vi.fn(async () => ({
      ...attendanceRow,
      concert_rel: { ...attendanceRow.concert_rel, concert_date: null },
    }));

    const res = await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(400);

    expect(res.body.error).toMatch(/no confirmed date/i);
    expect(prisma.concertMedia.create).not.toHaveBeenCalled();
    await expect(readdir(join(root, 'archive', 'user-1'))).rejects.toThrow();
  });
});

describe('an upload carrying a band_id that is not a band id', () => {
  it('refuses a non-numeric band_id as the bad request it is', async () => {
    // The client sent the string "null" for a support act with no Band row:
    // truthy, so it was appended, then parseInt'd to NaN here. NaN is on no
    // bill, so it came back as "That band is not on this bill" — an answer
    // about the band that was nothing to do with what went wrong.
    const res = await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .field('band_id', 'null')
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(400);

    expect(res.body.error).toMatch(/validation/i);
    expect(prisma.concertMedia.create).not.toHaveBeenCalled();
  });

  it('leaves no temp file behind when it refuses one', async () => {
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .field('band_id', 'null')
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(400);

    expect(await readdir(join(root, 'incoming')).catch(() => [])).toEqual([]);
  });

  it('still takes an upload with no band at all', async () => {
    // The common case: uploading is deliberately untagged, and the sweep in
    // the gig view is where a band gets chosen.
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(201);
  });
});

describe('POST /attendances/:id/lineup', () => {
  // Linking a support act to a concert so photographs can be tagged to them.
  // ConcertMedia.band_id is a foreign key, so an act that exists only as a
  // string in the scraped lineup has nothing to point at until this runs.
  const withLineup = (names) => ({
    ...attendanceRow,
    concert_rel: { ...attendanceRow.concert_rel, metadata: JSON.stringify(names) },
  });

  beforeEach(() => {
    prisma.band = {
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }) => ({ id: 501, ...data })),
    };
    prisma.concertBandReference = {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }) => ({ id: 900, ...data })),
    };
    prisma.concertAttendance.findUnique = vi.fn(async () => withLineup(['Gojira', 'Svalbard']));
  });

  it('creates the band and puts it on that concert\'s bill', async () => {
    const res = await request(app())
      .post('/data/concerts/attendances/1/lineup')
      .set(...authHeader(admin))
      .send({ name: 'Svalbard' })
      .expect(201);

    expect(prisma.band.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ name: 'Svalbard' }),
    }));
    expect(prisma.concertBandReference.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ concert: 8417, band: 501 }),
    }));
    expect(res.body.data).toMatchObject({ band: { id: 501, name: 'Svalbard' }, created: true });
  });

  it('reuses a band that already exists rather than making a second row', async () => {
    // Band.name is unique and the table is shared by every account, so a
    // second "Svalbard" is not merely untidy — it is a row that cannot be
    // written. Matched canonically, the same comparison enrich-lineup uses.
    prisma.band.findMany = vi.fn(async () => [{ id: 44, name: 'Svalbard' }]);
    prisma.concertAttendance.findUnique = vi.fn(async () => withLineup(['Svalbard (UK)']));

    const res = await request(app())
      .post('/data/concerts/attendances/1/lineup')
      .set(...authHeader(admin))
      .send({ name: 'Svalbard (UK)' })
      .expect(201);

    expect(prisma.band.create).not.toHaveBeenCalled();
    expect(res.body.data).toMatchObject({ band: { id: 44 }, created: false });
  });

  it('refuses a name the scraper never said played that night', async () => {
    // Without this, one account could put any band on any concert's bill —
    // and the bill is shared with everyone else who attended, feeds their
    // bands-seen counts, and decides what the map shows.
    const res = await request(app())
      .post('/data/concerts/attendances/1/lineup')
      .set(...authHeader(admin))
      .send({ name: 'Metallica' })
      .expect(400);

    expect(res.body.error).toMatch(/lineup/i);
    expect(prisma.band.create).not.toHaveBeenCalled();
  });

  it('says so without linking twice when the act is already on the bill', async () => {
    prisma.band.findMany = vi.fn(async () => [{ id: 92, name: 'Gojira' }]);
    const res = await request(app())
      .post('/data/concerts/attendances/1/lineup')
      .set(...authHeader(admin))
      .send({ name: 'Gojira' })
      .expect(201);

    expect(prisma.concertBandReference.create).not.toHaveBeenCalled();
    expect(res.body.data).toMatchObject({ band: { id: 92 }, created: false });
  });

  it('is admin-only, because the bill it changes is everyone\'s', async () => {
    await request(app())
      .post('/data/concerts/attendances/1/lineup')
      .set(...authHeader({ id: 'user-1', role: 'USER' }))
      .send({ name: 'Svalbard' })
      .expect(403);
  });

  it('refuses a show that is not the caller\'s', async () => {
    await request(app())
      .post('/data/concerts/attendances/1/lineup')
      .set(...authHeader({ id: 'someone-else', role: 'ADMIN' }))
      .send({ name: 'Svalbard' })
      .expect(403);
  });

  it('stores the cleaned name, not the scraper\'s spelling of it', async () => {
    // "Counterparts266K Followers" would become a permanent row in a table
    // every account shares.
    prisma.concertAttendance.findUnique = vi.fn(async () => withLineup(['Counterparts266K Followers']));
    await request(app())
      .post('/data/concerts/attendances/1/lineup')
      .set(...authHeader(admin))
      .send({ name: 'Counterparts266K Followers' })
      .expect(201);

    expect(prisma.band.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ name: 'Counterparts' }),
    }));
  });
});

describe('two uploads racing into one show', () => {
  it('keeps both files when they arrive at the same time under the same name', async () => {
    // The filename was chosen from a snapshot — existing rows, readdir, the
    // sidecar — read with no lock, and the rename onto it is an unconditional
    // overwrite. Two requests that both read before either wrote picked the
    // same name; the second replaced the first's bytes, then failed its
    // insert on @@unique([attendance_id, filename]) and unlinked the file it
    // had just written over. Result: no bytes on disk, a row and a sidecar
    // entry both claiming the photograph exists, and the first client told
    // 201. This is the retrying-client case, which a flaky home connection
    // produces on its own.
    const seen = [];
    prisma.concertMedia.create = vi.fn(async ({ data }) => {
      // Widen the window the same way a real insert does, and record which
      // name each request settled on.
      await new Promise((r) => setTimeout(r, 15));
      seen.push(data.filename);
      return { id: seen.length, ...data };
    });

    const send = (seed) => request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .attach('files', jpeg(seed), 'IMG_1.jpg');

    const [a, b] = await Promise.all([send('a'), send('b')]);
    expect([a.status, b.status]).toEqual([201, 201]);

    // Two distinct names, and both sets of bytes still on disk.
    expect(new Set(seen).size).toBe(2);
    const dir = join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');
    const onDisk = (await readdir(dir)).filter((n) => n.endsWith('.jpg'));
    expect(onDisk).toHaveLength(2);
  });
});

describe('the same file uploaded twice', () => {
  // The checksum has always been computed and stored, and until now was only
  // ever used as a thumbnail cache key. Nothing compared it, so a second
  // upload of a photograph already in the archive was stored again under
  // "IMG_1 (2).jpg" — a second copy on disk, a second row, a second sidecar
  // entry and a second file synced to Drive, with nothing said about it.
  const sha = (buf) => createHash('sha256').update(buf).digest('hex');

  it('refuses bytes the show already has instead of storing them again', async () => {
    prisma.concertMedia.findMany = vi.fn(async () => [
      { filename: 'IMG_first.jpg', rel_path: 'user-1/2026-06-12 Oslo - Gojira/IMG_first.jpg', sha256: sha(jpeg()) },
    ]);

    const res = await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .attach('files', jpeg(), 'IMG_again.jpg')
      .expect(201);

    expect(res.body.data.created).toHaveLength(0);
    expect(res.body.data.duplicates).toEqual(['IMG_again.jpg']);
    expect(prisma.concertMedia.create).not.toHaveBeenCalled();
  });

  it('leaves no bytes behind in the show folder when it refuses one', async () => {
    // The temp file has to go too. A skipped upload that still wrote into the
    // archive would be found by the next rebuild as a file no sidecar
    // mentions — drift created by the very check meant to prevent it.
    prisma.concertMedia.findMany = vi.fn(async () => [
      { filename: 'IMG_first.jpg', rel_path: 'x', sha256: sha(jpeg()) },
    ]);

    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .attach('files', jpeg(), 'IMG_again.jpg')
      .expect(201);

    const dir = join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');
    const present = await readdir(dir).catch(() => []);
    expect(present).not.toContain('IMG_again.jpg');
    expect(await readdir(join(root, 'incoming')).catch(() => [])).toEqual([]);
  });

  it('takes the same bytes under two names in one batch only once', async () => {
    // The client dedupes on name and size, so the same photograph re-exported
    // under a different name arrives here as two parts of one request. The
    // database has nothing to compare against yet for the second one.
    const res = await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .attach('files', jpeg(), 'IMG_1.jpg')
      .attach('files', jpeg(), 'IMG_1_copy.jpg')
      .expect(201);

    expect(res.body.data.created).toHaveLength(1);
    expect(res.body.data.duplicates).toEqual(['IMG_1_copy.jpg']);
  });

  it('still takes a genuinely different file of the same name', async () => {
    // Name collisions are not duplicates. Two phones both write IMG_0001.jpg,
    // and the suffixing that already handles that must not be mistaken for
    // this.
    prisma.concertMedia.findMany = vi.fn(async () => [
      { filename: 'IMG_1.jpg', rel_path: 'x', sha256: 'a-different-file-entirely' },
    ]);

    const res = await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(201);

    expect(res.body.data.created).toHaveLength(1);
    expect(res.body.data.duplicates).toEqual([]);
  });
});

describe('which folder a show lands in', () => {
  // A stateful stand-in for the table, because both of these are about what a
  // second upload does with what the first one left behind. The fake object
  // itself is the one installed at module scope — only its methods are
  // replaced, for the reason at the top of this file.
  let rows;
  const stateful = () => {
    rows = [];
    prisma.concertMedia.findMany = vi.fn(async ({ where }) =>
      rows.filter((r) => r.attendance_id === where.attendance_id));
    prisma.concertMedia.create = vi.fn(async ({ data }) => {
      const row = { id: rows.length + 1, ...data };
      rows.push(row);
      return row;
    });
  };

  const post = (attendanceId, filename) => request(app())
    .post(`/data/concerts/attendances/${attendanceId}/media`)
    .set(...authHeader(admin))
    .attach('files', jpeg(), filename);

  it('keeps one night in one folder when a support act is added between two uploads', async () => {
    // headlinerOf reads concert.bands[0] from a relation fetched with no
    // orderBy, so adding a band to the bill changed what the same show derived
    // to and filed its next upload in '2026-06-12 Oslo - Alcest' beside the
    // half-full '2026-06-12 Oslo - Gojira'. The directory is settled by the
    // first upload now and never recomputed.
    stateful();
    await post(1, 'A.jpg').expect(201);

    prisma.concertAttendance.findUnique = vi.fn(async () => ({
      ...attendanceRow,
      concert_rel: {
        ...attendanceRow.concert_rel,
        bands: [
          { band: 7, band_rel: { id: 7, name: 'Alcest' } },
          ...attendanceRow.concert_rel.bands,
        ],
      },
    }));
    await post(1, 'B.jpg').expect(201);

    expect(await readdir(join(root, 'archive', 'user-1')))
      .toEqual(['2026-06-12 Oslo - Gojira']);
  });

  it('gives two shows that derive the same name a folder each, and a rebuild files them apart', async () => {
    // Venue is deliberately not in the folder name, so a duplicate Concert row
    // for one night — or an early and a late show — derived one folder for two
    // attended concerts. The sidecar holds a single scalar concert_id, so the
    // second show's files were filed under the first at write time and a
    // rebuild reattributed them with every drift channel empty.
    stateful();
    const second = {
      ...attendanceRow,
      id: 2,
      concert_id: 9000,
      concert_rel: { ...attendanceRow.concert_rel, id: 9000, venue: 'Rockefeller' },
    };
    prisma.concertAttendance.findUnique = vi.fn(async ({ where }) =>
      (where.id === 2 ? second : attendanceRow));

    await post(1, 'A.jpg').expect(201);
    await post(2, 'B.jpg').expect(201);

    expect(await readdir(join(root, 'archive', 'user-1'))).toEqual([
      '2026-06-12 Oslo - Gojira', '2026-06-12 Oslo - Gojira (2)',
    ]);

    const { collectArchive, planRebuild, attendanceKey } = await import('../../utils/mediaRebuild.js');
    const { sidecars, filesOnDisk } = await collectArchive(join(root, 'archive'));
    const plan = planRebuild({
      sidecars,
      filesOnDisk,
      attendanceIds: new Map([
        [attendanceKey('user-1', 8417), 1],
        [attendanceKey('user-1', 9000), 2],
      ]),
    });

    expect(plan.upserts.map((u) => [u.attendance_id, u.filename]).sort())
      .toEqual([[1, 'A.jpg'], [2, 'B.jpg']]);
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

  it('asks for the night in the order it happened, not the order it was uploaded', async () => {
    // Ordered in Postgres rather than on the client because everything
    // downstream inherits it: the grid, the shift-click range, and the clips the
    // lightbox reasons about to guess which song a video is of.
    //
    // Nulls last, and there will be some — a photograph whose EXIF carried no
    // stamp, a clip whose container had none, and everything uploaded before
    // either was read. An unknown time is not the same as a late one, so they
    // keep upload order among themselves and sit after everything placeable.
    prisma.concertMedia.findMany = vi.fn(async () => []);
    await request(app())
      .get('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .expect(200);

    expect(prisma.concertMedia.findMany.mock.calls[0][0].orderBy).toEqual([
      { taken_at: { sort: 'asc', nulls: 'last' } },
      { id: 'asc' },
    ]);
  });

  it('sends the night\'s bill and both setlists, so the song picker needs no second request', async () => {
    prisma.concertMedia.findMany = vi.fn(async () => []);
    const res = await request(app())
      .get('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .expect(200);

    expect(res.body.data.bands).toEqual([{
      id: 92,
      name: 'Gojira',
      setlist: { songs: [{ name: 'Stranded', tape: false, cover: null }] },
      recent_setlist: { songs: [{ name: 'Flying Whales', tape: false, cover: null }] },
      // `linked` is how the client tells an act it can tag straight away from
      // one that needs a Band row created first.
      linked: true,
    }]);
  });

  it('sends the support acts too, so the bill is the whole bill', async () => {
    // On a festival most of the lineup has no Band row at all — support acts
    // nobody has wishlisted live only in the scraped metadata. The gig view is
    // the only place that says who played a night you went to.
    prisma.concertMedia.findMany = vi.fn(async () => []);
    prisma.concertAttendance.findUnique = vi.fn(async () => ({
      ...attendanceRow,
      concert_rel: {
        ...attendanceRow.concert_rel,
        metadata: JSON.stringify(['Gojira', 'Svalbard']),
      },
    }));

    const res = await request(app())
      .get('/data/concerts/attendances/1/media')
      .set(...authHeader({ id: 'user-1' }))
      .expect(200);

    expect(res.body.data.bands.map((b) => b.name)).toEqual(['Gojira', 'Svalbard']);
    expect(res.body.data.bands[1]).toMatchObject({ id: null, linked: false });
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

describe('PATCH /media — an act from another stage that day', () => {
  // Graspop is stored as one concert row per act. The night's photographs were
  // uploaded with no band, so they sit on the WARGASM row; Dayseeker played the
  // same day, in the same city, on a row of its own. Tagging one of them as
  // Dayseeker used to be refused ("other show") — it now moves the file into
  // Dayseeker's show, which is where picking Dayseeker at upload would have
  // put it, and where the band view looks.
  const day = new Date('2025-06-22T00:00:00Z');
  const wargasmShow = {
    id: 900, concert_date: day, venue: 'Main Stage', city: 'Dessel', country: 'BE',
    bands: [{ band_rel: { id: 125, name: 'WARGASM' } }],
  };
  const dayseekerHome = (over = {}) => ({
    id: 41,
    concert_rel: {
      id: 901, concert_date: day, venue: 'Jupiler Stage', city: 'Dessel', country: 'BE',
      bands: [{ band_rel: { id: 501, name: 'Dayseeker' } }],
      ...over,
    },
  });
  const srcRel = 'user-1/2025-06-22 Dessel - WARGASM';
  const srcDir = () => join(root, 'archive', srcRel);
  const row = (over = {}) => ({
    id: 5, attendance_id: 40, rel_path: `${srcRel}/IMG_1.jpg`, filename: 'IMG_1.jpg',
    kind: 'PHOTO', sha256: 'h5', bytes: 5, width: null, height: null, duration_ms: null,
    caption: null, song: null, taken_at: null, band_id: null,
    attendance_rel: { wishlist_rel: { user_id: 'user-1' }, concert_rel: wargasmShow },
    ...over,
  });

  // The file on disk, and a sidecar that records it with a caption edited by
  // hand — which must travel with it rather than be rebuilt from the row.
  const seed = async (files = [row()]) => {
    await mkdir(srcDir(), { recursive: true });
    for (const f of files) await writeFile(join(root, 'archive', f.rel_path), `bytes-${f.id}`);
    await writeFile(join(srcDir(), 'concert-media.json'), JSON.stringify({
      version: 1, concert_id: 900, user_id: 'user-1',
      concert: { date: '2025-06-22', venue: 'Main Stage', city: 'Dessel', country: 'BE' },
      files: files.map((f) => ({ name: f.filename, kind: f.kind, band_id: null, band_name: null, caption: 'hand-edited', song: null, sha256: f.sha256 })),
    }));
  };

  const mockDb = ({ rows = [row()], inHome = [], homes = [dayseekerHome()] } = {}) => {
    prisma.concertMedia.findMany = vi.fn(async ({ where }) => (where.id ? rows : inHome));
    prisma.concertAttendance.findMany = vi.fn(async () => homes);
    prisma.concertMedia.update = vi.fn(async ({ where, data }) => ({ id: where.id, ...data }));
    prisma.$transaction = vi.fn(async (ops) => Promise.all(ops));
  };

  const tag = (body) => request(app())
    .patch('/data/concerts/media')
    .set(...authHeader({ id: 'user-1' }))
    .send(body);

  const exists = (p) => readFile(p).then(() => true, () => false);
  const sidecarAt = async (absDir) => JSON.parse(await readFile(join(absDir, 'concert-media.json'), 'utf8'));

  it('moves the photo into the act\'s own show and tags it there', async () => {
    await seed();
    mockDb();

    const res = await tag({ ids: [5], band_id: 501 }).expect(200);
    expect(res.body.data).toMatchObject({ updated: 1, moved: 1 });

    const { data } = prisma.concertMedia.update.mock.calls[0][0];
    expect(data).toMatchObject({ band_id: 501, attendance_id: 41, filename: 'IMG_1.jpg' });
    expect(await readFile(join(root, 'archive', data.rel_path), 'utf8')).toBe('bytes-5');
    expect(await exists(join(srcDir(), 'IMG_1.jpg'))).toBe(false);

    // The destination's sidecar names Dayseeker's concert, files the entry
    // under Dayseeker from its own bill, and kept the hand-edited caption.
    const dest = await sidecarAt(join(root, 'archive', dirname(data.rel_path)));
    expect(dest).toMatchObject({ concert_id: 901, user_id: 'user-1' });
    expect(dest.files).toEqual([expect.objectContaining({
      name: 'IMG_1.jpg', band_id: 501, band_name: 'Dayseeker', caption: 'hand-edited',
    })]);
    // And the show it left no longer claims it.
    expect((await sidecarAt(srcDir())).files).toEqual([]);
  });

  it('moves only the files whose own show lacks the act', async () => {
    const own = row({
      id: 6, attendance_id: 41, rel_path: 'user-1/2025-06-22 Dessel - Dayseeker/IMG_2.jpg', filename: 'IMG_2.jpg',
      sha256: 'h6', attendance_rel: { wishlist_rel: { user_id: 'user-1' }, concert_rel: dayseekerHome().concert_rel },
    });
    await seed();
    await mkdir(join(root, 'archive', 'user-1/2025-06-22 Dessel - Dayseeker'), { recursive: true });
    await writeFile(join(root, 'archive', own.rel_path), 'bytes-6');
    mockDb({ rows: [row(), own], inHome: [{ filename: 'IMG_2.jpg', rel_path: own.rel_path, sha256: 'h6' }] });

    const res = await tag({ ids: [5, 6], band_id: 501 }).expect(200);
    expect(res.body.data).toMatchObject({ updated: 2, moved: 1 });

    const byId = Object.fromEntries(prisma.concertMedia.update.mock.calls.map(([c]) => [c.where.id, c.data]));
    expect(byId[6]).toEqual({ band_id: 501 });
    expect(byId[5]).toMatchObject({ attendance_id: 41, rel_path: 'user-1/2025-06-22 Dessel - Dayseeker/IMG_1.jpg' });
  });

  it('carries a video\'s poster and web rendition with it', async () => {
    // Nothing on this server can make another poster, so one left behind is
    // lost; the rendition is only CPU, but minutes of it for a big clip.
    const clip = row({ kind: 'VIDEO', rel_path: `${srcRel}/VID_1.mp4`, filename: 'VID_1.mp4' });
    await seed([clip]);
    await mkdir(join(srcDir(), '.posters'), { recursive: true });
    await mkdir(join(srcDir(), '.web'), { recursive: true });
    await writeFile(join(srcDir(), '.posters', 'VID_1.mp4.webp'), 'poster');
    await writeFile(join(srcDir(), '.web', 'VID_1.mp4.mp4'), 'rendition');
    mockDb({ rows: [clip] });

    await tag({ ids: [5], band_id: 501 }).expect(200);

    const destDir = join(root, 'archive', dirname(prisma.concertMedia.update.mock.calls[0][0].data.rel_path));
    expect(await readFile(join(destDir, '.posters', 'VID_1.mp4.webp'), 'utf8')).toBe('poster');
    expect(await readFile(join(destDir, '.web', 'VID_1.mp4.mp4'), 'utf8')).toBe('rendition');
    expect(await exists(join(srcDir(), '.posters', 'VID_1.mp4.webp'))).toBe(false);
    expect(await exists(join(srcDir(), '.web', 'VID_1.mp4.mp4'))).toBe(false);
  });

  it('picks a free name when the act\'s show already has a file called that', async () => {
    const destRel = 'user-1/2025-06-22 Dessel - Dayseeker';
    await seed();
    await mkdir(join(root, 'archive', destRel), { recursive: true });
    await writeFile(join(root, 'archive', destRel, 'IMG_1.jpg'), 'theirs');
    mockDb({ inHome: [{ filename: 'IMG_1.jpg', rel_path: `${destRel}/IMG_1.jpg`, sha256: 'different' }] });

    await tag({ ids: [5], band_id: 501 }).expect(200);

    const { data } = prisma.concertMedia.update.mock.calls[0][0];
    expect(data.filename).toBe('IMG_1 (2).jpg');
    expect(await readFile(join(root, 'archive', destRel, 'IMG_1.jpg'), 'utf8')).toBe('theirs');
    expect(await readFile(join(root, 'archive', destRel, 'IMG_1 (2).jpg'), 'utf8')).toBe('bytes-5');
  });

  it('moves nothing when that show already holds the same photograph', async () => {
    // Uploaded to both rows. Moving it would put two copies in one night.
    await seed();
    mockDb({ inHome: [{ filename: 'other-name.jpg', rel_path: 'user-1/x/other-name.jpg', sha256: 'h5' }] });

    const res = await tag({ ids: [5], band_id: 501 }).expect(409);
    expect(res.body.message ?? res.body.error).toMatch(/IMG_1\.jpg/);
    expect(await exists(join(srcDir(), 'IMG_1.jpg'))).toBe(true);
    expect(prisma.concertMedia.update).not.toHaveBeenCalled();
  });

  it('refuses an act that played no show of yours that day in that city', async () => {
    await seed();
    mockDb({ homes: [dayseekerHome({ concert_date: new Date('2025-06-21T00:00:00Z') }), dayseekerHome({ city: 'Antwerp' })] });

    await tag({ ids: [5], band_id: 501 }).expect(400);
    expect(await exists(join(srcDir(), 'IMG_1.jpg'))).toBe(true);
    expect(prisma.concertMedia.update).not.toHaveBeenCalled();
  });

  it('puts the file and both sidecars back when the database write fails', async () => {
    await seed();
    mockDb();
    prisma.$transaction = vi.fn(async () => { throw new Error('connection reset'); });

    await tag({ ids: [5], band_id: 501 }).expect(500);

    expect(await readFile(join(srcDir(), 'IMG_1.jpg'), 'utf8')).toBe('bytes-5');
    expect((await sidecarAt(srcDir())).files).toEqual([expect.objectContaining({ name: 'IMG_1.jpg', caption: 'hand-edited' })]);
    const destDir = join(root, 'archive', 'user-1', (await readdir(join(root, 'archive', 'user-1')))
      .find((d) => d.includes('Dayseeker')));
    expect(await exists(join(destDir, 'IMG_1.jpg'))).toBe(false);
    expect((await sidecarAt(destDir)).files).toEqual([]);
  });

  it('says so when the archive no longer has the file, and moves nothing', async () => {
    await seed([]);
    mockDb();

    const res = await tag({ ids: [5], band_id: 501 }).expect(409);
    expect(res.body.message ?? res.body.error).toMatch(/no longer in the archive/);
    expect(prisma.concertMedia.update).not.toHaveBeenCalled();
  });
});

describe('PATCH /media — the song a video is of', () => {
  // The case this exists for: a video of a whole song. The band tag says who
  // was on stage, the song tag says which three minutes of their set this is.
  const dirFor = () => join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');

  const videoRow = (over = {}) => ({
    id: 5,
    attendance_id: 1,
    rel_path: 'user-1/2026-06-12 Oslo - Gojira/VID_1.mp4',
    filename: 'VID_1.mp4',
    kind: 'VIDEO',
    sha256: 'h5',
    bytes: 99999,
    width: 1920,
    height: 1080,
    duration_ms: 214000,
    caption: null,
    taken_at: null,
    band_id: 92,
    song: null,
    attendance_rel: {
      wishlist_rel: { user_id: 'user-1' },
      concert_rel: {
        id: 8417,
        concert_date: new Date('2026-06-12T19:00:00Z'),
        venue: 'Sentrum Scene',
        city: 'Oslo',
        country: 'NO',
        bands: [{ band_rel: { id: 92, name: 'Gojira' } }],
      },
    },
    ...over,
  });

  beforeEach(async () => {
    await mkdir(dirFor(), { recursive: true });
    prisma.concertMedia.update = vi.fn(async ({ data }) => ({ id: 5, ...data }));
    prisma.$transaction = vi.fn(async (fns) => Promise.all(fns.map((f) => (typeof f === 'function' ? f() : f))));
  });

  it('writes the song to Postgres and to the sidecar', async () => {
    prisma.concertMedia.findMany = vi.fn(async () => [videoRow()]);

    await request(app())
      .patch('/data/concerts/media')
      .set(...authHeader({ id: 'user-1' }))
      .send({ ids: [5], song: 'Stranded' })
      .expect(200);

    expect(prisma.concertMedia.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ song: 'Stranded' }) }),
    );
    const sidecar = JSON.parse(await readFile(join(dirFor(), 'concert-media.json'), 'utf8'));
    expect(sidecar.files[0]).toMatchObject({ name: 'VID_1.mp4', song: 'Stranded' });
  });

  it('trims the song and reads an empty one as no song at all', async () => {
    // The picker sends '' for "No song", and a name arriving with whitespace
    // would sort and compare as a different song from the same one typed clean.
    prisma.concertMedia.findMany = vi.fn(async () => [videoRow({ song: 'Stranded' })]);

    await request(app())
      .patch('/data/concerts/media')
      .set(...authHeader({ id: 'user-1' }))
      .send({ ids: [5], song: '   ' })
      .expect(200);

    expect(prisma.concertMedia.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ song: null }) }),
    );
  });

  it('refuses a song on a photograph', async () => {
    // A still is not "of" a song the way a recording of one is, and allowing
    // it would put a song label on the hundreds of photos in a festival import.
    prisma.concertMedia.findMany = vi.fn(async () => [
      videoRow({ kind: 'PHOTO', filename: 'IMG_1.jpg', rel_path: 'user-1/2026-06-12 Oslo - Gojira/IMG_1.jpg' }),
    ]);

    const res = await request(app())
      .patch('/data/concerts/media')
      .set(...authHeader({ id: 'user-1' }))
      .send({ ids: [5], song: 'Stranded' })
      .expect(400);

    // Asserted on the message, not just the status: an unrecognised `song` key
    // already 400s as "Nothing to change", so a status-only check here passed
    // before any of this was implemented.
    expect(res.body.error).toMatch(/video/i);
    expect(prisma.concertMedia.update).not.toHaveBeenCalled();
  });

  it('refuses a song on a video with no band to hang it on', async () => {
    // "Stranded" on a four-act festival day names nobody: the same song title
    // can appear on two bills, and the band view is what a song is read under.
    prisma.concertMedia.findMany = vi.fn(async () => [videoRow({ band_id: null })]);

    const res = await request(app())
      .patch('/data/concerts/media')
      .set(...authHeader({ id: 'user-1' }))
      .send({ ids: [5], song: 'Stranded' })
      .expect(400);

    expect(res.body.error).toMatch(/band/i);
    expect(prisma.concertMedia.update).not.toHaveBeenCalled();
  });

  it('accepts a song and the band it belongs to in one request', async () => {
    // Tagging an untagged video is one action in the lightbox, so the band
    // arriving in the same patch has to satisfy the has-a-band rule above.
    prisma.concertMedia.findMany = vi.fn(async () => [videoRow({ band_id: null })]);

    await request(app())
      .patch('/data/concerts/media')
      .set(...authHeader({ id: 'user-1' }))
      .send({ ids: [5], band_id: 92, song: 'Stranded' })
      .expect(200);

    expect(prisma.concertMedia.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ band_id: 92, song: 'Stranded' }) }),
    );
  });

  it('drops the song when the band it belonged to is cleared', async () => {
    // Untagging the band leaves a song with no artist — the exact state the
    // rule above refuses to create, so it must not be reachable by this route
    // either. The sidecar is the record of truth, so it has to forget it too.
    prisma.concertMedia.findMany = vi.fn(async () => [videoRow({ song: 'Stranded' })]);

    await request(app())
      .patch('/data/concerts/media')
      .set(...authHeader({ id: 'user-1' }))
      .send({ ids: [5], band_id: null })
      .expect(200);

    expect(prisma.concertMedia.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ band_id: null, song: null }) }),
    );
    const sidecar = JSON.parse(await readFile(join(dirFor(), 'concert-media.json'), 'utf8'));
    expect(sidecar.files[0]).toMatchObject({ name: 'VID_1.mp4', song: null });
  });
});

describe('DELETE /media/:id', () => {
  it('removes the row, the sidecar entry and the file together', async () => {
    // All three or none. A row without a file is a broken tile; a file without
    // a row is invisible until the next rebuild.
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
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
      .set(...authHeader(admin))
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
      .set(...authHeader(admin))
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

describe('a byte route answering 404', () => {
  it('does not tell the browser to cache the miss for a year', async () => {
    // Cache-Control was set before res.sendFile, so it was still on the
    // response when the ENOENT callback answered 404. The share dropping or
    // remounting late after a container restart made every tile the user
    // looked at 404 — and immutable for twelve months, so they stayed broken
    // after the share came back. Only a hard reload could fix it.
    prisma.concertMedia.findUnique = vi.fn(async () => ({
      id: 5, rel_path: 'user-1/show/gone.jpg', kind: 'PHOTO', sha256: 'h5',
      attendance_rel: { wishlist_rel: { user_id: 'user-1' } },
    }));

    const token = signMediaToken({ mediaId: 5, userId: 'user-1' });
    const res = await request(app())
      .get(`/data/concerts/media/5/file?t=${encodeURIComponent(token)}`)
      .expect(404);

    expect(res.headers['cache-control'] ?? '').not.toMatch(/immutable/);
  });
});

describe('GET /media/:id/play', () => {
  // The archive holds phone originals and they are not viewing copies: one
  // night's clips measured 43 Mbit/s of 4K HEVC, a gigabyte for three and a
  // half minutes, which no browser streams over a home connection and which
  // Firefox cannot decode at all. A rendition service writes `.web/<name>.mp4`
  // beside the original, and existence is the entire record of it — no column,
  // no sidecar entry, nothing that can fall out of step.
  const uploadClip = async () => {
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .attach('files', Buffer.from('original bytes'), 'VID_1.mp4')
      .expect(201);
    prisma.concertMedia.findUnique = vi.fn(async () => ({
      id: 1, kind: 'VIDEO', sha256: 'h1', filename: 'VID_1.mp4',
      rel_path: 'user-1/2026-06-12 Oslo - Gojira/VID_1.mp4',
      attendance_rel: { wishlist_rel: { user_id: 'user-1' } },
    }));
    return join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');
  };

  const tok = () => signMediaToken({ mediaId: 1, userId: 'user-1' });

  it('serves the original when no rendition has been made yet', async () => {
    // Which is what happened before renditions existed at all. A missing one is
    // an ordinary state, not a failure.
    await uploadClip();
    const res = await bytesOf(request(app()).get(`/data/concerts/media/1/play?t=${tok()}`)).expect(200);
    expect(res.body).toBe('original bytes');
  });

  it('serves the rendition once one is there', async () => {
    const dir = await uploadClip();
    await mkdir(join(dir, '.web'), { recursive: true });
    await writeFile(join(dir, '.web', 'VID_1.mp4.mp4'), 'rendition bytes');

    const res = await bytesOf(request(app()).get(`/data/concerts/media/1/play?t=${tok()}`)).expect(200);
    expect(res.body).toBe('rendition bytes');
    // Not mime-types' application/mp4, which a browser tab opened straight on
    // a share link can offer as a download instead of playing.
    expect(res.headers['content-type']).toMatch(/^video\/mp4/);
  });

  it('leaves /file on the archive master, so a download is never the rendition', async () => {
    // The whole premise of the archive is that the original is what is kept.
    const dir = await uploadClip();
    await mkdir(join(dir, '.web'), { recursive: true });
    await writeFile(join(dir, '.web', 'VID_1.mp4.mp4'), 'rendition bytes');

    const res = await bytesOf(request(app()).get(`/data/concerts/media/1/file?t=${tok()}`)).expect(200);
    expect(res.body).toBe('original bytes');
  });

  it('does not let the browser keep the original for a year', async () => {
    // /play answers from the same URL before and after the service reaches a
    // clip, so an immutable original would hide the rendition behind a cache
    // entry nothing can invalidate.
    await uploadClip();
    const res = await request(app()).get(`/data/concerts/media/1/play?t=${tok()}`).expect(200);
    expect(res.headers['cache-control']).toBe('private, max-age=300');
  });

  it('marks a rendition immutable, there being nothing left to supersede it', async () => {
    const dir = await uploadClip();
    await mkdir(join(dir, '.web'), { recursive: true });
    await writeFile(join(dir, '.web', 'VID_1.mp4.mp4'), 'rendition bytes');

    const res = await request(app()).get(`/data/concerts/media/1/play?t=${tok()}`).expect(200);
    expect(res.headers['cache-control']).toMatch(/immutable/);
  });

  it('never looks for a rendition of a photograph', async () => {
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(201);
    prisma.concertMedia.findUnique = vi.fn(async () => ({
      id: 1, kind: 'PHOTO', sha256: 'h1', filename: 'IMG_1.jpg',
      rel_path: 'user-1/2026-06-12 Oslo - Gojira/IMG_1.jpg',
      attendance_rel: { wishlist_rel: { user_id: 'user-1' } },
    }));

    const res = await request(app()).get(`/data/concerts/media/1/play?t=${tok()}`).expect(200);
    expect(res.headers['content-type']).toMatch(/image\/jpeg/);
    // And it is cached as hard as /file is: a photograph has no better copy
    // coming.
    expect(res.headers['cache-control']).toMatch(/immutable/);
  });

  it('carries its own auth and refuses a token for another file', async () => {
    await uploadClip();
    const t = signMediaToken({ mediaId: 999, userId: 'user-1' });
    await request(app()).get(`/data/concerts/media/1/play?t=${t}`).expect(401);
  });
});

describe('GET /media/:id/thumb', () => {
  it('generates the thumbnail on a cache miss rather than 404ing', async () => {
    // The cache directory is safe to delete at any time precisely because of
    // this. It is also what lets the upload skip thumbnails on failure.
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
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

  it('serves the stored poster for a video, even though it lives under a dot-directory', async () => {
    // Posters live at <show>/.posters/<name>.webp. `send` refuses dotfiles by
    // default, so this is the case that shipped broken: every video tile was
    // a permanent placeholder even with a poster sitting right there on disk.
    const poster = await (await import('sharp')).default(
      { create: { width: 1920, height: 1080, channels: 3, background: '#222' } }).jpeg().toBuffer();

    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .field('band_id', '92')
      .attach('files', Buffer.from('fake mp4'), { filename: 'VID_1.mp4', contentType: 'video/mp4' })
      .attach('posters', poster, { filename: 'VID_1.mp4.webp', contentType: 'image/webp' })
      .expect(201);

    const created = prisma.concertMedia.create.mock.calls[0][0].data;
    prisma.concertMedia.findUnique = vi.fn(async () => ({
      id: 1, kind: 'VIDEO', sha256: created.sha256, filename: 'VID_1.mp4',
      rel_path: created.rel_path,
      attendance_rel: { wishlist_rel: { user_id: 'user-1' } },
    }));

    const t = signMediaToken({ mediaId: 1, userId: 'user-1' });
    const res = await request(app()).get(`/data/concerts/media/1/thumb?t=${t}`).expect(200);
    expect(res.headers['content-type']).toMatch(/image\/webp/);
  });

  it('answers 404 for a video whose poster extraction failed in the browser', async () => {
    await request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .field('band_id', '92')
      .attach('files', Buffer.from('fake mp4'), { filename: 'VID_1.mp4', contentType: 'video/mp4' })
      .expect(201);

    const created = prisma.concertMedia.create.mock.calls[0][0].data;
    prisma.concertMedia.findUnique = vi.fn(async () => ({
      id: 1, kind: 'VIDEO', sha256: created.sha256, filename: 'VID_1.mp4',
      rel_path: created.rel_path,
      attendance_rel: { wishlist_rel: { user_id: 'user-1' } },
    }));

    const t = signMediaToken({ mediaId: 1, userId: 'user-1' });
    await request(app()).get(`/data/concerts/media/1/thumb?t=${t}`).expect(404);
  });

  it('does not answer 404 for a row whose path escapes the archive', async () => {
    // A no-poster video and an archive-escape refusal must never look the
    // same to the client: one is an expected placeholder, the other is the
    // single most important thing this route can detect. Both threw from
    // inside the same try before this was fixed, and both came back 404.
    prisma.concertMedia.findUnique = vi.fn(async () => ({
      id: 1, kind: 'PHOTO', sha256: 'h1', filename: 'passwd',
      rel_path: '../../../../../../etc/passwd',
      attendance_rel: { wishlist_rel: { user_id: 'user-1' } },
    }));

    const t = signMediaToken({ mediaId: 1, userId: 'user-1' });
    const res = await request(app()).get(`/data/concerts/media/1/thumb?t=${t}`);
    expect(res.status).not.toBe(404);
  });
});

describe('the byte routes under conditions the archive really meets', () => {
  const point = (row) => {
    prisma.concertMedia.findUnique = vi.fn(async () => ({
      id: 1, attendance_rel: { wishlist_rel: { user_id: 'user-1' } }, ...row,
    }));
  };
  const tok = () => signMediaToken({ mediaId: 1, userId: 'user-1' });

  it('survives a client that hangs up in the middle of a download', async () => {
    // This crashed the whole API before the headersSent guard. send reports a
    // hang-up as "Request aborted" through the sendFile callback, which fires
    // after the headers are already on the wire; answering it with fail()
    // threw ERR_HTTP_HEADERS_SENT from inside send's own callback, where no
    // try/catch is left to see it, and index.js meets uncaughtException with
    // process.exit(1). Closing a tab during playback was enough to do it.
    // The body has to be bigger than one chunk or the abort lands after the
    // response has already finished and nothing is exercised.
    const dir = join(root, 'archive', 'user-1', 'show');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'big.bin'), Buffer.alloc(6 * 1024 * 1024, 7));
    point({ kind: 'PHOTO', sha256: 'h1', filename: 'big.bin', rel_path: 'user-1/show/big.bin' });

    const uncaught = [];
    const onUncaught = (e) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const http = await import('node:http');
    const server = app().listen(0);
    const { port } = server.address();
    await new Promise((resolve) => {
      const req = http.get({ port, path: `/data/concerts/media/1/file?t=${tok()}` }, (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', () => resolve());
    });
    await new Promise((r) => { setTimeout(r, 300); });
    process.off('uncaughtException', onUncaught);
    server.close();
    vi.restoreAllMocks();

    expect(uncaught.map((e) => e.code)).toEqual([]);
  });

  it('serves a file even when the archive sits under a hidden directory', async () => {
    // send tests every segment of the absolute path for a leading dot when no
    // `root` option is given, so one hidden directory anywhere in MEDIA_ROOT
    // used to 404 every download in the archive — not just the posters this
    // was first noticed on. resolveArchivePath has already confined the path
    // by then, so the check guards nothing and only breaks such a deploy.
    const dotted = join(root, '.appdata');
    process.env.MEDIA_ROOT = dotted;
    const dir = join(dotted, 'archive', 'user-1', 'show');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.jpg'), jpeg());
    point({ kind: 'PHOTO', sha256: 'h1', filename: 'a.jpg', rel_path: 'user-1/show/a.jpg' });

    const res = await request(app()).get(`/data/concerts/media/1/file?t=${tok()}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/jpeg/);
  });

  it('calls a photo whose original has gone missing a 404, like the file route does', async () => {
    // An original that is not there is ordinary archive drift, not a fault.
    // sharp answers it with "Input file is missing: <absolute path>", which
    // carries no ENOENT code, so it used to reach the outer catch as a 500 —
    // logging noise in production and the container's real path in the
    // response anywhere else.
    point({ kind: 'PHOTO', sha256: 'h1', filename: 'gone.jpg', rel_path: 'user-1/show/gone.jpg' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app()).get(`/data/concerts/media/1/thumb?t=${tok()}`);

    expect(res.status).toBe(404);
    expect(res.text).toBe('');
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('refuses an id that is not written the way the router writes it', async () => {
    point({ kind: 'PHOTO', sha256: 'h1', filename: 'a.jpg', rel_path: 'user-1/show/a.jpg' });
    await request(app()).get(`/data/concerts/media/01/file?t=${tok()}`).expect(400);
  });
});

describe('an upload that collides with the archive\'s own bookkeeping', () => {
  it('will not let a file named concert-media.json land on the sidecar', async () => {
    // A multipart part carries both its filename and its content type, and the
    // client picks both, so declaring image/jpeg over a part named
    // concert-media.json got past the MIME gate and wrote its bytes onto the
    // record of truth. `taken` is built from database rows and sidecar
    // entries, and the sidecar is not one of its own entries, so nothing
    // covered its name. In the ordering that actually runs, the sidecar write
    // at the end of the batch put valid JSON back over the photo, so it was
    // the user's file that vanished while a row and an entry both went on
    // pointing at it; a different ordering loses the sidecar instead.
    const dir = join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');
    await request(app()).post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(201);
    prisma.concertMedia.findMany = vi.fn(async () => [{ filename: 'IMG_1.jpg' }]);

    await request(app()).post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .attach('files', jpeg(), { filename: 'concert-media.json', contentType: 'image/jpeg' })
      .expect(201);

    const stored = prisma.concertMedia.create.mock.calls.at(-1)[0].data;
    expect(stored.filename).toBe('concert-media (2).json');
    // The sidecar is still the sidecar, and still knows about both files.
    const sidecar = JSON.parse(await readFile(join(dir, 'concert-media.json'), 'utf8'));
    expect(sidecar.files.map((f) => f.name).sort())
      .toEqual(['IMG_1.jpg', 'concert-media (2).json']);
    // And the uploaded bytes are still a JPEG, at the name the row claims.
    const bytes = await readFile(join(dir, 'concert-media (2).json'));
    expect(bytes.slice(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });
});

describe('sharing one file by public link', () => {
  // A stateful stand-in for the MediaShareLink table: every behaviour here is
  // about what one call leaves behind for the next — the same link handed back
  // twice, a revoke that kills it, a reshare that mints a fresh one.
  let links;
  const owned = {
    id: 1, kind: 'PHOTO', sha256: 'h1', filename: 'IMG_1.jpg',
    rel_path: 'user-1/2026-06-12 Oslo - Gojira/IMG_1.jpg',
    attendance_rel: { wishlist_rel: { user_id: 'user-1' } },
  };
  const user = { id: 'user-1', role: 'USER' };

  beforeEach(() => {
    links = [];
    prisma.concertMedia.findUnique = vi.fn(async () => owned);
    prisma.mediaShareLink = {
      // Matches on the range as the real query does: `start_ms: null` in a
      // Prisma where is IS NULL, so a whole-file link and a moment never meet.
      findFirst: vi.fn(async ({ where }) => links
        .filter((l) => l.media_id === where.media_id && l.revoked_at === null
          && l.expires_at > where.expires_at.gt
          && l.start_ms === where.start_ms && l.end_ms === where.end_ms)
        .sort((a, b) => b.created_at - a.created_at)[0] ?? null),
      findMany: vi.fn(async ({ where }) => links
        .filter((l) => l.media_id === where.media_id && l.revoked_at === null)),
      create: vi.fn(async ({ data }) => {
        const link = {
          id: links.length + 1, created_at: new Date(), revoked_at: null, start_ms: null, end_ms: null, ...data,
        };
        links.push(link);
        return link;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const hit = links.filter((l) => l.media_id === where.media_id && l.revoked_at === null);
        hit.forEach((l) => Object.assign(l, data));
        return { count: hit.length };
      }),
      findUnique: vi.fn(async ({ where }) => links.find((l) => l.token === where.token) ?? null),
    };
  });

  const share = (as = user) => request(app())
    .post('/data/concerts/media/1/share')
    .set(...authHeader(as));
  const revoke = (as = user) => request(app())
    .delete('/data/concerts/media/1/share')
    .set(...authHeader(as));
  const tokenOf = (res) => res.body.data.url.split('/').pop();

  describe('POST /media/:id/share', () => {
    it('refuses an unauthenticated caller', async () => {
      await request(app()).post('/data/concerts/media/1/share').expect(401);
    });

    it('refuses a file that belongs to someone else', async () => {
      await share({ id: 'someone-else', role: 'USER' }).expect(403);
      expect(prisma.mediaShareLink.create).not.toHaveBeenCalled();
    });

    it('answers 404 for a file that does not exist', async () => {
      prisma.concertMedia.findUnique = vi.fn(async () => null);
      await share().expect(404);
    });

    it('lets a plain user share their own file, with a link that lasts 12 hours', async () => {
      // Tagging and deleting are open to every signed-in user; only uploading
      // is admin-only. Sharing belongs with the former.
      const before = Date.now();
      const res = await share().expect(200);

      expect(res.body.data.url).toMatch(/^https:\/\/api\.example\.com\/data\/concerts\/media\/share\/[A-Za-z0-9_-]{32}$/);
      const ttl = new Date(res.body.data.expires_at).getTime() - before;
      expect(ttl).toBeGreaterThan(12 * 60 * 60 * 1000 - 5000);
      expect(ttl).toBeLessThanOrEqual(12 * 60 * 60 * 1000 + 5000);
    });

    it('hands back the same link while it is live, rather than minting a second', async () => {
      const first = await share().expect(200);
      const second = await share().expect(200);

      expect(second.body.data.url).toBe(first.body.data.url);
      expect(prisma.mediaShareLink.create).toHaveBeenCalledTimes(1);
    });

    it('mints a fresh link after the last one was revoked', async () => {
      const first = await share().expect(200);
      await revoke().expect(204);
      const second = await share().expect(200);

      expect(tokenOf(second)).not.toBe(tokenOf(first));
    });
  });

  describe('DELETE /media/:id/share', () => {
    it('refuses an unauthenticated caller', async () => {
      await request(app()).delete('/data/concerts/media/1/share').expect(401);
    });

    it('refuses a file that belongs to someone else, and revokes nothing', async () => {
      await share().expect(200);
      await revoke({ id: 'someone-else', role: 'USER' }).expect(403);
      expect(prisma.mediaShareLink.updateMany).not.toHaveBeenCalled();
    });

    it('is a quiet no-op when there is nothing live to revoke', async () => {
      await revoke().expect(204);
      await revoke().expect(204);
    });
  });

  describe('GET /media/share/:token', () => {
    const uploadPhoto = () => request(app())
      .post('/data/concerts/attendances/1/media')
      .set(...authHeader(admin))
      .attach('files', jpeg(), 'IMG_1.jpg')
      .expect(201);

    it('serves the photo to a request with no Authorization header at all', async () => {
      // The whole point: the recipient has no account.
      await uploadPhoto();
      const token = tokenOf(await share().expect(200));

      const res = await request(app()).get(`/data/concerts/media/share/${token}`).expect(200);
      expect(res.headers['content-type']).toMatch(/image\/jpeg/);
    });

    it('serves a video\'s web rendition rather than the archive master', async () => {
      // A browser pointed straight at the link has to be able to play it, and
      // a 4K HEVC original is exactly what Firefox cannot.
      await request(app())
        .post('/data/concerts/attendances/1/media')
        .set(...authHeader(admin))
        .attach('files', Buffer.from('original bytes'), 'VID_1.mp4')
        .expect(201);
      prisma.concertMedia.findUnique = vi.fn(async () => ({
        ...owned, kind: 'VIDEO', filename: 'VID_1.mp4',
        rel_path: 'user-1/2026-06-12 Oslo - Gojira/VID_1.mp4',
      }));
      const dir = join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira');
      await mkdir(join(dir, '.web'), { recursive: true });
      await writeFile(join(dir, '.web', 'VID_1.mp4.mp4'), 'rendition bytes');
      const token = tokenOf(await share().expect(200));

      const res = await bytesOf(request(app()).get(`/data/concerts/media/share/${token}`)).expect(200);
      expect(res.body).toBe('rendition bytes');
    });

    it('tells the browser not to keep a copy, so a revoke is not undone by its cache', async () => {
      await uploadPhoto();
      const token = tokenOf(await share().expect(200));

      const res = await request(app()).get(`/data/concerts/media/share/${token}`).expect(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
    });

    it('answers 404 for a token that was never issued', async () => {
      await request(app()).get('/data/concerts/media/share/not-a-real-token').expect(404);
    });

    it('answers 404, not 403, once the link has been revoked', async () => {
      // A 403 would confirm the token had once been real.
      await uploadPhoto();
      const token = tokenOf(await share().expect(200));
      await revoke().expect(204);

      await request(app()).get(`/data/concerts/media/share/${token}`).expect(404);
    });

    it('answers 404 once the link has expired, with no revoke needed', async () => {
      await uploadPhoto();
      links.push({
        id: 99, media_id: 1, token: 'expired-token', created_at: new Date(Date.now() - 13 * 3600e3),
        expires_at: new Date(Date.now() - 3600e3), revoked_at: null,
      });

      await request(app()).get('/data/concerts/media/share/expired-token').expect(404);
    });

    it('answers 404 when the file behind a live link has since been deleted', async () => {
      await uploadPhoto();
      const token = tokenOf(await share().expect(200));
      prisma.concertMedia.findUnique = vi.fn(async () => null);

      await request(app()).get(`/data/concerts/media/share/${token}`).expect(404);
    });
  });

  describe('a moment of a video', () => {
    const clipRow = {
      ...owned, kind: 'VIDEO', filename: 'VID_1.mp4', duration_ms: 240_000,
      rel_path: 'user-1/2026-06-12 Oslo - Gojira/VID_1.mp4',
    };
    const clipsDir = () => join(root, 'cache', 'clips');
    const shareMoment = (range) => request(app())
      .post('/data/concerts/media/1/share')
      .set(...authHeader(user))
      .send(range);
    const open = (token) => request(app()).get(`/data/concerts/media/share/${token}`);

    beforeEach(() => {
      prisma.concertMedia.findUnique = vi.fn(async () => clipRow);
    });

    it('asks the rendition service to cut it, and says it is on its way', async () => {
      const res = await shareMoment({ start_ms: 83_000, end_ms: 101_000 }).expect(200);

      expect(res.body.data).toMatchObject({ start_ms: 83_000, end_ms: 101_000, status: 'preparing' });
      const id = links.at(-1).id;
      const written = JSON.parse(await readFile(join(clipsDir(), `${id}.json`), 'utf8'));
      expect(written).toMatchObject({
        id, rel_path: clipRow.rel_path, start_ms: 83_000, end_ms: 101_000,
      });
    });

    it('names the cut by the link\'s id and never writes its token to disk', async () => {
      // The token is the credential; the cache is a directory anyone on the
      // box can list.
      const res = await shareMoment({ start_ms: 83_000, end_ms: 101_000 }).expect(200);
      const token = tokenOf(res);

      const names = await readdir(clipsDir());
      const contents = await Promise.all(names.map((n) => readFile(join(clipsDir(), n), 'utf8')));
      expect([...names, ...contents].join('\n')).not.toContain(token);
    });

    it('hands back the same link for the same moment, and a new one for another', async () => {
      const first = await shareMoment({ start_ms: 83_000, end_ms: 101_000 }).expect(200);
      const again = await shareMoment({ start_ms: 83_000, end_ms: 101_000 }).expect(200);
      const other = await shareMoment({ start_ms: 150_000, end_ms: 160_000 }).expect(200);
      const whole = await share().expect(200);

      expect(tokenOf(again)).toBe(tokenOf(first));
      expect(new Set([first, other, whole].map(tokenOf)).size).toBe(3);
      expect(whole.body.data).toMatchObject({ start_ms: null, end_ms: null, status: 'ready' });
    });

    it('reports the moment ready once the service has cut it', async () => {
      await shareMoment({ start_ms: 83_000, end_ms: 101_000 }).expect(200);
      await writeFile(join(clipsDir(), `${links.at(-1).id}.mp4`), 'clip bytes');

      const res = await shareMoment({ start_ms: 83_000, end_ms: 101_000 }).expect(200);
      expect(res.body.data.status).toBe('ready');
    });

    it('refuses a moment of a photograph', async () => {
      prisma.concertMedia.findUnique = vi.fn(async () => owned);
      const res = await shareMoment({ start_ms: 0, end_ms: 5000 }).expect(400);
      expect(res.body.error).toMatch(/only a video/i);
      expect(prisma.mediaShareLink.create).not.toHaveBeenCalled();
    });

    it('refuses a moment shorter than a second, or times that are not whole milliseconds', async () => {
      await shareMoment({ start_ms: 5000, end_ms: 5400 }).expect(400);
      await shareMoment({ start_ms: 1.5, end_ms: 5000 }).expect(400);
      await shareMoment({ start_ms: -1, end_ms: 5000 }).expect(400);
      expect(prisma.mediaShareLink.create).not.toHaveBeenCalled();
    });

    it('tells a recipient who is early to wait, without pretending the page is the clip', async () => {
      const token = tokenOf(await shareMoment({ start_ms: 83_000, end_ms: 101_000 }).expect(200));

      const res = await open(token).expect(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toMatch(/still being prepared/);
    });

    it('serves the cut, not the whole video, once it exists', async () => {
      const token = tokenOf(await shareMoment({ start_ms: 83_000, end_ms: 101_000 }).expect(200));
      await writeFile(join(clipsDir(), `${links.at(-1).id}.mp4`), 'just the moment');

      const res = await bytesOf(open(token)).expect(200);
      expect(res.body).toBe('just the moment');
      expect(res.headers['content-type']).toMatch(/video\/mp4/);
      expect(res.headers['cache-control']).toBe('private, no-store');
    });

    it('answers 404 for a moment ffmpeg refused, rather than a page promising it', async () => {
      const token = tokenOf(await shareMoment({ start_ms: 83_000, end_ms: 101_000 }).expect(200));
      await writeFile(join(clipsDir(), `${links.at(-1).id}.mp4.failed`), 'ffprobe exited 1');

      await open(token).expect(404);
    });

    it('asks for the cut again when cache/ has been cleared out from under it', async () => {
      const token = tokenOf(await shareMoment({ start_ms: 83_000, end_ms: 101_000 }).expect(200));
      const { rm } = await import('node:fs/promises');
      await rm(join(root, 'cache'), { recursive: true, force: true });

      await open(token).expect(503);
      expect(await readdir(clipsDir())).toEqual([`${links.at(-1).id}.json`]);
    });

    it('stops every link to the video on revoke, and deletes the cuts', async () => {
      const token = tokenOf(await shareMoment({ start_ms: 83_000, end_ms: 101_000 }).expect(200));
      await writeFile(join(clipsDir(), `${links.at(-1).id}.mp4`), 'just the moment');
      const whole = tokenOf(await share().expect(200));

      await revoke().expect(204);

      await open(token).expect(404);
      await open(whole).expect(404);
      expect(await readdir(clipsDir())).toEqual([]);
    });
  });
});
