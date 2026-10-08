import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp, authHeader, installFakePrisma, routeManifest } from '../../test/routeApp.js';

const prisma = installFakePrisma({
  concert: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(async () => ({})) },
  // Read by the alert pass the checks route runs after a change.
  concertFollow: { findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
});

const { default: router } = await import('./followChecks.js');
const app = buildApp(router);
const system = authHeader({ id: 'sync', role: 'SYSTEM' });

beforeEach(() => { vi.clearAllMocks(); });

describe('the routes', () => {
  it('are the checker\'s, behind auth and a role check', () => {
    expect(routeManifest(router)).toEqual([
      'GET /follows/check-pending [4]',
      'POST /follows/checks [5]',
    ]);
  });

  it('turn away a user', async () => {
    const user = authHeader({ role: 'USER' });
    expect((await request(app).get('/follows/check-pending').set(...user)).status).toBe(403);
    expect((await request(app).post('/follows/checks').set(...user).send({ checks: [] })).status).toBe(403);
  });
});

describe('GET /follows/check-pending', () => {
  const row = (id, over = {}) => ({
    id, name: `Show ${id}`, url: `https://www.songkick.com/concerts/${id}`, event_id: `sk_${id}`, event_status: null,
    on_sale: false, sold_out: false, ticket_sale_start: null,
    ticket_check_attempted_at: null, ticket_check_requested_at: null, ticket_check_failures: 0, ...over,
  });

  it('lists the followed shows due a read, asked-for first, then the oldest read', async () => {
    const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000);
    prisma.concert.findMany.mockResolvedValue([
      row(1, { ticket_check_attempted_at: minutesAgo(40) }),
      row(2, { ticket_check_attempted_at: minutesAgo(5) }),
      row(3),
      row(4, { ticket_check_attempted_at: minutesAgo(5), ticket_check_requested_at: minutesAgo(1) }),
      row(5, { url: null, event_id: null }),
      row(6, { url: 'https://www.bandsintown.com/e/66', event_id: 'bit_66', ticket_check_attempted_at: minutesAgo(31) }),
    ]);

    const res = await request(app).get('/follows/check-pending').set(...system);

    expect(res.status).toBe(200);
    expect(res.body.map((c) => c.concert_id)).toEqual([4, 3, 1, 6]);
    expect(res.body[0]).toEqual({
      concert_id: 4, name: 'Show 4', source: 'songkick', url: 'https://www.songkick.com/concerts/4', hot: false, requested: true,
    });
    expect(res.body[3]).toMatchObject({ source: 'bandsintown', url: 'https://www.bandsintown.com/e/66' });
    // Only followed shows still to come.
    const { where } = prisma.concert.findMany.mock.calls[0][0];
    expect(where.follows).toEqual({ some: {} });
  });

  it('stops at the limit', async () => {
    prisma.concert.findMany.mockResolvedValue([row(1), row(2), row(3)]);

    const res = await request(app).get('/follows/check-pending?limit=2').set(...system);

    expect(res.body).toHaveLength(2);
    expect((await request(app).get('/follows/check-pending?limit=0').set(...system)).status).toBe(400);
  });
});

describe('POST /follows/checks', () => {
  const stored = {
    id: 300, name: 'Hollywood Undead: EU/UK 2027', venue: 'Fållan', latitude: '59.30', longitude: '18.08',
    concert_date: new Date('2099-02-13T18:45:00Z'), source: 'songkick', metadata: null, festival: false,
    on_sale: false, sold_out: false, ticket_sale_start: new Date('2099-01-09T00:00:00Z'),
    price_min: null, price_max: null, price_currency: null, ticket_vendors: null, event_status: null,
  };

  it('writes what a read found, marks it read, and tells the followers at once', async () => {
    prisma.concert.findUnique.mockResolvedValue(stored);

    const res = await request(app).post('/follows/checks').set(...system).send({ checks: [{
      concert_id: 300, ok: true,
      concert: { source: 'songkick', sold_out: true, on_sale: false, price_min: 45, price_currency: 'EUR' },
      vendors: [{ name: 'Ticketmaster', state: 'sold_out', url: 'https://www.ticketmaster.se/1' }],
      event_status: 'scheduled',
    }] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ checked: 1, failed: 0, missing: 0, alerts: { alerted: 0, failed: 0 } });
    expect(res.body.changed).toEqual([{
      concert_id: 300, fields: expect.arrayContaining(['sold_out', 'price_min', 'price_currency', 'ticket_vendors']),
    }]);
    const { data } = prisma.concert.update.mock.calls[0][0];
    expect(data).toMatchObject({
      sold_out: true, price_min: 45, ticket_check_failures: 0, ticket_check_error: null,
      tickets_checked_at: expect.any(Date), ticket_check_attempted_at: expect.any(Date),
    });
    expect(prisma.concertFollow.findMany).toHaveBeenCalledTimes(1);
  });

  it('marks a read that found nothing new as read, and runs no alerts for it', async () => {
    prisma.concert.findUnique.mockResolvedValue(stored);

    const res = await request(app).post('/follows/checks').set(...system).send({ checks: [{
      concert_id: 300, ok: true, concert: { source: 'songkick', on_sale: false, sold_out: false, ticket_sale_start: '2099-01-09' },
    }] });

    expect(res.body).toMatchObject({ checked: 1, changed: [], alerts: null });
    expect(Object.keys(prisma.concert.update.mock.calls[0][0].data).sort()).toEqual([
      'ticket_check_attempted_at', 'ticket_check_error', 'ticket_check_failures', 'tickets_checked_at',
    ]);
    expect(prisma.concertFollow.findMany).not.toHaveBeenCalled();
  });

  it('counts a failed read against the show, with why', async () => {
    prisma.concert.findUnique.mockResolvedValueOnce(stored).mockResolvedValueOnce(null);

    const res = await request(app).post('/follows/checks').set(...system).send({ checks: [
      { concert_id: 300, ok: false, error: 'redirected off Songkick to https://elsewhere.test/'.repeat(20) },
      { concert_id: 999, ok: true },
    ] });

    expect(res.body).toMatchObject({ checked: 0, failed: 1, missing: 1 });
    const { data } = prisma.concert.update.mock.calls[0][0];
    expect(data).toMatchObject({ ticket_check_failures: { increment: 1 }, ticket_check_attempted_at: expect.any(Date) });
    expect(data.ticket_check_error).toHaveLength(300);
    expect(data).not.toHaveProperty('tickets_checked_at');
  });

  it('refuses a body that is not a list of checks', async () => {
    expect((await request(app).post('/follows/checks').set(...system).send({ checks: [] })).status).toBe(400);
    expect((await request(app).post('/follows/checks').set(...system).send({ checks: [{ ok: true }] })).status).toBe(400);
  });
});
