import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp, authHeader, installFakePrisma } from '../../../test/routeApp.js';

// A client with two bands and nothing pointing at them. The table moves are
// covered in utils/bandMerge.test.js; this is about the HTTP edges.
const tho999Bands = new Map();
const prisma = installFakePrisma({
  $queryRaw: vi.fn(async () => []),
  band: {
    findUnique: vi.fn(async ({ where }) => tho999Bands.get(where.id) ?? null),
    delete: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
  },
  ...Object.fromEntries(['concertBandReference', 'wishlistBandReference', 'attendanceMissedBand', 'concertDelivery', 'notificationSubscription', 'concertMedia']
    .map((m) => [m, {
      findMany: vi.fn(async () => []), update: vi.fn(), deleteMany: vi.fn(async () => ({ count: 0 })), updateMany: vi.fn(async () => ({ count: 0 })),
    }])),
  $transaction: vi.fn(async (fn) => fn(prisma)),
});

const { default: router } = await import('./merge.js');
const app = buildApp(router);
const admin = authHeader({ role: 'ADMIN' });

beforeEach(() => {
  vi.clearAllMocks();
  tho999Bands.clear();
  tho999Bands.set(1, { id: 1, name: 'Opeth (SE)', MBID: 'mb-1', spotify_id: null, ticketmaster_id: null });
  tho999Bands.set(2, { id: 2, name: 'Opeth', MBID: 'mb-2', spotify_id: null, ticketmaster_id: null });
});

describe('POST /bands/:bandId/merge-into/:targetId', () => {
  it('is for admins only', async () => {
    const res = await request(app).post('/bands/1/merge-into/2').set(...authHeader());
    expect(res.status).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses to merge a band into itself, which would delete it', async () => {
    const res = await request(app).post('/bands/2/merge-into/2').set(...admin);
    expect(res.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses an id that is not a whole number before it reaches a where', async () => {
    expect((await request(app).post('/bands/1.5/merge-into/2').set(...admin)).status).toBe(400);
    expect((await request(app).post('/bands/x/merge-into/2').set(...admin)).status).toBe(400);
  });

  it('answers 404 naming the band that is gone', async () => {
    tho999Bands.delete(2);
    const res = await request(app).post('/bands/1/merge-into/2').set(...admin);
    expect(res.status).toBe(404);
    expect(res.body.bandId).toBe(2);
  });

  it('answers 409 with the conflicting ids, and deletes nothing', async () => {
    const res = await request(app).post('/bands/1/merge-into/2').set(...admin);
    expect(res.status).toBe(409);
    expect(res.body.conflicts).toEqual([{ field: 'MBID', source: 'mb-1', target: 'mb-2' }]);
    expect(prisma.band.delete).not.toHaveBeenCalled();
  });

  it('merges anyway with ?force=1 and says which ids it overrode', async () => {
    const res = await request(app).post('/bands/1/merge-into/2?force=1').set(...admin);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'success',
      survivor: { id: 2, name: 'Opeth' },
      overridden: [{ field: 'MBID', source: 'mb-1', target: 'mb-2' }],
      retaggedFiles: 0,
      retagFailed: 0,
    });
    expect(prisma.band.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it('does not take ?force=0 or ?force=false as a force', async () => {
    // A loose truthiness check would read both as "yes" and skip the question.
    expect((await request(app).post('/bands/1/merge-into/2?force=0').set(...admin)).status).toBe(409);
    expect((await request(app).post('/bands/1/merge-into/2?force=false').set(...admin)).status).toBe(409);
  });

  it('runs the merge in one transaction with a long timeout, since a big band moves thousands of rows', async () => {
    tho999Bands.set(1, { ...tho999Bands.get(1), MBID: null });
    await request(app).post('/bands/1/merge-into/2').set(...admin).expect(200);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][1]).toEqual({ timeout: 30000 });
  });
});
