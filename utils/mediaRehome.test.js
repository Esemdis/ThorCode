import { describe, it, expect, beforeEach } from 'vitest';
import {
  mkdtemp, mkdir, writeFile, readFile, readdir, access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { festivalSibling, moveFileBytes, undoRenames } from './mediaRehome.js';
import { webRenditionPath } from './mediaPaths.js';
import { FAILED_SUFFIX } from './renditionPlan.js';

const day = new Date('2025-06-22T00:00:00Z');
const show = (id, over = {}) => ({
  id,
  concert_rel: {
    concert_date: day, city: 'Dessel', bands: [{ band_rel: { id: 501, name: 'Dayseeker' } }],
    ...over,
  },
});
const own = { concert_date: new Date('2025-06-22T14:30:00Z'), city: 'Dessel' };

describe('festivalSibling', () => {
  it('finds the show that day, in that city, with the act on its bill', () => {
    expect(festivalSibling(own, [show(41)])?.id).toBe(41);
  });

  it('reads the calendar day, not the instant', () => {
    // The file's own show carries a start time; the act's row was scraped at
    // midnight. Same night.
    expect(festivalSibling({ concert_date: new Date('2025-06-22T23:10:00Z'), city: 'Dessel' }, [show(41)])?.id).toBe(41);
  });

  it('ignores a show on another day or in another city', () => {
    expect(festivalSibling(own, [
      show(41, { concert_date: new Date('2025-06-21T00:00:00Z') }),
      show(42, { city: 'Antwerp' }),
    ])).toBeNull();
  });

  it('prefers the most specific bill, then the lowest id', () => {
    // The rule dayBill routes an upload by, so tagging later files a photo
    // where picking the act at upload would have.
    const wide = show(40, { bands: [{ band_rel: { id: 501 } }, { band_rel: { id: 7 } }, { band_rel: { id: 8 } }] });
    expect(festivalSibling(own, [wide, show(44), show(43)])?.id).toBe(43);
  });

  it('has nothing to offer a show with no date', () => {
    expect(festivalSibling({ concert_date: null, city: 'Dessel' }, [show(41)])).toBeNull();
  });

  it('never reaches a candidate with no date either', () => {
    expect(festivalSibling(own, [show(41, { concert_date: null })])).toBeNull();
  });
});

describe('moveFileBytes', () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rehome-'));
    process.env.MEDIA_ROOT = root;
  });

  const from = 'user-1/2025-06-22 Dessel - WARGASM/VID_1.mp4';
  const to = 'user-1/2025-06-22 Dessel - Dayseeker/VID_1.mp4';
  const abs = (rel) => join(root, 'archive', rel);
  // Where the rendition service says it could not encode a clip: beside where
  // the rendition would have gone, under the same name plus the suffix.
  const marker = (rel) => `${webRenditionPath(abs(rel))}${FAILED_SUFFIX}`;
  const exists = (p) => access(p).then(() => true, () => false);

  const seed = async ({ withMarker = true } = {}) => {
    await mkdir(dirname(abs(from)), { recursive: true });
    await mkdir(dirname(abs(to)), { recursive: true });
    await writeFile(abs(from), 'clip');
    if (withMarker) {
      await mkdir(dirname(marker(from)), { recursive: true });
      await writeFile(marker(from), 'ffmpeg could not read it\n');
    }
  };

  it('carries the rendition service\'s failure marker with the clip', async () => {
    // Left behind, the marker marks nothing in the old show forever, and the
    // clip is encoded, fails and is marked all over again in its new one.
    await seed();
    await moveFileBytes({ fromRelPath: from, toRelPath: to, kind: 'VIDEO' });

    expect(await readFile(marker(to), 'utf8')).toBe('ffmpeg could not read it\n');
    expect(await exists(marker(from))).toBe(false);
  });

  it('puts the marker back along with the clip when the move is undone', async () => {
    await seed();
    const done = await moveFileBytes({ fromRelPath: from, toRelPath: to, kind: 'VIDEO' });
    await undoRenames(done);

    expect(await readFile(abs(from), 'utf8')).toBe('clip');
    expect(await readFile(marker(from), 'utf8')).toBe('ffmpeg could not read it\n');
    expect(await exists(marker(to))).toBe(false);
  });

  it('takes the clip back when its marker cannot follow it', async () => {
    // A non-empty directory where the marker has to land: a file can replace
    // a file, but never that, so the marker's rename is the step that fails.
    await seed();
    await mkdir(marker(to), { recursive: true });
    await writeFile(join(marker(to), 'occupied'), '');

    await expect(moveFileBytes({ fromRelPath: from, toRelPath: to, kind: 'VIDEO' })).rejects.toThrow();
    expect(await readFile(abs(from), 'utf8')).toBe('clip');
    expect(await readFile(marker(from), 'utf8')).toBe('ffmpeg could not read it\n');
    expect(await exists(abs(to))).toBe(false);
  });

  it('leaves no .web folder in the new show for a clip with nothing to carry', async () => {
    await seed({ withMarker: false });
    await moveFileBytes({ fromRelPath: from, toRelPath: to, kind: 'VIDEO' });

    expect(await readdir(dirname(abs(to)))).toEqual(['VID_1.mp4']);
  });
});
