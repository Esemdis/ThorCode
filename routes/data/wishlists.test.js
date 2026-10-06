import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import { buildApp, authHeader, installFakePrisma, routeManifest } from '../../test/routeApp.js';

const model = () => ({
  findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), count: vi.fn(),
  create: vi.fn(), createMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(),
  delete: vi.fn(), deleteMany: vi.fn(), upsert: vi.fn(), groupBy: vi.fn(),
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
  attendanceMissedBand: model(),
  activityLog: model(),
  city: model(),
  notificationSubscription: model(),
  concertDelivery: model(),
  $queryRaw: vi.fn(async () => []),
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
  // No limiter: it shared the 10-a-minute budget for adding and removing
  // bands, and the app reads it on every load.
  'GET /wishlists [3]',
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
  'PUT /wishlists/:id/attendance/missed [8]',
  // One more than it was: the setlist.fm budget it shares with the band routes.
  'POST /wishlists/:id/attendance/from-setlist [7]',
  'GET /wishlists/:id/weekly [6]',
  // One more for its own limiter: a post goes to Discord, which has its own.
  'POST /wishlists/:id/weekly/discord [7]',
  'GET /wishlists/:id/festivals [4]',
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

describe('a wishlist that is someone else\'s', () => {
  // Every route that names a wishlist by id asks ownWishlist, and each one used
  // to spell the check out for itself. This walks all of them, so a route that
  // stops asking fails here rather than quietly serving a stranger's list.
  const user = authHeader({ id: 'user-1', role: 'USER' });
  const admin = authHeader({ id: 'user-1', role: 'ADMIN' });
  const routes = [
    ['get', '/wishlists/7', user],
    ['get', '/wishlists/7/new', user],
    ['get', '/wishlists/7/recent-concerts', user],
    ['get', '/wishlists/7/activity', user],
    ['get', '/wishlists/7/attendance', user],
    ['post', '/wishlists/7/attendance', user, { concert_id: 1 }],
    ['delete', '/wishlists/7/attendance/1', user],
    ['put', '/wishlists/7/attendance/missed', user, { attendance_ids: [1], band_id: 1, missed: true }],
    ['post', '/wishlists/7/attendance/from-setlist', user, { setlistfm_id: '63de4613', band_id: 1 }],
    ['patch', '/wishlists/7/bands/1', user, { tier: 'LOVE' }],
    ['put', '/wishlists/7', admin, { name: 'Mine now' }],
    ['post', '/wishlists/7/bands', user, { name: 'Gojira' }],
    ['delete', '/wishlists/7/bands/1', user],
    ['delete', '/wishlists/7', admin],
    ['get', '/wishlists/7/calendar-token', user],
    ['post', '/wishlists/7/calendar-token', user],
    ['delete', '/wishlists/7/calendar-token', user],
    ['get', '/wishlists/7/weekly', user],
    ['post', '/wishlists/7/weekly/discord', user],
    ['get', '/wishlists/7/festivals', user],
  ];

  beforeEach(() => {
    prisma.wishlist.findUnique.mockResolvedValue({ id: 7, user_id: 'user-2', bands: [] });
  });

  // The writes share one limiter of ten a minute per IP (see ./shared.js), and
  // this sweep spends it. Handed back so the tests after it are not refused
  // for what these did.
  afterAll(async () => {
    const { rateLimit } = createRequire(import.meta.url)('./wishlists/shared.js');
    const { sendLimit } = createRequire(import.meta.url)('./wishlists/recap.js');
    for (const ip of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) {
      await rateLimit.resetKey(ip);
      await sendLimit.resetKey(ip);
    }
  });

  it.each(routes)('%s %s answers 403 and goes no further', async (method, path, auth, body) => {
    const res = await request(app)[method](path).set(...auth).send(body ?? {});

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'That wishlist is not yours.' });
    expect(prisma.wishlist.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 7 } }));
    for (const table of ['wishlistBandReference', 'concertAttendance', 'concert', 'band', 'activityLog']) {
      for (const fn of ['findMany', 'findFirst', 'create', 'update', 'upsert', 'delete', 'deleteMany']) {
        expect(prisma[table][fn]).not.toHaveBeenCalled();
      }
    }
  });

  it('lets an admin read it whole, which is the one exception', async () => {
    prisma.band.findMany.mockResolvedValue([]);
    prisma.concertAttendance.findMany.mockResolvedValue([]);

    const res = await request(app).get('/wishlists/7').set(...admin);

    expect(res.status).toBe(200);
  });

  it('answers 404 in the same words everywhere when there is no such wishlist', async () => {
    prisma.wishlist.findUnique.mockResolvedValue(null);

    for (const [method, path, auth, body] of routes) {
      const res = await request(app)[method](path).set(...auth).send(body ?? {});
      expect([path, res.status, res.body]).toEqual([path, 404, { error: 'Wishlist not found.' }]);
    }
  });
});

describe('PATCH /wishlists/:id/bands/:bandId', () => {
  it('answers 404 for a band that is not on the list, rather than 500', async () => {
    prisma.wishlist.findUnique.mockResolvedValue({ id: 7, user_id: 'user-1' });
    prisma.wishlistBandReference.update.mockRejectedValue(Object.assign(new Error('not found'), { code: 'P2025' }));

    const res = await request(app).patch('/wishlists/7/bands/99').set(...authHeader({ id: 'user-1' })).send({ tier: 'LOVE' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'That band is not on this wishlist.' });
  });
});

describe('GET /wishlists', () => {
  it('is not counted against adding and removing bands', async () => {
    // It shared their 10-a-minute limiter. The app reads it on every load, so
    // a few bands added and a reload or two came back 429, and the app sat
    // empty with no wishlist to show.
    prisma.wishlist.findMany.mockResolvedValue([{ id: 7, user_id: 'user-1', bands: [] }]);

    for (let i = 0; i < 12; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).get('/wishlists').set(...authHeader({ id: 'user-1' }));
      expect(res.status).toBe(200);
    }
  });
});

