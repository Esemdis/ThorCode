import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, access, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import sharp from 'sharp';
import {
  THUMB_WIDTH, DISPLAY_EDGE, ensureThumb, ensureDisplay, storePoster,
} from './mediaThumbs.js';
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
