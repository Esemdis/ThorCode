import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attendanceKey, collectArchive, planRebuild } from './mediaRebuild.js';

const sidecar = (relDir, concertId, files, userId = 'user-1') => ({
  relDir, data: { version: 1, concert_id: concertId, user_id: userId, concert: {}, files },
});
const entry = (name, over = {}) => ({
  name, kind: 'PHOTO', band_id: 92, band_name: 'Gojira', caption: '',
  sha256: `h-${name}`, bytes: 10, width: 1, height: 1, duration_ms: null, taken_at: null, ...over,
});

describe('planRebuild', () => {
  it('plans one upsert per sidecar entry that has a file behind it', () => {
    const plan = planRebuild({
      sidecars: [sidecar('user-1/show', 8417, [entry('a.jpg')])],
      filesOnDisk: { 'user-1/show': ['a.jpg'] },
      attendanceIds: new Map([[attendanceKey('user-1', 8417), 1]]),
    });
    expect(plan.upserts).toEqual([expect.objectContaining({
      attendance_id: 1, filename: 'a.jpg', rel_path: 'user-1/show/a.jpg', band_id: 92,
    })]);
  });

  it('reports a sidecar entry whose file is gone instead of writing a broken row', () => {
    // A row pointing at nothing renders as a broken tile forever. Reporting it
    // is the only useful thing to do: the file is not coming back from here.
    const plan = planRebuild({
      sidecars: [sidecar('user-1/show', 8417, [entry('a.jpg')])],
      filesOnDisk: { 'user-1/show': [] },
      attendanceIds: new Map([[attendanceKey('user-1', 8417), 1]]),
    });
    expect(plan.upserts).toEqual([]);
    expect(plan.missingFiles).toEqual(['user-1/show/a.jpg']);
  });

  it('reports a file on disk that no sidecar mentions', () => {
    // This is the drift that matters: a photo that is safely backed up and
    // completely invisible in the app.
    const plan = planRebuild({
      sidecars: [sidecar('user-1/show', 8417, [entry('a.jpg')])],
      filesOnDisk: { 'user-1/show': ['a.jpg', 'stray.jpg'] },
      attendanceIds: new Map([[attendanceKey('user-1', 8417), 1]]),
    });
    expect(plan.unlistedFiles).toEqual(['user-1/show/stray.jpg']);
  });

  it('does not count the sidecar itself as an unlisted file', () => {
    const plan = planRebuild({
      sidecars: [sidecar('user-1/show', 8417, [entry('a.jpg')])],
      filesOnDisk: { 'user-1/show': ['a.jpg', 'concert-media.json'] },
      attendanceIds: new Map([[attendanceKey('user-1', 8417), 1]]),
    });
    expect(plan.unlistedFiles).toEqual([]);
  });

  it('reports a sidecar whose concert has no attendance rather than guessing one', () => {
    // The concert may have been deleted, or this may be a restore onto a
    // database that predates the show. Inventing an attendance would assert
    // the user went somewhere they may not have.
    const plan = planRebuild({
      sidecars: [sidecar('user-1/show', 9999, [entry('a.jpg')])],
      filesOnDisk: { 'user-1/show': ['a.jpg'] },
      attendanceIds: new Map(),
    });
    expect(plan.upserts).toEqual([]);
    expect(plan.unknownConcerts).toEqual([{ relDir: 'user-1/show', concert_id: 9999, files: 1 }]);
  });

  it('carries the checksum and dimensions through from the sidecar', () => {
    const plan = planRebuild({
      sidecars: [sidecar('user-1/show', 8417, [entry('a.mp4', { kind: 'VIDEO', duration_ms: 24000, width: 1920, height: 1080 })])],
      filesOnDisk: { 'user-1/show': ['a.mp4'] },
      attendanceIds: new Map([[attendanceKey('user-1', 8417), 1]]),
    });
    expect(plan.upserts[0]).toMatchObject({
      kind: 'VIDEO', duration_ms: 24000, width: 1920, height: 1080, sha256: 'h-a.mp4',
    });
  });

  it('attaches media to the attendance row belonging to the sidecar user, not just any row for that concert', () => {
    // Two people at the same gig have two attendance rows carrying the same
    // concert_id. Keyed on the concert alone, the second overwrote the first,
    // and a restore moved someone's photos into a stranger's account — where
    // the byte routes would then have served them, since they authorise from
    // the attendance's owner.
    const plan = planRebuild({
      sidecars: [sidecar('user-2/show', 8417, [entry('a.jpg')], 'user-2')],
      filesOnDisk: { 'user-2/show': ['a.jpg'] },
      attendanceIds: new Map([
        [attendanceKey('user-1', 8417), 1],
        [attendanceKey('user-2', 8417), 2],
      ]),
    });
    expect(plan.upserts[0].attendance_id).toBe(2);
  });

  it('reports a folder whose owner disagrees with the sidecar inside it, rather than trusting either', () => {
    const plan = planRebuild({
      sidecars: [sidecar('user-1/show', 8417, [entry('a.jpg')], 'user-2')],
      filesOnDisk: { 'user-1/show': ['a.jpg'] },
      attendanceIds: new Map([[attendanceKey('user-2', 8417), 1]]),
    });
    expect(plan.upserts).toEqual([]);
    expect(plan.mismatchedUsers).toEqual([{ relDir: 'user-1/show', sidecar_user: 'user-2' }]);
  });
});

