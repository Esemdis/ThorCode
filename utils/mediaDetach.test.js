import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countMediaForAttendances, sweepableConcertIds, detachAttendances, undoDetach,
} from './mediaDetach.js';

let root;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'detach-'));
  process.env.MEDIA_ROOT = root;
});

// Understands the two shapes detachAttendances asks for: the attendances it is
// detaching (`in`), and the rows under those folders belonging to anyone else
// (`notIn` plus an OR of rel_path prefixes).
const fakePrisma = (rows) => ({
  concertMedia: {
    count: vi.fn(async ({ where }) =>
      rows.filter((r) => where.attendance_id.in.includes(r.attendance_id)).length),
    findMany: vi.fn(async ({ where }) => rows.filter((r) => {
      if (where.attendance_id.in) return where.attendance_id.in.includes(r.attendance_id);
      if (where.attendance_id.notIn.includes(r.attendance_id)) return false;
      return where.OR.some((c) => r.rel_path.startsWith(c.rel_path.startsWith));
    })),
    deleteMany: vi.fn(async () => ({ count: rows.length })),
  },
});

describe('countMediaForAttendances', () => {
  it('counts the files that would be destroyed', async () => {
    const prisma = fakePrisma([{ attendance_id: 1, rel_path: 'u/show/a.jpg' }]);
    expect(await countMediaForAttendances(prisma, [1, 2])).toBe(1);
  });

  it('is zero for attendances with nothing attached', async () => {
    expect(await countMediaForAttendances(fakePrisma([]), [1])).toBe(0);
  });
});

/**
 * Concerts with the two facts the sweep decides on. The fake applies the same
 * relation filters Prisma would, so a query that drops one of them shows up here
 * as a concert being swept that should not have been.
 */
const fakeConcerts = (concerts) => ({
  concert: {
    findMany: vi.fn(async ({ where }) => concerts.filter((c) => {
      if (!where.id.in.includes(c.id)) return false;
      if (where.bands?.none && c.bands > 0) return false;
      if (where.attendances?.none && c.attendances > 0) return false;
      return true;
    }).map((c) => ({ id: c.id }))),
  },
});

describe('sweepableConcertIds', () => {
  it('sweeps a concert nobody attended once its last band is gone', async () => {
    const prisma = fakeConcerts([{ id: 10, bands: 0, attendances: 0 }]);
    expect(await sweepableConcertIds(prisma, [10])).toEqual([10]);
  });

  it('spares a concert someone attended, however few bands are left on it', async () => {
    // The bug this exists to stop: deleting a band unlinked it from every
    // concert and then swept whatever was left band-less, with no thought for
    // attendance. A gig someone had been to — and uploaded a night's
    // photographs to — was swept as debris, and the rebuild could not put it
    // back because it skips _detached and the sidecar there names a concert_id
    // that no longer exists.
    const prisma = fakeConcerts([{ id: 10, bands: 0, attendances: 1 }]);
    expect(await sweepableConcertIds(prisma, [10])).toEqual([]);
  });

  it('spares a concert that still has bands', async () => {
    const prisma = fakeConcerts([{ id: 10, bands: 2, attendances: 0 }]);
    expect(await sweepableConcertIds(prisma, [10])).toEqual([]);
  });

  it('keeps the two rules together in one query', async () => {
    // Asserted on the query itself as well as its result: a fake can be made to
    // agree with a filter that is not there, and both halves of this rule have
    // to reach Postgres.
    const prisma = fakeConcerts([]);
    await sweepableConcertIds(prisma, [10, 11]);
    expect(prisma.concert.findMany.mock.calls[0][0].where).toMatchObject({
      id: { in: [10, 11] },
      bands: { none: {} },
      attendances: { none: {} },
    });
  });

  it('sorts the attended from the unattended in one pass', async () => {
    const prisma = fakeConcerts([
      { id: 10, bands: 0, attendances: 0 },
      { id: 11, bands: 0, attendances: 3 },
      { id: 12, bands: 0, attendances: 0 },
    ]);
    expect(await sweepableConcertIds(prisma, [10, 11, 12])).toEqual([10, 12]);
  });

  it('asks nothing when there are no candidates', async () => {
    const prisma = fakeConcerts([]);
    expect(await sweepableConcertIds(prisma, [])).toEqual([]);
    expect(prisma.concert.findMany).not.toHaveBeenCalled();
  });
});

