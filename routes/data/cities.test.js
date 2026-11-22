import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

// Seeded before the router is imported — see installFakePrisma.
const prisma = installFakePrisma({
  city: { update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
  $transaction: vi.fn(async (ops) => Promise.all(ops)),
});
const { default: router } = await import('./cities.js');
const app = buildApp(router);

describe('PATCH /data/cities/:id', () => {
  it('answers 404 for a city that does not exist, rather than 500', async () => {
    prisma.city.update.mockRejectedValue(Object.assign(new Error('not found'), { code: 'P2025' }));

    const res = await request(app).patch('/404').set(...authHeader({ role: 'ADMIN' })).send({ reachable: true });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'City not found' });
  });
});

describe('GET /data/cities (THO-967)', () => {
  it('lists cities without their monthly weather', async () => {
    prisma.city.findMany.mockResolvedValue([]);

    const res = await request(app).get('/').set(...authHeader({ role: 'USER' }));

    expect(res.status).toBe(200);
    const query = prisma.city.findMany.mock.calls[0][0];
    // A select, not an include: an include sends every column, and
    // weather_monthly is a year of averages per city that no reader of this
    // list draws.
    expect(query.include).toBeUndefined();
    expect(query.select).toEqual({
      id: true,
      name: true,
      country: true,
      latitude: true,
      longitude: true,
      reachable: true,
      airport_iata: true,
      weather_updated_at: true,
      _count: { select: { concerts: true } },
    });
  });
});

describe('PATCH /data/cities/weather/bulk (THO-967)', () => {
  const system = authHeader({ role: 'SYSTEM' });
  const weatherEntryTho967 = (id) => ({ id, weather_monthly: { 1: { t: 3 } }, weather_updated_at: '2026-11-15T03:00:00Z' });
  // What the real client does: update throws P2025 on a row that is gone,
  // updateMany counts nothing. Both are set so the old and new code each meet
  // the database as it actually behaves.
  const cityMergedAwayTho967 = (goneId) => {
    prisma.city.update.mockImplementation(async ({ where }) => {
      if (where.id === goneId) throw Object.assign(new Error('not found'), { code: 'P2025' });
      return { id: where.id };
    });
    prisma.city.updateMany.mockImplementation(async ({ where }) => ({ count: where.id === goneId ? 0 : 1 }));
  };

  it('skips a city merged away since the sync read the list, instead of a 500 after a partial write', async () => {
    cityMergedAwayTho967(2);

    const res = await request(app).patch('/weather/bulk').set(...system)
      .send([weatherEntryTho967(1), weatherEntryTho967(2), weatherEntryTho967(3), { weather_monthly: {} }]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 2 });
    expect(prisma.city.updateMany).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { weather_monthly: { 1: { t: 3 } }, weather_updated_at: new Date('2026-11-15T03:00:00Z') },
    });
  });

  it('answers 500 with how many it wrote when a chunk fails', async () => {
    prisma.city.updateMany.mockResolvedValue({ count: 1 });
    prisma.$transaction
      .mockImplementationOnce(async (ops) => Promise.all(ops))
      .mockRejectedValueOnce(new Error('connection lost'));
    const thirtyTho967 = Array.from({ length: 30 }, (_, i) => weatherEntryTho967(i + 1));

    const res = await request(app).patch('/weather/bulk').set(...system).send(thirtyTho967);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error', updated: 25 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(25);
  });

  it('still refuses an entry whose id is not an integer', async () => {
    const res = await request(app).patch('/weather/bulk').set(...system).send([{ id: '1' }]);

    expect(res.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
