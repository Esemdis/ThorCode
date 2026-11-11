import { describe, it, expect, beforeEach } from 'vitest';
import {
  mkdtemp, mkdir, writeFile, readFile, access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retargetSidecars, undoRetarget } from './mediaRetarget.js';

describe('retargetSidecars', () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'retarget-'));
    process.env.MEDIA_ROOT = root;
  });

  const abs = (relDir) => join(root, 'archive', relDir);
  const sidecarAt = (relDir) => join(abs(relDir), 'concert-media.json');
  const exists = (p) => access(p).then(() => true, () => false);
  const read = async (relDir) => JSON.parse(await readFile(sidecarAt(relDir), 'utf8'));

  const retargetFiles = [
    { name: 'IMG_1.jpg', kind: 'PHOTO', band_id: 3, band_name: 'Gojira', sha256: 'aa' },
    { name: 'VID_1.mp4', kind: 'VIDEO', band_id: null, band_name: null, sha256: 'bb' },
  ];
  const retargetOld = {
    version: 1, concert_id: 99, user_id: 'user-1',
    concert: { date: '2026-06-23', venue: 'Fållan', city: 'Stockholm', country: 'SE' },
    files: retargetFiles,
  };
  const retargetRight = {
    concert_date: new Date('2026-06-24T12:00:00Z'), venue: 'Fållan', city: 'Stockholm', country: 'SE',
  };
  const seed = async (relDir, sidecar) => {
    await mkdir(abs(relDir), { recursive: true });
    await writeFile(sidecarAt(relDir), JSON.stringify(sidecar));
  };

  it('names the new concert and its date, and keeps every file entry', async () => {
    await seed('user-1/2026-06-23 Stockholm - Gojira', retargetOld);

    const undo = await retargetSidecars({
      relDirs: ['user-1/2026-06-23 Stockholm - Gojira'], concertId: 77, concert: retargetRight,
    });

    expect(await read('user-1/2026-06-23 Stockholm - Gojira')).toEqual({
      ...retargetOld,
      concert_id: 77,
      // The calendar day, sliced: the same form an upload seeds a sidecar with.
      concert: { date: '2026-06-24', venue: 'Fållan', city: 'Stockholm', country: 'SE' },
    });
    expect(undo).toHaveLength(1);
  });

  it('leaves a folder with no sidecar alone rather than claiming it', async () => {
    // A sidecar written here would claim the folder for the concert with an
    // empty file list, which is not what the folder holds.
    await mkdir(abs('user-1/hand made'), { recursive: true });

    const undo = await retargetSidecars({ relDirs: ['user-1/hand made'], concertId: 77, concert: retargetRight });

    expect(await exists(sidecarAt('user-1/hand made'))).toBe(false);
    expect(undo).toEqual([]);
  });

  it('writes nothing to a sidecar already naming the concert', async () => {
    await seed('user-1/done', { ...retargetOld, concert_id: 77 });

    const undo = await retargetSidecars({ relDirs: ['user-1/done'], concertId: 77, concert: retargetRight });

    // The old date stays: nothing was rewritten, so a retry is a no-op.
    expect((await read('user-1/done')).concert.date).toBe('2026-06-23');
    expect(undo).toEqual([]);
  });

  it('carries what it already rewrote on the error when a later folder fails', async () => {
    await seed('user-1/a', retargetOld);
    await seed('user-1/b', { ...retargetOld, version: 99 });

    const err = await retargetSidecars({
      relDirs: ['user-1/a', 'user-1/b'], concertId: 77, concert: retargetRight,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.undo.map((u) => u.absDir)).toEqual([abs('user-1/a')]);
    expect((await read('user-1/a')).concert_id).toBe(77);
  });

  it('undo puts the previous concert back and keeps a file added since', async () => {
    await seed('user-1/a', retargetOld);
    const undo = await retargetSidecars({ relDirs: ['user-1/a'], concertId: 77, concert: retargetRight });
    // An upload landing between the rewrite and the undo.
    const now = await read('user-1/a');
    await writeFile(sidecarAt('user-1/a'), JSON.stringify({
      ...now, files: [...now.files, { name: 'IMG_9.jpg', kind: 'PHOTO' }],
    }));

    await undoRetarget(undo);

    const restored = await read('user-1/a');
    expect(restored.concert_id).toBe(99);
    expect(restored.concert).toEqual(retargetOld.concert);
    expect(restored.files.map((f) => f.name)).toEqual(['IMG_1.jpg', 'VID_1.mp4', 'IMG_9.jpg']);
  });
});
