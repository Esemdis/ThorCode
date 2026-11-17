import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { mkdtemp, writeFile, access, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import sharp from 'sharp';
import {
  THUMB_WIDTH, DISPLAY_EDGE, ensureThumb, ensureDisplay, storePoster,
  MAX_CONCURRENT_RENDERS, MAX_REMEMBERED_FAILURES,
} from './mediaThumbs.js';
import { createRequire } from 'node:module';
import { posterPath } from './mediaPaths.js';

let root;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'thumbs-'));
  process.env.MEDIA_ROOT = root;
});

const aPhoto = async (name = 'a.jpg') => {
  const p = join(root, name);
  await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#334155' } })
    .jpeg().toFile(p);
  return p;
};

describe('ensureThumb for a photo', () => {
  it('writes a thumbnail at the checksum-keyed path', async () => {
    const out = await ensureThumb({ absPath: await aPhoto(), kind: 'PHOTO', sha256: 'abc' });
    expect(out).toBe(join(root, 'cache', 'thumbs', 'abc.webp'));
    await expect(access(out)).resolves.toBeUndefined();
  });

  it('downscales to the grid width rather than storing the original again', async () => {
    const out = await ensureThumb({ absPath: await aPhoto(), kind: 'PHOTO', sha256: 'abc' });
    expect((await sharp(out).metadata()).width).toBe(THUMB_WIDTH);
  });

  it('does not upscale a picture smaller than the grid', async () => {
    const small = join(root, 'small.jpg');
    await sharp({ create: { width: 100, height: 80, channels: 3, background: '#000' } })
      .jpeg().toFile(small);
    const out = await ensureThumb({ absPath: small, kind: 'PHOTO', sha256: 'small' });
    expect((await sharp(out).metadata()).width).toBe(100);
  });

  it('reuses an existing thumbnail instead of regenerating it', async () => {
    // Keyed by content hash, so an existing entry can never be stale for its
    // key. Regenerating would make every grid scroll a CPU burst.
    const p = await aPhoto();
    const first = await ensureThumb({ absPath: p, kind: 'PHOTO', sha256: 'abc' });
    const { mtimeMs } = await (await import('node:fs/promises')).stat(first);
    await ensureThumb({ absPath: p, kind: 'PHOTO', sha256: 'abc' });
    expect((await (await import('node:fs/promises')).stat(first)).mtimeMs).toBe(mtimeMs);
  });

  it('creates the cache directory the first time', async () => {
    await ensureThumb({ absPath: await aPhoto(), kind: 'PHOTO', sha256: 'abc' });
    expect(await readdir(join(root, 'cache', 'thumbs'))).toEqual(['abc.webp']);
  });

  it('leaves nothing servable at the final path when the source is not an image', async () => {
    // This does NOT exercise temp-file cleanup: sharp rejects invalid input
    // before writing anything, so rename is never reached and no temp file
    // ever exists here for the cleanup code to remove. What it does pin is
    // that a failed conversion never leaves something servable at the final
    // path — a half-written thumbnail would be served forever, since the
    // cache never re-checks a key it already has. See "writeWebp cleanup on
    // failure" below for a test that actually forces rename to fail.
    const junk = join(root, 'junk.jpg');
    await writeFile(junk, 'not an image');
    await expect(ensureThumb({ absPath: junk, kind: 'PHOTO', sha256: 'junk' })).rejects.toThrow();
    await expect(access(join(root, 'cache', 'thumbs', 'junk.webp'))).rejects.toThrow();
  });
});

describe('writeWebp cleanup on failure', () => {
  const rel = 'user-1/2026-06-12 Oslo - Gojira/VID_1.mp4';

  const aFrame = () => sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#7c2d5c' } })
    .jpeg().toBuffer();

  it('deletes the temp file when the rename to the final path fails', async () => {
    // Unlike the junk-source case above, this needs sharp to succeed and a
    // real temp file to exist before the failure hits, so rename onto an
    // existing non-empty directory is used to force it: a file can replace a
    // file, but never a directory, regardless of whether that directory is
    // empty.
    const target = posterPath(rel);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'occupied'), '');

    await expect(storePoster({ relPath: rel, source: await aFrame() })).rejects.toThrow();

    // Checked by suffix rather than by exact name, since the temp name now
    // carries a random nonce.
    const leftovers = await readdir(dirname(target));
    expect(leftovers.some((name) => name.endsWith('.tmp'))).toBe(false);
  });
});

