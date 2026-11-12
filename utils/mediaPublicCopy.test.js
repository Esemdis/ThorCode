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

  it('never serves a file nobody planned to a request that joins another for a different source', async () => {
    // A rendition key is not a checksum: two rows with one sha256 share
    // web-<sha>.mp4 but each has its own rendition. A request joining one in
    // flight for the other row's clean file was handed its own source,
    // unplanned, GPS and all (round-2 review).
    const a = await sourceTho894('RA.jpg', minimalJpegTho894);
    const b = await sourceTho894('RB.jpg', jpegWithGpsTho894().jpeg);
    const [, fromB] = await Promise.all([
      ensurePublicCopy({ absPath: a, key: 'web-join.jpg' }),
      ensurePublicCopy({ absPath: b, key: 'web-join.jpg' }),
    ]);
    expect((await readFile(fromB)).includes(Buffer.from('SN-1234567890'))).toBe(false);
  });

  it('does not share a clean verdict between two renditions of one size written in the same millisecond', async () => {
    // A rendition key's stamp was size and mtime only, so the second file,
    // GPS and all, was served on the first one's `.clean` marker.
    const { jpeg } = jpegWithGpsTho894();
    const cleanBytes = applyPatches(jpeg, await planScrub(jpeg));
    const same = new Date('2026-06-12T20:00:00.000Z');
    const a = await sourceTho894('RENDITION_A.jpg', cleanBytes);
    const b = await sourceTho894('RENDITION_B.jpg', jpeg);
    await utimes(a, same, same);
    await utimes(b, same, same);

    expect(await ensurePublicCopy({ absPath: a, key: 'web-shared-ms.mp4' })).toBe(a);
    const served = await ensurePublicCopy({ absPath: b, key: 'web-shared-ms.mp4' });
    expect(served).not.toBe(b);
    expect((await readFile(served)).includes(Buffer.from('SN-1234567890'))).toBe(false);
  });

  it('plans a joining request\'s own file under a checksum key, rather than trusting the checksum', async () => {
    // A request that joined another in flight got its own path back on
    // "clean" without that file being looked at, not even its size; a file
    // that no longer matched its checksum went out raw.
    const { jpeg } = jpegWithGpsTho894();
    const cleanBytes = applyPatches(jpeg, await planScrub(jpeg));
    const a = await sourceTho894('MASTER_A.jpg', cleanBytes);
    const b = await sourceTho894('MASTER_B.jpg', jpeg);

    const [, served] = await Promise.all([
      ensurePublicCopy({ absPath: a, key: 'cafe-join.jpg', keyedByContent: true }),
      ensurePublicCopy({ absPath: b, key: 'cafe-join.jpg', keyedByContent: true }),
    ]);
    expect((await readFile(served)).includes(Buffer.from('SN-1234567890'))).toBe(false);
  });

  // The clean marker held only the version and the size, so under one
  // checksum key row A's "clean" let row B's same-size file go out unplanned
  // once B's bytes no longer matched the checksum (THO-894 review, round 4).
  it('does not let one row\'s clean verdict under a checksum key send another row\'s file unplanned', async () => {
    const { jpeg } = jpegWithGpsTho894();
    const cleanBytes = applyPatches(jpeg, await planScrub(jpeg));
    const a = await sourceTho894('MASTER_CA.jpg', cleanBytes);
    const b = await sourceTho894('MASTER_CB.jpg', jpeg);

    expect(await ensurePublicCopy({ absPath: a, key: 'cafe-clean.jpg', keyedByContent: true })).toBe(a);
    const served = await ensurePublicCopy({ absPath: b, key: 'cafe-clean.jpg', keyedByContent: true });
    expect((await readFile(served)).includes(Buffer.from('SN-1234567890'))).toBe(false);
  });

  // One marker per key held one verdict, so two rows with the same bytes
  // overwrote each other's "clean" and every request re-planned the file.
  it('keeps each row\'s clean verdict under a shared checksum key, rather than one overwriting the other', async () => {
    const a = await sourceTho894('MASTER_DA.jpg', minimalJpegTho894);
    const b = await sourceTho894('MASTER_DB.jpg', minimalJpegTho894);

    expect(await ensurePublicCopy({ absPath: a, key: 'cafe-dup.jpg', keyedByContent: true })).toBe(a);
    expect(await ensurePublicCopy({ absPath: b, key: 'cafe-dup.jpg', keyedByContent: true })).toBe(b);

    const verdicts = (await readFile(join(publicDirTho894(), 'cafe-dup.jpg.clean'), 'utf8')).split('\n').filter(Boolean);
    expect(verdicts).toHaveLength(2);
    // And a third request finds its own verdict: nothing new is written.
    await ensurePublicCopy({ absPath: a, key: 'cafe-dup.jpg', keyedByContent: true });
    expect((await readFile(join(publicDirTho894(), 'cafe-dup.jpg.clean'), 'utf8')).split('\n').filter(Boolean)).toEqual(verdicts);
  });

  // The master's verdict held only the size, so a file rewritten in place at
  // the same size kept its "clean" and went out unplanned.
  it('looks again at a master rewritten in place at the same size', async () => {
    const { jpeg } = jpegWithGpsTho894();
    const cleanBytes = applyPatches(jpeg, await planScrub(jpeg));
    const absPath = await sourceTho894('MASTER_RW.jpg', cleanBytes);
    expect(await ensurePublicCopy({ absPath, key: 'cafe-rw.jpg', keyedByContent: true })).toBe(absPath);

    await writeFile(absPath, jpeg);
    const later = new Date(Date.now() + 5000);
    await utimes(absPath, later, later);

    const served = await ensurePublicCopy({ absPath, key: 'cafe-rw.jpg', keyedByContent: true });
    expect((await readFile(served)).includes(Buffer.from('SN-1234567890'))).toBe(false);
  });

  // The check after the plan compared the stamp, which under a checksum key
  // is the size alone: a master rewritten at the same size while it was
  // being planned (clean bytes planned, GPS bytes served) went out raw.
  it('does not serve a master rewritten at the same size while it was being planned', async () => {
    const { jpeg } = jpegWithGpsTho894();
    const cleanBytes = applyPatches(jpeg, await planScrub(jpeg));
    const absPath = await sourceTho894('MASTER_RACE.jpg', cleanBytes);
    const realStat = fsPromises.stat;
    let statsTho894Race = 0;
    vi.spyOn(fsPromises, 'stat').mockImplementation(async (p, ...rest) => {
      if (p === absPath && ++statsTho894Race === 2) {
        // The second look is the one after the plan.
        await writeFile(absPath, jpeg);
        const later = new Date(Date.now() + 5000);
        await utimes(absPath, later, later);
      }
      return realStat(p, ...rest);
    });

    const served = await ensurePublicCopy({ absPath, key: 'cafe-race.jpg', keyedByContent: true }).catch((err) => err);

    if (served instanceof Error) expect(served.code).toBe('UNSCRUBBABLE');
    else expect((await readFile(served)).includes(Buffer.from('SN-1234567890'))).toBe(false);
    // And the next request plans the file as it is now.
    vi.restoreAllMocks();
    const next = await ensurePublicCopy({ absPath, key: 'cafe-race.jpg', keyedByContent: true });
    expect((await readFile(next)).includes(Buffer.from('SN-1234567890'))).toBe(false);
  });

  it('does not let one row\'s refusal under a checksum key refuse another row\'s file', async () => {
    // Same size, so only the marker naming its file tells the two apart. A's
    // first segment claims to run past the end of the file, which is refused.
    const broken = Buffer.from(minimalJpegTho894);
    broken.writeUInt16BE(0xffff, 4);
    const a = await sourceTho894('MASTER_RA.jpg', broken);
    const b = await sourceTho894('MASTER_RB.jpg', minimalJpegTho894);
    expect(await planScrub(minimalJpegTho894)).toEqual([]);

    await expect(ensurePublicCopy({ absPath: a, key: 'cafe-refused.jpg', keyedByContent: true }))
      .rejects.toMatchObject({ code: 'UNSCRUBBABLE' });
    expect(await ensurePublicCopy({ absPath: b, key: 'cafe-refused.jpg', keyedByContent: true })).toBe(b);
  });

  it('takes the copy back out when its file is deleted just as the copy lands', async () => {
    // The delete unlinks the source before it removes the copies, so a check
    // after the rename either sees the source gone or ran before the delete's
    // own removal, which then finds the copy.
    const { jpeg } = jpegWithGpsTho894();
    const absPath = await sourceTho894('IMG_R.jpg', jpeg);
    const realRename = fsPromises.rename;
    vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      await realRename(from, to);
      await fsPromises.unlink(absPath);
    });
    await expect(ensurePublicCopy({ absPath, key: 'del.jpg' })).rejects.toMatchObject({ code: 'NO_SOURCE' });
    expect(await readdir(publicDirTho894())).toEqual([]);
  });
});

