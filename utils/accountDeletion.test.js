import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtemp, mkdir, writeFile, readFile, access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACCOUNT_DELETION_ORDER,
  DELETED_BEFORE_TRANSACTION,
  accountDeletionRefusal,
  accountDeletionOperations,
  userArchiveDir,
  removeAccountMedia,
  removeDerivedCopies,
} from './accountDeletion.js';

const accountDeletionExists = (p) => access(p).then(() => true, () => false);

/**
 * Every relation in the schema, from the side that holds the foreign key:
 * which model holds it, which model it points at, and its onDelete.
 */
function accountDeletionRelations(schema) {
  const relations = [];
  let model = null;
  for (const line of schema.split('\n')) {
    const opened = line.match(/^model (\w+) \{/);
    if (opened) { [, model] = opened; continue; }
    if (line.startsWith('}')) { model = null; continue; }
    if (!model || !line.includes('@relation(') || !line.includes('fields:')) continue;
    const [, type] = line.trim().split(/\s+/);
    const onDelete = line.match(/onDelete:\s*(\w+)/)?.[1] ?? 'Restrict';
    relations.push({ from: model, to: type.replace(/[?[\]]/g, ''), onDelete });
  }
  return relations;
}

// Prisma's client property for a model: only the first letter lower-cased.
const accessorOf = (model) => model[0].toLowerCase() + model.slice(1);

describe('the order an account is deleted in', () => {
  // The guard for the next table that points at a user. Without a cascade it
  // blocks the delete, Postgres refuses with a foreign-key error, and the
  // person asking to leave gets a 500 with all their data still there.
  it('deletes every row that would block a later delete before it, as the schema stands', async () => {
    const schema = await readFile(join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
    const order = [...ACCOUNT_DELETION_ORDER.map((s) => s.model), 'user'];
    const handled = new Set([...order, ...DELETED_BEFORE_TRANSACTION]);

    const problems = [];
    for (const { from, to, onDelete } of accountDeletionRelations(schema)) {
      const target = accessorOf(to);
      const holder = accessorOf(from);
      if (!handled.has(target) || onDelete === 'Cascade' || onDelete === 'SetNull' || from === to) continue;
      if (!handled.has(holder)) {
        problems.push(`${from} points at ${to} without a cascade and is never deleted`);
      } else if (!DELETED_BEFORE_TRANSACTION.includes(holder) && order.indexOf(holder) > order.indexOf(target)) {
        problems.push(`${from} is deleted after ${to}, which it blocks`);
      }
    }
    expect(problems).toEqual([]);
  });

  // The parser above must actually see these, or the test passes on nothing.
  it('reads the relations it guards from the schema', async () => {
    const schema = await readFile(join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
    const relations = accountDeletionRelations(schema);

    expect(relations).toContainEqual({ from: 'Trip', to: 'User', onDelete: 'Restrict' });
    expect(relations).toContainEqual({ from: 'ConcertMedia', to: 'ConcertAttendance', onDelete: 'Restrict' });
    expect(relations).toContainEqual({ from: 'VenueReview', to: 'User', onDelete: 'Cascade' });
  });

  it('builds one deleteMany per table and deletes the user last', () => {
    const calls = [];
    const fake = new Proxy({}, {
      get: (_, model) => ({
        deleteMany: (args) => { calls.push([model, 'deleteMany', args]); return model; },
        delete: (args) => { calls.push([model, 'delete', args]); return model; },
      }),
    });

    const ops = accountDeletionOperations(fake, 'u-del');

    expect(ops).toHaveLength(ACCOUNT_DELETION_ORDER.length + 1);
    expect(calls.at(-1)).toEqual(['user', 'delete', { where: { id: 'u-del' } }]);
    expect(calls).toContainEqual(['oAuth', 'deleteMany', { where: { user: 'u-del' } }]);
    expect(calls).toContainEqual(['concertAttendance', 'deleteMany', { where: { wishlist_rel: { user_id: 'u-del' } } }]);
    expect(calls).toContainEqual(['trip', 'deleteMany', { where: { user_id: 'u-del' } }]);
  });
});

describe('accountDeletionRefusal', () => {
  it('lets an ordinary user go', () => {
    expect(accountDeletionRefusal({ role: 'USER' }, 0)).toBeNull();
  });

  // The sync service signs in as it; deleting it stops every sync.
  it('refuses the service account', () => {
    expect(accountDeletionRefusal({ role: 'SYSTEM' }, 1)).toMatchObject({ status: 403 });
  });

  it('refuses the last admin, and lets one of two go', () => {
    expect(accountDeletionRefusal({ role: 'ADMIN' }, 1)).toMatchObject({ status: 409 });
    expect(accountDeletionRefusal({ role: 'ADMIN' }, 2)).toBeNull();
  });
});

describe('userArchiveDir', () => {
  beforeEach(() => { process.env.MEDIA_ROOT = '/media'; });
  afterEach(() => { delete process.env.MEDIA_ROOT; });

  it('is the user\'s own folder under the archive', () => {
    expect(userArchiveDir('abc123')).toBe('/media/archive/abc123');
  });

  // The folder is removed with everything in it, so a missing id must not
  // quietly name some other folder.
  it('refuses a missing or blank id', () => {
    expect(() => userArchiveDir('')).toThrow(/Refusing/);
    expect(() => userArchiveDir('  ')).toThrow(/Refusing/);
    expect(() => userArchiveDir(undefined)).toThrow(/Refusing/);
  });
});

describe('removeAccountMedia', () => {
  let root;
  const show = 'gone-user/2026-06-12 Oslo - Gojira';
  const accountDeletionRow = (id, filename, extra = {}) => ({
    id, filename, kind: 'PHOTO', rel_path: `${show}/${filename}`, sha256: `sha-${id}`, ...extra,
  });
  const fakeAccountPrisma = (rows) => ({
    concertMedia: { findMany: vi.fn(async () => rows), deleteMany: vi.fn(async () => ({})) },
    mediaShareLink: { findMany: vi.fn(async () => []) },
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'account-delete-'));
    process.env.MEDIA_ROOT = root;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.MEDIA_ROOT;
    vi.restoreAllMocks();
  });

  it('removes the user\'s whole folder, detached shows included, and leaves other users alone', async () => {
    const dir = join(root, 'archive', show);
    await mkdir(join(dir, '.posters'), { recursive: true });
    await writeFile(join(dir, 'IMG_1.jpg'), 'photo');
    await writeFile(join(dir, 'VID_1.mp4'), 'video');
    await writeFile(join(dir, '.posters', 'VID_1.mp4.webp'), 'poster');
    await writeFile(join(dir, 'concert-media.json'), JSON.stringify({
      version: 1, files: [{ name: 'IMG_1.jpg' }, { name: 'VID_1.mp4' }],
    }));
    // No row points into _detached; only removing the folder reaches it.
    const detached = join(root, 'archive', 'gone-user', '_detached', '2025-01-01 Bergen - Enslaved');
    await mkdir(detached, { recursive: true });
    await writeFile(join(detached, 'IMG_9.jpg'), 'detached photo');
    const stranger = join(root, 'archive', 'staying-user', 'night');
    await mkdir(stranger, { recursive: true });
    await writeFile(join(stranger, 'IMG_1.jpg'), 'someone else');

    const prisma = fakeAccountPrisma([
      accountDeletionRow(1, 'IMG_1.jpg'),
      accountDeletionRow(2, 'VID_1.mp4', { kind: 'VIDEO', sha256: 'sha-1' }),
    ]);
    const result = await removeAccountMedia(prisma, 'gone-user');

    expect(result).toEqual({ ok: true, sha256s: ['sha-1'] });
    expect(await accountDeletionExists(join(root, 'archive', 'gone-user'))).toBe(false);
    expect(await readFile(join(stranger, 'IMG_1.jpg'), 'utf8')).toBe('someone else');
    expect(prisma.concertMedia.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [1, 2] } } });
  });

  // A photograph removed cannot be put back, so a file that would not go
  // stops everything after it: the caller deletes no other rows, and the
  // row for that file stays so a retry can find it.
  it('stops, keeping the row of a file that would not go and the folder, when one fails', async () => {
    const prisma = fakeAccountPrisma([accountDeletionRow(1, 'IMG_1.jpg'), accountDeletionRow(2, 'IMG_2.jpg')]);
    const removeDir = vi.fn();
    const remove = vi.fn(async () => ({ removed: [1], failed: [{ id: 2, error: 'EBUSY' }] }));

    const result = await removeAccountMedia(prisma, 'gone-user', { remove, removeDir });

    expect(result.ok).toBe(false);
    expect(prisma.concertMedia.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [1] } } });
    expect(removeDir).not.toHaveBeenCalled();
  });

  it('reports a folder that would not go', async () => {
    const prisma = fakeAccountPrisma([]);
    const removeDir = vi.fn(async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); });

    expect(await removeAccountMedia(prisma, 'gone-user', { removeDir })).toEqual({ ok: false, sha256s: [] });
  });

  it('needs no archive for a user who never uploaded on a server without one', async () => {
    delete process.env.MEDIA_ROOT;
    const removeDir = vi.fn();

    const result = await removeAccountMedia(fakeAccountPrisma([]), 'gone-user', { removeDir });

    expect(result).toEqual({ ok: true, sha256s: [] });
    expect(removeDir).not.toHaveBeenCalled();
  });
});

