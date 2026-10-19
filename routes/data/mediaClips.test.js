import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';
import { namedClips } from '../../utils/namedClips.js';
import { planRebuild, attendanceKey } from '../../utils/mediaRebuild.js';

const prisma = installFakePrisma({
  concertMedia: { findMany: vi.fn() },
  mediaClip: { deleteMany: vi.fn(), createMany: vi.fn() },
  $transaction: vi.fn(),
});
const router = (await import('./media.js')).default ?? (await import('./media.js'));

const folder = '2026-06-12 Oslo - Gojira';
let root;
const dirFor = () => join(root, 'archive', 'user-1', folder);
const readSidecarFile = async () => JSON.parse(await readFile(join(dirFor(), 'concert-media.json'), 'utf8'));

const videoRowForClips = (over = {}) => ({
  id: 5,
  attendance_id: 1,
  rel_path: `user-1/${folder}/VID_1.mp4`,
  filename: 'VID_1.mp4',
  kind: 'VIDEO',
  sha256: 'h5',
  bytes: 99999,
  width: 1920,
  height: 1080,
  duration_ms: 214000,
  caption: null,
  taken_at: null,
  band_id: 92,
  song: null,
  picked: false,
  moment_start_ms: null,
  moment_end_ms: null,
  attendance_rel: {
    wishlist_rel: { user_id: 'user-1' },
    concert_rel: {
      id: 8417, concert_date: new Date('2026-06-12T19:00:00Z'), venue: 'Sentrum Scene',
      city: 'Oslo', country: 'NO', bands: [{ band_rel: { id: 92, name: 'Gojira' } }],
    },
  },
  ...over,
});

const putClips = (clips, user = { id: 'user-1', role: 'ADMIN' }, id = 5) => request(buildApp(router, '/data/concerts'))
  .put(`/data/concerts/media/${id}/clips`)
  .set(...authHeader(user))
  .send({ clips });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'media-clips-'));
  process.env.MEDIA_ROOT = root;
  await mkdir(dirFor(), { recursive: true });
  prisma.concertMedia.findMany = vi.fn(async () => [videoRowForClips()]);
  prisma.mediaClip.deleteMany = vi.fn((a) => ({ op: 'deleteMany', a }));
  prisma.mediaClip.createMany = vi.fn((a) => ({ op: 'createMany', a }));
  prisma.$transaction = vi.fn(async (ops) => ops);
});

describe('PUT /media/:id/clips', () => {
  it('replaces the video\'s clips in Postgres and in the sidecar, in start order', async () => {
    const res = await putClips([
      { name: ' Encore ', start_ms: 150000, end_ms: 200000 },
      { name: 'Intro', start_ms: 1000, end_ms: 40000 },
    ]).expect(200);

    const want = [
      { name: 'Intro', start_ms: 1000, end_ms: 40000 },
      { name: 'Encore', start_ms: 150000, end_ms: 200000 },
    ];
    expect(res.body.data.clips).toEqual(want);
    expect(prisma.mediaClip.deleteMany).toHaveBeenCalledWith({ where: { media_id: 5 } });
    expect(prisma.mediaClip.createMany).toHaveBeenCalledWith({ data: want.map((c) => ({ ...c, media_id: 5 })) });
    expect((await readSidecarFile()).files[0]).toMatchObject({ name: 'VID_1.mp4', band_name: 'Gojira', clips: want });
  });

  it('keeps what an existing sidecar entry says about the file', async () => {
    await writeFile(join(dirFor(), 'concert-media.json'), JSON.stringify({
      version: 1, concert_id: 8417, user_id: 'user-1',
      concert: { date: '2026-06-12', venue: 'Sentrum Scene', city: 'Oslo', country: 'NO' },
      files: [{ name: 'VID_1.mp4', kind: 'VIDEO', caption: 'by hand', sha256: 'h5', bytes: 99999, duration_ms: 214000 }],
    }));

    await putClips([{ name: 'Intro', start_ms: 0, end_ms: 5000 }]).expect(200);

    expect((await readSidecarFile()).files[0]).toMatchObject({ caption: 'by hand', clips: [{ name: 'Intro' }] });
  });

  it('clears them with an empty list', async () => {
    await putClips([]).expect(200);

    expect(prisma.mediaClip.createMany).toHaveBeenCalledWith({ data: [] });
    expect((await readSidecarFile()).files[0].clips).toEqual([]);
  });

  it('refuses a plain user, and someone else\'s video, writing nothing', async () => {
    await putClips([], { id: 'user-1', role: 'USER' }).expect(403);
    await putClips([], { id: 'someone-else', role: 'ADMIN' }).expect(403);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a photo and a video that is not there', async () => {
    prisma.concertMedia.findMany = vi.fn(async () => [videoRowForClips({ kind: 'PHOTO' })]);
    await putClips([]).expect(400);
    prisma.concertMedia.findMany = vi.fn(async () => []);
    await putClips([]).expect(404);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['an unnamed clip', [{ name: ' ', start_ms: 0, end_ms: 5000 }]],
    ['one that ends before it starts', [{ name: 'A', start_ms: 9000, end_ms: 5000 }]],
    ['one under a second', [{ name: 'A', start_ms: 0, end_ms: 500 }]],
    ['one that starts after the video ends', [{ name: 'A', start_ms: 214000, end_ms: 220000 }]],
    ['a fractional start', [{ name: 'A', start_ms: 0.5, end_ms: 5000 }]],
  ])('refuses %s', async (_what, clips) => {
    await putClips(clips).expect(400);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('namedClips', () => {
  it('ends a clip asked to run past the video on its last frame, and allows more than the recap\'s 25 seconds', () => {
    expect(namedClips([{ name: 'Set', start_ms: 10000, end_ms: 999999 }], { durationMs: 214000 }))
      .toEqual({ clips: [{ name: 'Set', start_ms: 10000, end_ms: 214000 }] });
  });
});

describe('a rebuild from the sidecar', () => {
  const plan = (files) => planRebuild({
    sidecars: [{ relDir: 'user-1/show', data: { version: 1, concert_id: 8417, user_id: 'user-1', concert: {}, files } }],
    filesOnDisk: { 'user-1/show': files.map((f) => f.name) },
    attendanceIds: new Map([[attendanceKey('user-1', 8417), 1]]),
  });
  const entry = (over) => ({
    name: 'a.mp4', kind: 'VIDEO', sha256: 'h', bytes: 10, duration_ms: 60000, ...over,
  });

  it('brings a video\'s clips back, and none for one that has none', () => {
    const { upserts } = plan([entry({ clips: [{ name: 'Intro', start_ms: 0, end_ms: 5000 }] }), entry({ name: 'b.mp4' })]);

    expect(upserts.map((u) => u.clips)).toEqual([[{ name: 'Intro', start_ms: 0, end_ms: 5000 }], []]);
  });

  it('reports an entry whose clips are malformed rather than indexing it', () => {
    const { upserts, malformedEntries } = plan([entry({ clips: [{ name: 'Intro', start_ms: '0', end_ms: 5000 }] })]);

    expect(upserts).toEqual([]);
    expect(malformedEntries[0].reason).toMatch(/^clips:/);
  });
});
