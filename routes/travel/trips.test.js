import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

// Seeded before the router is imported — see installFakePrisma.
const prisma = installFakePrisma({
  trip: {
    create: vi.fn(async ({ data }) => ({ id: 9, ...data })),
    update: vi.fn(async ({ data }) => ({ id: 5, ...data })),
    findFirst: vi.fn(),
  },
  tripItem: {},
  tripPlace: { findFirst: vi.fn() },
});

const { default: router } = await import('./trips.js');
const app = buildApp(router);

describe('a trip weather sync the Python service turns away', () => {
  // trips.js reported this through `fail`, which answers 500 and, outside
  // production, hands back the caught message — so an upstream 401 arrived as
  // this API's own 500 saying "Request failed with status code 401".
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

  it('answers a bad gateway naming the shared secret', async () => {
    const res = await request(app).post('/sync-weather').set(...authHeader({ role: 'ADMIN' }));

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/SCRAPER_TOKEN/);
    expect(res.body.error).not.toMatch(/Request failed with status/);
  });
});

describe('POST /travel/trips', () => {
  it('answers a malformed body with 400 rather than letting Prisma throw', async () => {
    // A string in tags, or a date that does not parse, reached Prisma and came
    // back as a 500 with nothing to say which field.
    for (const body of [{ name: 'Lisbon', tags: 'city' }, { name: 'Lisbon', start_date: 'soon' }, { name: 'Lisbon', currency: 12 }]) {
      const res = await request(app).post('/').set(...authHeader()).send(body);
      expect(res.status).toBe(400);
    }
    expect(prisma.trip.create).not.toHaveBeenCalled();
  });

  it('creates the trip for the caller', async () => {
    const res = await request(app).post('/').set(...authHeader({ id: 'user-1' })).send({ name: 'Lisbon', currency: 'eur' });

    expect(res.status).toBe(201);
    expect(prisma.trip.create).toHaveBeenCalledWith({
      data: { name: 'Lisbon', currency: 'EUR', tags: [], user_id: 'user-1' },
    });
  });
});

describe('PATCH /travel/trips/:id', () => {
  it('refuses a terminal that is not one of this trip\'s places', async () => {
    prisma.tripPlace.findFirst.mockResolvedValue(null);

    const res = await request(app).patch('/5').set(...authHeader({ id: 'user-1' })).send({ arrival_place_id: 77 });

    expect(res.status).toBe(400);
    expect(prisma.tripPlace.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 77, trip_id: 5, trip_rel: { user_id: 'user-1' } },
    }));
    expect(prisma.trip.update).not.toHaveBeenCalled();
  });

  it('stores a terminal that is', async () => {
    prisma.tripPlace.findFirst.mockResolvedValue({ id: 77 });

    const res = await request(app).patch('/5').set(...authHeader({ id: 'user-1' })).send({ arrival_place_id: 77, arrival_time: 840 });

    expect(res.status).toBe(200);
    expect(prisma.trip.update).toHaveBeenCalledWith({
      where: { id: 5, user_id: 'user-1' },
      data: { arrival_place_id: 77, arrival_time: 840 },
    });
  });
});

describe('POST /travel/trips/:id/duplicate', () => {
  it('copies the trip and its items in one write, bags included', async () => {
    prisma.trip.findFirst.mockResolvedValue({
      id: 5, name: 'Lisbon', destination: 'Lisbon', notes: null, tags: ['city'],
      items: [{ name: 'Tent', category: 'Shelter', status: 'PACKED', note: null, url: null, sort_order: 0, gear_item_id: 3, bag_id: 4, worn: false }],
    });

    const res = await request(app).post('/5/duplicate').set(...authHeader({ id: 'user-1' }));

    expect(res.status).toBe(201);
    expect(prisma.trip.create).toHaveBeenCalledTimes(1);
    const { data } = prisma.trip.create.mock.calls[0][0];
    expect(data.name).toBe('Copy of Lisbon');
    expect(data.items.create).toEqual([expect.objectContaining({ gear_item_id: 3, bag_id: 4 })]);
  });
});
