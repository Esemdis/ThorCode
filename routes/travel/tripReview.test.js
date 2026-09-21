import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

const fakePrisma = installFakePrisma({
  trip: { findFirst: async () => ({ id: 1 }) },
  tripReview: { upsert: async ({ create, update }) => ({ id: 1, ...(create ?? update) }) },
});

const { default: router } = await import('./tripReview.js');
const app = buildApp(router, '/travel/trips/:tripId/trip-review');

const photoDataUrl = (n) => `data:image/jpeg;base64,${'a'.repeat(n)}`;

describe('a trip review with more category photos than the wizard offers slots for', () => {
  // The wizard caps each category at 3 slots client-side, but nothing stops a
  // replayed or hand-built request from sending more, so the API has to hold
  // the same limit rather than trust the client.
  it('rejects a fourth culture photo with a 400, not silently truncating it', async () => {
    const res = await request(app)
      .post('/travel/trips/1/trip-review')
      .set(...authHeader())
      .send({ culture_photos: [photoDataUrl(10), photoDataUrl(10), photoDataUrl(10), photoDataUrl(10)] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/culture_photos/);
  });

  it('accepts exactly 3 photos per category and stores them on the review', async () => {
    const res = await request(app)
      .post('/travel/trips/1/trip-review')
      .set(...authHeader())
      .send({
        food_photos: [photoDataUrl(5), photoDataUrl(5), photoDataUrl(5)],
        fun_rating: 4,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.food_photos).toHaveLength(3);
    expect(res.body.data.culture_photos).toEqual([]);
  });
});
