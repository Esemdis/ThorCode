import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildApp, installFakePrisma } from '../../test/routeApp.js';
import { minimalJpegTho894 } from '../../test/exifFixture.js';

// THO-1003: how many full-size downloads one album share link, and one client,
// may hold open at once. Its own file because every case here keeps responses
// open on a real socket, which neither supertest's one-shot requests nor the
// fakes in mediaAlbum.test.js are built for.

const require = createRequire(import.meta.url);
// Spied on before the router is imported: bytes.js destructures it at load, so
// a spy installed afterwards would never be the function it calls. The spy is
// what holds a download open — /file waits on its scrubbed copy, and here that
// copy is a promise each test settles when it wants the response to end.
const publicCopyTho1003 = require('../../utils/mediaPublicCopy.js');
const ensurePublicCopySpyTho1003 = vi.spyOn(publicCopyTho1003, 'ensurePublicCopy');

const prisma = installFakePrisma({});
const router = (await import('./media.js')).default ?? (await import('./media.js'));

const albumTokenTho1003 = 'album-token-tho1003';
const otherAlbumTokenTho1003 = 'other-album-token-tho1003';

let root;
let server;
let baseUrl;
let mediaRowsTho1003;
let pendingCopiesTho1003;
let openRequestsTho1003;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'album-cap-'));
  process.env.MEDIA_ROOT = root;
  process.env.MEDIA_URL_SECRET = 'test-media-secret';

  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const links = [albumTokenTho1003, otherAlbumTokenTho1003].map((token, i) => ({
    id: i + 1, token, user_id: 'user-1', attendance_ids: [1], picks_only: false, revoked_at: null, expires_at: future,
  }));
  mediaRowsTho1003 = [];
  prisma.mediaAlbumShareLink = {
    findUnique: vi.fn(async ({ where }) => links.find((l) => l.token === where.token) ?? null),
  };
  prisma.concertMedia = {
    findUnique: vi.fn(async ({ where }) => mediaRowsTho1003.find((m) => m.id === where.id) ?? null),
  };

  // Every scrubbed copy asked for waits here until the test settles it.
  pendingCopiesTho1003 = [];
  ensurePublicCopySpyTho1003.mockImplementation(({ absPath }) => new Promise((resolve, reject) => {
    pendingCopiesTho1003.push({ resolve: () => resolve(absPath), reject });
  }));

  await photoInAlbumTho1003();

  // X-Forwarded-For is how each request here claims its own client address,
  // and Express only reads it with a proxy trusted — as index.js sets it.
  const app = buildApp(router, '/data/concerts');
  app.set('trust proxy', 1);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => { server.once('listening', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  openRequestsTho1003 = [];
});

afterEach(async () => {
  // Let every handler still waiting run to its end, then drop the sockets, so
  // nothing from this test is still in flight in the next.
  for (const copy of pendingCopiesTho1003) copy.resolve();
  for (const req of openRequestsTho1003) req.destroy();
  server.closeAllConnections();
  await new Promise((resolve) => { server.close(resolve); });
});

async function photoInAlbumTho1003({ id = 1, filename = 'IMG_1.jpg' } = {}) {
  const dir = join(root, 'archive', 'user-1', 'night');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), minimalJpegTho894);
  mediaRowsTho1003.push({
    id, attendance_id: 1, kind: 'PHOTO', filename, rel_path: `user-1/night/${filename}`, sha256: `sha${id}`,
    attendance_rel: { wishlist_rel: { user_id: 'user-1' } },
  });
}

/**
 * Starts a GET and hands back the pending response and a way to hang up.
 * `done` resolves with the status, headers and body once the response ends,
 * or with `{ aborted: true }` when the test hung up first.
 */
function getTho1003(path, ip) {
  let req;
  const done = new Promise((resolve) => {
    req = http.get(`${baseUrl}${path}`, { headers: { 'X-Forwarded-For': ip } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', () => resolve({ aborted: true }));
    });
    req.on('error', () => resolve({ aborted: true }));
  });
  openRequestsTho1003.push(req);
  return { done, abort: () => req.destroy() };
}

const fileUrlTho1003 = (token = albumTokenTho1003, id = 1) => `/data/concerts/album-shares/${token}/media/${id}/file`;

/**
 * A /file download that got past the cap and is now held open, waiting on its
 * scrubbed copy. Resolves once the handler has asked for that copy, so the
 * test knows the slot is taken before it starts the next request.
 */
async function heldDownloadTho1003(ip, token = albumTokenTho1003) {
  const asked = ensurePublicCopySpyTho1003.mock.calls.length;
  const download = getTho1003(fileUrlTho1003(token), ip);
  await vi.waitFor(() => expect(ensurePublicCopySpyTho1003.mock.calls.length).toBe(asked + 1));
  return { ...download, copy: pendingCopiesTho1003[pendingCopiesTho1003.length - 1] };
}

/**
 * Whether a /file download would be let in now: 'held' when it got past the
 * cap and is waiting on its copy (and is then held, like any other), or the
 * status it was answered with instead.
 */
