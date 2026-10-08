import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

const prisma = installFakePrisma({
  concert: { findUnique: vi.fn(), updateMany: vi.fn(async () => ({ count: 0 })) },
  user: { findUnique: vi.fn(), update: vi.fn(async () => ({})) },
  concertFollow: { findMany: vi.fn(), upsert: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 1 })) },
  notificationSubscription: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), delete: vi.fn() },
  band: { findUnique: vi.fn() },
  city: { findUnique: vi.fn() },
});

const { default: router } = await import('./notifications.js');
const app = buildApp(router);
const me = authHeader({ id: 'user-1', role: 'USER' });

beforeEach(() => { vi.clearAllMocks(); });

describe('following a show for its tickets', () => {
  it('starts from where the tickets are now, so an on-sale show says nothing until it changes', async () => {
    prisma.concert.findUnique.mockResolvedValue({
      id: 300, on_sale: true, sold_out: false, ticket_sale_start: null,
      metadata: JSON.stringify(['Ghost', 'Uncle Acid']),
      bands: [{ band_rel: { name: 'Opeth' } }],
      event_status: null, concert_date: new Date('2027-02-13T18:45:00Z'), venue: 'Fållan',
    });

    const res = await request(app).put('/notifications/follows/300').set(...me);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ concert_id: 300, tickets: 'on_sale' });
    expect(prisma.concertFollow.upsert).toHaveBeenCalledWith({
      where: { user_id_concert_id: { user_id: 'user-1', concert_id: 300 } },
      create: {
        user_id: 'user-1', concert_id: 300, told_state: 'on_sale',
        // The bill as it stands, so only what joins it later is news — the
        // acts with a Band row and the plain names in metadata alike.
        lineup_told: JSON.stringify(['Opeth', 'Ghost', 'Uncle Acid']),
        // Going ahead, on this day at this venue: only a move after this is news.
        status_told: 'scheduled',
        date_told: new Date('2027-02-13T18:45:00Z'),
        venue_told: 'Fållan',
      },
      // Following again keeps what you have been told.
      update: {},
    });
  });

  it('saves the browser\'s time zone for the sale-day reminder, when the account has none yet', async () => {
    prisma.concert.findUnique.mockResolvedValue({ id: 300, on_sale: false, sold_out: false, ticket_sale_start: null, metadata: null, bands: [] });
    prisma.user.findUnique.mockResolvedValue({ settings: { discord_user_id: '42' } });

    await request(app).put('/notifications/follows/300').set(...me).send({ tz: 'Europe/Stockholm' });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' }, data: { settings: { discord_user_id: '42', timeZone: 'Europe/Stockholm' } },
    });

    prisma.user.update.mockClear();
    prisma.user.findUnique.mockResolvedValue({ settings: { timeZone: 'Europe/Oslo' } });
    await request(app).put('/notifications/follows/300').set(...me).send({ tz: 'Europe/Stockholm' });
    await request(app).put('/notifications/follows/300').set(...me).send({ tz: 'Not/AZone' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('answers 404 for a show that is not there, and 400 for an id that is not one', async () => {
    prisma.concert.findUnique.mockResolvedValue(null);

    expect((await request(app).put('/notifications/follows/999').set(...me)).status).toBe(404);
    expect((await request(app).put('/notifications/follows/abc').set(...me)).status).toBe(400);
    expect(prisma.concertFollow.upsert).not.toHaveBeenCalled();
  });

  it('unfollows only your own', async () => {
    const res = await request(app).delete('/notifications/follows/300').set(...me);

    expect(res.status).toBe(200);
    expect(prisma.concertFollow.deleteMany).toHaveBeenCalledWith({ where: { user_id: 'user-1', concert_id: 300 } });
  });

  it('lists yours with where each show\'s tickets are', async () => {
    prisma.concertFollow.findMany.mockResolvedValue([{
      concert_id: 300, created_at: new Date('2026-10-06T12:00:00Z'),
      concert_rel: {
        id: 300, name: 'Hollywood Undead: EU/UK 2027', venue: 'Fållan', city: 'Stockholm', country: 'SE',
        concert_date: new Date('2027-02-13T18:45:00Z'), url: null, on_sale: false, sold_out: false,
        ticket_sale_start: new Date('2099-10-09T00:00:00Z'), metadata: null,
        bands: [{ band_rel: { id: 9, name: 'Hollywood Undead' } }],
      },
    }]);

    const res = await request(app).get('/notifications/follows').set(...me);

    expect(prisma.concertFollow.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { user_id: 'user-1' } }));
    expect(res.body).toEqual([expect.objectContaining({
      concert_id: 300, tickets: 'on_sale_soon',
      concert: expect.objectContaining({
        venue: 'Fållan',
        bands: [expect.objectContaining({ id: 9, name: 'Hollywood Undead', linked: true })],
      }),
    })]);
  });

  it('lists the whole bill, including the acts with no band row, and keeps the raw lineup out of the answer', async () => {
    prisma.concertFollow.findMany.mockResolvedValue([{
      concert_id: 300, created_at: new Date('2026-10-06T12:00:00Z'),
      concert_rel: {
        id: 300, name: 'Wacken 2027', venue: 'Wacken', city: 'Wacken', country: 'DE',
        concert_date: new Date('2027-07-29T10:00:00Z'), url: null, on_sale: true, sold_out: false,
        ticket_sale_start: null,
        // "Hollywood Undead (US)" is the same act as the linked row: the
        // scraper's disambiguator must not list it a second time.
        metadata: JSON.stringify(['Hollywood Undead (US)', 'Sleep Token', 'Ghost']),
        bands: [{ band_rel: { id: 9, name: 'Hollywood Undead' } }],
      },
    }]);

    const res = await request(app).get('/notifications/follows').set(...me);

    expect(res.body[0].concert.bands).toEqual([
      expect.objectContaining({ id: 9, name: 'Hollywood Undead', linked: true }),
      expect.objectContaining({ id: null, name: 'Sleep Token', linked: false }),
      expect.objectContaining({ id: null, name: 'Ghost', linked: false }),
    ]);
    expect(res.body[0].concert).not.toHaveProperty('metadata');
  });

  it('says who sells each show, for how much, and when the checker last read it', async () => {
    const checked = new Date(Date.now() - 4 * 60 * 1000);
    prisma.concertFollow.findMany.mockResolvedValue([{
      concert_id: 300, created_at: new Date('2026-10-06T12:00:00Z'),
      concert_rel: {
        id: 300, name: 'Hollywood Undead: EU/UK 2027', venue: 'Fållan', city: 'Stockholm', country: 'SE',
        concert_date: new Date('2099-02-13T18:45:00Z'), url: 'https://www.songkick.com/concerts/43451188',
        source: 'songkick', on_sale: true, sold_out: false, ticket_sale_start: null, metadata: null, bands: [],
        price_min: 45, price_max: 89, price_currency: 'EUR', event_status: null,
        tickets_opened_at: new Date('2026-10-09T08:02:00Z'),
        ticket_vendors: [{ name: 'Ticketmaster', state: 'on_sale', sale_date: null, url: 'https://www.ticketmaster.se/1', price: null }],
        event_id: 'sk_43451188', tickets_checked_at: checked, ticket_check_attempted_at: checked,
        ticket_check_requested_at: null, ticket_check_failures: 0,
      },
    }]);

    const res = await request(app).get('/notifications/follows').set(...me);

    expect(res.body[0].concert).toMatchObject({
      price_min: 45, price_max: 89, price_currency: 'EUR',
      vendors: [{ name: 'Ticketmaster', state: 'on_sale', url: 'https://www.ticketmaster.se/1' }],
      tickets_opened_at: '2026-10-09T08:02:00.000Z',
    });
    expect(res.body[0].check).toEqual({
      checked_at: checked.toISOString(), pending: false, hot: false, failing: false,
      // Half an hour after the last read, less the two minutes' slack the
      // checker's ticks are given.
      next_at: new Date(checked.getTime() + 28 * 60 * 1000).toISOString(),
    });
    // The checker's own bookkeeping stays out of the row.
    for (const key of ['ticket_vendors', 'event_id', 'ticket_check_failures', 'ticket_check_attempted_at']) {
      expect(res.body[0].concert).not.toHaveProperty(key);
    }
  });

  it('turns away a caller with no token', async () => {
    expect((await request(app).get('/notifications/follows')).status).toBe(401);
    expect((await request(app).put('/notifications/follows/300')).status).toBe(401);
    expect((await request(app).post('/notifications/follows/check')).status).toBe(401);
  });
});

