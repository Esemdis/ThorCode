import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SIDECAR_NAME, SIDECAR_VERSION, emptySidecar, upsertFile, removeFile,
  readSidecar, writeSidecar,
} from './mediaSidecar.js';

const concert = { date: '2026-06-12', venue: 'Sentrum Scene', city: 'Oslo', country: 'NO' };
const entry = {
  name: 'IMG_4821.jpg', kind: 'PHOTO', band_id: 92, band_name: 'Gojira',
  caption: '', sha256: 'abc', bytes: 10, width: 4080, height: 3072,
  duration_ms: null, taken_at: '2026-06-12T21:14:09',
};

const tmpShowDir = () => mkdtemp(join(tmpdir(), 'sidecar-'));

describe('emptySidecar', () => {
  it('records the concert well enough to restore without a database', () => {
    // A restore that can only say "this belongs to concert 8417" is not a
    // restore. The denormalised copy is the whole point of the file.
    const s = emptySidecar({ concertId: 8417, userId: 'user-1', concert });
    expect(s).toMatchObject({
      version: SIDECAR_VERSION, concert_id: 8417, user_id: 'user-1', concert, files: [],
    });
  });
});

describe('upsertFile', () => {
  it('adds a file that is not there yet', () => {
    const s = upsertFile(emptySidecar({ concertId: 1, userId: 'u', concert }), entry);
    expect(s.files).toEqual([entry]);
  });

  it('replaces the entry with the same name rather than adding a second', () => {
    const once = upsertFile(emptySidecar({ concertId: 1, userId: 'u', concert }), entry);
    const twice = upsertFile(once, { ...entry, caption: 'stage dive' });
    expect(twice.files).toHaveLength(1);
    expect(twice.files[0].caption).toBe('stage dive');
  });

  it('does not mutate the sidecar it was given', () => {
    // Callers read, transform and write. An in-place update would let a failed
    // write leave the in-memory copy ahead of the file on disk.
    const before = emptySidecar({ concertId: 1, userId: 'u', concert });
    upsertFile(before, entry);
    expect(before.files).toEqual([]);
  });

  it('keeps files in a stable order so the file does not churn in the backup', () => {
    // rclone compares contents. Reordering entries on every write would resync
    // the sidecar of every show for no reason.
    const s = ['c.jpg', 'a.jpg', 'b.jpg'].reduce(
      (acc, name) => upsertFile(acc, { ...entry, name }),
      emptySidecar({ concertId: 1, userId: 'u', concert }),
    );
    expect(s.files.map((f) => f.name)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
  });
});

describe('removeFile', () => {
  it('drops the named entry and leaves the rest', () => {
    let s = emptySidecar({ concertId: 1, userId: 'u', concert });
    s = upsertFile(s, entry);
    s = upsertFile(s, { ...entry, name: 'IMG_4822.jpg' });
    expect(removeFile(s, 'IMG_4821.jpg').files.map((f) => f.name)).toEqual(['IMG_4822.jpg']);
  });

  it('is a no-op for a name that is not there', () => {
    const s = upsertFile(emptySidecar({ concertId: 1, userId: 'u', concert }), entry);
    expect(removeFile(s, 'nope.jpg').files).toHaveLength(1);
  });
});

describe('readSidecar and writeSidecar', () => {
  it('round-trips a sidecar through the disk', async () => {
    const dir = await tmpShowDir();
    const s = upsertFile(emptySidecar({ concertId: 8417, userId: 'u', concert }), entry);
    await writeSidecar(dir, s);
    expect(await readSidecar(dir)).toEqual(s);
  });

  it('returns null for a folder that has no sidecar', async () => {
    expect(await readSidecar(await tmpShowDir())).toBeNull();
  });

  it('leaves no temp file behind after a successful write', async () => {
    // The write is a temp file plus a rename so a crash cannot truncate the
    // record of truth. A leaked temp file would then be synced to Drive.
    const dir = await tmpShowDir();
    await writeSidecar(dir, emptySidecar({ concertId: 1, userId: 'u', concert }));
    expect(await readdir(dir)).toEqual([SIDECAR_NAME]);
  });

  it('writes formatted JSON, because a person may open this file', async () => {
    const dir = await tmpShowDir();
    await writeSidecar(dir, emptySidecar({ concertId: 1, userId: 'u', concert }));
    expect(await readFile(join(dir, SIDECAR_NAME), 'utf8')).toMatch(/\n  "version": 1/);
  });

  it('refuses a sidecar written by a newer version rather than guessing', async () => {
    // Silently reading a future shape would let a rebuild write half-understood
    // rows over good ones.
    const dir = await tmpShowDir();
    await writeFile(join(dir, SIDECAR_NAME), JSON.stringify({ version: 99, files: [] }));
    await expect(readSidecar(dir)).rejects.toThrow(/version 99/);
  });
});
