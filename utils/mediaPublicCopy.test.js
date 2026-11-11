import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import {
  mkdtemp, readdir, readFile, stat, utimes, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { jpegWithGpsTho894, minimalJpegTho894 } from '../test/exifFixture.js';

// THO-894: the scrubbed copy a public route serves, cached like a thumbnail.

const require = createRequire(import.meta.url);
const { ensurePublicCopy, removePublicCopies } = require('./mediaPublicCopy.js');
const { stalePublicTemps } = require('./mediaClips.js');
const { planScrub, applyPatches } = require('./mediaScrub.js');
const fsPromises = require('node:fs/promises');

let rootTho894;
const publicDirTho894 = () => join(rootTho894, 'cache', 'public');

beforeEach(async () => {
  rootTho894 = await mkdtemp(join(tmpdir(), 'public-copy-'));
  vi.stubEnv('MEDIA_ROOT', rootTho894);
});

// A spy left behind by a failing test would wrap the next test's spy.
afterEach(() => { vi.restoreAllMocks(); });

async function sourceTho894(name, bytes) {
  const p = join(rootTho894, name);
  await writeFile(p, bytes);
  return p;
}

describe('ensurePublicCopy', () => {
  it('makes the copy once and serves it from the cache after', async () => {
    const { jpeg } = jpegWithGpsTho894();
    const absPath = await sourceTho894('IMG_1.jpg', jpeg);

    const first = await ensurePublicCopy({ absPath, key: 'abc123.jpg' });
    expect(first).toBe(join(publicDirTho894(), 'abc123.jpg'));
    const copy = await readFile(first);
    expect(copy.length).toBe(jpeg.length);
    expect(copy.includes(Buffer.from('SN-1234567890'))).toBe(false);

    // Served from the cache: nothing is copied a second time.
    const copyFile = vi.spyOn(fsPromises, 'copyFile');
    expect(await ensurePublicCopy({ absPath, key: 'abc123.jpg' })).toBe(first);
    expect(copyFile).not.toHaveBeenCalled();
    copyFile.mockRestore();
    // And the original was never touched.
    expect((await readFile(absPath)).equals(jpeg)).toBe(true);
  });

  it('two first requests at once share one copy', async () => {
    const { jpeg } = jpegWithGpsTho894();
    const absPath = await sourceTho894('IMG_1.jpg', jpeg);
    const copy = vi.spyOn(fsPromises, 'copyFile');

    const [a, b] = await Promise.all([
      ensurePublicCopy({ absPath, key: 'same.jpg' }),
      ensurePublicCopy({ absPath, key: 'same.jpg' }),
    ]);
    expect(a).toBe(b);
    expect(copy).toHaveBeenCalledTimes(1);
    copy.mockRestore();
  });

  it('serves a clean file from source without copying it', async () => {
    const absPath = await sourceTho894('IMG_2.jpg', minimalJpegTho894);

    expect(await ensurePublicCopy({ absPath, key: 'clean.jpg' })).toBe(absPath);
    expect(await readdir(publicDirTho894())).toEqual(['clean.jpg.clean']);
    expect(await ensurePublicCopy({ absPath, key: 'clean.jpg' })).toBe(absPath);
  });

  it('looks again when the file behind a clean marker has changed', async () => {
    // A rendition can be made again under the same key, and the new one may
    // carry what the old one did not.
    const absPath = await sourceTho894('VID.jpg', minimalJpegTho894);
    await ensurePublicCopy({ absPath, key: 'web-h1.jpg' });
    const { jpeg } = jpegWithGpsTho894();
    await writeFile(absPath, jpeg);

    const served = await ensurePublicCopy({ absPath, key: 'web-h1.jpg' });
    expect(served).toBe(join(publicDirTho894(), 'web-h1.jpg'));
    expect((await readFile(served)).includes(Buffer.from('SN-1234567890'))).toBe(false);
  });

  it('never leaves a temp file behind on a failure', async () => {
    // Parses as a JPEG for the first plan and the copy, then the patch write
    // fails: what is left must be nothing, not a half-scrubbed copy.
    const { jpeg } = jpegWithGpsTho894();
    const absPath = await sourceTho894('IMG_3.jpg', jpeg);
    const realOpen = fsPromises.open;
    const spy = vi.spyOn(fsPromises, 'open').mockImplementation(async (p, flags) => {
      if (flags === 'r+') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return realOpen(p, flags);
    });

    await expect(ensurePublicCopy({ absPath, key: 'fails.jpg' })).rejects.toThrow('disk full');
    expect(await readdir(publicDirTho894())).toEqual([]);
    spy.mockRestore();
  });



  it('says NO_SOURCE for a file that is not there', async () => {
    await expect(ensurePublicCopy({ absPath: join(rootTho894, 'gone.jpg'), key: 'gone.jpg' }))
      .rejects.toMatchObject({ code: 'NO_SOURCE' });
  });

  it('refuses a key that could name a path outside the cache', async () => {
    const absPath = await sourceTho894('IMG_5.jpg', minimalJpegTho894);
    await expect(ensurePublicCopy({ absPath, key: '../escape.jpg' })).rejects.toThrow(/unsafe/);
    await expect(ensurePublicCopy({ absPath, key: '.hidden' })).rejects.toThrow(/unsafe/);
  });

  it('makes the copy again when the file behind it has changed', async () => {
    // A rendition is made again under the same web-<sha>.mp4 key. The cached
    // copy of the old one must not go on being served for it (THO-894 review).
    const first = jpegWithGpsTho894().jpeg;
    const absPath = await sourceTho894('VID_R.jpg', first);
    await ensurePublicCopy({ absPath, key: 'web-r1.jpg' });

    const second = jpegWithGpsTho894(minimalJpegTho894, { little: false }).jpeg;
    await writeFile(absPath, second);
    const later = new Date(Date.now() + 60_000);
    await utimes(absPath, later, later);

    const served = await ensurePublicCopy({ absPath, key: 'web-r1.jpg' });
    expect((await readFile(served)).equals(applyPatches(second, await planScrub(second)))).toBe(true);
  });

  it('looks again at a file an older scrubber called clean', async () => {
    // The marker a scrubber without a version wrote: size and mtime only. A
    // planner that has since learned to strip more must not trust it, or every
    // file already served keeps the old verdict until cache/public is emptied.
    const { jpeg } = jpegWithGpsTho894();
    const absPath = await sourceTho894('IMG_V.jpg', jpeg);
    const info = await stat(absPath);
    await fsPromises.mkdir(publicDirTho894(), { recursive: true });
    await writeFile(join(publicDirTho894(), 'v1.jpg.clean'), `${info.size}:${Math.trunc(info.mtimeMs)}`);

    const served = await ensurePublicCopy({ absPath, key: 'v1.jpg' });
    expect(served).toBe(join(publicDirTho894(), 'v1.jpg'));
    expect((await readFile(served)).includes(Buffer.from('SN-1234567890'))).toBe(false);
  });

  it('refuses a key that would name another key\'s marker', async () => {
    const absPath = await sourceTho894('IMG_6.jpg', minimalJpegTho894);
    await expect(ensurePublicCopy({ absPath, key: 'abc.jpg.clean' })).rejects.toThrow(/unsafe/);
    await expect(ensurePublicCopy({ absPath, key: 'abc.jpg.stamp' })).rejects.toThrow(/unsafe/);
  });

  it('removes the copies a deleted file left in the cache, and nothing else', async () => {
    // A scrubbed master is a full second copy of the file; with the row gone
    // no route can reach it, and nothing else would ever delete it.
    await fsPromises.mkdir(publicDirTho894(), { recursive: true });
    for (const name of ['abc123.mp4', 'abc123.mp4.stamp', 'web-abc123.mp4', 'web-abc123.mp4.clean', 'def456.jpg']) {
      await writeFile(join(publicDirTho894(), name), 'x');
    }
    await removePublicCopies({ sha256: 'abc123', rel_path: 'u/show/VID_1.MP4' });
    expect(await readdir(publicDirTho894())).toEqual(['def456.jpg']);
  });

  it('refuses a file it cannot parse, and remembers the refusal until the file changes', async () => {
    // Re-reading and re-planning a refused file on every request let a legal
    // but slow file (200 MB of stuffed scan, say) hold the loop each time.
    const absPath = await sourceTho894('IMG_4.jpg', 'master bytes');
    await expect(ensurePublicCopy({ absPath, key: 'bad.jpg' })).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
    expect(await readdir(publicDirTho894())).toEqual(['bad.jpg.refused']);
    await expect(ensurePublicCopy({ absPath, key: 'bad.jpg' }))
      .rejects.toMatchObject({ code: 'UNSCRUBBABLE', message: expect.stringMatching(/refused before/) });

    // The file replaced with one it can read: looked at again, and served.
    await writeFile(absPath, minimalJpegTho894);
    const later = new Date(Date.now() + 60_000);
    await utimes(absPath, later, later);
    expect(await ensurePublicCopy({ absPath, key: 'bad.jpg' })).toBe(absPath);
  });

  it('copies a file once for two rows with the same bytes, whose mtimes differ', async () => {
    // A master's key is its checksum, so two rows with one sha256 share it. A
    // stamp with the source's mtime made each request for the other row copy
    // the whole file again — for a video, on every Range request.
    const { jpeg } = jpegWithGpsTho894();
    const a = await sourceTho894('A.jpg', jpeg);
    const b = await sourceTho894('B.jpg', jpeg);
    const earlier = new Date(Date.now() - 86_400_000);
    await utimes(b, earlier, earlier);
    const copyFile = vi.spyOn(fsPromises, 'copyFile');
    for (let i = 0; i < 6; i += 1) {
      await ensurePublicCopy({ absPath: i % 2 ? b : a, key: 'deadbeef.jpg', keyedByContent: true });
    }
    expect(copyFile).toHaveBeenCalledTimes(1);
    copyFile.mockRestore();
  });

  it('serves each row its own source when shared bytes have nothing to strip', async () => {
    const a = await sourceTho894('CA.jpg', minimalJpegTho894);
    const b = await sourceTho894('CB.jpg', minimalJpegTho894);
    const [fromA, fromB] = await Promise.all([
      ensurePublicCopy({ absPath: a, key: 'cafe.jpg', keyedByContent: true }),
      ensurePublicCopy({ absPath: b, key: 'cafe.jpg', keyedByContent: true }),
    ]);
    expect([fromA, fromB]).toEqual([a, b]);
  });

  it('puts no copy back for a file deleted while its copy was being made', async () => {
    // DELETE /media removes the copies; a copy still in flight then renamed
    // itself into place after the delete and stayed for good.
    const { jpeg } = jpegWithGpsTho894();
    const absPath = await sourceTho894('IMG_D.jpg', jpeg);
    const realCopy = fsPromises.copyFile;
    const spy = vi.spyOn(fsPromises, 'copyFile').mockImplementation(async (from, to) => {
      await realCopy(from, to);
      await fsPromises.unlink(absPath);
    });
    await expect(ensurePublicCopy({ absPath, key: 'gone-mid.jpg' })).rejects.toMatchObject({ code: 'NO_SOURCE' });
    expect(await readdir(publicDirTho894())).toEqual([]);
    spy.mockRestore();
  });
});

describe('stalePublicTemps', () => {
  it('names the temp copies a crash left behind, and none still being written', () => {
    const now = Date.parse('2026-11-11T12:00:00Z');
    const day = 86_400_000;
    const entries = [
      { name: 'abc.mp4.123.5f0c3a3e-1d2b-4c5d-8e9f-0a1b2c3d4e5f.tmp', mtimeMs: now - 2 * day },
      { name: 'web-abc.mp4.9.0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d.tmp', mtimeMs: now - 60_000 },
      { name: 'abc.mp4', mtimeMs: now - 30 * day },
      { name: 'abc.mp4.stamp', mtimeMs: now - 30 * day },
    ];
    expect(stalePublicTemps(entries, now)).toEqual(['abc.mp4.123.5f0c3a3e-1d2b-4c5d-8e9f-0a1b2c3d4e5f.tmp']);
  });
});
