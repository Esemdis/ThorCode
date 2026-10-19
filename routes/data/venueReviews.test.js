import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp, authHeader, installFakePrisma, routeManifest } from '../../test/routeApp.js';

const prisma = installFakePrisma({
  venueReview: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  concertAttendance: { findFirst: vi.fn() },
});
const { default: router } = await import('./venueReviews.js');
const app = buildApp(router);
const me = authHeader({ id: 'user-1' });
const put = (body, who = me) => request(app).put('/venues/7/review').set(...who).send(body);

beforeEach(() => {
  prisma.concertAttendance.findFirst.mockResolvedValue({ id: 1 });
  prisma.venueReview.upsert.mockImplementation(async ({ create }) => ({ id: 1, ...create }));
});

describe('venue review routes', () => {
  it('require a signed-in user, on every method', () => {
    expect(routeManifest(router)).toEqual([
      'GET /venues/:venueId/review [4]',
      'PUT /venues/:venueId/review [10]',
      'DELETE /venues/:venueId/review [4]',
    ]);
  });

  it('turn away a caller with no token', async () => {
    expect((await request(app).get('/venues/7/review')).status).toBe(401);
  });

  it('read only the caller\'s own review', async () => {
    prisma.venueReview.findUnique.mockResolvedValue(null);
    const res = await request(app).get('/venues/7/review').set(...me);
    expect(res.body).toEqual({ data: null });
    expect(prisma.venueReview.findUnique).toHaveBeenCalledWith({ where: { user_id_venue_id: { user_id: 'user-1', venue_id: 7 } } });
  });
});

describe('PUT /venues/:venueId/review', () => {
  it('saves what was rated and clears what was left out', async () => {
    const res = await put({ sound: 4, wheelchair: 'PARTIAL', comment: '  Loud.  ' });
    expect(res.status).toBe(200);
    expect(prisma.venueReview.upsert.mock.calls[0][0].update).toEqual({
      sound: 4, view: null, stage: null, vibe: null, wheelchair: 'PARTIAL', comment: 'Loud.',
    });
  });

  it.each([
    [{ sound: 0 }], [{ vibe: 6 }], [{ view: 'x' }], [{ wheelchair: 'MAYBE' }], [{ comment: 'x'.repeat(1001) }],
  ])('refuses %j', async (body) => {
    expect((await put(body)).status).toBe(400);
    expect(prisma.venueReview.upsert).not.toHaveBeenCalled();
  });

  it('refuses an empty review', async () => {
    expect((await put({ sound: null, comment: '   ' })).status).toBe(400);
  });

  it('asks for a show at the venue that has already happened', async () => {
    prisma.concertAttendance.findFirst.mockResolvedValue(null);
    const res = await put({ sound: 5 });
    expect(res.status).toBe(403);
    expect(prisma.venueReview.upsert).not.toHaveBeenCalled();
    const { where } = prisma.concertAttendance.findFirst.mock.calls[0][0];
    expect(where.wishlist_rel).toEqual({ user_id: 'user-1' });
    expect(where.concert_rel.venue_id).toBe(7);
    expect(where.concert_rel.concert_date.lt).toBeInstanceOf(Date);
  });
});

describe('DELETE /venues/:venueId/review', () => {
  it('removes only the caller\'s row', async () => {
    const res = await request(app).delete('/venues/7/review').set(...me);
    expect(res.status).toBe(204);
    expect(prisma.venueReview.deleteMany).toHaveBeenCalledWith({ where: { user_id: 'user-1', venue_id: 7 } });
  });
});