describe('collectArchive', () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rebuild-'));
  });

  it('finds a show folder, its sidecar and its files', async () => {
    const showDir = join(root, 'user-1', '2026-06-12 Oslo - Gojira');
    await mkdir(showDir, { recursive: true });
    await writeFile(join(showDir, 'concert-media.json'), JSON.stringify({
      version: 1, concert_id: 8417, user_id: 'user-1', concert: {}, files: [],
    }));
    await writeFile(join(showDir, 'a.jpg'), 'x');

    const result = await collectArchive(root);
    expect(result.sidecars).toEqual([{
      relDir: 'user-1/2026-06-12 Oslo - Gojira',
      data: expect.objectContaining({ concert_id: 8417, user_id: 'user-1' }),
    }]);
    // The sidecar file itself is a real, non-dot file in the folder — planRebuild
    // is what excludes it from drift, not the walk.
    expect(result.filesOnDisk['user-1/2026-06-12 Oslo - Gojira']).toEqual(['a.jpg', 'concert-media.json']);
    expect(result.noSidecar).toEqual([]);
  });

  it('skips a _detached folder rather than treating it as a show with no home', async () => {
    // _detached folders name a concert_id that no longer exists, so there is
    // nothing left to re-anchor them to; they stay on disk without being
    // reported as drift.
    const detachedDir = join(root, 'user-1', '_detached', '2025-01-01 Old Show');
    await mkdir(detachedDir, { recursive: true });
    await writeFile(join(detachedDir, 'a.jpg'), 'x');

    const result = await collectArchive(root);
    expect(result.sidecars).toEqual([]);
    expect(result.filesOnDisk).toEqual({});
    expect(result.noSidecar).toEqual([]);
  });

  it('reports a show with files but no sidecar', async () => {
    const showDir = join(root, 'user-1', 'orphan-show');
    await mkdir(showDir, { recursive: true });
    await writeFile(join(showDir, 'a.jpg'), 'x');

    const result = await collectArchive(root);
    expect(result.sidecars).toEqual([]);
    expect(result.noSidecar).toEqual(['user-1/orphan-show']);
  });

  it('leaves dotfiles like a poster cache and a temp sidecar write out of filesOnDisk', async () => {
    const showDir = join(root, 'user-1', 'show');
    await mkdir(join(showDir, '.posters'), { recursive: true });
    await writeFile(join(showDir, '.posters', 'a.jpg.webp'), 'x');
    await writeFile(join(showDir, '.concert-media.json.tmp'), '{}');
    await writeFile(join(showDir, 'a.jpg'), 'x');

    const result = await collectArchive(root);
    expect(result.filesOnDisk['user-1/show']).toEqual(['a.jpg']);
  });
});
