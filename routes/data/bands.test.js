import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp, authHeader, installFakePrisma, routeManifest } from '../../test/routeApp.js';

// Seeded before the router is imported — see installFakePrisma for why this
// is a global rather than a vi.mock.
const prisma = installFakePrisma({
  band: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  concert: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
  wishlist: { findUnique: vi.fn(), findFirst: vi.fn() },
  wishlistBandReference: { findMany: vi.fn(), create: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn() },
  concertBandReference: { findMany: vi.fn(), deleteMany: vi.fn() },
  concertAttendance: { findMany: vi.fn(), deleteMany: vi.fn() },
  concertMedia: { findMany: vi.fn(), deleteMany: vi.fn() },
  // /bands answers with raw SQL rather than the query builder.
  $queryRaw: vi.fn(async () => []),
  // The array form ($transaction([...])) resolves an already-built list of
  // query promises; the interactive form ($transaction(async tx => ...)) runs
  // its callback against the fake client itself, same as the real client runs
  // it against a scoped one.
  $transaction: vi.fn(async (arg) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
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

describe('POST /bands', () => {
  // Only the paths that answer before the MusicBrainz lookup are covered here.
  // The lookup itself is unit-tested in utils/bandSourceUrls.test.js with an
  // injected client: vi.mock does not reach a CommonJS `require`, so a route
  // test that got as far as findSourceUrls would make a real network call.
  it('refuses a request with no name rather than creating an unnamed band', async () => {
    const res = await request(app).post('/bands').set(...authHeader()).send({});

    expect(res.status).toBe(400);
    expect(prisma.band.create).not.toHaveBeenCalled();
  });

  it('reports an existing band as a conflict without looking anything up', async () => {
    // The name is the unique key, so this is the ordinary "already added" case
    // rather than an error — and it must not spend a MusicBrainz call on a band
    // whose urls were resolved when it was first added.
    prisma.band.findUnique.mockResolvedValue({ id: 5, name: 'Architects' });

    const res = await request(app).post('/bands').set(...authHeader()).send({ name: 'Architects' });

    expect(res.status).toBe(409);
    expect(prisma.band.create).not.toHaveBeenCalled();
  });

  it('trims the name before deciding whether the band already exists', async () => {
    prisma.band.findUnique.mockResolvedValue({ id: 5, name: 'Architects' });

    await request(app).post('/bands').set(...authHeader()).send({ name: '  Architects  ' });

    expect(prisma.band.findUnique).toHaveBeenCalledWith({ where: { name: 'Architects' } });
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
  // auth + artistLookupRateLimit + handler. This route used to be reachable
  // with no token at all, and it calls matchBandToSpotify — a write plus a
  // Spotify quota burn — so it was an unauthenticated, unmetered proxy.
  'GET /bands/:bandId/upcoming [3]',
  'GET /bands/:bandId/related [2]',
  'POST /bands/:bandId/refresh-urls [3]',
  'PATCH /bands/:bandId [5]',
  'DELETE /bands/:bandId [3]',
  // Same treatment as /upcoming below, and for the same reason: it reaches
  // Last.fm and Spotify on the caller's behalf.
  'GET /bands/artist-search [3]',
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

describe('adding a band to a wishlist that is not yours', () => {
  // wishlistId arrived in the request body and went straight into
  // wishlist_id. Wishlist.user_id is unique — one wishlist per account — and
  // ids are sequential autoincrement ints, so counting up from 1 planted a
  // band on every account in the system. utils/wishlists/notify.js then fans
  // that band's new concerts out to the victim's Discord webhook.
  beforeEach(() => {
    prisma.band.findFirst = vi.fn(async () => ({ id: 92, name: 'Gojira' }));
    prisma.wishlist.findFirst = vi.fn(async () => null);
    prisma.wishlistBandReference.upsert = vi.fn(async () => ({}));
    prisma.wishlistBandReference.create = vi.fn(async () => ({}));
  });

  it('refuses quick-add against a stranger\'s wishlist', async () => {
    const res = await request(app)
      .post('/bands/quick-add')
      .set(...authHeader({ id: 'user-1', role: 'USER' }))
      .send({ name: 'Gojira', wishlistId: 3, tier: 'LOVE' });

    expect(res.status).toBe(403);
    expect(prisma.wishlistBandReference.upsert).not.toHaveBeenCalled();
  });

  it('refuses the full create route against a stranger\'s wishlist too', async () => {
    const res = await request(app)
      .post('/bands')
      .set(...authHeader({ id: 'user-1', role: 'USER' }))
      .send({ name: 'Gojira', wishlistId: 3 });

    expect(res.status).toBe(403);
    expect(prisma.wishlistBandReference.create).not.toHaveBeenCalled();
  });

  it('checks the wishlist against the caller, not merely that it exists', async () => {
    await request(app)
      .post('/bands/quick-add')
      .set(...authHeader({ id: 'user-1', role: 'USER' }))
      .send({ name: 'Gojira', wishlistId: 3 });

    expect(prisma.wishlist.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 3, user_id: 'user-1' }),
    }));
  });

  it('still adds to your own wishlist', async () => {
    prisma.wishlist.findFirst = vi.fn(async () => ({ id: 3 }));

    const res = await request(app)
      .post('/bands/quick-add')
      .set(...authHeader({ id: 'user-1', role: 'USER' }))
      .send({ name: 'Gojira', wishlistId: 3, tier: 'LOVE' });

    expect(res.status).toBe(201);
    expect(prisma.wishlistBandReference.upsert).toHaveBeenCalled();
  });

  it('still creates a band when no wishlist is named at all', async () => {
    const res = await request(app)
      .post('/bands/quick-add')
      .set(...authHeader({ id: 'user-1', role: 'USER' }))
      .send({ name: 'Gojira' });

    expect(res.status).toBe(201);
    expect(prisma.wishlist.findFirst).not.toHaveBeenCalled();
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

  it('serves one band\'s upcoming shows to a signed-in caller', async () => {
    const res = await request(app).get('/bands/1/upcoming').set(...authHeader({ id: 'user-1' }));
    expect(res.status).toBe(200);
  });

  it('turns away an unauthenticated caller, who would otherwise spend our Spotify quota', async () => {
    // The handler calls matchBandToSpotify, which writes to the band row and
    // burns a third-party request. Open to the world that is a free proxy.
    const res = await request(app).get('/bands/1/upcoming');
    expect(res.status).toBe(401);
  });
});

// Three sites detach media before deleting the ConcertAttendance rows that
// gate it. All three once passed the CONCERT id into detachAttendances, which
// reads and deletes ConcertMedia by ATTENDANCE id — both autoincrement ints in
// the same table space, so the bug either detached nothing (then the Restrict
// key rolled the whole transaction back on any orphan with real attendance)
// or, on an id collision, renamed an unrelated user's show folder into
// _detached and deleted their media rows. Each test below asserts the actual
// argument shape passed to concertMedia.findMany, with the concert id and the
// attendance id deliberately different numbers so a regression cannot pass by
// coincidence.
describe('DELETE /concerts/:concertId', () => {
  beforeEach(() => {
    prisma.concert.findUnique.mockResolvedValue({ id: 55 });
    prisma.concertAttendance.findMany.mockResolvedValue([{ id: 501 }]);
    prisma.concertMedia.findMany.mockResolvedValue([]);
    prisma.concertBandReference.deleteMany.mockResolvedValue({ count: 0 });
    prisma.concertAttendance.deleteMany.mockResolvedValue({ count: 1 });
    prisma.concert.delete.mockResolvedValue({ id: 55 });
  });

  it('detaches media by this concert\'s attendance ids, not the concert id, before the rows go', async () => {
    const res = await request(app).delete('/concerts/55').set(...authHeader({ role: 'ADMIN' }));

    expect(res.status).toBe(200);
    expect(prisma.concertAttendance.findMany).toHaveBeenCalledWith({
      where: { concert_id: 55 },
      select: { id: true },
    });
    // Names the attendance id (501), not the concert id (55) — the swap this
    // guards against would have made this [55] instead.
    expect(prisma.concertMedia.findMany).toHaveBeenCalledWith({
      where: { attendance_id: { in: [501] } },
      select: { rel_path: true },
    });
    // Order matters: deleting the index before every folder move has
    // succeeded is not recoverable. See utils/mediaDetach.js.
    const mediaCallOrder = prisma.concertMedia.findMany.mock.invocationCallOrder[0];
    const deleteCallOrder = prisma.concertAttendance.deleteMany.mock.invocationCallOrder[0];
    expect(mediaCallOrder).toBeLessThan(deleteCallOrder);
  });
});

describe('DELETE /bands/:bandId', () => {
  beforeEach(() => {
    prisma.band.findUnique.mockResolvedValue({ id: 9, concerts: [{ concert: 700 }] });
    prisma.wishlistBandReference.deleteMany.mockResolvedValue({ count: 0 });
    prisma.concertBandReference.deleteMany.mockResolvedValue({ count: 1 });
    prisma.band.delete.mockResolvedValue({ id: 9 });
    prisma.concert.findMany.mockResolvedValue([{ id: 700 }]); // the orphan left with zero bands
    prisma.concertAttendance.findMany.mockResolvedValue([{ id: 901 }]);
    prisma.concertMedia.findMany.mockResolvedValue([]);
    prisma.concertAttendance.deleteMany.mockResolvedValue({ count: 1 });
    prisma.concert.deleteMany.mockResolvedValue({ count: 1 });
  });

  it('looks up media by the attendance ids behind an orphaned concert, not the concert id itself', async () => {
    const res = await request(app).delete('/bands/9').set(...authHeader({ role: 'ADMIN' }));

    expect(res.status).toBe(200);
    expect(prisma.concertAttendance.findMany).toHaveBeenCalledWith({
      where: { concert_id: { in: [700] } },
      select: { id: true },
    });
    // Names the attendance id (901), not the orphaned concert id (700).
    expect(prisma.concertMedia.findMany).toHaveBeenCalledWith({
      where: { attendance_id: { in: [901] } },
      select: { rel_path: true },
    });
  });
});

describe('POST /bands/:bandId/reconcile', () => {
  // A concert the scraper no longer reports for this band. Support-act-only,
  // so unlinking the reconciled band leaves it with zero bands and orphans it.
  const staleDbConcert = {
    id: 800,
    event_id: null,
    concert_date: new Date('2030-06-01T20:00:00Z'),
    venue: 'Slakthuset',
    city: 'Stockholm',
    latitude: '59.3',
    longitude: '18.0',
    festival: false,
    bands: [{ band_rel: { id: 3, name: 'Support Act', songkick_url: null, bandsintown_url: null } }],
  };

  beforeEach(() => {
    prisma.concert.findMany
      .mockResolvedValueOnce([staleDbConcert]) // this band's future concerts, checked against `upcoming`
      .mockResolvedValueOnce([{ id: 800 }]); // the orphans query inside the transaction
    prisma.concertBandReference.deleteMany.mockResolvedValue({ count: 1 });
    prisma.concertAttendance.findMany.mockResolvedValue([{ id: 950 }]);
    prisma.concertMedia.findMany.mockResolvedValue([]);
    prisma.concertAttendance.deleteMany.mockResolvedValue({ count: 1 });
    prisma.concert.deleteMany.mockResolvedValue({ count: 1 });
  });

  it('looks up media by the attendance ids behind an orphaned concert, not the concert id itself', async () => {
    const res = await request(app)
      .post('/bands/5/reconcile')
      .set(...authHeader({ role: 'ADMIN' }))
      // Decades away from staleDbConcert's date, so nothing matches and it is
      // flagged stale regardless of the day-window/venue/coordinate rules.
      .send({ upcoming: [{ concert_date: '2005-01-01', venue: 'Somewhere Else', city: 'Elsewhere' }] });

    expect(res.status).toBe(200);
    expect(prisma.concertAttendance.findMany).toHaveBeenCalledWith({
      where: { concert_id: { in: [800] } },
      select: { id: true },
    });
    // Names the attendance id (950), not the orphaned concert id (800).
    expect(prisma.concertMedia.findMany).toHaveBeenCalledWith({
      where: { attendance_id: { in: [950] } },
      select: { rel_path: true },
    });
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
