import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { jpegWithGpsTho894, minimalJpegTho894 } from '../test/exifFixture.js';

// THO-894: the scrubbed copy a public route serves, cached like a thumbnail.

const require = createRequire(import.meta.url);
const { ensurePublicCopy } = require('./mediaPublicCopy.js');
const fsPromises = require('node:fs/promises');

let rootTho894;
const publicDirTho894 = () => join(rootTho894, 'cache', 'public');

beforeEach(async () => {
  rootTho894 = await mkdtemp(join(tmpdir(), 'public-copy-'));
  vi.stubEnv('MEDIA_ROOT', rootTho894);
});

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

    // Served from the cache: the source is not read again, which a source
    // gone missing proves.
    await fsPromises.unlink(absPath);
    expect(await ensurePublicCopy({ absPath, key: 'abc123.jpg' })).toBe(first);
    // And the original was never touched.
    expect(jpeg.includes(Buffer.from('SN-1234567890'))).toBe(true);
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

  it('refuses a file it cannot parse, and caches no verdict for it', async () => {
    const absPath = await sourceTho894('IMG_4.jpg', 'master bytes');
    await expect(ensurePublicCopy({ absPath, key: 'bad.jpg' })).rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
    expect(await readdir(rootTho894)).toEqual(['IMG_4.jpg']);
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
});