async function tryDownloadTho1003(ip, token = albumTokenTho1003) {
  const asked = ensurePublicCopySpyTho1003.mock.calls.length;
  const download = getTho1003(fileUrlTho1003(token), ip);
  const started = vi.waitFor(() => {
    if (ensurePublicCopySpyTho1003.mock.calls.length <= asked) throw new Error('not yet');
  }, { timeout: 2000 }).then(() => 'held', () => 'neither');
  return Promise.race([started, download.done.then((r) => r.status)]);
}

describe('GET /album-shares/:token/media/:id/file, open at once', () => {
  it('refuses a fifth download of one album while four are open, before opening anything', async () => {
    // Four clients, so the per-IP cap is not what refuses the fifth.
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4']) {
      await heldDownloadTho1003(ip);
    }

    const fifth = await getTho1003(fileUrlTho1003(), '198.51.100.5').done;
    expect(fifth.status).toBe(429);
    expect(JSON.parse(fifth.body.toString())).toEqual({ error: expect.any(String) });
    // Refused before the handler named a file or asked for a copy of it.
    expect(fifth.headers['content-disposition']).toBeUndefined();
    expect(ensurePublicCopySpyTho1003).toHaveBeenCalledTimes(4);
  });

  it('refuses a fourth download from one client, even of another album', async () => {
    for (let i = 0; i < 3; i += 1) await heldDownloadTho1003('198.51.100.7');

    const fourth = await getTho1003(fileUrlTho1003(otherAlbumTokenTho1003), '198.51.100.7').done;
    expect(fourth.status).toBe(429);
    expect(fourth.headers['content-disposition']).toBeUndefined();

    // The album still has a slot, for someone else.
    expect(await tryDownloadTho1003('198.51.100.8')).toBe('held');
  });

  it('counts an IPv6 client by its /64, so a fresh address is not a fresh budget', async () => {
    for (let i = 1; i <= 3; i += 1) await heldDownloadTho1003(`2001:db8:0:1::${i}`);
    expect(await tryDownloadTho1003('2001:db8:0:1::99', otherAlbumTokenTho1003)).toBe(429);
  });

  it('frees the slot when a download finishes', async () => {
    const held = [];
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4']) {
      held.push(await heldDownloadTho1003(ip));
    }
    expect(await tryDownloadTho1003('198.51.100.5')).toBe(429);

    held[0].copy.resolve();
    const finished = await held[0].done;
    expect(finished.status).toBe(200);
    expect(Buffer.compare(finished.body, minimalJpegTho894)).toBe(0);

    expect(await tryDownloadTho1003('198.51.100.5')).toBe('held');
    // Freed once, not twice: 'finish' and 'close' both fired for it.
    expect(await tryDownloadTho1003('198.51.100.6')).toBe(429);
  });

  it('frees the slot when the client hangs up, even while the handler is still waiting', async () => {
    const held = [];
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4']) {
      held.push(await heldDownloadTho1003(ip));
    }

    held[0].abort();
    // The server learns of the hang-up asynchronously; until it does, a new
    // download is still refused, so ask until it is let in.
    await vi.waitFor(async () => {
      expect(await tryDownloadTho1003('198.51.100.5')).toBe('held');
    }, { timeout: 2000, interval: 20 });
    expect(await tryDownloadTho1003('198.51.100.6')).toBe(429);
  });

  it('frees the slot of a download answered 404', async () => {
    // A copy that cannot be scrubbed is refused with a 404 (THO-894).
    for (let i = 0; i < 3; i += 1) {
      const held = await heldDownloadTho1003('198.51.100.9');
      held.copy.reject(Object.assign(new Error('no'), { code: 'UNSCRUBBABLE' }));
      expect((await held.done).status).toBe(404);
    }
    expect(await tryDownloadTho1003('198.51.100.9')).toBe('held');
  });

  it('frees the slot of an unknown token, a file outside the album and a handler error', async () => {
    // More than the per-IP cap in a row from one client: each must give its
    // slot back, or the fourth would be a 429.
    for (let i = 0; i < 4; i += 1) {
      expect((await getTho1003(fileUrlTho1003('no-such-token'), '198.51.100.10').done).status).toBe(404);
      expect((await getTho1003(fileUrlTho1003(albumTokenTho1003, 77), '198.51.100.10').done).status).toBe(404);
    }
    prisma.concertMedia.findUnique.mockRejectedValue(new Error('database went away'));
    for (let i = 0; i < 4; i += 1) {
      expect((await getTho1003(fileUrlTho1003(), '198.51.100.10').done).status).toBe(500);
    }
  });

  it('never counts thumbnails or viewing copies', async () => {
    // The album's four slots and this client's three are all taken.
    for (const ip of ['198.51.100.11', '198.51.100.11', '198.51.100.11', '198.51.100.12']) {
      await heldDownloadTho1003(ip);
    }

    for (const which of ['thumb', 'view']) {
      for (let i = 0; i < 5; i += 1) {
        const res = await getTho1003(`/data/concerts/album-shares/${albumTokenTho1003}/media/1/${which}`, '198.51.100.11').done;
        expect(res.status).toBe(200);
      }
    }
    expect(ensurePublicCopySpyTho1003).toHaveBeenCalledTimes(4);
  });
});
