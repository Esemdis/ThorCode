import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

const prisma = installFakePrisma({
  trip: { findFirst: vi.fn(async () => ({ id: 1 })) },
  tripItem: { findFirst: vi.fn(async () => null) },
  itemReview: { upsert: vi.fn(async () => ({ id: 1 })) },
});

const { default: router } = await import('./reviews.js');
const app = buildApp(router, '/travel/trips/:tripId/reviews');

describe('a gear review note of a megabyte (THO-981)', () => {
  it('is refused with a 400 naming the note, before anything is read or written', async () => {
    prisma.trip.findFirst = vi.fn(async () => ({ id: 1 }));
    prisma.tripItem.findFirst = vi.fn(async () => ({ id: 4, name: 'Shell', gear_item_id: null }));
    prisma.itemReview.upsert = vi.fn(async () => ({ id: 1 }));

    const res = await request(app)
      .post('/travel/trips/1/reviews')
      .set(...authHeader())
      .send({ trip_item_id: 4, verdict: 'KEEP', note: 'x'.repeat(1000000) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/note/);
    expect(prisma.itemReview.upsert).not.toHaveBeenCalled();
  });
});