describe('storePoster', () => {
  const rel = 'user-1/2026-06-12 Oslo - Gojira/VID_1.mp4';

  const aFrame = () => sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#7c2d5c' } })
    .jpeg().toBuffer();

  it('writes the poster beside the video, in the archive', async () => {
    // Not in the cache. The browser produced this frame because the server
    // cannot decode video, so deleting it means it is gone.
    const out = await storePoster({ relPath: rel, source: await aFrame() });
    expect(out).toBe(posterPath(rel));
    await expect(access(out)).resolves.toBeUndefined();
  });

  it('downscales the frame the browser sent to the grid width', async () => {
    // The canvas hands over a full-resolution frame. Storing 1920px of it would
    // put more bytes in the backup than the thumbnail it is for.
    const out = await storePoster({ relPath: rel, source: await aFrame() });
    expect((await sharp(out).metadata()).width).toBe(THUMB_WIDTH);
  });

  it('creates the dotted posters folder on first use', async () => {
    await storePoster({ relPath: rel, source: await aFrame() });
    expect(await readdir(join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira')))
      .toContain('.posters');
  });

  it('rejects something that is not an image rather than writing it', async () => {
    await expect(storePoster({ relPath: rel, source: Buffer.from('not an image') }))
      .rejects.toThrow();
  });

  it('takes a path as readily as a buffer, so a batch never sits in the heap', async () => {
    // The upload route hands over multer's temp path. Reading each poster into
    // memory first put a whole batch there at once, ahead of any write.
    const temp = join(root, 'a-frame.webp');
    await writeFile(temp, await aFrame());
    const out = await storePoster({ relPath: rel, source: temp });
    expect((await sharp(out).metadata()).width).toBe(THUMB_WIDTH);
  });
});

describe('ensureThumb for a video', () => {
  const rel = 'user-1/2026-06-12 Oslo - Gojira/VID_1.mp4';

  it('returns the stored poster rather than trying to decode the video', async () => {
    const buffer = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#111' } })
      .jpeg().toBuffer();
    await storePoster({ relPath: rel, source: buffer });
    const out = await ensureThumb({ absPath: '/unused', kind: 'VIDEO', sha256: 'v1', relPath: rel });
    expect(out).toBe(posterPath(rel));
  });

  it('reports a video with no poster instead of inventing one', async () => {
    // Extraction can fail in the browser. The grid draws a placeholder tile for
    // this case; what it must not do is wait on a thumbnail that is never
    // coming.
    await expect(ensureThumb({ absPath: '/unused', kind: 'VIDEO', sha256: 'v1', relPath: rel }))
      .rejects.toThrow(/no poster/i);
  });
});

describe('ensureThumb for a photo whose original is gone', () => {
  it('reports the missing original in a form the caller can tell apart', async () => {
    // Left to sharp this surfaced as "Input file contains unsupported image
    // format"-style prose with no code on it, indistinguishable from a real
    // failure, so the thumb route answered ordinary archive drift with a 500
    // and put the container's absolute path in the message. The tag is what
    // lets the route say 404 for this and only this.
    const err = await ensureThumb({
      absPath: join(root, 'not-there.jpg'), kind: 'PHOTO', sha256: 'gone1', relPath: 'u/s/x.jpg',
    }).catch((e) => e);
    expect(err.code).toBe('NO_SOURCE');
  });
});

describe('ensureDisplay', () => {
  // A photograph of a given shape, optionally with the EXIF orientation a phone
  // writes when it stores a portrait shot as landscape pixels.
  const photo = async (name, width, height, orientation) => {
    const p = join(root, name);
    let img = sharp({ create: { width, height, channels: 3, background: '#475569' } });
    if (orientation) img = img.withMetadata({ orientation });
    await img.jpeg().toFile(p);
    return p;
  };
  const size = async (p) => {
    const { width, height } = await sharp(p).metadata();
    return [width, height];
  };

  it('writes a webp at the checksum-keyed path, beside the thumbnails', async () => {
    const out = await ensureDisplay({ absPath: await aPhoto(), sha256: 'abc' });
    expect(out).toBe(join(root, 'cache', 'display', 'abc.webp'));
    expect((await sharp(out).metadata()).format).toBe('webp');
  });

  it('fits a phone-sized photograph inside the display edge, in proportion', async () => {
    const out = await ensureDisplay({ absPath: await photo('big.jpg', 4000, 3000), sha256: 'big' });
    expect(await size(out)).toEqual([DISPLAY_EDGE, 1536]);
  });

  it('bounds a portrait photograph by its height rather than its width', async () => {
    // Capped on width alone, a 3000x4000 portrait would come out 2048 wide and
    // 2731 tall — bigger than the screen it is meant for.
    const out = await ensureDisplay({ absPath: await photo('tall.jpg', 3000, 4000), sha256: 'tall' });
    expect(await size(out)).toEqual([1536, DISPLAY_EDGE]);
  });

  it('does not enlarge a photograph already smaller than a screen', async () => {
    const out = await ensureDisplay({ absPath: await aPhoto(), sha256: 'small' });
    expect(await size(out)).toEqual([1200, 900]);
  });

  it('stands a photograph up the way the camera was held', async () => {
    // Orientation 6 is "rotate 90° clockwise to view". The copy carries no
    // EXIF, so unless the rotation is applied to the pixels it is served lying
    // on its side.
    const sideways = await photo('sideways.jpg', 3000, 2000, 6);
    const out = await ensureDisplay({ absPath: sideways, sha256: 'sideways' });
    expect(await size(out)).toEqual([1365, DISPLAY_EDGE]);
  });

  it('reuses a copy it has already made', async () => {
    const p = await aPhoto();
    const first = await ensureDisplay({ absPath: p, sha256: 'again' });
    const { stat } = await import('node:fs/promises');
    const { mtimeMs } = await stat(first);
    await ensureDisplay({ absPath: p, sha256: 'again' });
    expect((await stat(first)).mtimeMs).toBe(mtimeMs);
  });

  it('reports an original that is gone in a form the route can tell apart', async () => {
    const err = await ensureDisplay({ absPath: join(root, 'not-there.jpg'), sha256: 'gone' })
      .catch((e) => e);
    expect(err.code).toBe('NO_SOURCE');
    await expect(access(join(root, 'cache', 'display', 'gone.webp'))).rejects.toThrow();
  });
});

describe('concurrent renders (THO-979)', () => {
  // An album share link needs no account, and its limiter bounds the rate of
  // requests (5000 an hour per IP), not how many run at once. Before THO-979
  // every request that arrived before the first render finished started its
  // own full decode of a 12 to 50 MP original, on the same four libuv threads
  // that serve every file.

  // sharp ships separate CJS and ESM builds, each with its own class, and
  // mediaThumbs.js requires the CJS one. A spy on the ESM import above would
  // never see a render.
  const sharpCjsTho979 = createRequire(import.meta.url)('sharp');

  // A spy left behind by a failing test would wrap the next test's spy.
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Counts only renders into the cache: every render writes to a `.tmp` name
  // first, while the fixtures these tests build write straight to a `.jpg`.
  // Renders wait behind the gate until it is opened, so a test can look at how
  // many have started while they are all still running.
  function gatedRendersTho979({ open = false } = {}) {
    const realToFile = sharpCjsTho979.prototype.toFile;
    const gate = {};
    gate.open = new Promise((resolve) => { gate.release = resolve; });
    if (open) gate.release();
    const state = { started: 0, running: 0, most: 0 };
    vi.spyOn(sharpCjsTho979.prototype, 'toFile').mockImplementation(async function toFileTho979(file, ...rest) {
      if (!String(file).endsWith('.tmp')) return realToFile.call(this, file, ...rest);
      state.started += 1;
      state.running += 1;
      state.most = Math.max(state.most, state.running);
      try {
        await gate.open;
        return await realToFile.call(this, file, ...rest);
      } finally {
        state.running -= 1;
      }
    });
    return { gate, state };
  }

  const settleTho979 = () => new Promise((resolve) => { setTimeout(resolve, 50); });

  const junkTho979 = async (name = 'junk.jpg') => {
    const p = join(root, name);
    await writeFile(p, 'not an image');
    return p;
  };

  it('renders an uncached photo once for fifty requests at once', async () => {
    const absPath = await aPhoto();
    const { gate, state } = gatedRendersTho979();

    const all = Promise.all(Array.from({ length: 50 }, () => ensureThumb({ absPath, kind: 'PHOTO', sha256: 'fifty' })));
    await settleTho979();
    gate.release();
    const paths = await all;

    expect(state.started).toBe(1);
    expect(new Set(paths)).toEqual(new Set([join(root, 'cache', 'thumbs', 'fifty.webp')]));
  });

  it('renders an uncached display copy once for fifty requests at once', async () => {
    const absPath = await aPhoto();
    const { gate, state } = gatedRendersTho979();

    const all = Promise.all(Array.from({ length: 50 }, () => ensureDisplay({ absPath, sha256: 'fifty' })));
    await settleTho979();
    gate.release();
    const paths = await all;

    expect(state.started).toBe(1);
    expect(new Set(paths)).toEqual(new Set([join(root, 'cache', 'display', 'fifty.webp')]));
  });

  it('runs at most MAX_CONCURRENT_RENDERS at once, and the rest in turn', async () => {
    const absPath = await aPhoto();
    const { gate, state } = gatedRendersTho979();
    const count = MAX_CONCURRENT_RENDERS + 3;

    const all = Promise.all(Array.from({ length: count }, (_, i) => ensureThumb({ absPath, kind: 'PHOTO', sha256: `cap${i}` })));
    await settleTho979();
    expect(state.started).toBe(MAX_CONCURRENT_RENDERS);

    gate.release();
    const paths = await all;
    expect(state.started).toBe(count);
    expect(state.most).toBe(MAX_CONCURRENT_RENDERS);
    for (const p of paths) await expect(access(p)).resolves.toBeUndefined();
  });

  // A copy already made is a stat; a video poster is a stat; a missing
  // original is a stat. None of them may queue behind a stranger's cold renders.
  it('does not make a cached thumbnail, a video poster or a missing original wait for a slot', async () => {
    const absPath = await aPhoto();
    const warm = await ensureThumb({ absPath, kind: 'PHOTO', sha256: 'warm' });
    const rel = 'user-1/2026-06-12 Oslo - Gojira/VID_1.mp4';
    const frame = await sharp({ create: { width: 64, height: 36, channels: 3, background: '#111' } }).jpeg().toBuffer();
    const poster = await storePoster({ relPath: rel, source: frame });

    const { gate, state } = gatedRendersTho979();
    const cold = Array.from({ length: MAX_CONCURRENT_RENDERS + 1 }, (_, i) => ensureThumb({ absPath, kind: 'PHOTO', sha256: `cold${i}` }));
    await settleTho979();
    expect(state.started).toBe(MAX_CONCURRENT_RENDERS);

    expect(await ensureThumb({ absPath, kind: 'PHOTO', sha256: 'warm' })).toBe(warm);
    expect(await ensureThumb({ kind: 'VIDEO', relPath: rel })).toBe(poster);
    const gone = await ensureThumb({ absPath: join(root, 'gone.jpg'), kind: 'PHOTO', sha256: 'gone' }).catch((e) => e);
    expect(gone.code).toBe('NO_SOURCE');

    gate.release();
    await Promise.all(cold);
  });

  it('shares one failure among callers who joined it, and does not leave it in flight', async () => {
    const absPath = await junkTho979();
    const { gate, state } = gatedRendersTho979();

    const all = Array.from({ length: 10 }, () => ensureThumb({ absPath, kind: 'PHOTO', sha256: 'junk' }).catch((e) => e));
    await settleTho979();
    gate.release();
    const errors = await Promise.all(all);

    expect(state.started).toBe(1);
    expect(errors[0]).toBeInstanceOf(Error);
    for (const e of errors) expect(e).toBe(errors[0]);
    // Nothing waits forever on a settled flight: the slot it held is free.
    const ok = await ensureThumb({ absPath: await aPhoto(), kind: 'PHOTO', sha256: 'after' });
    await expect(access(ok)).resolves.toBeUndefined();
  });

  it('remembers an undecodable original for a while, then tries it again', async () => {
    // Before THO-979 each request for a photo sharp cannot read decoded it
    // again and answered 500, so one broken file was a free decode per request.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
    const absPath = await junkTho979();
    const { state } = gatedRendersTho979({ open: true });

    const first = await ensureDisplay({ absPath, sha256: 'bad' }).catch((e) => e);
    expect(state.started).toBe(1);

    vi.setSystemTime(new Date('2026-11-14T12:09:00Z'));
    const again = await ensureDisplay({ absPath, sha256: 'bad' }).catch((e) => e);
    // The same error, so the route still answers it as it always has (500).
    expect(again).toBe(first);
    expect(state.started).toBe(1);

    // Past the ten minutes the file is tried again: it may have been replaced.
    vi.setSystemTime(new Date('2026-11-14T12:10:01Z'));
    await expect(ensureDisplay({ absPath, sha256: 'bad' })).rejects.toThrow();
    expect(state.started).toBe(2);
  });

  it('does not remember a missing original', async () => {
    // Archive drift is answered with a 404 and is cheap to check; a file that
    // turns up a moment later (a restore, a slow sync) must render at once.
    const absPath = join(root, 'late.jpg');
    const err = await ensureThumb({ absPath, kind: 'PHOTO', sha256: 'late' }).catch((e) => e);
    expect(err.code).toBe('NO_SOURCE');

    await aPhoto('late.jpg');
    const out = await ensureThumb({ absPath, kind: 'PHOTO', sha256: 'late' });
    await expect(access(out)).resolves.toBeUndefined();
  });

  it('does not remember a failure that was not the decode', async () => {
    // A full disk or a permissions slip is the server's fault, not the file's,
    // and must not hide a good photo for ten minutes. Forced here by putting a
    // file where the thumbnail folder goes, so creating it fails.
    const absPath = await aPhoto();
    const folder = join(root, 'cache', 'thumbs');
    await mkdir(dirname(folder), { recursive: true });
    await writeFile(folder, '');

    await expect(ensureThumb({ absPath, kind: 'PHOTO', sha256: 'blocked' })).rejects.toThrow();
    await (await import('node:fs/promises')).unlink(folder);
    const out = await ensureThumb({ absPath, kind: 'PHOTO', sha256: 'blocked' });
    await expect(access(out)).resolves.toBeUndefined();
  });

  it('keeps remembered failures bounded, forgetting the oldest first', async () => {
    const absPath = await junkTho979();
    const { state } = gatedRendersTho979({ open: true });

    for (let i = 0; i <= MAX_REMEMBERED_FAILURES; i++) {
      await ensureThumb({ absPath, kind: 'PHOTO', sha256: `many${i}` }).catch(() => {});
    }
    const filled = state.started;
    expect(filled).toBe(MAX_REMEMBERED_FAILURES + 1);

    // The newest is still remembered, the oldest has been pushed out.
    await ensureThumb({ absPath, kind: 'PHOTO', sha256: `many${MAX_REMEMBERED_FAILURES}` }).catch(() => {});
    expect(state.started).toBe(filled);
    await ensureThumb({ absPath, kind: 'PHOTO', sha256: 'many0' }).catch(() => {});
    expect(state.started).toBe(filled + 1);
  });

  it('gives every render a time limit, so a hung decode cannot hold a slot forever', async () => {
    const timeout = vi.spyOn(sharpCjsTho979.prototype, 'timeout');
    await ensureThumb({ absPath: await aPhoto(), kind: 'PHOTO', sha256: 'timed' });
    expect(timeout).toHaveBeenCalledWith({ seconds: 60 });
  });
});
