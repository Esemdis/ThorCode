import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { showDirForAttendance } from './mediaShowDir.js';

let root;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'showdir-'));
  process.env.MEDIA_ROOT = root;
});

const show = { date: '2026-06-12', city: 'Oslo', headliner: 'Gojira' };

async function seedShow(folder, sidecar) {
  const dir = join(root, 'archive', 'user-1', folder);
  await mkdir(dir, { recursive: true });
  if (sidecar) {
    await writeFile(join(dir, 'concert-media.json'), JSON.stringify(sidecar), 'utf8');
  }
  return dir;
}

describe('showDirForAttendance', () => {
  it('derives the folder from the date, city and headliner for a show with nothing in it yet', async () => {
    expect(await showDirForAttendance({
      existingRelPath: null, userId: 'user-1', concertId: 8417, show,
    })).toBe('user-1/2026-06-12 Oslo - Gojira');
  });

  it('keeps the folder a show already has even when the derived name has moved on', async () => {
    // The whole point of the lookup. headlinerOf reads an unordered relation,
    // so adding a support act changed what this show derives to and split one
    // night across two folders. The first upload decides; nothing recomputes it.
    expect(await showDirForAttendance({
      existingRelPath: 'user-1/2026-06-12 Oslo - Gojira/IMG_1.jpg',
      userId: 'user-1',
      concertId: 8417,
      show: { date: '2026-06-12', city: 'Oslo', headliner: 'Alcest' },
    })).toBe('user-1/2026-06-12 Oslo - Gojira');
  });

  it('writes into a folder whose sidecar already names this concert', async () => {
    await seedShow('2026-06-12 Oslo - Gojira', { concert_id: 8417, files: [] });

    expect(await showDirForAttendance({
      existingRelPath: null, userId: 'user-1', concertId: 8417, show,
    })).toBe('user-1/2026-06-12 Oslo - Gojira');
  });

  it('suffixes rather than sharing a folder that belongs to a different concert', async () => {
    // Two attended concerts on one date, in one city, with one headliner is
    // not exotic: a duplicate Concert row, or an early and a late show. The
    // sidecar holds a single scalar concert_id, so sharing the folder destroys
    // which show a file came from at write time — a rebuild then files it
    // under the wrong attendance and reports the archive as clean.
    await seedShow('2026-06-12 Oslo - Gojira', { concert_id: 8417, files: [] });

    expect(await showDirForAttendance({
      existingRelPath: null, userId: 'user-1', concertId: 9000, show,
    })).toBe('user-1/2026-06-12 Oslo - Gojira (2)');
  });

  it('keeps counting past a suffix that is itself taken', async () => {
    await seedShow('2026-06-12 Oslo - Gojira', { concert_id: 8417, files: [] });
    await seedShow('2026-06-12 Oslo - Gojira (2)', { concert_id: 9000, files: [] });

    expect(await showDirForAttendance({
      existingRelPath: null, userId: 'user-1', concertId: 9001, show,
    })).toBe('user-1/2026-06-12 Oslo - Gojira (3)');
  });

  it('adopts a folder that exists with no sidecar at all', async () => {
    // Matches how the upload route already treats a missing sidecar — it
    // writes a fresh one — so a directory made by hand, or left behind by a
    // batch that failed before its first file landed, is not stepped around.
    await seedShow('2026-06-12 Oslo - Gojira', null);

    expect(await showDirForAttendance({
      existingRelPath: null, userId: 'user-1', concertId: 8417, show,
    })).toBe('user-1/2026-06-12 Oslo - Gojira');
  });

  it('refuses a sidecar it cannot understand instead of adopting the folder', async () => {
    // readSidecar throws on a future version on purpose. Treating that as
    // "free" would write a second show's files into a folder this build has
    // already admitted it cannot read.
    await seedShow('2026-06-12 Oslo - Gojira', { version: 99, concert_id: 8417, files: [] });

    await expect(showDirForAttendance({
      existingRelPath: null, userId: 'user-1', concertId: 9000, show,
    })).rejects.toThrow(/version 99/);
  });

  it('slugs the user segment the same way the archive was written', async () => {
    // User.id is a String that merely defaults to a uuid. A federated
    // 'auth0|…' carries a character the slug rewrites, and a folder derived
    // from the raw id would never be found again.
    expect(await showDirForAttendance({
      existingRelPath: null, userId: 'auth0|abc', concertId: 8417, show,
    })).toBe('auth0-abc/2026-06-12 Oslo - Gojira');
  });
});
