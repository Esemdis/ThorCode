import { describe, it, expect, beforeEach } from 'vitest';
import {
  mkdtemp, mkdir, writeFile, readFile, readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retargetSidecars, undoRetarget } from './mediaRetarget.js';

describe('retargetSidecars (THO-823)', () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'retarget-'));
    process.env.MEDIA_ROOT = root;
  });

  const wrongDay = 'user-1/2026-06-23 Stockholm - Gojira';
  const abs = (rel) => join(root, 'archive', rel);
  const sidecarOf = async (rel) => JSON.parse(await readFile(join(abs(rel), 'concert-media.json'), 'utf8'));
  const tho823Files = [{ name: 'IMG_1.jpg', band_id: 3, band_name: 'Gojira' }];
  const tho823Seed = async (rel, sidecar) => {
    await mkdir(abs(rel), { recursive: true });
    await writeFile(join(abs(rel), 'IMG_1.jpg'), 'jpeg');
    if (sidecar) await writeFile(join(abs(rel), 'concert-media.json'), JSON.stringify(sidecar));
  };
  const OLD = {
    version: 1, concert_id: 500, user_id: 'user-1',
    concert: { date: '2026-06-23', venue: 'Fållan', city: 'Stockholm', country: 'SE' },
    files: tho823Files,
  };
  const TARGET = {
    concert_date: new Date('2026-06-24T12:00:00Z'), venue: 'Fållan', city: 'Stockholm', country: 'SE',
  };

  it('names the new concert and its date, and keeps the files', async () => {
    await tho823Seed(wrongDay, OLD);

    const done = await retargetSidecars({ relDirs: [wrongDay], concertId: 600, concert: TARGET });

    // planRebuild matches a folder to its attendance by (user_id, concert_id):
    // this is what makes a rebuild find the moved attendance.
    expect(await sidecarOf(wrongDay)).toEqual({
      ...OLD,
      concert_id: 600,
      concert: { date: '2026-06-24', venue: 'Fållan', city: 'Stockholm', country: 'SE' },
    });
    expect(await readdir(abs(wrongDay))).toContain('IMG_1.jpg');
    expect(done).toHaveLength(1);
  });

  it('leaves a folder with no sidecar alone rather than inventing one', async () => {
    await tho823Seed(wrongDay, null);

    const done = await retargetSidecars({ relDirs: [wrongDay], concertId: 600, concert: TARGET });

    expect(done).toEqual([]);
    expect(await readdir(abs(wrongDay))).toEqual(['IMG_1.jpg']);
  });

  it('puts the previous sidecar back on undo', async () => {
    await tho823Seed(wrongDay, OLD);
    const done = await retargetSidecars({ relDirs: [wrongDay], concertId: 600, concert: TARGET });

    await undoRetarget(done);

    expect(await sidecarOf(wrongDay)).toEqual(OLD);
  });

  it('undoes the folders it already rewrote when a later one fails', async () => {
    // A sidecar that is not JSON, because chmod stops nothing when the tests
    // run as root: readSidecar throws on it.
    const broken = 'user-1/2026-06-23 Stockholm - Gojira (2)';
    await tho823Seed(wrongDay, OLD);
    await mkdir(abs(broken), { recursive: true });
    await writeFile(join(abs(broken), 'concert-media.json'), '{ not json');

    await expect(retargetSidecars({ relDirs: [wrongDay, broken], concertId: 600, concert: TARGET }))
      .rejects.toThrow();

    expect(await sidecarOf(wrongDay)).toEqual(OLD);
  });

  it('refuses a folder outside the archive', async () => {
    await expect(retargetSidecars({ relDirs: ['../../etc'], concertId: 600, concert: TARGET }))
      .rejects.toThrow(/outside the archive/);
  });
});