describe('the cap on scrubs at once (THO-894)', () => {
  // Share links are unauthenticated, and each first request for a different
  // file reads and plans it whole, up to 256 MB, three times over. The album
  // limiter bounds the rate, not how many run at once. Blocked at the copy,
  // which only a real scrub reaches.
  async function blockedCopiesScrubCapTho894() {
    const realCopy = fsPromises.copyFile;
    const gate = {};
    gate.open = new Promise((resolve) => { gate.release = resolve; });
    let running = 0;
    const state = { started: 0, most: 0 };
    vi.spyOn(fsPromises, 'copyFile').mockImplementation(async (from, to) => {
      state.started += 1;
      running += 1;
      state.most = Math.max(state.most, running);
      await gate.open;
      running -= 1;
      return realCopy(from, to);
    });
    return { gate, state };
  }

  const settleScrubCapTho894 = () => new Promise((resolve) => { setTimeout(resolve, 50); });

  it('runs at most MAX_CONCURRENT_SCRUBS at once, and the rest in turn', async () => {
    const { MAX_CONCURRENT_SCRUBS } = require('./mediaPublicCopy.js');
    const { gate, state } = await blockedCopiesScrubCapTho894();
    const files = [];
    for (let i = 0; i < MAX_CONCURRENT_SCRUBS + 3; i++) {
      files.push(await sourceTho894(`CAP_${i}.jpg`, jpegWithGpsTho894().jpeg));
    }

    const all = Promise.all(files.map((absPath, i) => ensurePublicCopy({ absPath, key: `cap${i}.jpg` })));
    await settleScrubCapTho894();
    expect(state.started).toBe(MAX_CONCURRENT_SCRUBS);

    gate.release();
    const served = await all;
    expect(state.started).toBe(files.length);
    expect(state.most).toBe(MAX_CONCURRENT_SCRUBS);
    for (const p of served) expect((await readFile(p)).includes(Buffer.from('SN-1234567890'))).toBe(false);
  });

  // A copy already made is a stamp read and a stat; it must not queue behind
  // a stranger's cold scrubs.
  it('does not make a cached copy wait for a slot', async () => {
    const { MAX_CONCURRENT_SCRUBS } = require('./mediaPublicCopy.js');
    const warm = await sourceTho894('CAP_WARM.jpg', jpegWithGpsTho894().jpeg);
    const warmCopy = await ensurePublicCopy({ absPath: warm, key: 'capwarm.jpg' });

    const { gate } = await blockedCopiesScrubCapTho894();
    const cold = [];
    for (let i = 0; i < MAX_CONCURRENT_SCRUBS + 1; i++) {
      const absPath = await sourceTho894(`CAP_COLD_${i}.jpg`, jpegWithGpsTho894().jpeg);
      cold.push(ensurePublicCopy({ absPath, key: `capcold${i}.jpg` }));
    }
    await settleScrubCapTho894();

    expect(await ensurePublicCopy({ absPath: warm, key: 'capwarm.jpg' })).toBe(warmCopy);
    gate.release();
    await Promise.all(cold);
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
