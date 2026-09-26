import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtemp, mkdir, writeFile, readFile, readdir, access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeMediaFiles } from './mediaRemove.js';
import { updateSidecar } from './mediaSidecar.js';

let root;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'remove-'));
  process.env.MEDIA_ROOT = root;
  // The failure cases log the whole error, path and all, which is the point of
  // logging it; the suite's output does not need it.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const gojira = 'user-1/2026-06-12 Oslo - Gojira';
const alcest = 'user-1/2026-06-13 Oslo - Alcest';
const dirOf = (show) => join(root, 'archive', show);
const row = (id, filename, { kind = 'PHOTO', show = gojira } = {}) => ({
  id, filename, kind, rel_path: `${show}/${filename}`,
});
const exists = (p) => access(p).then(() => true, () => false);

// A show folder holding these files, each one recorded in its sidecar.
const seed = async (names, show = gojira) => {
  await mkdir(dirOf(show), { recursive: true });
  for (const name of names) await writeFile(join(dirOf(show), name), `bytes of ${name}`);
  await writeFile(join(dirOf(show), 'concert-media.json'), JSON.stringify({
    version: 1, concert_id: 8417, user_id: 'user-1',
    concert: { date: '2026-06-12', venue: 'Sentrum Scene', city: 'Oslo', country: 'NO' },
    files: names.map((name) => ({ name, kind: name.endsWith('.mp4') ? 'VIDEO' : 'PHOTO' })),
  }));
};
const listed = async (show = gojira) => JSON.parse(
  await readFile(join(dirOf(show), 'concert-media.json'), 'utf8'),
).files.map((f) => f.name);

