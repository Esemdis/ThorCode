/**
 * Against a real Postgres, for the failures a fake client cannot show.
 *
 * Every route test in this suite fakes Prisma, and that is how each of these
 * reached production green: a fake returns whatever row it is given whatever
 * `select` asked for, has no transaction to abort, and treats a missing filter
 * value however the test says. Each case here is a bug that was confirmed
 * against Postgres and passed the suite at the time.
 *
 * Skipped unless INTEGRATION_DATABASE_URL points at a database built by
 * `prisma migrate deploy` — the CI job does that. Rows are made per test and
 * removed after, so it can share a database with nothing else.
 */
import {
  describe, it, expect, beforeAll, afterAll, vi,
} from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';

const url = process.env.INTEGRATION_DATABASE_URL;

// Everything through Node's require, so the routes and this file share one
// Prisma client and one copy of each module a test stands in for.
const require = createRequire(import.meta.url);

describe.skipIf(!url)('against Postgres', () => {
  let prisma;
  let signJWT;
  const RUN = `it${Date.now()}`;

  const token = (id, role = 'USER') => `Bearer ${signJWT({ user: { id, email: `${id}@example.test`, role } })}`;
  const appWith = (mounts) => {
    const app = express();
    app.use(express.json());
    for (const [path, router] of mounts) app.use(path, router);
    return app;
  };

  beforeAll(() => {
    process.env.DATABASE_URL = url;
    process.env.JWT_SECRET ||= 'integration-secret';
    prisma = require('../../prisma/client.js');
    signJWT = require('../../auth/signJWT.js');
  });

  afterAll(async () => {
    await prisma.trip.deleteMany({ where: { user_id: { startsWith: RUN } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: RUN } } });
    await prisma.$disconnect();
  });

  it('refuses an OAuth state as a login, so a user filter can never go missing', async () => {
    // With the state accepted, req.user.id was undefined and Prisma read
    // `where: { user_id: undefined }` as no filter: another account's trips
    // were listed and deleted.
    process.env.SPOTIFY_CLIENT_ID ||= 'client-id';
    process.env.SPOTIFY_CLIENT_SECRET ||= 'client-secret';
    process.env.CALLBACK_URL ||= 'https://api.example.test';
    const victim = await prisma.user.create({ data: { id: `${RUN}-victim`, email: `${RUN}-victim@example.test` } });
    await prisma.user.create({ data: { id: `${RUN}-attacker`, email: `${RUN}-attacker@example.test` } });
    const trip = await prisma.trip.create({ data: { user_id: victim.id, name: 'Private' } });

    const app = appWith([
      ['/oauth/spotify', require('../../routes/oauth/spotify.js')],
      ['/travel/trips', require('../../routes/travel/trips.js')],
    ]);
    const res = await request(app).get('/oauth/spotify/authorize-url').set('Authorization', token(`${RUN}-attacker`));
    const state = new URL(res.body.url).searchParams.get('state');

    const list = await request(app).get('/travel/trips').set('Authorization', `Bearer ${state}`);
    const del = await request(app).delete(`/travel/trips/${trip.id}`).set('Authorization', `Bearer ${state}`);

    expect(list.status).toBe(401);
    expect(del.status).toBe(401);
    expect(await prisma.trip.findUnique({ where: { id: trip.id } })).not.toBeNull();
  });

  it('keeps the good concerts of a bulk ingest when one fails in the database', async () => {
    // A failing statement aborts the whole Postgres transaction. Caught and
    // carried on from, it made every later statement fail and turned the
    // COMMIT into a ROLLBACK, while the response still reported the inserts.
    const venue = `${RUN}-explode`;
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ${RUN}_explode() RETURNS trigger AS $$
      BEGIN IF NEW.venue = '${venue}' THEN RAISE EXCEPTION 'forced'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER ${RUN}_explode BEFORE INSERT ON "Concert" FOR EACH ROW EXECUTE FUNCTION ${RUN}_explode()`);
    const band = await prisma.band.create({ data: { name: `${RUN} band` } });
    // Months apart, so the duplicate rules have nothing to say about them.
    const concert = (v, month) => ({
      country: 'SE', city: `${RUN} city`, venue: v, concert_date: `2031-${month}-10T19:00:00Z`,
      bands: [{ band_id: band.id }, { band_id: band.id }],
    });

    try {
      const app = appWith([['/data/concerts', require('../../routes/data/bands.js')]]);
      const res = await request(app)
        .post('/data/concerts/bulk')
        .set('Authorization', token(`${RUN}-scraper`, 'SYSTEM'))
        .send({ concerts: [concert(`${RUN}-a`, '01'), concert(venue, '04'), concert(`${RUN}-b`, '08')] });

      const stored = await prisma.concert.findMany({ where: { city: `${RUN} city` }, select: { venue: true } });
      expect(res.status).toBe(200);
      expect(res.body.inserted).toBe(2);
      expect(res.body.errors).toBe(1);
      expect(stored.map((c) => c.venue).sort()).toEqual([`${RUN}-a`, `${RUN}-b`]);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${RUN}_explode ON "Concert"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${RUN}_explode()`);
      await prisma.concertBandReference.deleteMany({ where: { band: band.id } });
      await prisma.concert.deleteMany({ where: { city: `${RUN} city` } });
      await prisma.city.deleteMany({ where: { name: `${RUN} city` } });
      await prisma.band.delete({ where: { id: band.id } });
    }
  });

  it('gives the planner the arrival and departure the trip holds', async () => {
    // Both solve routes selected only dates and weather, so these never reached
    // the planner and a 14:00 landing was planned from 09:00.
    process.env.ROUTE_PLANNER_URL ||= 'http://planner.invalid';
    const routePlanner = require('../../utils/travel/routePlanner.js');
    const solve = vi.spyOn(routePlanner, 'solve').mockResolvedValue({ days: [] });
    const owner = await prisma.user.create({ data: { id: `${RUN}-planner`, email: `${RUN}-planner@example.test` } });
    const trip = await prisma.trip.create({
      data: {
        user_id: owner.id, name: 'Paris', start_date: new Date('2031-10-01'), end_date: new Date('2031-10-02'),
        arrival_time: 14 * 60, departure_time: 11 * 60, transfer_minutes: 45,
        places: { create: { name: 'Hotel', kind: 'HOTEL', lat: 48.85, lon: 2.35 } },
      },
    });

    const app = appWith([['/travel/trips/:tripId/plan', require('../../routes/travel/tripPlan.js')]]);
    const res = await request(app).post(`/travel/trips/${trip.id}/plan`).set('Authorization', token(owner.id)).send({});

    expect(res.status).toBe(200);
    const { days } = solve.mock.calls[0][0];
    expect(days[0].start).toBe(14 * 60 + 45);
    expect(days[days.length - 1].end).toBe(11 * 60 - 45);
    solve.mockRestore();
  });

  it('answers the admin user lookup', async () => {
    // It selected scalar columns with a nested select, which Postgres-backed
    // Prisma refuses outright: a 500 on every request.
    const id = `${RUN}`.padEnd(32, '0').slice(0, 32).replace(/[^a-z0-9]/g, '0');
    await prisma.user.create({ data: { id, email: `${RUN}-lookup@example.test` } });

    const app = appWith([['/users', require('../../routes/users.js')]]);
    const res = await request(app).get(`/users/${id}`).set('Authorization', token(`${RUN}-admin`, 'ADMIN'));

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(id);
    await prisma.user.delete({ where: { id } });
  });
});
