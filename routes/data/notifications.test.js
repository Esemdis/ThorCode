import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

const prisma = installFakePrisma({
  concert: { findUnique: vi.fn() },
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
    prisma.concert.findUnique.mockResolvedValue({ id: 300, on_sale: true, sold_out: false, ticket_sale_start: null });

    const res = await request(app).put('/notifications/follows/300').set(...me);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ concert_id: 300, tickets: 'on_sale' });
    expect(prisma.concertFollow.upsert).toHaveBeenCalledWith({
      where: { user_id_concert_id: { user_id: 'user-1', concert_id: 300 } },
      create: { user_id: 'user-1', concert_id: 300, told_state: 'on_sale' },
      // Following again keeps what you have been told.
      update: {},
    });
  });

  it('saves the browser\'s time zone for the sale-day reminder, when the account has none yet', async () => {
    prisma.concert.findUnique.mockResolvedValue({ id: 300, on_sale: false, sold_out: false, ticket_sale_start: null });
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
        ticket_sale_start: new Date('2099-10-09T00:00:00Z'), bands: [{ band_rel: { id: 9, name: 'Hollywood Undead' } }],
      },
    }]);

    const res = await request(app).get('/notifications/follows').set(...me);

    expect(prisma.concertFollow.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { user_id: 'user-1' } }));
    expect(res.body).toEqual([expect.objectContaining({
      concert_id: 300, tickets: 'on_sale_soon',
      concert: expect.objectContaining({ venue: 'Fållan', bands: [{ id: 9, name: 'Hollywood Undead' }] }),
    })]);
  });

  it('turns away a caller with no token', async () => {
    expect((await request(app).get('/notifications/follows')).status).toBe(401);
    expect((await request(app).put('/notifications/follows/300')).status).toBe(401);
  });
});
