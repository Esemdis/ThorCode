import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp, authHeader, installFakePrisma, routeManifest } from '../../test/routeApp.js';

const prisma = installFakePrisma({
  wishlist: { findUnique: vi.fn() },
  concert: { findMany: vi.fn() },
});
const { default: router } = await import('./concertsNearby.js');
const app = buildApp(router);
const me = authHeader({ id: 'user-1' });
const ask = (qs, who = me) => request(app).get(`/nearby?${qs}`).set(...who);
const WINDOW = 'from=2026-11-12&to=2026-11-16';
const POINT = 'lat=55.6761&lng=12.5683';

const concertRowAt = (over = {}) => ({
  id: 7, name: 'Tour', festival: false, venue: 'Vega', city: 'Copenhagen', country: 'DK',
  concert_date: new Date('2026-11-14T19:00:00Z'), source: 'bandsintown', latitude: '55.6677', longitude: '12.5455',
  url: 'https://example.test/e', on_sale: true, sold_out: false, ticket_sale_start: null,
  price_min: null, price_max: null, price_currency: null, city_rel: null,
  bands: [{ band_rel: { id: 4, name: 'Alpha' } }], ...over,
});

beforeEach(() => {
  prisma.wishlist.findUnique.mockResolvedValue({ bands: [{ band_id: 4, tier: 'MUST' }] });
  prisma.concert.findMany.mockResolvedValue([concertRowAt()]);
});

