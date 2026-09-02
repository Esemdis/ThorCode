import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp, authHeader, installFakePrisma, routeManifest } from '../../test/routeApp.js';

// Seeded before the router is imported — see installFakePrisma for why this
// is a global rather than a vi.mock.
const prisma = installFakePrisma({
  band: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  concert: { findMany: vi.fn(), count: vi.fn() },
  wishlist: { findUnique: vi.fn(), findFirst: vi.fn() },
  wishlistBandReference: { findMany: vi.fn(), create: vi.fn(), findUnique: vi.fn() },
  concertBandReference: { findMany: vi.fn() },
  // /bands answers with raw SQL rather than the query builder.
  $queryRaw: vi.fn(async () => []),
});

const { default: router } = await import('./bands.js');
const app = buildApp(router);

beforeEach(() => { vi.clearAllMocks(); });

describe('GET /bands/search', () => {
  it('answers a one-character query with an empty list, without touching the database', async () => {
    const res = await request(app).get('/bands/search').query({ q: 'a' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(prisma.band.findMany).not.toHaveBeenCalled();
  });

  it('puts prefix matches above the rest', async () => {
    prisma.band.findMany.mockResolvedValue([
      { id: 2, name: 'Bring Me The Horizon' },
      { id: 1, name: 'Horizon' },
    ]);
    const res = await request(app).get('/bands/search').query({ q: 'hori' });
    expect(res.status).toBe(200);
    expect(res.body.map((b) => b.name)).toEqual(['Horizon', 'Bring Me The Horizon']);
  });
});

/**
 * The full routing surface of this file, in registration order.
 *
 * This exists to make splitting bands.js safe. It is not a description of good
 * design — it is a fingerprint. Moving a route to another module is fine as
 * long as the aggregate router still presents exactly this, and if it does not,
 * this test names the route that went missing rather than leaving it to be
 * found in production.
 *
 * The trailing count is how many handlers sit on the route, so a lost `auth` or
 * `roleCheck` fails here too.
 */
const EXPECTED_ROUTES = [
  'POST /bulk [4]',
  'GET /bands/search [1]',
  'GET /upcoming/bands [1]',
  'GET /bands [1]',
  'POST /bands/:bandId/sync-concerts [4]',
  'POST /bands/:bandId/reconcile [3]',
  'POST /bands [6]',
  'POST /bands/quick-add [2]',
  'GET /bands/:bandId/upcoming [1]',
  'GET /bands/:bandId/related [2]',
  'POST /bands/:bandId/refresh-urls [3]',
  'PATCH /bands/:bandId [5]',
  'DELETE /bands/:bandId [3]',
  'GET /bands/artist-search [1]',
  'POST /bands/sync-spotify-ids [3]',
  'POST /bands/sync-photos [3]',
  'POST /bands/sync-all [3]',
  'POST /sync-weather [3]',
  'POST /bands/sync-setlists [3]',
  'GET /bandsintown/enrich-pending [3]',
  'GET /weather-pending [3]',
  'GET /bands/setlist-pending [3]',
  'PATCH /bands/setlists/bulk [3]',
  'DELETE /concerts/:concertId [3]',
  'POST /:concertId/enrich-lineup [3]',
  'GET /bands/:bandId/setlist-history [2]',
  'GET /setlist-lookup [2]',
];

describe('the routing surface', () => {
  it('registers exactly the routes it did before, in the same order', () => {
    expect(routeManifest(router)).toEqual(EXPECTED_ROUTES);
  });
});

describe('auth', () => {
  it('turns away an unauthenticated write', async () => {
    const res = await request(app).post('/bands/quick-add').send({ name: 'Opeth' });
    expect(res.status).toBe(401);
  });

  it('turns away a non-admin on an admin job', async () => {
    const res = await request(app).post('/bands/sync-all').set(...authHeader({ role: 'USER' }));
    expect(res.status).toBe(403);
  });

  it('lets an ordinary user search without a token at all', async () => {
    prisma.band.findMany.mockResolvedValue([]);
    const res = await request(app).get('/bands/search').query({ q: 'opeth' });
    expect(res.status).toBe(200);
  });
});

describe('the handlers actually run', () => {
  // The manifest proves a route is registered; it does not prove the handler
  // can execute. Splitting wishlists.js dropped a top-level helper and left two
  // endpoints returning 500 with every routing and auth test still green. These
  // exercise the bodies of the reads the frontend depends on.
  beforeEach(() => {
    prisma.band.findMany.mockResolvedValue([
      { id: 1, name: 'Opeth', songkick_url: 'sk', bandsintown_url: 'bit', concerts: [] },
    ]);
    prisma.band.findUnique.mockResolvedValue({ id: 1, name: 'Opeth', concerts: [] });
    prisma.concert.findMany.mockResolvedValue([]);
    prisma.concertBandReference.findMany.mockResolvedValue([]);
  });

  it('serves the upcoming-bands list', async () => {
    const res = await request(app).get('/upcoming/bands');
    expect(res.status).toBe(200);
  });

  it('serves the band list', async () => {
    const res = await request(app).get('/bands');
    expect(res.status).toBe(200);
  });

  it('serves one band\'s upcoming shows', async () => {
    const res = await request(app).get('/bands/1/upcoming');
    expect(res.status).toBe(200);
  });
});

describe('a sync the Python service turns away', () => {
  // The failure this pins: the sync service began requiring SCRAPER_TOKEN, this
  // API was never given one, and every admin sync answered a 500 whose body was
  // axios's "Request failed with status code 401" — a status the admin's own
  // login had nothing to do with, naming nothing to go and fix.
  //
  // Served by a real socket rather than a stubbed client: the routers require
  // pythonService through CommonJS, so vi.mock cannot reach it for the same
  // reason installFakePrisma exists.
  let server;

  beforeAll(async () => {
    const { createServer } = await import('node:http');
    server = createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'Unauthorized' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.PYTHON_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
    delete process.env.PYTHON_SERVICE_FALLBACK_URL;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  for (const path of ['/bands/sync-all', '/sync-weather', '/bands/sync-setlists']) {
    it(`answers ${path} with a bad gateway naming the shared secret`, async () => {
      const res = await request(app).post(path).set(...authHeader({ role: 'ADMIN' }));

      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/SCRAPER_TOKEN/);
      expect(res.body.error).not.toMatch(/Request failed with status/);
    });
  }

  it('reports a rejected single-band sync the same way', async () => {
    // Same laundering, on the route an admin reaches from one band's page
    // rather than from the sync panel.
    prisma.band.findUnique.mockResolvedValue({
      id: 1, name: 'Opeth', songkick_url: 'sk', bandsintown_url: null,
    });

    const res = await request(app).post('/bands/1/sync-concerts').set(...authHeader({ role: 'ADMIN' }));

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/SCRAPER_TOKEN/);
  });
});