describe('removeMediaFiles', () => {
  it('removes a photograph and its sidecar entry, and nothing else', async () => {
    await seed(['IMG_1.jpg', 'IMG_2.jpg']);

    const result = await removeMediaFiles([row(1, 'IMG_1.jpg')]);

    expect(result).toEqual({ removed: [1], failed: [] });
    expect(await readdir(dirOf(gojira))).toEqual(expect.not.arrayContaining(['IMG_1.jpg']));
    expect(await exists(join(dirOf(gojira), 'IMG_2.jpg'))).toBe(true);
    expect(await listed()).toEqual(['IMG_2.jpg']);
  });

  it('takes everything a video left in the archive with it', async () => {
    // The rendition and the failure marker are what the route used to leave
    // behind: inside the show folder, synced offsite, for a video that no
    // longer existed.
    await seed(['VID_1.mp4']);
    const dir = dirOf(gojira);
    await mkdir(join(dir, '.posters'), { recursive: true });
    await mkdir(join(dir, '.web'), { recursive: true });
    await writeFile(join(dir, '.posters', 'VID_1.mp4.webp'), 'poster');
    await writeFile(join(dir, '.web', 'VID_1.mp4.mp4'), 'rendition');
    await writeFile(join(dir, '.web', 'VID_1.mp4.mp4.failed'), 'an older attempt\n');

    const result = await removeMediaFiles([row(1, 'VID_1.mp4', { kind: 'VIDEO' })]);

    expect(result).toEqual({ removed: [1], failed: [] });
    expect(await exists(join(dir, 'VID_1.mp4'))).toBe(false);
    expect(await readdir(join(dir, '.posters'))).toEqual([]);
    expect(await readdir(join(dir, '.web'))).toEqual([]);
    expect(await listed()).toEqual([]);
  });

  it('is content with a video that never had a poster or a rendition', async () => {
    await seed(['VID_1.mp4']);
    const result = await removeMediaFiles([row(1, 'VID_1.mp4', { kind: 'VIDEO' })]);
    expect(result).toEqual({ removed: [1], failed: [] });
  });

  it('counts an original that is already gone as removed', async () => {
    // A retry after a half-finished delete lands exactly here, and must be
    // able to finish the job rather than fail on the file it already removed.
    await seed([]);
    await writeFile(join(dirOf(gojira), 'concert-media.json'), JSON.stringify({
      version: 1, concert_id: 8417, user_id: 'user-1', concert: {}, files: [{ name: 'IMG_1.jpg' }],
    }));

    expect(await removeMediaFiles([row(1, 'IMG_1.jpg')])).toEqual({ removed: [1], failed: [] });
    expect(await listed()).toEqual([]);
  });

  it('writes each show\'s sidecar once, however many files leave it', async () => {
    await seed(['A.jpg', 'B.jpg', 'C.jpg']);
    await seed(['D.jpg'], alcest);
    const update = vi.fn(updateSidecar);

    const result = await removeMediaFiles([
      row(1, 'A.jpg'), row(2, 'B.jpg'), row(4, 'D.jpg', { show: alcest }), row(3, 'C.jpg'),
    ], { update });

    expect(result).toEqual({ removed: [1, 2, 4, 3], failed: [] });
    expect(update).toHaveBeenCalledTimes(2);
    expect(await listed()).toEqual([]);
    expect(await listed(alcest)).toEqual([]);
  });

  it('keeps the row of a file that would not go, and still removes the rest', async () => {
    // A non-empty directory where the file should be: unlink refuses it with
    // something other than ENOENT, whatever user the suite runs as.
    await seed(['IMG_1.jpg']);
    await mkdir(join(dirOf(gojira), 'IMG_2.jpg', 'inside'), { recursive: true });
    await writeFile(join(dirOf(gojira), 'concert-media.json'), JSON.stringify({
      version: 1, concert_id: 8417, user_id: 'user-1', concert: {},
      files: [{ name: 'IMG_1.jpg' }, { name: 'IMG_2.jpg' }],
    }));

    const result = await removeMediaFiles([row(1, 'IMG_1.jpg'), row(2, 'IMG_2.jpg')]);

    expect(result.removed).toEqual([1]);
    expect(result.failed).toEqual([{ id: 2, error: expect.stringMatching(/could not remove/i) }]);
    // Its entry stays with it: the sidecar goes on describing a file that is
    // still there.
    expect(await listed()).toEqual(['IMG_2.jpg']);
  });

  it('does not hand the client the container\'s paths', async () => {
    await mkdir(join(dirOf(gojira), 'IMG_2.jpg', 'inside'), { recursive: true });

    const { failed } = await removeMediaFiles([row(2, 'IMG_2.jpg')]);

    expect(failed[0].error).not.toContain(root);
  });

  it('fails every file of a show whose sidecar cannot be written, and only that show\'s', async () => {
    // Their files are gone by then, but the sidecar still lists them, so the
    // rows must stay too: a rebuild then reports the missing files, and a
    // retry finishes the delete.
    await seed(['A.jpg', 'B.jpg']);
    await writeFile(join(dirOf(gojira), 'concert-media.json'), JSON.stringify({ version: 99, files: [] }));
    await seed(['D.jpg'], alcest);

    const result = await removeMediaFiles([
      row(1, 'A.jpg'), row(2, 'B.jpg'), row(4, 'D.jpg', { show: alcest }),
    ]);

    expect(result.removed).toEqual([4]);
    expect(result.failed.map((f) => f.id)).toEqual([1, 2]);
    expect(result.failed[0].error).toMatch(/sidecar/i);
    expect(await listed(alcest)).toEqual([]);
  });

  it('refuses a row whose path leads out of the archive, and carries on', async () => {
    await seed(['IMG_1.jpg']);

    const result = await removeMediaFiles([
      { id: 9, filename: 'passwd', kind: 'PHOTO', rel_path: '../../../../etc/passwd' },
      row(1, 'IMG_1.jpg'),
    ]);

    expect(result.removed).toEqual([1]);
    expect(result.failed.map((f) => f.id)).toEqual([9]);
  });
});
