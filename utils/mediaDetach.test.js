import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countMediaForAttendances, detachAttendances } from './mediaDetach.js';

let root;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'detach-'));
  process.env.MEDIA_ROOT = root;
});

const fakePrisma = (rows) => ({
  concertMedia: {
    count: vi.fn(async ({ where }) =>
      rows.filter((r) => where.attendance_id.in.includes(r.attendance_id)).length),
    findMany: vi.fn(async ({ where }) =>
      rows.filter((r) => where.attendance_id.in.includes(r.attendance_id))),
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

  it('leaves the rows alone if the move fails', async () => {
    // Deleting the index while the files are still where the index says they
    // are is recoverable. Deleting it after a failed move is not.
    const prisma = fakePrisma([{ attendance_id: 1, rel_path: 'u/missing/a.jpg' }]);
    await expect(detachAttendances(prisma, [1])).rejects.toThrow();
    expect(prisma.concertMedia.deleteMany).not.toHaveBeenCalled();
  });
});
