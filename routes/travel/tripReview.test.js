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

describe('what a trip review stores (THO-981)', () => {
  const postTripReviewTho981 = (body) => request(app)
    .post('/travel/trips/1/trip-review')
    .set(...authHeader())
    .send(body);

  it('refuses a plain URL as a culture photo', async () => {
    const res = await postTripReviewTho981({ culture_photos: ['https://example.com/pixel.gif'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/culture_photos/);
  });

  it('refuses an SVG data URL as a food photo', async () => {
    const res = await postTripReviewTho981({ food_photos: ['data:image/svg+xml,<svg onload=alert(1)>'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/food_photos/);
  });

  it('refuses an HTML data URL and a non-base64 payload as fun photos', async () => {
    for (const photo of ['data:text/html,<script>alert(1)</script>', 'data:image/jpeg;base64,x), url(https://a/b)']) {
      const res = await postTripReviewTho981({ fun_photos: [photo] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/fun_photos/);
    }
  });

  it('refuses a photo entry that is not a string rather than dropping it', async () => {
    const res = await postTripReviewTho981({ culture_photos: [photoDataUrl(10), 42] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/culture_photos/);
  });

  it('refuses a photo over 700,000 characters', async () => {
    const res = await postTripReviewTho981({ fun_photos: [photoDataUrl(700000)] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/fun_photos/);
  });

  it('still takes a 300,000-character JPEG, which is what the wizard sends', async () => {
    const res = await postTripReviewTho981({ culture_photos: [photoDataUrl(300000)] });
    expect(res.status).toBe(201);
    expect(res.body.data.culture_photos).toHaveLength(1);
  });

  it('refuses a 1 MB comment', async () => {
    const res = await postTripReviewTho981({ comment: 'x'.repeat(1000000) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/comment/);
  });

  it('answers a note that is not text with 400, not 500', async () => {
    const res = await postTripReviewTho981({ food_note: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/food_note/);
  });

  it('refuses more than 1,000 missing gear ids', async () => {
    const res = await postTripReviewTho981({ missing_gear_item_ids: Array.from({ length: 1001 }, (_, i) => i + 1) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing_gear_item_ids/);
  });
});