describe('checking the shows you follow now', () => {
  // A real socket standing in for the sync service: pythonService.js
  // requires axios through CommonJS, out of reach of a module mock.
  let server;
  let calls;
  let answer;

  beforeAll(async () => {
    const { createServer } = await import('node:http');
    server = createServer((req, res) => {
      calls.push({ path: req.url, auth: req.headers.authorization });
      res.writeHead(answer());
      res.end('{"status":"started"}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.PYTHON_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.SCRAPER_TOKEN = 'shared-secret';
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  beforeEach(() => {
    calls = [];
    answer = () => 200;
  });

  const followed = (id, over = {}) => ({
    concert_id: id,
    concert_rel: {
      url: `https://www.songkick.com/concerts/${id}`, event_id: `sk_${id}`,
      tickets_checked_at: null, ticket_check_requested_at: null, ticket_check_attempted_at: null, ...over,
    },
  });

  it('asks for every show you follow that has a listing, and starts the checker', async () => {
    const justNow = new Date(Date.now() - 30 * 1000);
    prisma.concertFollow.findMany.mockResolvedValue([
      followed(300),
      // Read half a minute ago: the listing has not moved since.
      followed(301, { tickets_checked_at: justNow }),
      // Nothing the checker could read.
      followed(302, { url: null, event_id: 'tm_9' }),
    ]);

    const res = await request(app).post('/notifications/follows/check').set(...me);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ requested: 1, skipped: 2, started: true });
    expect(prisma.concert.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [300] } }, data: { ticket_check_requested_at: expect.any(Date) },
    });
    expect(calls).toEqual([{ path: '/check-follows', auth: 'Bearer shared-secret' }]);
    // Only your own follows, and only shows still to come.
    expect(prisma.concertFollow.findMany.mock.calls[0][0].where).toMatchObject({ user_id: 'user-1' });
  });

  it('keeps the request when the checker cannot be started, for its next tick to find', async () => {
    answer = () => 503;
    prisma.concertFollow.findMany.mockResolvedValue([followed(300)]);

    const res = await request(app).post('/notifications/follows/check').set(...me).send({ concert_id: 300 });

    expect(res.body).toEqual({ requested: 1, skipped: 0, started: false });
    expect(prisma.concert.updateMany).toHaveBeenCalled();
    expect(prisma.concertFollow.findMany.mock.calls[0][0].where).toMatchObject({ user_id: 'user-1', concert_id: 300 });
  });

  it('starts nothing when there is nothing to ask for', async () => {
    prisma.concertFollow.findMany.mockResolvedValue([
      followed(300, { ticket_check_requested_at: new Date(Date.now() - 10 * 1000) }),
    ]);

    const res = await request(app).post('/notifications/follows/check').set(...me);

    expect(res.body).toEqual({ requested: 0, skipped: 1, started: false });
    expect(prisma.concert.updateMany).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('answers 404 for a show you do not follow', async () => {
    prisma.concertFollow.findMany.mockResolvedValue([]);

    const res = await request(app).post('/notifications/follows/check').set(...me).send({ concert_id: 999 });

    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });
});