describe('GET /wishlists/bands', () => {
  const REFS = [
    { tier: 'LOVE', band_rel: { id: 1, name: 'Opeth', MBID: 'c14b4180-dc87-481e-b17a-64e4150f90f6' } },
    { tier: 'FOLLOW', band_rel: { id: 2, name: 'Tool', MBID: null } },
  ];

  it('turns away an unauthenticated caller', async () => {
    const res = await request(app).get('/wishlists/bands');
    expect(res.status).toBe(401);
  });

  it('answers with the caller’s own bands, flattened to id, name, tier and MBID', async () => {
    // The MBID is for the band page's Similar tab, which tells an artist you
    // follow by it. Without it here, that page loaded the whole wishlist.
    prisma.wishlistBandReference.findMany.mockResolvedValue(REFS);

    const res = await request(app).get('/wishlists/bands').set(...authHeader({ id: 'user-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: 1, name: 'Opeth', tier: 'LOVE', mbid: 'c14b4180-dc87-481e-b17a-64e4150f90f6' },
      { id: 2, name: 'Tool', tier: 'FOLLOW', mbid: null },
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
  // What each webhook answers, by path and how many posts it has had: 204
  // unless a test says otherwise.
  let answer;
  const hook = (path) => `http://127.0.0.1:${server.address().port}${path}`;

  beforeAll(async () => {
    const { createServer } = await import('node:http');
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        received.push({ path: req.url, body: JSON.parse(body || '{}') });
        const nth = received.filter((r) => r.path === req.url).length;
        res.writeHead(answer(req.url, nth));
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
  // re-reads it, so city_id is resolved and the lineup is whole. A new show:
  // every act on it is still owed its announcement.
  const link = (id, name, pending = true) => ({ id: 500 + id, notify_pending: pending, band_rel: { id, name } });
  const CONCERT = {
    id: 100, name: null, venue: 'Debaser', city: 'Stockholm', country: 'SE',
    concert_date: new Date('2026-11-02T19:00:00Z'), url: null, metadata: null,
    city_id: 12, bands: [link(9, 'Someone Elses Band')],
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
    answer = () => 204;
    prisma.concertDelivery.findMany.mockResolvedValue([]);
    prisma.concertDelivery.createMany.mockResolvedValue({ count: 0 });
    prisma.wishlist.findMany.mockResolvedValue([MINE(), THEIRS()]);
    // Whichever shows the request names, each one the row above.
    prisma.concert.findMany.mockImplementation(async ({ where }) => where.id.in.map((id) => ({ ...CONCERT, id })));
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
    prisma.concert.findMany.mockResolvedValue([{ ...CONCERT, bands: [link(1, 'Opeth')] }]);
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

  it('clears the flag on the shows it posted, so the next sync does not send them again', async () => {
    await post(payload(9, 'Someone Elses Band'));

    expect(prisma.concert.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [100] }, notify_pending: true },
      data: { notify_pending: false },
    });
  });

  it('records each post that went through, before the activity feed can fail', async () => {
    // The 500 below leaves the show pending for the next sync, and what was
    // already posted is on record, so that try does not post it again.
    prisma.activityLog.create.mockRejectedValue(new Error('connection reset'));

    const res = await post(payload(9, 'Someone Elses Band'));

    expect(res.status).toBe(500);
    expect(received.filter((r) => r.path === '/theirs')).toHaveLength(1);
    expect(prisma.concertDelivery.createMany).toHaveBeenCalledWith({
      data: [{ concert_id: 100, band_id: 9, wishlist_id: 8 }], skipDuplicates: true,
    });
    expect(prisma.concert.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: { notify_pending: false },
    }));
  });

  describe('when a post fails', () => {
    // Both wishlists follow band 9 here, so one show has two recipients.
    const BOTH = () => [
      { ...MINE(), bands: [{ band_rel: { id: 9, name: 'Someone Elses Band', ticketmaster_id: null } }] },
      THEIRS(),
    ];
    const cleared = () => prisma.concert.updateMany.mock.calls
      .filter(([arg]) => arg.data.notify_pending === false)
      .flatMap(([arg]) => arg.where.id.in);

    beforeEach(() => {
      prisma.wishlist.findMany.mockResolvedValue(BOTH());
    });

    it('keeps the show pending, and records who did get it', async () => {
      // The flag was cleared for every show in the request, so the recipient
      // whose post failed was never sent it again.
      answer = (path) => (path === '/mine' ? 503 : 204);

      const res = await post(payload(9, 'Someone Elses Band'));

      expect(res.status).toBe(200);
      expect(cleared()).not.toContain(100);
      expect(prisma.concertDelivery.createMany).toHaveBeenCalledWith({
        data: [{ concert_id: 100, band_id: 9, wishlist_id: 8 }], skipDuplicates: true,
      });
    });

    it('sends the retry only to the recipient that did not get it', async () => {
      prisma.concertDelivery.findMany.mockResolvedValue([{ concert_id: 100, band_id: 9, wishlist_id: 8 }]);

      await post(payload(9, 'Someone Elses Band'));

      expect(received.filter((r) => r.path === '/theirs')).toHaveLength(0);
      expect(received.filter((r) => r.path === '/mine')).toHaveLength(1);
      expect(cleared()).toContain(100);
    });

    it('lets the show go when Discord refuses a webhook for good', async () => {
      // A deleted webhook answers 404 to every retry until the show is past.
      answer = (path) => (path === '/mine' ? 404 : 204);

      await post(payload(9, 'Someone Elses Band'));

      expect(cleared()).toContain(100);
    });

    it('holds only the shows a split post did not get to', async () => {
      // Twenty-five fields fill an embed, so twenty-six shows are two posts.
      // The first went through; only the show in the second is owed.
      answer = (path, nth) => (path === '/theirs' && nth === 2 ? 503 : 204);
      prisma.wishlist.findMany.mockResolvedValue([THEIRS()]);
      const body = payload(9, 'Someone Elses Band');
      body.bands[0].concerts = Array.from({ length: 26 }, (_, i) => ({
        ...body.bands[0].concerts[0], concert_id: 200 + i,
      }));

      await post(body);

      const recorded = prisma.concertDelivery.createMany.mock.calls.flatMap(([arg]) => arg.data);
      expect(recorded.map((d) => d.concert_id)).toEqual(Array.from({ length: 25 }, (_, i) => 200 + i));
      expect(cleared()).toHaveLength(25);
      expect(cleared()).not.toContain(225);
    });

    it('adds no second activity entry for a show the feeds were already told about', async () => {
      prisma.concert.findMany.mockResolvedValue([{ ...CONCERT, announced_at: new Date('2026-10-01') }]);
      prisma.concertDelivery.findMany.mockResolvedValue([{ concert_id: 100, band_id: 9, wishlist_id: 8 }]);

      await post(payload(9, 'Someone Elses Band'));

      expect(prisma.activityLog.create).not.toHaveBeenCalled();
    });

    it('marks the shows announced once the feeds have them', async () => {
      await post(payload(9, 'Someone Elses Band'));

      expect(prisma.activityLog.create).toHaveBeenCalled();
      expect(prisma.concert.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [100] }, announced_at: null },
        data: { announced_at: expect.any(Date) },
      });
    });
  });

  describe('an act joining a show already announced', () => {
    // Copenhell: one row, its first act posted long ago, a second act merged
    // into it by this sync. Each act after the first used to be filed as a
    // duplicate and reach no one, the festival watch included.
    const FESTIVAL = {
      ...CONCERT, id: 300, name: 'Motionless In White @ Copenhell', venue: 'Copenhell', city: 'Copenhagen', city_id: 40,
      bands: [link(1, 'Opeth', false), link(9, 'Someone Elses Band')],
    };
    const watch = (over) => ({
      user_id: 'user-1', band_id: null, city_id: null, tour_query: null, venue_query: null,
      user_rel: { id: 'user-1', email: 'me@example.com', settings: null }, ...over,
    });
    const to = (path) => received.filter((r) => r.path === path);

    beforeEach(() => {
      prisma.concert.findMany.mockResolvedValue([FESTIVAL]);
    });

    it('tells a festival watch about each act that joins, and which one it is', async () => {
      prisma.notificationSubscription.findMany.mockResolvedValue([watch({ tour_query: 'copenhell' })]);

      await post(payload(9, 'Someone Elses Band', 300));

      expect(to('/mine')).toHaveLength(1);
      expect(to('/mine')[0].body.embeds[0].fields[0].value).toContain('**New on the bill:** Someone Elses Band');
    });

    it('tells whoever follows the act that joined', async () => {
      await post(payload(9, 'Someone Elses Band', 300));

      expect(to('/theirs')).toHaveLength(1);
      expect(to('/theirs')[0].body.embeds[0].title).toBe('New concerts: Someone Elses Band');
      // Opeth was on the bill before: following it is not news of this.
      expect(to('/mine')).toHaveLength(0);
    });

    it('does not tell a band watch again about a show its band was already on', async () => {
      prisma.notificationSubscription.findMany.mockResolvedValue([watch({ band_id: 1 })]);

      await post(payload(9, 'Someone Elses Band', 300));

      expect(to('/mine')).toHaveLength(0);
    });

    it('does not post the show to a city watch for an act it has nothing to do with', async () => {
      // Both join at once. The wishlist post covers Opeth, which this wishlist
      // follows; the city watch must not then post the show again for band 9.
      prisma.concert.findMany.mockResolvedValue([{
        ...FESTIVAL, bands: [link(1, 'Opeth'), link(9, 'Someone Elses Band'), link(4, 'An Old Act', false)],
      }]);
      prisma.notificationSubscription.findMany.mockResolvedValue([watch({ city_id: 40 })]);

      await post(payload(9, 'Someone Elses Band', 300));

      expect(to('/mine')).toHaveLength(1);
      expect(to('/mine')[0].body.embeds[0].title).toBe('New concerts: Opeth');
    });

    it('records each delivery per act, and clears only the links it read', async () => {
      prisma.notificationSubscription.findMany.mockResolvedValue([watch({ tour_query: 'copenhell' })]);

      await post(payload(9, 'Someone Elses Band', 300));

      expect(prisma.concertDelivery.createMany).toHaveBeenCalledWith({
        data: [{ concert_id: 300, band_id: 9, wishlist_id: 7 }], skipDuplicates: true,
      });
      expect(prisma.concertBandReference.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [509] } }, data: { notify_pending: false },
      });
    });

    it('adds no new-concert entry to the feeds for a show that only gained an act', async () => {
      // Rows from before announced_at have none, and the batch the act rides
      // in can be another band's.
      await post(payload(9, 'Someone Elses Band', 300));

      expect(prisma.activityLog.create).not.toHaveBeenCalled();
    });

    it('posts nothing about a show whose acts have all been announced', async () => {
      prisma.concert.findMany.mockResolvedValue([{
        ...FESTIVAL, bands: FESTIVAL.bands.map((l) => ({ ...l, notify_pending: false })),
      }]);
      prisma.notificationSubscription.findMany.mockResolvedValue([watch({ tour_query: 'copenhell' })]);

      await post(payload(9, 'Someone Elses Band', 300));

      expect(received).toHaveLength(0);
    });
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

describe('GET /wishlists/:id/attendance', () => {
  const WISHLIST = { id: 7, user_id: 'user-1', bands: [] };

  const attendanceRow = (id) => ({
    id,
    created_at: new Date('2026-01-01'),
    missed_bands: [],
    concert_rel: {
      id: id * 10, event_id: `e${id}`, name: null, venue: 'Vega', city: 'Copenhagen',
      country: 'DK', concert_date: new Date('2026-01-01'), url: null, festival: false,
      metadata: null, source: 'songkick', latitude: null, longitude: null,
      on_sale: false, sold_out: false, price_min: null, price_max: null,
      price_currency: null, weather: null, bands: [],
    },
  });

  beforeEach(() => {
    prisma.wishlist.findUnique.mockResolvedValue(WISHLIST);
  });

  it('flags a show that has photographs, and one that has only video as video', async () => {
    // has_photos used to mean any media at all, and the list draws it as "This
    // night has photographs" — a night with three clips and no photograph said
    // it had photographs.
    prisma.concertAttendance.findMany.mockResolvedValue([attendanceRow(1), attendanceRow(2), attendanceRow(3)]);
    // groupBy, not the raw rows: this is the same shape countMediaForAttendances
    // uses to decide whether a show has any media, just grouped per attendance
    // and kind instead of summed across all of them.
    prisma.concertMedia.groupBy.mockResolvedValue([
      { attendance_id: 1, kind: 'PHOTO', _count: 3 },
      { attendance_id: 1, kind: 'VIDEO', _count: 1 },
      { attendance_id: 2, kind: 'VIDEO', _count: 2 },
    ]);

    const res = await request(app).get('/wishlists/7/attendance').set(...authHeader({ id: 'user-1' }));

    expect(res.status).toBe(200);
    expect(prisma.concertMedia.groupBy).toHaveBeenCalledWith(expect.objectContaining({ by: ['attendance_id', 'kind'] }));
    const flags = (id) => {
      const { has_photos, has_videos } = res.body.attendance.find((a) => a.attendance_id === id);
      return { has_photos, has_videos };
    };
    expect(flags(1)).toEqual({ has_photos: true, has_videos: true });
    expect(flags(2)).toEqual({ has_photos: false, has_videos: true });
    expect(flags(3)).toEqual({ has_photos: false, has_videos: false });
  });

  it('skips the media lookup entirely when there is no attendance', async () => {
    prisma.concertAttendance.findMany.mockResolvedValue([]);

    const res = await request(app).get('/wishlists/7/attendance').set(...authHeader({ id: 'user-1' }));

    expect(res.status).toBe(200);
    expect(res.body.attendance).toEqual([]);
    expect(prisma.concertMedia.groupBy).not.toHaveBeenCalled();
  });

  it('marks an act you missed on the bill, and leaves the rest of it seen', async () => {
    const band = (id, name) => ({ setlist: null, band_rel: { id, name } });
    prisma.concertAttendance.findMany.mockResolvedValue([{
      ...attendanceRow(1),
      missed_bands: [{ band_id: 2 }],
      concert_rel: { ...attendanceRow(1).concert_rel, bands: [band(1, 'Gojira'), band(2, 'Mastodon')] },
    }]);
    prisma.concertMedia.groupBy.mockResolvedValue([]);

    const res = await request(app).get('/wishlists/7/attendance').set(...authHeader({ id: 'user-1' }));

    const bands = res.body.attendance[0].concert.participating_bands;
    expect(bands.find((b) => b.id === 1).missed).toBe(false);
    expect(bands.find((b) => b.id === 2).missed).toBe(true);
  });

  it("leaves a show you missed a band at out of that band's own list", async () => {
    prisma.concertAttendance.findMany.mockResolvedValue([]);

    await request(app).get('/wishlists/7/attendance?band_id=5').set(...authHeader({ id: 'user-1' }));

    expect(prisma.concertAttendance.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        concert_rel: { bands: { some: { band: 5 } } },
        missed_bands: { none: { band_id: 5 } },
      }),
    }));
  });
});

