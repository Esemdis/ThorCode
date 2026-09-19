import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp, authHeader, installFakePrisma, routeManifest } from '../../test/routeApp.js';

const model = () => ({
  findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), count: vi.fn(),
  create: vi.fn(), createMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(),
  delete: vi.fn(), deleteMany: vi.fn(), upsert: vi.fn(),
});

// Seeded before the router is imported — see installFakePrisma for why this is
// a global rather than a vi.mock.
const prisma = installFakePrisma({
  wishlist: model(),
  wishlistBandReference: model(),
  band: model(),
  concert: model(),
  concertBandReference: model(),
  concertAttendance: model(),
  concertMedia: model(),
  activityLog: model(),
  city: model(),
  notificationSubscription: model(),
  $transaction: vi.fn(async (arg) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
});

const { default: router } = await import('./wishlists.js');
const app = buildApp(router);

beforeEach(() => { vi.clearAllMocks(); });

/**
 * The full routing surface of this file, in registration order.
 *
 * Here for the same reason as the one in bands.test.js: it is the safety net
 * that makes splitting a 1473-line router into several files a mechanical
 * change rather than a leap. See that file for the reasoning on the counts.
 */
const EXPECTED_ROUTES = [
  'GET /wishlists [4]',
  'GET /wishlists/raw [3]',
  'GET /wishlists/bands [3]',
  'GET /wishlists/:id/new [4]',
  'GET /wishlists/:id/recent-concerts [4]',
  'GET /wishlists/:id/activity [4]',
  'GET /wishlists/:id [4]',
  'PATCH /weather/bulk [3]',
  'PATCH /wishlists/:id/bands/:bandId [6]',
  'POST /wishlists [6]',
  'PUT /wishlists/:id [7]',
  'POST /wishlists/:id/bands [8]',
  'DELETE /wishlists/:id/bands/:bandId [6]',
  'DELETE /wishlists/:id [5]',
  'POST /wishlists/notify [4]',
  'GET /wishlists/:id/calendar-token [4]',
  'POST /wishlists/:id/calendar-token [4]',
  'DELETE /wishlists/:id/calendar-token [4]',
  'GET /wishlists/:id/attendance [4]',
  'POST /wishlists/:id/attendance [5]',
  'DELETE /wishlists/:id/attendance/:concertId [5]',
  'POST /wishlists/:id/attendance/from-setlist [12]',
];

describe('the routing surface', () => {
  it('registers exactly the routes it did before, in the same order', () => {
    expect(routeManifest(router)).toEqual(EXPECTED_ROUTES);
  });

  it('keeps /wishlists/raw ahead of /wishlists/:id', () => {
    // Both match GET /wishlists/raw. Registered the other way round, "raw" is
    // read as an id and the route becomes unreachable — the kind of thing that
    // only shows up when someone reorders the file.
    const manifest = routeManifest(router);
    expect(manifest.indexOf('GET /wishlists/raw [3]'))
      .toBeLessThan(manifest.indexOf('GET /wishlists/:id [4]'));
  });

  it('keeps /wishlists/bands ahead of /wishlists/:id', () => {
    // Same trap as /wishlists/raw, with a sharper edge: /wishlists/:id validates
    // the id as an integer, so registered the other way round this does not fall
    // through to the right handler — it answers 400 for every caller.
    const manifest = routeManifest(router);
    expect(manifest.indexOf('GET /wishlists/bands [3]'))
      .toBeLessThan(manifest.indexOf('GET /wishlists/:id [4]'));
  });
});

describe('auth', () => {
  it('turns away an unauthenticated read of a wishlist', async () => {
    const res = await request(app).get('/wishlists');
    expect(res.status).toBe(401);
  });

  it('turns away an unauthenticated write', async () => {
    const res = await request(app).post('/wishlists').send({ name: 'Mine' });
    expect(res.status).toBe(401);
  });

  it('turns away a non-system caller from the bulk weather write', async () => {
    const res = await request(app).patch('/weather/bulk').set(...authHeader({ role: 'USER' })).send({});
    expect(res.status).toBe(403);
  });
});

describe('GET /wishlists/bands', () => {
  const REFS = [
    { tier: 'LOVE', band_rel: { id: 1, name: 'Opeth' } },
    { tier: 'FOLLOW', band_rel: { id: 2, name: 'Tool' } },
  ];

  it('turns away an unauthenticated caller', async () => {
    const res = await request(app).get('/wishlists/bands');
    expect(res.status).toBe(401);
  });

  it('answers with the caller’s own bands, flattened to id, name and tier', async () => {
    prisma.wishlistBandReference.findMany.mockResolvedValue(REFS);

    const res = await request(app).get('/wishlists/bands').set(...authHeader({ id: 'user-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: 1, name: 'Opeth', tier: 'LOVE' },
      { id: 2, name: 'Tool', tier: 'FOLLOW' },
    ]);
  });

  it('scopes the query to the caller, not to a wishlist id in the path', async () => {
    // There is no id in this route on purpose — Wishlist.user_id is unique, so
    // the token is the only thing that should decide whose bands come back. A
    // filter built any other way is how one account reads another's.
    prisma.wishlistBandReference.findMany.mockResolvedValue([]);

    await request(app).get('/wishlists/bands').set(...authHeader({ id: 'user-2' }));

    const [{ where }] = prisma.wishlistBandReference.findMany.mock.calls[0];
    expect(where).toEqual({ wishlist_rel: { user_id: 'user-2' } });
  });

  it('answers with an empty list for a user who has no wishlist yet', async () => {
    prisma.wishlistBandReference.findMany.mockResolvedValue([]);

    const res = await request(app).get('/wishlists/bands').set(...authHeader({ id: 'user-3' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('does not read concerts, which is the whole point of the route', async () => {
    // The band overview used to get this list from GET /wishlists/:id, which
    // loads every band's full concert history to hand back a set of ids.
    prisma.wishlistBandReference.findMany.mockResolvedValue(REFS);

    await request(app).get('/wishlists/bands').set(...authHeader({ id: 'user-1' }));

    expect(prisma.concert.findMany).not.toHaveBeenCalled();
    expect(prisma.band.findMany).not.toHaveBeenCalled();
  });
});

describe('POST /wishlists/notify', () => {
  it('refuses a webhook that is not a Discord one', async () => {
    // The server POSTs to whatever URL this holds, so anything but Discord's
    // own host is an SSRF vector aimed at the network the API sits in.
    const res = await request(app)
      .post('/wishlists/notify')
      .set(...authHeader({ role: 'ADMIN' }))
      .send({ discord_webhook: 'http://169.254.169.254/latest/meta-data/' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe('the handlers actually run', () => {
  // The manifest above proves a route is registered; it says nothing about
  // whether the handler can execute. Splitting the file dropped a top-level
  // helper that two of these handlers call, and every routing and auth test
  // still passed while both endpoints returned 500 to real traffic. These
  // exercise the bodies.
  const WISHLIST = {
    id: 7,
    user_id: 'user-1',
    name: 'My Wishlist',
    bands: [{ band_id: 1, tier: 'LOVE', band_rel: { id: 1, name: 'Opeth' } }],
  };

  beforeEach(() => {
    prisma.wishlist.findUnique.mockResolvedValue(WISHLIST);
    prisma.wishlist.findMany.mockResolvedValue([WISHLIST]);
    prisma.band.findMany.mockResolvedValue([
      { id: 1, name: 'Opeth', concerts: [] },
    ]);
    prisma.concertAttendance.findMany.mockResolvedValue([]);
    prisma.concert.findMany.mockResolvedValue([]);
    prisma.concertBandReference.findMany.mockResolvedValue([]);
  });

  it('serves a single wishlist', async () => {
    const res = await request(app)
      .get('/wishlists/7')
      .query({ start_date: '2026-09-01', end_date: '2026-09-30' })
      .set(...authHeader({ id: 'user-1' }));
    expect(res.status).toBe(200);
  });

  it('serves a single wishlist with no date range', async () => {
    const res = await request(app).get('/wishlists/7').set(...authHeader({ id: 'user-1' }));
    expect(res.status).toBe(200);
  });

  it('serves the raw wishlist list', async () => {
    // SYSTEM-only: it is what the Python scoring service reads.
    const res = await request(app).get('/wishlists/raw').set(...authHeader({ role: 'SYSTEM' }));
    expect(res.status).toBe(200);
  });

  it('serves the wishlist list', async () => {
    const res = await request(app).get('/wishlists').set(...authHeader({ id: 'user-1' }));
    expect(res.status).toBe(200);
  });
});

describe('GET /wishlists/:id setlist placement', () => {
  // A band's setlist belongs to the band, not to each of its concerts, but the
  // payload attached a copy to every band on every concert. On the live data
  // that was 85 distinct setlists sent as 1532 copies — 1.1MB of a 2MB
  // response. It is sent once in `bands` and looked up by id on the client.
  const SETLIST = { songs: [{ name: 'Ghost of Perdition', tape: false }], tour: 'Tour' };
  const OPETH = { id: 1, name: 'Opeth', setlist: SETLIST, MBID: null, songkick_url: null, bandsintown_url: null };

  const concert = (id, date, city = 'Stockholm', venue = 'Slakthuset') => ({
    concert_rel: {
      id, event_id: `e${id}`, name: null, city, country: 'SE',
      venue, concert_date: new Date(date), metadata: null,
      latitude: '59.3', longitude: '18.0', on_sale: true, ticket_sale_start: null,
      price_min: null, price_max: null, price_currency: null, sold_out: false,
      festival: false, source: 'songkick', url: null, weather: null, reachable: null,
      city_rel: null,
      bands: [{ band_rel: OPETH }],
    },
  });

  beforeEach(() => {
    prisma.wishlist.findUnique.mockResolvedValue({
      id: 7, user_id: 'user-1', name: 'My Wishlist',
      bands: [{ band_id: 1, tier: 'LOVE', band_rel: OPETH }],
    });
    // Two concerts for the same band: the duplication this guards against only
    // shows up once a band plays more than one date.
    prisma.band.findMany.mockResolvedValue([
      // Different nights and cities, or deduplicateConcerts folds them into one
      // and the duplication under test cannot show up.
      { id: 1, name: 'Opeth', concerts: [
        concert(10, '2026-09-10'),
        concert(11, '2026-10-02', 'Gothenburg', 'Pustervik'),
      ] },
    ]);
    prisma.concertAttendance.findMany.mockResolvedValue([]);
  });

  it('sends each setlist once, on the band', async () => {
    const res = await request(app).get('/wishlists/7').set(...authHeader({ id: 'user-1' }));
    expect(res.status).toBe(200);
    expect(res.body.bands).toHaveLength(1);
    expect(res.body.bands[0]).toMatchObject({ id: 1, setlist: SETLIST });
  });

  it('omits setlists for bands with no concerts in the response', async () => {
    // Sending every wishlist band's setlist regardless made a narrow date range
    // worse than before the dedup: on live data a one-week window was 122KB, of
    // which 87KB was setlists for bands playing nothing that week.
    prisma.wishlist.findUnique.mockResolvedValue({
      id: 7, user_id: 'user-1', name: 'My Wishlist',
      bands: [
        { band_id: 1, tier: 'LOVE', band_rel: OPETH },
        { band_id: 2, tier: 'LIKE', band_rel: { ...OPETH, id: 2, name: 'Tool' } },
      ],
    });
    // Band 2 is on the wishlist but plays nothing in range.
    prisma.band.findMany.mockResolvedValue([
      { id: 1, name: 'Opeth', concerts: [concert(10, '2026-09-10')] },
      { id: 2, name: 'Tool', concerts: [] },
    ]);

    const res = await request(app).get('/wishlists/7').set(...authHeader({ id: 'user-1' }));
    const byId = new Map(res.body.bands.map((b) => [b.id, b]));
    expect(byId.get(1).setlist).toEqual(SETLIST);
    expect(byId.get(2).setlist).toBeNull();
    // Still listed, so tier and times_seen keep working.
    expect(byId.get(2)).toMatchObject({ id: 2, name: 'Tool', tier: 'LIKE' });
  });

  it('does not repeat the setlist on every concert', async () => {
    const res = await request(app).get('/wishlists/7').set(...authHeader({ id: 'user-1' }));
    expect(res.body.concerts).toHaveLength(2);
    for (const c of res.body.concerts) {
      expect(c.participating_bands[0]).toEqual({ id: 1, name: 'Opeth', tier: 'LOVE' });
      expect(c.participating_bands[0]).not.toHaveProperty('setlist');
    }
  });
});

describe('POST /wishlists/notify subscription delivery', () => {
  // Served by a real socket for the same reason bands.test.js does it: the
  // route requires axios through CommonJS, so vi.mock cannot reach it.
  let server;
  let received;
  const hook = (path) => `http://127.0.0.1:${server.address().port}${path}`;

  beforeAll(async () => {
    const { createServer } = await import('node:http');
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        received.push({ path: req.url, body: JSON.parse(body || '{}') });
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  const MINE = () => ({
    id: 7, user_id: 'user-1', discord_webhook: hook('/mine'),
    bands: [{ band_rel: { id: 1, name: 'Opeth', ticketmaster_id: null } }],
  });
  const THEIRS = () => ({
    id: 8, user_id: 'user-2', discord_webhook: hook('/theirs'),
    bands: [{ band_rel: { id: 9, name: 'Someone Elses Band', ticketmaster_id: null } }],
  });

  // Band 9 plays Stockholm, which is city_id 12. The row as the endpoint
  // re-reads it, so city_id is resolved and the lineup is whole.
  const CONCERT = {
    id: 100, name: null, venue: 'Debaser', city: 'Stockholm', country: 'SE',
    concert_date: new Date('2026-11-02T19:00:00Z'), url: null, metadata: null,
    city_id: 12, bands: [{ band_rel: { id: 9, name: 'Someone Elses Band' } }],
  };

  const payload = (bandId, name, concertId = 100) => ({
    bands: [{
      band_id: bandId, name, inserted: 1,
      concerts: [{
        concert_id: concertId, concert_date: '2026-11-02T19:00:00.000Z',
        city: 'Stockholm', country: 'SE', venue: 'Debaser', url: null, metadata: null,
      }],
    }],
  });

  const post = (body) => request(app)
    .post('/wishlists/notify')
    .set(...authHeader({ role: 'SYSTEM' }))
    .send(body);

  beforeEach(() => {
    received = [];
    prisma.wishlist.findMany.mockResolvedValue([MINE(), THEIRS()]);
    prisma.concert.findMany.mockResolvedValue([CONCERT]);
    prisma.notificationSubscription.findMany.mockResolvedValue([]);
    prisma.activityLog.findMany.mockResolvedValue([]);
    prisma.activityLog.create.mockResolvedValue({});
    prisma.activityLog.deleteMany.mockResolvedValue({ count: 0 });
  });

  it('stays silent on my webhook for a band only someone else wishlists', async () => {
    // The bug this exists for: a single global webhook meant every band in the
    // database pinged one person, including bands they had never heard of.
    const res = await post(payload(9, 'Someone Elses Band'));

    expect(res.status).toBe(200);
    expect(received.filter((r) => r.path === '/theirs')).toHaveLength(1);
    expect(received.filter((r) => r.path === '/mine')).toHaveLength(0);
  });

  it('posts to a subscriber when a watched band plays a watched city', async () => {
    prisma.notificationSubscription.findMany.mockResolvedValue([
      { user_id: 'user-1', band_id: 9, city_id: 12, user_rel: { id: 'user-1', email: 'me@example.com', settings: null } },
    ]);

    const res = await post(payload(9, 'Someone Elses Band'));

    expect(res.status).toBe(200);
    const mine = received.filter((r) => r.path === '/mine');
    expect(mine).toHaveLength(1);
    expect(mine[0].body.embeds[0].fields[0].value).toContain('Debaser');
  });

  it('does not post to a subscriber whose watch matches nothing in this batch', async () => {
    prisma.notificationSubscription.findMany.mockResolvedValue([
      { user_id: 'user-1', band_id: 4242, city_id: null, user_rel: { id: 'user-1', email: 'me@example.com', settings: null } },
    ]);

    await post(payload(9, 'Someone Elses Band'));

    expect(received.filter((r) => r.path === '/mine')).toHaveLength(0);
  });

  it('sends one message for a concert that is both wishlisted and watched', async () => {
    // Subscribing to a band already on your wishlist is the ordinary case, and
    // it must not double every notification.
    prisma.concert.findMany.mockResolvedValue([
      { ...CONCERT, bands: [{ band_rel: { id: 1, name: 'Opeth' } }] },
    ]);
    prisma.notificationSubscription.findMany.mockResolvedValue([
      { user_id: 'user-1', band_id: 1, city_id: null, user_rel: { id: 'user-1', email: 'me@example.com', settings: null } },
    ]);

    await post(payload(1, 'Opeth'));

    expect(received.filter((r) => r.path === '/mine')).toHaveLength(1);
  });

  it('mentions the subscriber when they have a discord id in their settings', async () => {
    // Replaces the hardcoded mention the deleted Stockholm pinger carried, so
    // a watched show still buzzes a phone rather than arriving silently.
    prisma.notificationSubscription.findMany.mockResolvedValue([
      {
        user_id: 'user-1', band_id: 9, city_id: 12,
        user_rel: { id: 'user-1', email: 'me@example.com', settings: { discord_user_id: '4242' } },
      },
    ]);

    await post(payload(9, 'Someone Elses Band'));

    const mine = received.filter((r) => r.path === '/mine');
    expect(mine[0].body.content).toBe('<@4242>');
  });

  it('skips the concert read entirely when no concert ids came through', async () => {
    // Older scraper builds post without them. The wishlist digest still has to
    // work, and matching subscriptions is impossible without a resolved city.
    const body = payload(9, 'Someone Elses Band');
    delete body.bands[0].concerts[0].concert_id;

    await post(body);

    expect(prisma.concert.findMany).not.toHaveBeenCalled();
    expect(received.filter((r) => r.path === '/theirs')).toHaveLength(1);
  });
});

describe('DELETE /wishlists/:id/attendance/:concertId', () => {
  // This is the one call site of the four that refuses instead of detaching:
  // un-attending a show is the user's own call, not a cleanup sweep, and it is
  // not a request to delete their photographs. The other three call sites
  // (admin concert delete, and the two orphan sweeps in routes/data/bands/)
  // are covered in routes/data/bands.test.js.
  const WISHLIST = { id: 7, user_id: 'user-1', bands: [] };
  const ATTENDANCE = { id: 42 };

  beforeEach(() => {
    prisma.wishlist.findUnique.mockResolvedValue(WISHLIST);
    prisma.concertAttendance.findUnique.mockResolvedValue(ATTENDANCE);
  });

  it('refuses with a 409 naming the photo count, and deletes nothing, when media is attached', async () => {
    prisma.concertMedia.count.mockResolvedValue(3);

    const res = await request(app)
      .delete('/wishlists/7/attendance/99')
      .set(...authHeader({ id: 'user-1' }));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/3 photos attached/);
    expect(prisma.concertAttendance.delete).not.toHaveBeenCalled();
  });

  it('singularises the count for exactly one photo', async () => {
    prisma.concertMedia.count.mockResolvedValue(1);

    const res = await request(app)
      .delete('/wishlists/7/attendance/99')
      .set(...authHeader({ id: 'user-1' }));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/1 photo attached/);
  });

  it('deletes the attendance normally when no media is attached', async () => {
    prisma.concertMedia.count.mockResolvedValue(0);
    prisma.concertAttendance.delete.mockResolvedValue(ATTENDANCE);

    const res = await request(app)
      .delete('/wishlists/7/attendance/99')
      .set(...authHeader({ id: 'user-1' }));

    expect(res.status).toBe(200);
    expect(prisma.concertAttendance.delete).toHaveBeenCalledWith({ where: { id: 42 } });
  });
});