describe('GET /nearby', () => {
  it('requires a signed-in user, with the role check in front', () => {
    expect(routeManifest(router)).toEqual(['GET /nearby [11]']);
  });

  it('turns away a caller with no token', async () => {
    expect((await request(app).get(`/nearby?${WINDOW}&${POINT}`)).status).toBe(401);
  });

  it('turns away a SYSTEM token, which reads everyone\'s rows and has no wishlist of its own', async () => {
    expect((await ask(`${WINDOW}&${POINT}`, authHeader({ role: 'SYSTEM' }))).status).toBe(403);
  });

  it('answers a wishlist show near the point, with how to read its time', async () => {
    const res = await ask(`${WINDOW}&${POINT}`);
    expect(res.status).toBe(200);
    expect(res.body.data.truncated).toBe(false);
    expect(res.body.data.concerts).toHaveLength(1);
    expect(res.body.data.concerts[0]).toMatchObject({
      id: 7, venue: 'Vega', time_kind: 'wall_clock', match: 'distance', concert_date: '2026-11-14T19:00:00.000Z',
      bands: [{ id: 4, name: 'Alpha', tier: 'MUST' }],
    });
  });

  it('reads only the caller\'s own wishlist and only its bands, a day either side of the window', async () => {
    await ask(`${WINDOW}&${POINT}`);
    expect(prisma.wishlist.findUnique.mock.calls[0][0].where).toEqual({ user_id: 'user-1' });
    const { where } = prisma.concert.findMany.mock.calls[0][0];
    expect(where.bands).toEqual({ some: { band: { in: [4] } } });
    expect(where.concert_date.gte.toISOString()).toBe('2026-11-11T00:00:00.000Z');
    expect(where.concert_date.lt.toISOString()).toBe('2026-11-18T00:00:00.000Z');
  });

  it('answers an empty list, and reads no concerts, for someone with no wishlist', async () => {
    prisma.wishlist.findUnique.mockResolvedValue(null);
    const res = await ask(`${WINDOW}&${POINT}`);
    expect(res.body.data.concerts).toEqual([]);
    expect(prisma.concert.findMany).not.toHaveBeenCalled();
  });

  it('drops a show beyond the radius', async () => {
    prisma.concert.findMany.mockResolvedValue([concertRowAt({ latitude: '59.9139', longitude: '10.7522' })]);
    expect((await ask(`${WINDOW}&${POINT}&radius_km=30`)).body.data.concerts).toEqual([]);
  });

  it('says when the read hit its ceiling, so a missing show is not silently missing', async () => {
    prisma.concert.findMany.mockResolvedValue(Array.from({ length: 501 }, (_, i) => concertRowAt({ id: i + 1 })));
    const res = await ask(`${WINDOW}&${POINT}`);
    expect(res.body.data.truncated).toBe(true);
    // The 501st row is only the proof that there was more.
    expect(res.body.data.concerts).toHaveLength(500);
  });

  it('does not call exactly 500 rows truncated, which is a complete answer', async () => {
    prisma.concert.findMany.mockResolvedValue(Array.from({ length: 500 }, (_, i) => concertRowAt({ id: i + 1 })));
    expect((await ask(`${WINDOW}&${POINT}`)).body.data.truncated).toBe(false);
    expect(prisma.concert.findMany.mock.calls[0][0].take).toBe(501);
  });

  it('leaves out past-attendance imports from setlist.fm, but not rows with no source', async () => {
    await ask(`${WINDOW}&${POINT}`);
    expect(prisma.concert.findMany.mock.calls[0][0].where.OR).toEqual([{ source: null }, { source: { not: 'setlistfm' } }]);
  });

  it('cuts wall-clock rows to the asked days but keeps the instant rows\' slack for the caller', async () => {
    prisma.concert.findMany.mockResolvedValue([
      concertRowAt({ id: 1, concert_date: new Date('2026-11-11T20:00:00Z'), source: 'bandsintown' }),
      concertRowAt({ id: 2, concert_date: new Date('2026-11-11T23:30:00Z'), source: 'songkick' }),
      concertRowAt({ id: 3, concert_date: new Date('2026-11-12T19:00:00Z'), source: 'bandsintown' }),
    ]);
    const ids = (await ask(`${WINDOW}&${POINT}`)).body.data.concerts.map((c) => c.id);
    expect(ids).toEqual([2, 3]);
  });

  it('passes the country on for the name fallback', async () => {
    prisma.concert.findMany.mockResolvedValue([concertRowAt({ latitude: null, longitude: null, city: 'Birmingham', country: 'US' })]);
    expect((await ask(`${WINDOW}&city=Birmingham&country=GB`)).body.data.concerts).toEqual([]);
    expect((await ask(`${WINDOW}&city=Birmingham&country=US`)).body.data.concerts).toHaveLength(1);
  });

  it('accepts a city with no point and marks a name match', async () => {
    prisma.concert.findMany.mockResolvedValue([concertRowAt({ latitude: null, longitude: null })]);
    const res = await ask(`${WINDOW}&city=Copenhagen`);
    expect(res.body.data.concerts[0]).toMatchObject({ match: 'city_name', distance_km: null, latitude: null });
  });

  it.each([
    ['no dates', POINT],
    ['a bad date', `from=2026-13-40&to=2026-11-16&${POINT}`],
    ['a date that does not exist, which Date would roll over', `from=2026-02-30&to=2026-03-02&${POINT}`],
    ['a window the wrong way round', `from=2026-11-16&to=2026-11-12&${POINT}`],
    ['a window over 120 days', `from=2026-01-01&to=2026-12-31&${POINT}`],
    ['neither a point nor a city', WINDOW],
    ['a latitude without a longitude', `${WINDOW}&lat=55`],
    ['a latitude out of range', `${WINDOW}&lat=95&lng=12`],
    ['a radius given twice, which Number() would turn into NaN and skip the filter', `${WINDOW}&${POINT}&radius_km=1&radius_km=2`],
    ['a latitude given twice', `${WINDOW}&lat=55&lat=56&lng=12`],
    ['a date given twice', `from=2026-11-12&from=2026-11-13&to=2026-11-16&${POINT}`],
    ['a city given twice', `${WINDOW}&city=Oslo&city=Bergen`],
    ['a radius over the cap', `${WINDOW}&${POINT}&radius_km=5000`],
  ])('refuses %s with a 400', async (_name, qs) => {
    const res = await ask(qs);
    expect(res.status).toBe(400);
    expect(prisma.concert.findMany).not.toHaveBeenCalled();
  });

  it('answers a database failure as a 500', async () => {
    prisma.concert.findMany.mockRejectedValue(new Error('down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await ask(`${WINDOW}&${POINT}`)).status).toBe(500);
    spy.mockRestore();
  });
});