describe('PUT /wishlists/:id/attendance/missed', () => {
  const WISHLIST = { id: 7, user_id: 'user-1' };
  const put = (body) => request(app)
    .put('/wishlists/7/attendance/missed')
    .set(...authHeader({ id: 'user-1' }))
    .send(body);
  // An attendance as the route reads it: just whether its bill has the band.
  const row = (id, onBill) => ({ id, concert_rel: { bands: onBill ? [{ band: 3 }] : [] } });

  beforeEach(() => {
    prisma.wishlist.findUnique.mockResolvedValue(WISHLIST);
  });

  it("marks the act missed on each of the night's shows whose bill has it, and no other", async () => {
    // A festival day: the act played one stage's show of the two.
    prisma.concertAttendance.findMany.mockResolvedValue([row(11, true), row(12, false)]);

    const res = await put({ attendance_ids: [11, 12], band_id: 3, missed: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ band_id: 3, missed: true, attendance_ids: [11] });
    expect(prisma.concertAttendance.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: [11, 12] }, wishlist_id: 7 },
    }));
    expect(prisma.attendanceMissedBand.createMany).toHaveBeenCalledWith({
      data: [{ attendance_id: 11, band_id: 3 }],
      skipDuplicates: true,
    });
  });

  it('takes the mark off every show it was asked about', async () => {
    prisma.concertAttendance.findMany.mockResolvedValue([row(11, true), row(12, false)]);

    const res = await put({ attendance_ids: [11, 12], band_id: 3, missed: false });

    expect(res.status).toBe(200);
    expect(prisma.attendanceMissedBand.deleteMany).toHaveBeenCalledWith({
      where: { attendance_id: { in: [11, 12] }, band_id: 3 },
    });
    expect(prisma.attendanceMissedBand.createMany).not.toHaveBeenCalled();
  });

  it('refuses an act that is not on the bill of any of them', async () => {
    prisma.concertAttendance.findMany.mockResolvedValue([row(11, false)]);

    const res = await put({ attendance_ids: [11], band_id: 3, missed: true });

    expect(res.status).toBe(400);
    expect(prisma.attendanceMissedBand.createMany).not.toHaveBeenCalled();
  });

  it("writes nothing when one of the shows is not on this wishlist", async () => {
    // Asked for two, found one: the other is someone else's, or gone.
    prisma.concertAttendance.findMany.mockResolvedValue([row(11, true)]);

    const res = await put({ attendance_ids: [11, 99], band_id: 3, missed: true });

    expect(res.status).toBe(404);
    expect(prisma.attendanceMissedBand.createMany).not.toHaveBeenCalled();
    expect(prisma.attendanceMissedBand.deleteMany).not.toHaveBeenCalled();
  });

  it.each([
    ['no shows', { attendance_ids: [], band_id: 3, missed: true }],
    ['a show that is not an id', { attendance_ids: ['x'], band_id: 3, missed: true }],
    ['no band', { attendance_ids: [11], missed: true }],
    ['a yes or no that is neither', { attendance_ids: [11], band_id: 3, missed: 'maybe' }],
    ['no yes or no at all', { attendance_ids: [11], band_id: 3 }],
  ])('turns away %s', async (_label, body) => {
    const res = await put(body);

    expect(res.status).toBe(400);
    expect(prisma.concertAttendance.findMany).not.toHaveBeenCalled();
  });
});

