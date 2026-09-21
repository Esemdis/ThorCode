import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attendanceKey, collectArchive, planRebuild, applyUpserts } from './mediaRebuild.js';
import { showFolderRelPath } from './mediaPaths.js';

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

  it('carries the song a video was tagged with back out of the sidecar', () => {
    // The sidecar is the record of truth and Postgres is rebuilt from it, so a
    // field the rebuild does not copy is a tag that survives the backup and
    // then quietly disappears the first time the index is rebuilt.
    const plan = planRebuild({
      sidecars: [sidecar('user-1/show', 8417, [entry('a.mp4', { kind: 'VIDEO', song: 'Stranded' })])],
      filesOnDisk: { 'user-1/show': ['a.mp4'] },
      attendanceIds: new Map([[attendanceKey('user-1', 8417), 1]]),
    });
    expect(plan.upserts[0]).toMatchObject({ song: 'Stranded' });
  });

  it('reads a sidecar written before songs existed as a file with no song', () => {
    // Every entry in the archive today predates this field. An undefined here
    // reaching Prisma is not the same as a null, so it is normalised.
    const plan = planRebuild({
      sidecars: [sidecar('user-1/show', 8417, [entry('a.mp4', { kind: 'VIDEO' })])],
      filesOnDisk: { 'user-1/show': ['a.mp4'] },
      attendanceIds: new Map([[attendanceKey('user-1', 8417), 1]]),
    });
    expect(plan.upserts[0].song).toBeNull();
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

  it.each([
    ['a kind someone deleted because they did not understand it', { kind: undefined }],
    ['a kind that is not one of the two', { kind: 'AUDIO' }],
    ['a number someone put quotes around', { bytes: '12345' }],
    ['a dimension replaced with a word', { width: 'unknown' }],
    ['a checksum blanked out', { sha256: '' }],
    ['a name that is not there at all', { name: undefined }],
  ])('routes an entry with %s into malformedEntries rather than into an upsert', (_label, over) => {
    // The sidecar is a text file the spec invites a human to read and touch.
    // Passed through verbatim, one of these became an upsert Postgres refused,
    // and the script's bare loop stopped there — every show after it in walk
    // order left unindexed, on the one day this runs.
    const plan = planRebuild({
      sidecars: [sidecar('user-1/show', 8417, [entry('a.jpg', over)])],
      filesOnDisk: { 'user-1/show': ['a.jpg'] },
      attendanceIds: new Map([[attendanceKey('user-1', 8417), 1]]),
    });
    expect(plan.upserts).toEqual([]);
    expect(plan.malformedEntries).toHaveLength(1);
    expect(plan.malformedEntries[0]).toMatchObject({ relDir: 'user-1/show' });
  });

  it('accepts an entry whose nullable numbers are absent, which is what a photo actually looks like', () => {
    // width/height/duration_ms are nullable columns and a photo with no probe
    // data leaves them null. Rejecting those would refuse most of the archive.
    const plan = planRebuild({
      sidecars: [sidecar('user-1/show', 8417, [
        entry('a.jpg', { width: null, height: undefined, duration_ms: null }),
      ])],
      filesOnDisk: { 'user-1/show': ['a.jpg'] },
      attendanceIds: new Map([[attendanceKey('user-1', 8417), 1]]),
    });
    expect(plan.malformedEntries).toEqual([]);
    expect(plan.upserts).toHaveLength(1);
  });

  it('does not report a malformed entry a second time as a file nothing mentions', () => {
    // The file is named by the sidecar; it is the entry that is wrong. Two
    // complaints about one problem sends an operator looking twice.
    const plan = planRebuild({
      sidecars: [sidecar('user-1/show', 8417, [entry('a.jpg', { kind: 'AUDIO' })])],
      filesOnDisk: { 'user-1/show': ['a.jpg'] },
      attendanceIds: new Map([[attendanceKey('user-1', 8417), 1]]),
    });
    expect(plan.unlistedFiles).toEqual([]);
  });

  it('indexes a user whose id the folder name had to slug, instead of calling the archive corrupt', () => {
    // showFolderRelPath runs the id through slugSegment to make the folder, so
    // the folder segment and the sidecar's raw user_id are only ever equal by
    // luck. User.id is a String that merely defaults to a uuid; a federated
    // 'auth0|...' id, a colon, a leading space all survive in the database and
    // all get rewritten on the way to a directory name. Compared raw, every
    // one of that user's shows read as corrupt and not one of their files was
    // indexed — a healthy archive declared broken on restore day.
    const uid = 'auth0|6423ff';
    const relDir = `${showFolderRelPath(uid, { date: '2026-06-12', city: 'Oslo', headliner: 'Gojira' })}`;
    expect(relDir.split('/')[0]).not.toBe(uid); // the premise: the folder is slugged

    const plan = planRebuild({
      sidecars: [sidecar(relDir, 8417, [entry('a.jpg')], uid)],
      filesOnDisk: { [relDir]: ['a.jpg'] },
      attendanceIds: new Map([[attendanceKey(uid, 8417), 1]]),
    });

    expect(plan.mismatchedUsers).toEqual([]);
    expect(plan.upserts).toHaveLength(1);
    expect(plan.upserts[0].attendance_id).toBe(1);
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

  it('reports an archive that is not there instead of throwing at the operator', async () => {
    // A rebuild before the first upload does this, but the case that matters
    // is a share that failed to mount: the right answer is "there is nothing
    // here, check the mount", and a stack trace is not it.
    const result = await collectArchive(join(root, 'not-mounted'));
    expect(result).toMatchObject({
      sidecars: [], filesOnDisk: {}, noSidecar: [], archiveMissing: true,
    });
  });

  it('says an archive that is merely empty is not a missing one', async () => {
    expect(await collectArchive(root)).toMatchObject({ sidecars: [], archiveMissing: false });
  });
});

describe('applyUpserts', () => {
  const row = (filename) => ({
    attendance_id: 1, filename, rel_path: `user-1/show/${filename}`, kind: 'PHOTO',
  });

  it('keeps indexing the rest of the archive after Postgres refuses one row', async () => {
    // The loop used to be a bare `for ... await` in the script's main(), so a
    // single rejection propagated to the top-level catch and stopped there,
    // leaving every show after it in walk order unindexed. A partial index
    // plus a stack trace is the worst outcome available on restore day.
    const prisma = {
      concertMedia: {
        upsert: vi.fn(async ({ create }) => {
          if (create.filename === 'bad.jpg') throw new Error('kind must not be null');
          return create;
        }),
      },
    };

    const result = await applyUpserts(prisma, [row('a.jpg'), row('bad.jpg'), row('c.jpg')]);

    expect(prisma.concertMedia.upsert).toHaveBeenCalledTimes(3);
    expect(result.indexed).toBe(2);
    expect(result.rejected).toEqual([
      { rel_path: 'user-1/show/bad.jpg', reason: 'kind must not be null' },
    ]);
  });
});