describe('removeDerivedCopies', () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'account-cache-'));
    process.env.MEDIA_ROOT = root;
    await mkdir(join(root, 'cache', 'thumbs'), { recursive: true });
    await mkdir(join(root, 'cache', 'display'), { recursive: true });
  });
  afterEach(() => { delete process.env.MEDIA_ROOT; });

  // Keyed by checksum, so a photograph someone else also uploaded shares its
  // thumbnail with theirs.
  it('removes thumbnails and display copies no remaining file shares', async () => {
    for (const sha of ['mine', 'shared']) {
      await writeFile(join(root, 'cache', 'thumbs', `${sha}.webp`), 't');
      await writeFile(join(root, 'cache', 'display', `${sha}.webp`), 'd');
    }
    const prisma = { concertMedia: { findMany: vi.fn(async () => [{ sha256: 'shared' }]) } };

    await removeDerivedCopies(prisma, ['mine', 'shared', 'never-cached']);

    expect(await accountDeletionExists(join(root, 'cache', 'thumbs', 'mine.webp'))).toBe(false);
    expect(await accountDeletionExists(join(root, 'cache', 'display', 'mine.webp'))).toBe(false);
    expect(await accountDeletionExists(join(root, 'cache', 'thumbs', 'shared.webp'))).toBe(true);
  });
});