describe('GET /wishlists/:id times_seen', () => {
  const band = (id, name) => ({
    id, name, setlist: null, MBID: null, songkick_url: null, bandsintown_url: null,
  });
  // A seen-count row as computeSeenCounts reads it.
  const seen = (date, bands, missed = [], venue = 'Festivalpark Stenehei') => ({
    concert_rel: {
      concert_date: new Date(date), venue, city: 'Dessel',
      bands: bands.map((id) => ({ band: id })),
    },
    missed_bands: missed.map((id) => ({ band_id: id })),
  });

  beforeEach(() => {
    prisma.wishlist.findUnique.mockResolvedValue({
      id: 7, user_id: 'user-1', name: 'My Wishlist',
      bands: [
        { band_id: 1, tier: 'LOVE', band_rel: band(1, 'Gojira') },
        { band_id: 2, tier: 'LIKE', band_rel: band(2, 'Mastodon') },
      ],
    });
    prisma.band.findMany.mockResolvedValue([]);
  });

  const timesSeen = async () => {
    const res = await request(app).get('/wishlists/7').set(...authHeader({ id: 'user-1' }));
    expect(res.status).toBe(200);
    return Object.fromEntries(res.body.bands.map((b) => [b.name, b.times_seen]));
  };

  it("counts every act of a festival day, not just the first record's", async () => {
    // Bandsintown's shape: one record per act, all at the same grounds.
    prisma.concertAttendance.findMany.mockResolvedValue([
      seen('2025-06-21', [1]),
      seen('2025-06-21', [2]),
    ]);

    expect(await timesSeen()).toEqual({ Gojira: 1, Mastodon: 1 });
  });

  it('leaves out an act you missed, whichever copy of the night says so', async () => {
    prisma.concertAttendance.findMany.mockResolvedValue([
      seen('2025-06-21', [1, 2]),
      // The next day, imported twice: once with the mark, once without.
      seen('2025-06-22', [1, 2], [2]),
      seen('2025-06-22', [2]),
    ]);

    expect(await timesSeen()).toEqual({ Gojira: 2, Mastodon: 1 });
  });

  it('counts an act listed under two stages of one day once', async () => {
    // Bandsintown files the day's acts under the grounds and under each stage.
    prisma.concertAttendance.findMany.mockResolvedValue([
      seen('2025-06-21', [1]),
      seen('2025-06-21', [1, 2], [], 'South Stage'),
    ]);

    expect(await timesSeen()).toEqual({ Gojira: 1, Mastodon: 1 });
  });

  it('takes a missed mark under one stage name for the whole day', async () => {
    prisma.concertAttendance.findMany.mockResolvedValue([
      seen('2025-06-21', [1], [1]),
      seen('2025-06-21', [1, 2], [], 'South Stage'),
    ]);

    expect(await timesSeen()).toEqual({ Gojira: 0, Mastodon: 1 });
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
    // Counted by ATTENDANCE id (42), not the concert id in the URL (99). Both
    // are integers, both are in scope at the call site, and three of the four
    // sites that take attendance ids have been handed a concert id at some
    // point. Nothing here pinned it: mutating the argument to [concertId] left
    // the whole suite green, and the live version of that mistake counts zero,
    // lets the delete through, and hands the user a 500 from the restricting
    // foreign key instead of this sentence.
    expect(prisma.concertMedia.count).toHaveBeenCalledWith({
      where: { attendance_id: { in: [42] } },
    });
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

describe('POST /wishlists/:id/attendance/from-setlist', () => {
  // The router's own copy of the setlist.fm client: it is CommonJS and loads
  // its dependencies through Node's require, which an ESM import does not share.
  const setlistFm = createRequire(import.meta.url)('../../utils/setlistFm.js');

  const SETLIST = {
    id: '63de4613',
    eventDate: '24-06-2026',
    url: 'https://www.setlist.fm/setlist/gojira/2026/falan-63de4613.html',
    artist: { mbid: '65f4f0c5-ef9e-490c-aee3-909e7ae6b2ab', name: 'Gojira' },
    venue: { name: 'Fållan', city: { name: 'Stockholm', country: { code: 'SE' }, coords: { lat: 59.3, long: 18.0 } } },
    sets: { set: [{ song: [{ name: 'Stranded' }] }] },
  };

  beforeEach(() => {
    process.env.SETLIST_API_KEY = 'test-key';
    vi.spyOn(setlistFm, 'fetchSetlistById').mockResolvedValue(SETLIST);
    prisma.wishlist.findUnique.mockResolvedValue({ id: 7, user_id: 'user-1' });
    prisma.band.findUnique.mockResolvedValue({ id: 3, MBID: SETLIST.artist.mbid });
    prisma.city.upsert.mockResolvedValue({ id: 12, latitude: 59.3 });
    prisma.concert.upsert.mockResolvedValue({ id: 500 });
    prisma.concert.updateMany.mockResolvedValue({ count: 0 });
    prisma.concertBandReference.upsert.mockResolvedValue({});
    prisma.concertAttendance.upsert.mockResolvedValue({ id: 900 });
  });

  const post = (body) => request(app)
    .post('/wishlists/7/attendance/from-setlist')
    .set(...authHeader({ id: 'user-1' }))
    .send(body);

  it('takes the show from setlist.fm and ignores what the client says about it', async () => {
    // The body used to be the source for all of this, written into the table
    // every account reads.
    const res = await post({
      setlistfm_id: '63de4613', band_id: 3,
      date: '01-01-2030', venue: 'Somewhere else', city: 'Nowhere', country: 'XX',
      url: 'https://evil.example/', songs: [{ name: 'Not played' }],
    });

    expect(res.status).toBe(200);
    expect(setlistFm.fetchSetlistById).toHaveBeenCalledWith('63de4613');
    expect(prisma.concert.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { event_id: 'sfm_63de4613' },
      create: expect.objectContaining({
        venue: 'Fållan', city: 'Stockholm', country: 'SE',
        concert_date: new Date('2026-06-24T12:00:00Z'),
        url: SETLIST.url,
      }),
    }));
    expect(prisma.concertBandReference.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ setlist: { songs: [{ name: 'Stranded', cover: null, tape: false }] } }),
    }));
  });

  it('refuses a show that has not happened yet', async () => {
    setlistFm.fetchSetlistById.mockResolvedValue({ ...SETLIST, eventDate: '01-01-2099' });

    const res = await post({ setlistfm_id: '63de4613', band_id: 3 });

    expect(res.status).toBe(400);
    expect(prisma.concert.upsert).not.toHaveBeenCalled();
  });

  it('refuses a setlist by a different artist than the band named', async () => {
    prisma.band.findUnique.mockResolvedValue({ id: 3, MBID: 'ca891d65-d9b0-4258-89f7-e6ba29d83767' });

    const res = await post({ setlistfm_id: '63de4613', band_id: 3 });

    expect(res.status).toBe(400);
    expect(prisma.concert.upsert).not.toHaveBeenCalled();
  });

  it('matches an MBID stored in capitals — quick-add accepts either case', async () => {
    prisma.band.findUnique.mockResolvedValue({ id: 3, MBID: SETLIST.artist.mbid.toUpperCase() });

    const res = await post({ setlistfm_id: '63de4613', band_id: 3 });

    expect(res.status).toBe(200);
  });

  it('files the show under the id it asked for, even if the answer lacks one', async () => {
    // "sfm_null" would have made every such show one concert.
    setlistFm.fetchSetlistById.mockResolvedValue({ ...SETLIST, id: undefined });

    const res = await post({ setlistfm_id: '63de4613', band_id: 3 });

    expect(res.status).toBe(200);
    expect(prisma.concert.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { event_id: 'sfm_63de4613' },
    }));
  });

  it('refuses an id that could steer the request elsewhere on setlist.fm', async () => {
    const res = await post({ setlistfm_id: '../artist/x/setlists', band_id: 3 });

    expect(res.status).toBe(400);
    expect(setlistFm.fetchSetlistById).not.toHaveBeenCalled();
  });

  it('answers 404 for a band that does not exist, before asking setlist.fm', async () => {
    prisma.band.findUnique.mockResolvedValue(null);

    const res = await post({ setlistfm_id: '63de4613', band_id: 3 });

    expect(res.status).toBe(404);
    expect(setlistFm.fetchSetlistById).not.toHaveBeenCalled();
  });

  it('passes setlist.fm\'s own 404 on', async () => {
    setlistFm.fetchSetlistById.mockRejectedValue(Object.assign(new Error('nope'), { response: { status: 404 } }));

    const res = await post({ setlistfm_id: '63de4613', band_id: 3 });

    expect(res.status).toBe(404);
  });

  it('does nothing for someone else\'s wishlist', async () => {
    prisma.wishlist.findUnique.mockResolvedValue({ id: 7, user_id: 'user-2' });

    const res = await post({ setlistfm_id: '63de4613', band_id: 3 });

    expect(res.status).toBe(403);
    expect(setlistFm.fetchSetlistById).not.toHaveBeenCalled();
  });
});

