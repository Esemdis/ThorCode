import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

const prisma = installFakePrisma({
  concert: { findUnique: vi.fn() },
  user: { findUnique: vi.fn(), update: vi.fn(async () => ({})) },
  concertFollow: { findMany: vi.fn(), upsert: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 1 })) },
  concertListingCheck: { upsert: vi.fn(async () => ({})) },
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

  it('turns away a caller with no token', async () => {
    expect((await request(app).get('/notifications/follows')).status).toBe(401);
    expect((await request(app).put('/notifications/follows/300')).status).toBe(401);
  });
});

// The followed-show checker (THO-779). The wake goes through the module's own
// export, so it is spied on there rather than reaching a sync service.
const pythonServiceTho779 = createRequire(import.meta.url)('../../utils/pythonService.js');

const songkickFollowTho779 = (over = {}) => ({
  concert_id: 300,
  concert_rel: {
    id: 300, url: 'https://www.songkick.com/concerts/42938629-opeth', event_id: 'sk_42938629',
    concert_date: new Date('2099-02-13T18:45:00Z'), listing_check: null, ...over,
  },
});

describe('the checker on the followed-show list', () => {
  it('answers the price, vendors, status and opening beside the check, and keeps the id and check row out of the show', async () => {
    const checkedAt = new Date('2026-11-11T08:50:00Z');
    prisma.concertFollow.findMany.mockResolvedValue([{
      concert_id: 300, created_at: new Date('2026-10-06T12:00:00Z'),
      concert_rel: {
        id: 300, name: 'Opeth', venue: 'Fållan', city: 'Stockholm', country: 'SE',
        concert_date: new Date('2099-02-13T18:45:00Z'), url: 'https://www.songkick.com/concerts/42938629-opeth',
        source: 'songkick', on_sale: true, sold_out: false, ticket_sale_start: null, metadata: null,
        price_min: 45, price_max: 60, price_currency: 'EUR',
        vendors: [{ name: 'Ticketmaster', url: 'https://t.example/1', state: 'on_sale', sale_date: null, price: null }],
        event_status: 'postponed', tickets_opened_at: new Date('2026-11-01T09:02:00Z'),
        event_id: 'sk_42938629',
        listing_check: { checked_at: checkedAt, attempted_at: checkedAt, requested_at: null, failures: 0 },
        bands: [],
      },
    }]);

    const res = await request(app).get('/notifications/follows').set(...me);

    expect(res.body[0].check).toEqual({ checked_at: checkedAt.toISOString(), pending: false, hot: false, failing: false });
    expect(res.body[0].concert).toMatchObject({
      price_min: 45, price_max: 60, price_currency: 'EUR', event_status: 'postponed',
      tickets_opened_at: '2026-11-01T09:02:00.000Z',
      vendors: [expect.objectContaining({ name: 'Ticketmaster', state: 'on_sale' })],
    });
    expect(res.body[0].concert).not.toHaveProperty('listing_check');
    expect(res.body[0].concert).not.toHaveProperty('event_id');
  });

  it('answers a null check for a show with no Songkick listing', async () => {
    prisma.concertFollow.findMany.mockResolvedValue([{
      concert_id: 301, created_at: new Date('2026-10-06T12:00:00Z'),
      concert_rel: {
        id: 301, name: 'X', venue: 'Y', city: 'Z', country: 'SE', concert_date: new Date('2099-01-01'),
        url: 'https://www.bandsintown.com/e/1', event_id: 'bit_1', on_sale: false, sold_out: false,
        ticket_sale_start: null, metadata: null, listing_check: null, bands: [],
      },
    }]);

    const res = await request(app).get('/notifications/follows').set(...me);
    expect(res.body[0].check).toBeNull();
  });
});

describe('asking for followed shows to be checked now', () => {
  const savedUrlTho779 = process.env.PYTHON_SERVICE_URL;
  afterEach(() => {
    if (savedUrlTho779 === undefined) delete process.env.PYTHON_SERVICE_URL;
    else process.env.PYTHON_SERVICE_URL = savedUrlTho779;
    vi.restoreAllMocks();
  });

  it('asks for every upcoming followed show with a listing, and wakes the sync service once without waiting on it', async () => {
    process.env.PYTHON_SERVICE_URL = 'http://sync.invalid';
    const wake = vi.spyOn(pythonServiceTho779, 'pythonServicePost').mockReturnValue(new Promise(() => {}));
    prisma.concertFollow.findMany.mockResolvedValue([
      songkickFollowTho779(),
      { concert_id: 301, concert_rel: { id: 301, url: 'https://www.bandsintown.com/e/1', event_id: 'bit_1', concert_date: new Date('2099-01-01'), listing_check: null } },
    ]);

    const res = await request(app).post('/notifications/follows/check').set(...me).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requested: 1, concert_ids: [300] });
    expect(prisma.concertFollow.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { user_id: 'user-1' } }));
    expect(prisma.concertListingCheck.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.concertListingCheck.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { concert_id: 300 } }));
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith('/check-follows', {}, { timeout: 5000 });
  });

  it('answers even when the sync service cannot be woken', async () => {
    process.env.PYTHON_SERVICE_URL = 'http://sync.invalid';
    vi.spyOn(pythonServiceTho779, 'pythonServicePost').mockRejectedValue(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    prisma.concertFollow.findMany.mockResolvedValue([songkickFollowTho779()]);

    const res = await request(app).post('/notifications/follows/check').set(...me).send({ concert_id: 300 });

    expect(res.status).toBe(200);
    expect(res.body.requested).toBe(1);
    expect(prisma.concertFollow.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { user_id: 'user-1', concert_id: 300 } }));
  });

  it('asks for nothing when the show was tried in the last two minutes', async () => {
    prisma.concertFollow.findMany.mockResolvedValue([
      songkickFollowTho779({ listing_check: { attempted_at: new Date(Date.now() - 30 * 1000), requested_at: null } }),
    ]);

    const res = await request(app).post('/notifications/follows/check').set(...me).send({ concert_id: 300 });

    expect(res.body).toEqual({ requested: 0, concert_ids: [] });
    expect(prisma.concertListingCheck.upsert).not.toHaveBeenCalled();
  });

  it('counts a show already waiting but does not stamp it again', async () => {
    prisma.concertFollow.findMany.mockResolvedValue([
      songkickFollowTho779({ listing_check: { attempted_at: new Date(Date.now() - 600 * 1000), requested_at: new Date(Date.now() - 20 * 1000) } }),
    ]);

    const res = await request(app).post('/notifications/follows/check').set(...me).send({});

    expect(res.body).toEqual({ requested: 1, concert_ids: [300] });
    expect(prisma.concertListingCheck.upsert).not.toHaveBeenCalled();
  });

  it('answers 404 for a show you do not follow, 400 for an id that is not one, 401 without a token', async () => {
    prisma.concertFollow.findMany.mockResolvedValue([]);
    expect((await request(app).post('/notifications/follows/check').set(...me).send({ concert_id: 999 })).status).toBe(404);
    expect((await request(app).post('/notifications/follows/check').set(...me).send({ concert_id: 'abc' })).status).toBe(400);
    expect((await request(app).post('/notifications/follows/check').send({})).status).toBe(401);
  });

  it('answers requested 0, not 404, when you follow nothing and ask for all', async () => {
    prisma.concertFollow.findMany.mockResolvedValue([]);
    const res = await request(app).post('/notifications/follows/check').set(...me).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requested: 0, concert_ids: [] });
  });
});
