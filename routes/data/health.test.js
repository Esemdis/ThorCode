import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp, authHeader, installFakePrisma, routeManifest } from '../../test/routeApp.js';

const model = () => ({
  findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn(),
  create: vi.fn(), update: vi.fn(),
});

// Seeded before the router is imported — see installFakePrisma for why this is
// a global rather than a vi.mock.
const prisma = installFakePrisma({
  band: model(),
  concert: model(),
  $transaction: vi.fn(async (arg) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
});

const { default: router } = await import('./health.js');
const app = buildApp(router);

const admin = { role: 'ADMIN' };

beforeEach(() => {
  vi.clearAllMocks();
  // Answered in the order the route asks, so a number moving between fields
  // shows up here as a wrong number rather than as nothing at all.
  const bandCounts = [900, 12, 34, 56, 78];
  const concertCounts = [4000, 7, 19, 210, 40, 31, 3];
  prisma.band.count.mockImplementation(async () => bandCounts.shift() ?? 0);
  prisma.concert.count.mockImplementation(async () => concertCounts.shift() ?? 0);
});

describe('GET /health', () => {
  it('reports what each nightly job has waiting, as counts', async () => {
    const res = await request(app)
      .get('/health')
      .set(...authHeader(admin))
      .expect(200);

    expect(res.body.bands).toMatchObject({
      total: 900, no_setlist: 12, stale_setlist: 34, no_spotify_id: 56, photo_stale: 78,
    });
    expect(res.body.concerts).toMatchObject({ upcoming: 4000, no_coordinates: 7 });
    expect(res.body.weather).toMatchObject({ missing: 19, refreshable: 210 });
    expect(res.body.setlists).toMatchObject({
      queue: 40, never_checked: 31, checked_today: 3,
    });
  });

  it('counts rather than listing, so a browser can afford to ask', async () => {
    // The cron feeds this mirrors return every matching row — thousands of
    // them. A panel that asked those would move megabytes to render a number.
    await request(app).get('/health').set(...authHeader(admin)).expect(200);

    expect(prisma.concert.findMany).not.toHaveBeenCalled();
    expect(prisma.band.findMany).not.toHaveBeenCalled();
  });

  it('asks in one round trip', async () => {
    // Twelve sequential counts against a remote database is twelve latencies.
    await request(app).get('/health').set(...authHeader(admin)).expect(200);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(12);
  });

  it('only counts a setlist gap a run could actually close', async () => {
    // The backfill can only match a band that has an MBID, so a show whose
    // only gap is a band without one is not work waiting — it is work that
    // will never happen, and counting it would make the queue never empty.
    await request(app).get('/health').set(...authHeader(admin)).expect(200);

    const queries = prisma.$transaction.mock.calls[0][0];
    // The queue counts are the last three, in the order the route lists them.
    const [queue] = queries.slice(-3);
    expect(prisma.concert.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          attendances: { some: {} },
          bands: { some: expect.objectContaining({ band_rel: { MBID: { not: null } } }) },
        }),
      }),
    );
    expect(queue).toBeDefined();
  });

  it('turns a plain user away', async () => {
    await request(app).get('/health').set(...authHeader({ role: 'USER' })).expect(403);
  });

  it('turns away a caller with no token at all', async () => {
    await request(app).get('/health').expect(401);
  });

  it('says so plainly when the database is unreachable', async () => {
    prisma.$transaction.mockRejectedValueOnce(new Error('connection refused'));
    const res = await request(app).get('/health').set(...authHeader(admin)).expect(500);
    expect(res.body.error).toBeTruthy();
  });
});

describe('the routing surface', () => {
  it('registers exactly one route, behind auth, a role check and a limiter', () => {
    expect(routeManifest(router)).toEqual(['GET /health [4]']);
  });
});