describe('POST /wishlists', () => {
  const create = () => request(app).post('/wishlists').set(...authHeader({ id: 'user-1' })).send({ name: 'My Wishlist' });

  // These spend the shared write limiter too; see the sweep above.
  afterAll(async () => {
    const { rateLimit } = createRequire(import.meta.url)('./wishlists/shared.js');
    for (const ip of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) await rateLimit.resetKey(ip);
  });

  it('makes a wishlist for an account that has none', async () => {
    prisma.wishlist.findUnique.mockResolvedValue(null);
    prisma.wishlist.create.mockResolvedValue({ id: 5, user_id: 'user-1', bands: [] });

    const res = await create();

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(5);
  });

  it('hands back the one you have rather than making another', async () => {
    prisma.wishlist.findUnique.mockResolvedValue({ id: 7, user_id: 'user-1', bands: [] });

    const res = await create();

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(7);
    expect(prisma.wishlist.create).not.toHaveBeenCalled();
  });

  it('answers the loser of two overlapping creates with the wishlist the winner made', async () => {
    // Both read "none yet" before either wrote; user_id is unique, so the
    // second insert fails. That was a 500 on a wishlist that existed.
    prisma.wishlist.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 5, user_id: 'user-1', bands: [] });
    prisma.wishlist.create.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));

    const res = await create();

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(5);
  });

  it('still fails a create that broke for any other reason', async () => {
    prisma.wishlist.findUnique.mockResolvedValue(null);
    prisma.wishlist.create.mockRejectedValue(new Error('connection lost'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await create();

    expect(res.status).toBe(500);
  });
});

