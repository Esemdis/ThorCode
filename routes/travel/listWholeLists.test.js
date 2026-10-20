import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

// travel-bag reads the first page of these four lists and never asks for a
// second (THO-427), so the first page has to be as big as a page can be, and
// its order has to be stable enough that the cut never moves a row.
const prisma = installFakePrisma({
  trip: { findMany: vi.fn(), count: vi.fn() },
  gearItem: { findMany: vi.fn(), count: vi.fn() },
  travelWishlistItem: { findMany: vi.fn(), count: vi.fn() },
  itemReview: { findMany: vi.fn(), count: vi.fn() },
});

const LISTS = [
  ['trips', '/travel/trips', './trips.js', 'trip'],
  ['gear', '/travel/gear', './gear.js', 'gearItem'],
  ['wishlist', '/travel/wishlist', './wishlist.js', 'travelWishlistItem'],
  ['reviews', '/travel/reviews', './allReviews.js', 'itemReview'],
];

describe.each(LISTS)('GET %s with no limit asked for', (_name, mount, file, model) => {
  let app;
  beforeEach(async () => {
    app = buildApp((await import(file)).default, mount);
    prisma[model].findMany.mockResolvedValue([]);
    prisma[model].count.mockResolvedValue(0);
  });

  it('asks for the largest page and breaks every tie by id', async () => {
    const res = await request(app).get(mount).set(...authHeader());

    expect(res.status).toBe(200);
    const query = prisma[model].findMany.mock.calls[0][0];
    expect(query.take).toBe(500);
    expect(query.orderBy.at(-1)).toEqual({ id: 'asc' });
  });
});

describe('GET /travel/trips order', () => {
  it('puts the newest trip first, so a cut falls on the oldest', async () => {
    prisma.trip.findMany.mockResolvedValue([]);
    prisma.trip.count.mockResolvedValue(0);
    const app = buildApp((await import('./trips.js')).default, '/travel/trips');

    await request(app).get('/travel/trips').set(...authHeader());

    expect(prisma.trip.findMany.mock.calls[0][0].orderBy[0]).toEqual({ start_date: 'desc' });
  });
});
