import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import { buildApp, authHeader, installFakePrisma } from '../../test/routeApp.js';

// A trip row as Postgres holds it. The fake answers a findUnique with only the
// fields the route selected, the way the real client does — a fake that handed
// back the whole row is how the route could stop selecting the arrival and
// departure fields and still pass.
const TRIP = {
  id: 5,
  user_id: 'user-1',
  start_date: new Date('2026-10-01'),
  end_date: new Date('2026-10-02'),
  weather_data: null,
  arrival_time: 14 * 60,
  departure_time: 11 * 60,
  arrival_place_id: 20,
  departure_place_id: null,
  transfer_minutes: 45,
  plan_data: null,
  plan_updated_at: null,
};

const PLACES = [
  { id: 10, trip_id: 5, name: 'Hotel', kind: 'HOTEL', lat: 48.85, lon: 2.35, priority: 3 },
  { id: 20, trip_id: 5, name: 'CDG', kind: 'SIGHT', lat: 49.0, lon: 2.55, priority: 3 },
];

const pick = (row, select) => (select
  ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]))
  : row);

installFakePrisma({
  trip: {
    findFirst: vi.fn(async () => ({ id: TRIP.id })),
    findUnique: vi.fn(async ({ select }) => pick(TRIP, select)),
    update: vi.fn(async () => TRIP),
  },
  tripPlace: { findMany: vi.fn(async () => PLACES) },
});

// The router's own copy of the planner client — see media.test.js on why an
// ESM import would be a different instance.
const routePlanner = createRequire(import.meta.url)('../../utils/travel/routePlanner.js');

const { default: router } = await import('./tripPlan.js');
const app = buildApp(router, '/travel/trips/:tripId/plan');

describe('POST /travel/trips/:tripId/plan', () => {
  beforeEach(() => {
    vi.spyOn(routePlanner, 'solve').mockResolvedValue({ days: [] });
    vi.spyOn(routePlanner, 'explain').mockResolvedValue({ fits: true });
  });

  it('plans the first day from arrival and the last day up to departure', async () => {
    const res = await request(app).post('/travel/trips/5/plan').set(...authHeader({ id: 'user-1' })).send({});

    expect(res.status).toBe(200);
    const { days, transfer_minutes: transfer } = routePlanner.solve.mock.calls[0][0];
    // Landing at 14:00 at a terminal on the trip: the day starts there, then.
    expect(days[0].start).toBe(14 * 60);
    expect(days[0].start_id).toBe(20);
    // Leaving at 11:00 with no terminal named: free until the transfer.
    expect(days[days.length - 1].end).toBe(11 * 60 - 45);
    expect(transfer).toBe(45);
  });

  it('asks the explain solve with the same trip fields', async () => {
    const res = await request(app).post('/travel/trips/5/plan/explain/10').set(...authHeader({ id: 'user-1' })).send({});

    expect(res.status).toBe(200);
    const [request0, placeId] = routePlanner.explain.mock.calls[0];
    expect(placeId).toBe(10);
    expect(request0.days[0].start).toBe(14 * 60);
  });

  it('refuses an explain for a place id that is not a number', async () => {
    const res = await request(app).post('/travel/trips/5/plan/explain/abc').set(...authHeader({ id: 'user-1' })).send({});

    expect(res.status).toBe(400);
    expect(routePlanner.explain).not.toHaveBeenCalled();
  });
});