describe('POST /wishlists/:id/bands', () => {
  // The router's own copy of band creation — see the from-setlist tests.
  const bandCreate = createRequire(import.meta.url)('../../utils/bandCreate.js');

  beforeEach(() => {
    delete process.env.CALLBACK_URL;
    prisma.wishlist.findUnique.mockResolvedValue({ id: 7, user_id: 'user-1' });
    prisma.wishlistBandReference.findFirst.mockResolvedValue(null);
    prisma.wishlistBandReference.create.mockResolvedValue({});
  });

  const add = (body) => request(app).post('/wishlists/7/bands').set(...authHeader({ id: 'user-1' })).send(body);

  it('creates the band in-process, with no CALLBACK_URL needed', async () => {
    // This was the API calling itself over HTTP at CALLBACK_URL.
    vi.spyOn(bandCreate, 'createBand').mockResolvedValue({ band: { id: 50, name: 'Gojira' }, warning: null });

    const res = await add({ name: '  Gojira ', tier: 'LOVE' });

    expect(res.status).toBe(201);
    expect(bandCreate.createBand).toHaveBeenCalledWith('Gojira');
    expect(prisma.wishlistBandReference.create).toHaveBeenCalledWith({
      data: { wishlist_id: 7, band_id: 50, tier: 'LOVE' },
    });
  });

  it('links the band that already exists', async () => {
    vi.spyOn(bandCreate, 'createBand').mockRejectedValue(new bandCreate.BandExistsError({ id: 92, name: 'Gojira' }));

    const res = await add({ name: 'Gojira' });

    expect(res.status).toBe(201);
    expect(res.body.band.id).toBe(92);
  });

  it('says so when the band is already on the wishlist', async () => {
    vi.spyOn(bandCreate, 'createBand').mockRejectedValue(new bandCreate.BandExistsError({ id: 92, name: 'Gojira' }));
    prisma.wishlistBandReference.findFirst.mockResolvedValue({ id: 1 });

    const res = await add({ name: 'Gojira' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already on this wishlist/);
  });

  it('answers a double tap with the same conflict, not a 500', async () => {
    // Both requests passed the "already on it?" read before either wrote.
    vi.spyOn(bandCreate, 'createBand').mockRejectedValue(new bandCreate.BandExistsError({ id: 92, name: 'Gojira' }));
    prisma.wishlistBandReference.create.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));

    const res = await add({ name: 'Gojira' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already on this wishlist/);
  });

  it('answers 404 for a Ticketmaster id no band has', async () => {
    vi.spyOn(bandCreate, 'createBand');
    prisma.band.findUnique.mockResolvedValue(null);

    const res = await add({ ticketmaster_id: 'K8vZ917G' });

    expect(res.status).toBe(404);
    expect(bandCreate.createBand).not.toHaveBeenCalled();
  });
});

describe('wishlist ids that are not numbers', () => {
  it('answer 400 rather than reaching Prisma as NaN', async () => {
    for (const path of [
      '/wishlists/abc', '/wishlists/abc/new', '/wishlists/abc/activity', '/wishlists/abc/recent-concerts',
      '/wishlists/abc/attendance', '/wishlists/abc/calendar-token',
    ]) {
      const res = await request(app).get(path).set(...authHeader({ id: 'user-1' }));
      expect(res.status).toBe(400);
    }
    expect(prisma.wishlist.findUnique).not.toHaveBeenCalled();
  });
});

describe('GET /wishlists/:id with a date window', () => {
  it('asks the database for the window rather than reading every concert ever', async () => {
    prisma.wishlist.findUnique.mockResolvedValue({ id: 7, user_id: 'user-1', bands: [] });
    prisma.band.findMany.mockResolvedValue([]);
    prisma.concertAttendance.findMany.mockResolvedValue([]);

    await request(app)
      .get('/wishlists/7')
      .query({ start_date: '2026-10-01', end_date: '2026-10-07', countries: 'SE,NO' })
      .set(...authHeader({ id: 'user-1' }));

    const { select } = prisma.band.findMany.mock.calls[0][0];
    expect(select.concerts.where.concert_rel).toEqual({
      concert_date: { gte: new Date('2026-10-01'), lte: new Date('2026-10-07T23:59:59.999Z') },
      country: { in: ['SE', 'NO'] },
    });
  });

  it('ends the window at the end of the UTC day, whatever zone the server is in', async () => {
    // concert_date files a show under its UTC day, so that is the day the
    // window has to close on. Worked out in local time, a server in Stockholm
    // closed it two hours early and lost the evening's shows.
    const zone = process.env.TZ;
    process.env.TZ = 'Europe/Stockholm';
    try {
      prisma.wishlist.findUnique.mockResolvedValue({ id: 7, user_id: 'user-1', bands: [] });
      prisma.band.findMany.mockResolvedValue([]);
      prisma.concertAttendance.findMany.mockResolvedValue([]);

      await request(app)
        .get('/wishlists/7')
        .query({ start_date: '2026-10-01', end_date: '2026-10-07' })
        .set(...authHeader({ id: 'user-1' }));

      const { where } = prisma.band.findMany.mock.calls[0][0].select.concerts;
      expect(where.concert_rel.concert_date.lte).toEqual(new Date('2026-10-07T23:59:59.999Z'));
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  it('asks for everything when no window is given', async () => {
    prisma.wishlist.findUnique.mockResolvedValue({ id: 7, user_id: 'user-1', bands: [] });
    prisma.band.findMany.mockResolvedValue([]);
    prisma.concertAttendance.findMany.mockResolvedValue([]);

    await request(app).get('/wishlists/7').set(...authHeader({ id: 'user-1' }));

    expect(prisma.band.findMany.mock.calls[0][0].select.concerts).not.toHaveProperty('where');
  });
});

describe('GET /wishlists/:id/activity', () => {
  it('survives one entry that is not JSON', async () => {
    prisma.wishlist.findUnique.mockResolvedValue({ id: 7, user_id: 'user-1' });
    prisma.activityLog.findMany.mockResolvedValue([
      { id: 1, type: 'NEW_CONCERTS', data: '{"total":2}' },
      { id: 2, type: 'NEW_CONCERTS', data: 'not json' },
    ]);

    const res = await request(app).get('/wishlists/7/activity').set(...authHeader({ id: 'user-1' }));

    expect(res.status).toBe(200);
    expect(res.body.activity.map((a) => a.data)).toEqual([{ total: 2 }, null]);
  });
});

describe('logActivity', () => {
  const { logActivity, ACTIVITY_KEPT } = createRequire(import.meta.url)('./wishlists/shared.js');

  it('writes the entry as JSON and lets everything past the kept few fall off', async () => {
    prisma.activityLog.create.mockResolvedValue({});
    prisma.activityLog.findMany.mockResolvedValue([{ id: 3 }, { id: 1 }]);

    await logActivity(7, 'BAND_ADDED', { band_name: 'Opeth' });

    expect(prisma.activityLog.create).toHaveBeenCalledWith({
      data: { wishlist_id: 7, type: 'BAND_ADDED', data: '{"band_name":"Opeth"}' },
    });
    expect(prisma.activityLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { wishlist_id: 7 }, skip: ACTIVITY_KEPT,
    }));
    expect(prisma.activityLog.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [3, 1] } } });
  });

  it('deletes nothing while the feed is short', async () => {
    prisma.activityLog.create.mockResolvedValue({});
    prisma.activityLog.findMany.mockResolvedValue([]);

    await logActivity(7, 'NEW_CONCERTS', { total: 1 });

    expect(prisma.activityLog.deleteMany).not.toHaveBeenCalled();
  });
});