describe('detachAttendances', () => {
  it('moves the show folder under _detached rather than deleting it', async () => {
    // The concert row may legitimately be going away. The photographs are not.
    await mkdir(join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira'), { recursive: true });
    await writeFile(join(root, 'archive', 'user-1', '2026-06-12 Oslo - Gojira', 'a.jpg'), 'x');

    const prisma = fakePrisma([
      { attendance_id: 1, rel_path: 'user-1/2026-06-12 Oslo - Gojira/a.jpg' },
    ]);
    const result = await detachAttendances(prisma, [1]);

    expect(result.detached).toBe(1);
    const moved = join(root, 'archive', 'user-1', '_detached', '2026-06-12 Oslo - Gojira');
    expect(await readdir(moved)).toContain('a.jpg');
  });

  it('deletes the rows once the bytes are safely moved', async () => {
    await mkdir(join(root, 'archive', 'u', 'show'), { recursive: true });
    const prisma = fakePrisma([{ attendance_id: 1, rel_path: 'u/show/a.jpg' }]);
    await detachAttendances(prisma, [1]);
    expect(prisma.concertMedia.deleteMany).toHaveBeenCalledWith({
      where: { attendance_id: { in: [1] } },
    });
  });

  it('does nothing and touches no rows when there is no media', async () => {
    const prisma = fakePrisma([]);
    expect(await detachAttendances(prisma, [1])).toEqual({ detached: 0, folders: [] });
    expect(prisma.concertMedia.deleteMany).not.toHaveBeenCalled();
  });

  it('suffixes rather than overwriting when a detached folder of that name exists', async () => {
    // Two shows at the same venue on the same date is implausible, but a
    // repeated detach of a rebuilt row is not, and a silent overwrite here
    // destroys the thing this function exists to preserve.
    await mkdir(join(root, 'archive', 'u', 'show'), { recursive: true });
    await mkdir(join(root, 'archive', 'u', '_detached', 'show'), { recursive: true });
    const prisma = fakePrisma([{ attendance_id: 1, rel_path: 'u/show/a.jpg' }]);
    await detachAttendances(prisma, [1]);
    const entries = await readdir(join(root, 'archive', 'u', '_detached'));
    expect(entries).toContain('show');
    expect(entries.some((e) => e.startsWith('show ('))).toBe(true);
  });

  it('refuses to move a folder holding a live attendance it was not asked to detach', async () => {
    // Probed: with two attendances' files in one folder — which happens when a
    // sidecar is removed by hand and the next show adopts the directory —
    // detaching one renamed the folder into _detached with the other's
    // photographs still inside. The surviving rows then pointed at a path that
    // no longer existed, and the rebuild reported nothing, because
    // collectArchive skips _detached by design.
    await mkdir(join(root, 'archive', 'u', 'show'), { recursive: true });
    const prisma = fakePrisma([
      { attendance_id: 1, rel_path: 'u/show/a.jpg' },
      { attendance_id: 2, rel_path: 'u/show/b.jpg' },
    ]);

    await expect(detachAttendances(prisma, [1])).rejects.toThrow(/attendance 2/);
    expect(await readdir(join(root, 'archive', 'u'))).toEqual(['show']);
    expect(prisma.concertMedia.deleteMany).not.toHaveBeenCalled();
  });

  it('leaves the rows alone if the move fails', async () => {
    // Deleting the index while the files are still where the index says they
    // are is recoverable. Deleting it after a failed move is not.
    const prisma = fakePrisma([{ attendance_id: 1, rel_path: 'u/missing/a.jpg' }]);
    await expect(detachAttendances(prisma, [1])).rejects.toThrow();
    expect(prisma.concertMedia.deleteMany).not.toHaveBeenCalled();
  });
});

// The folder renames are the one part of a detach Postgres cannot roll back.
// Every caller runs detachAttendances inside an interactive transaction, so a
// statement failing after it returns restores the ConcertMedia rows while the
// folders stay in _detached — every rel_path pointing at nothing. It is silent
// too: collectArchive skips _detached by design, so the rebuild reports no
// drift at all. These cover putting the folders back.
describe('undoDetach', () => {
  const showDir = () => join(root, 'archive', 'u', 'show');

  it('records where each folder came from, so a caller can reverse it', async () => {
    await mkdir(showDir(), { recursive: true });
    const prisma = fakePrisma([{ attendance_id: 1, rel_path: 'u/show/a.jpg' }]);

    const moved = [];
    await detachAttendances(prisma, [1], { moved });

    expect(moved).toEqual([{
      from: showDir(),
      to: join(root, 'archive', 'u', '_detached', 'show'),
    }]);
  });

  it('puts the folder back where the detach found it', async () => {
    await mkdir(showDir(), { recursive: true });
    await writeFile(join(showDir(), 'a.jpg'), 'x');
    const prisma = fakePrisma([{ attendance_id: 1, rel_path: 'u/show/a.jpg' }]);

    const moved = [];
    await detachAttendances(prisma, [1], { moved });
    expect(await undoDetach(moved)).toEqual([]);

    expect(await readdir(showDir())).toContain('a.jpg');
    expect(await readdir(join(root, 'archive', 'u', '_detached'))).toEqual([]);
  });

  it('empties the list it was given, so a second call cannot move them again', async () => {
    await mkdir(showDir(), { recursive: true });
    const prisma = fakePrisma([{ attendance_id: 1, rel_path: 'u/show/a.jpg' }]);
    const moved = [];
    await detachAttendances(prisma, [1], { moved });

    await undoDetach(moved);
    expect(moved).toEqual([]);
    // The second call is a no-op rather than a rename of a folder that is
    // already home — which, with a suffixed name, would move the wrong one.
    expect(await undoDetach(moved)).toEqual([]);
    expect(await readdir(showDir())).toEqual([]);
  });

  it('reports what it could not put back rather than throwing over it', async () => {
    // The caller is already unwinding a failed transaction and has its own
    // error to rethrow. A throw here would replace the cause with a symptom.
    const failed = await undoDetach([{ from: join(root, 'nope', 'show'), to: join(root, 'also-nope') }]);
    expect(failed).toHaveLength(1);
    expect(failed[0].to).toBe(join(root, 'also-nope'));
  });

  it('reverses a partly-finished detach, including the move that suffixed', async () => {
    // Two folders, the second of which collides in _detached and so lands as
    // 'show (2)'. Undoing in insertion order would rename 'show' back first
    // and then find 'show (2)' still sitting there — reverse order is what
    // makes the pair unwind cleanly.
    await mkdir(join(root, 'archive', 'u', 'a', 'show'), { recursive: true });
    await mkdir(join(root, 'archive', 'u', '_detached'), { recursive: true });
    const prisma = fakePrisma([
      { attendance_id: 1, rel_path: 'u/show/a.jpg' },
      { attendance_id: 1, rel_path: 'u/a/show/b.jpg' },
    ]);
    await mkdir(join(root, 'archive', 'u', 'show'), { recursive: true });

    const moved = [];
    await detachAttendances(prisma, [1], { moved });
    expect(moved).toHaveLength(2);

    expect(await undoDetach(moved)).toEqual([]);
    expect(await readdir(join(root, 'archive', 'u', '_detached'))).toEqual([]);
    expect(await readdir(join(root, 'archive', 'u'))).toEqual(
      expect.arrayContaining(['show', 'a', '_detached']),
    );
  });
});