describe('GET /wishlists/:id/new', () => {
  it('moves the cursor only after everything it covers has been read', async () => {
    // Written first, a failure below it moved the cursor past concerts nobody
    // had been shown.
    prisma.wishlist.findUnique.mockResolvedValue({ id: 7, user_id: 'user-1', last_active_at: null, bands: [{ band_id: 1 }] });
    prisma.concertBandReference.findMany.mockRejectedValue(new Error('connection lost'));

    const res = await request(app).get('/wishlists/7/new').set(...authHeader({ id: 'user-1' }));

    expect(res.status).toBe(500);
    expect(prisma.wishlist.update).not.toHaveBeenCalled();
  });

  it('asks only for shows still to come, or not yet dated', async () => {
    // A show imported from setlist.fm history is a row created today with a
    // date years back. Filtered on created_at alone, it came back as news.
    prisma.wishlist.findUnique.mockResolvedValue({ id: 7, user_id: 'user-1', last_active_at: null, bands: [{ band_id: 1 }] });
    prisma.concertBandReference.findMany.mockResolvedValue([]);
    prisma.wishlist.update.mockResolvedValue({});

    const res = await request(app).get('/wishlists/7/new').set(...authHeader({ id: 'user-1' }));

    expect(res.status).toBe(200);
    const { concert_rel: filter } = prisma.concertBandReference.findMany.mock.calls[0][0].where;
    const from = filter.OR.find((clause) => clause.concert_date?.gte).concert_date.gte;
    expect(from.toISOString()).toBe(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    expect(filter.OR).toContainEqual({ concert_date: null });
  });

  it('carries the rest of the bill, for the show it pins on the map', async () => {
    // A show outside the map's dates is pinned from this copy, and the popup
    // reads every act you don't follow from metadata. Without it, Palaye Royale
    // at COS Torwar showed only Badflower, the one band linked to the show.
    const show = {
      id: 14000, created_at: new Date('2026-10-03'), name: 'Palaye Royale', city: 'Warsaw', country: 'PL',
      venue: 'COS Torwar', concert_date: new Date('2027-03-09T19:00:00Z'), source: 'songkick',
      metadata: '["Palaye Royale","Badflower","Winiary Bookings"]',
      bands: [{ band_rel: { id: 128, name: 'Badflower' } }],
    };
    prisma.wishlist.findUnique.mockResolvedValue({ id: 7, user_id: 'user-1', last_active_at: null, bands: [{ band_id: 128 }] });
    prisma.concertBandReference.findMany.mockResolvedValue([{ band_rel: { name: 'Badflower' }, concert_rel: show }]);
    prisma.activityLog.findMany.mockResolvedValue([]);
    prisma.wishlist.update.mockResolvedValue({});

    const res = await request(app).get('/wishlists/7/new').set(...authHeader({ id: 'user-1' }));

    expect(res.status).toBe(200);
    const { select } = prisma.concertBandReference.findMany.mock.calls[0][0].include.concert_rel;
    expect(select).toMatchObject({ metadata: true, source: true });
    expect(res.body.concerts[0]).toMatchObject({ metadata: show.metadata, source: 'songkick' });
  });
});

describe('GET /wishlists/:id/recent-concerts', () => {
  it('says which shows have sold out', async () => {
    // The Updates panel marks them on the row. It is the only news a show
    // carries after it was announced, now that the panel has no activity log.
    prisma.wishlist.findUnique.mockResolvedValue({ id: 7, user_id: 'user-1', bands: [{ band_id: 1, tier: 1 }] });
    prisma.concert.findMany.mockResolvedValue([{
      id: 10, name: null, city: 'Oslo', country: 'NO', venue: 'Spektrum',
      concert_date: new Date('2027-03-12'), url: null, festival: false, sold_out: true,
      created_at: new Date('2026-09-01'), latitude: null, longitude: null,
      bands: [{ band_rel: { id: 1, name: 'Ghost' } }],
    }]);

    const res = await request(app).get('/wishlists/7/recent-concerts').set(...authHeader({ id: 'user-1' }));

    expect(res.status).toBe(200);
    expect(prisma.concert.findMany.mock.calls[0][0].select.sold_out).toBe(true);
    expect(res.body.groups[0].concerts[0].sold_out).toBe(true);
  });

  it('sends what the map popup reads, as /new does', async () => {
    // "Show on map" pins a show from this feed exactly as it pins one from
    // /new, so the two must carry the same show: its bill, its listing, its
    // sale state and its price.
    prisma.wishlist.findUnique.mockResolvedValue({ id: 7, user_id: 'user-1', bands: [{ band_id: 128, tier: 'LIKE' }] });
    prisma.concert.findMany.mockResolvedValue([]);

    const res = await request(app).get('/wishlists/7/recent-concerts').set(...authHeader({ id: 'user-1' }));

    expect(res.status).toBe(200);
    expect(prisma.concert.findMany.mock.calls[0][0].select).toMatchObject({
      metadata: true, source: true, on_sale: true, ticket_sale_start: true,
      price_min: true, price_max: true, price_currency: true,
    });
  });
});

describe('the weekly recap', () => {
  // Served by a real socket, as the notify tests are: the recap posts through
  // axios required by CommonJS, which vi.mock cannot reach.
  let server;
  let received;
  let status;
  const hook = (path) => `http://127.0.0.1:${server.address().port}${path}`;

  beforeAll(async () => {
    const { createServer } = await import('node:http');
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        received.push({ path: req.url, body: JSON.parse(body || '{}') });
        res.writeHead(status);
        res.end();
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  const ADDED = [{
    id: 10, name: null, venue: 'Avicii Arena', festival: false, url: 'https://tickets.example/10', city: 'Stockholm', country: 'SE', concert_date: new Date('2027-03-12'), created_at: new Date(),
    bands: [{ band_rel: { id: 1, name: 'Ghost' } }],
  }];
  const wishlist = (extra = {}) => ({
    id: 7, user_id: 'user-1', discord_webhook: hook('/mine'), bands: [{ band_id: 1, tier: 'LOVE' }], ...extra,
  });

  beforeEach(async () => {
    received = [];
    status = 204;
    prisma.wishlist.findUnique.mockResolvedValue(wishlist());
    prisma.concert.findMany.mockResolvedValue(ADDED);
    const { sendLimit } = createRequire(import.meta.url)('./wishlists/recap.js');
    for (const ip of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) await sendLimit.resetKey(ip);
  });

  it("counts the week's new shows by city, in the viewer's zone", async () => {
    const res = await request(app).get('/wishlists/7/weekly?tz=Europe/Stockholm&weeks_ago=1').set(...authHeader({ id: 'user-1' }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 1, time_zone: 'Europe/Stockholm', country_count: 1,
      cities: [{
        city: 'Stockholm', country: 'SE', count: 1,
        concerts: [{
          id: 10, concert_date: '2027-03-12T00:00:00.000Z', name: null, venue: 'Avicii Arena', festival: false,
          url: 'https://tickets.example/10',
          bands: [{ id: 1, name: 'Ghost', tier: 'LOVE' }],
        }],
      }],
    });
    expect(Date.parse(res.body.end) - Date.parse(res.body.start)).toBeGreaterThanOrEqual(167 * 3600 * 1000);
  });

  it('says whether there is a webhook, and never what it is', async () => {
    // A webhook url is enough to post as it, so it stays on the server.
    const res = await request(app).get('/wishlists/7/weekly').set(...authHeader({ id: 'user-1' }));

    expect(res.body.discord).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('/mine');
  });

  it('refuses a zone it does not know, and a week out of range', async () => {
    for (const q of ['tz=Mars/Olympus_Mons', 'weeks_ago=-1', 'weeks_ago=9999', 'weeks_ago=one']) {
      const res = await request(app).get(`/wishlists/7/weekly?${q}`).set(...authHeader({ id: 'user-1' }));
      expect([q, res.status]).toEqual([q, 400]);
    }
    expect(prisma.concert.findMany).not.toHaveBeenCalled();
  });

  it('posts the week to the wishlist\'s own webhook', async () => {
    const res = await request(app).post('/wishlists/7/weekly/discord').set(...authHeader({ id: 'user-1' }))
      .send({ tz: 'Europe/Stockholm', weeks_ago: 0 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true, total: 1 });
    expect(received).toHaveLength(1);
    expect(received[0].path).toBe('/mine');
    expect(received[0].body.embeds[0].title).toMatch(/^Week \d+: 1 new concert$/);
    expect(received[0].body.embeds[0].description).toContain('**Ghost**');
  });

  it('says so when there is no webhook to post to', async () => {
    prisma.wishlist.findUnique.mockResolvedValue(wishlist({ discord_webhook: null }));

    const res = await request(app).post('/wishlists/7/weekly/discord').set(...authHeader({ id: 'user-1' })).send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no Discord webhook/);
    expect(prisma.concert.findMany).not.toHaveBeenCalled();
  });

  it('does not post an empty week', async () => {
    prisma.concert.findMany.mockResolvedValue([]);

    const res = await request(app).post('/wishlists/7/weekly/discord').set(...authHeader({ id: 'user-1' })).send({});

    expect(res.status).toBe(409);
    expect(received).toHaveLength(0);
  });

  it('answers 502 when Discord turns the post down', async () => {
    status = 404;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).post('/wishlists/7/weekly/discord').set(...authHeader({ id: 'user-1' })).send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Discord did not take the post/);
  });
});

describe('GET /wishlists/:id/festivals', () => {
  const me = authHeader({ id: 'user-1', role: 'USER' });
  const act = (id, name) => ({ band_rel: { id, name } });
  const COPENHELL = {
    id: 300, name: 'Gojira @ Copenhell', venue: 'Copenhell', city: 'Copenhagen', country: 'DK',
    concert_date: new Date('2027-06-17T00:00:00Z'), url: null, metadata: null,
    bands: [act(1, 'Opeth'), act(2, 'Gojira')],
  };
  const where = () => prisma.concert.findMany.mock.calls[0][0].where;

  beforeEach(() => {
    prisma.wishlist.findUnique.mockResolvedValue({ id: 7, user_id: 'user-1', bands: [{ band_id: 2, tier: 'LOVE' }] });
    prisma.notificationSubscription.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.concert.findMany.mockResolvedValue([COPENHELL]);
  });

  it('lists each festival with your bands on it', async () => {
    const res = await request(app).get('/wishlists/7/festivals').set(...me);

    expect(res.status).toBe(200);
    expect(res.body.festivals).toEqual([expect.objectContaining({
      name: 'Copenhell', first: '2027-06-17', acts: 2, watched: false,
      bands: [{ id: 2, name: 'Gojira', tier: 'LOVE' }],
    })]);
  });

  it('asks for what is flagged a festival, listed as one by Songkick, or crowded enough to be one', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 300 }]);

    await request(app).get('/wishlists/7/festivals').set(...me);

    const signals = where().AND[1].OR;
    expect(signals).toContainEqual({ festival: true });
    expect(signals).toContainEqual({ url: { contains: 'songkick.com/festivals/', mode: 'insensitive' } });
    expect(signals).toContainEqual({ id: { in: [300] } });
  });

  it('counts a festival you watch, before anything else would mark it one', async () => {
    // Copenhell's first act is one Bandsintown page: no flag, no Songkick
    // page, one act on the bill.
    prisma.notificationSubscription.findMany.mockResolvedValue([{ tour_query: 'copenhell', venue_query: null }]);

    const res = await request(app).get('/wishlists/7/festivals').set(...me);

    expect(where().AND[1].OR).toContainEqual({ AND: [{ OR: [
      { name: { contains: 'copenhell', mode: 'insensitive' } },
      { venue: { contains: 'copenhell', mode: 'insensitive' } },
    ] }] });
    expect(prisma.notificationSubscription.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { user_id: 'user-1', tour_query: { not: null } },
    }));
    expect(res.body.festivals[0].watched).toBe(true);
  });

  it('leaves out a tour Songkick files as a festival, unless something else says it is one', async () => {
    const date = (id, city, over = {}) => ({
      ...COPENHELL, id, city, name: 'Hollywood Undead: EU/UK 2027', venue: `Venue ${id}`, festival: false,
      url: `http://www.songkick.com/festivals/3808399-hollywood-undead-euuk/id/${id}-hollywood-undead-euuk-2027`,
      bands: [act(9, 'Hollywood Undead')], ...over,
    });
    prisma.concert.findMany.mockResolvedValue([date(1, 'Prague'), date(2, 'Warsaw'), date(3, 'Gothenburg', { festival: true }), COPENHELL]);

    const res = await request(app).get('/wishlists/7/festivals').set(...me);

    expect(res.body.festivals.map((f) => f.city)).toEqual(['Copenhagen', 'Gothenburg']);
  });

  it('leaves out what has already happened, by calendar day', async () => {
    await request(app).get('/wishlists/7/festivals').set(...me);

    const from = where().AND[0].OR.find((c) => c.concert_date?.gte).concert_date.gte;
    expect(from.toISOString()).toBe(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  });
});

describe('DELETE /wishlists/:id', () => {
  beforeEach(() => {
    prisma.wishlist.findUnique.mockResolvedValue({ id: 7, user_id: 'user-1' });
    prisma.activityLog.deleteMany.mockResolvedValue({ count: 3 });
    prisma.wishlistBandReference.deleteMany.mockResolvedValue({ count: 2 });
    prisma.wishlist.delete.mockResolvedValue({ id: 7 });
  });

  it('takes the activity log with it, in one transaction', async () => {
    // ActivityLog restricts the delete, so any wishlist that had ever seen a
    // new concert could not be deleted at all.
    prisma.concertAttendance.count = vi.fn(async () => 0);

    const res = await request(app).delete('/wishlists/7').set(...authHeader({ id: 'user-1', role: 'ADMIN' }));

    expect(res.status).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.activityLog.deleteMany).toHaveBeenCalledWith({ where: { wishlist_id: 7 } });
  });

  it('refuses in words while shows attended still hang off it', async () => {
    prisma.concertAttendance.count = vi.fn(async () => 2);

    const res = await request(app).delete('/wishlists/7').set(...authHeader({ id: 'user-1', role: 'ADMIN' }));

    expect(res.status).toBe(409);
    expect(prisma.wishlist.delete).not.toHaveBeenCalled();
  });
});

describe('POST /wishlists/:id/calendar-token', () => {
  it('only writes a token where there is none, and answers with what is stored', async () => {
    // Two requests at once each minted a token and the second overwrote the
    // first, breaking whichever calendar had subscribed with it.
    prisma.wishlist.findUnique
      .mockResolvedValueOnce({ id: 7, user_id: 'user-1', calendar_token: null })
      .mockResolvedValueOnce({ calendar_token: 'the-one-that-won' });
    prisma.wishlist.updateMany.mockResolvedValue({ count: 0 });
    process.env.CALLBACK_URL = 'https://api.example.test';

    const res = await request(app).post('/wishlists/7/calendar-token').set(...authHeader({ id: 'user-1' }));

    expect(res.status).toBe(200);
    expect(prisma.wishlist.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 7, calendar_token: null },
    }));
    expect(res.body.token).toBe('the-one-that-won');
  });
});
