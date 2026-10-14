/**
 * One place under several City rows (THO-316), against Postgres: the box query
 * ingest asks, and the raw SQL the merge script runs on User.settings.
 *
 * Skipped unless INTEGRATION_DATABASE_URL is set; see regressions.test.js.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';

const url = process.env.INTEGRATION_DATABASE_URL;
const require = createRequire(import.meta.url);

describe.skipIf(!url)('one place, one City', () => {
  let prisma;
  let mergeCity;
  const RUN = `cm${Date.now()}`;
  // A country of its own, so the nearby lookup cannot meet another test's rows.
  const COUNTRY = 'XZ';

  beforeAll(() => {
    process.env.DATABASE_URL = url;
    process.env.JWT_SECRET ||= 'integration-secret';
    prisma = require('../../prisma/client.js');
    ({ mergeCity } = require('../../utils/cityMatch.js'));
  });

  afterAll(async () => {
    await prisma.notificationSubscription.deleteMany({ where: { user_id: { startsWith: RUN } } });
    await prisma.concert.deleteMany({ where: { country: COUNTRY } });
    await prisma.city.deleteMany({ where: { country: COUNTRY } });
    await prisma.user.deleteMany({ where: { id: { startsWith: RUN } } });
    await prisma.band.deleteMany({ where: { name: { startsWith: RUN } } });
    await prisma.$disconnect();
  });

  it('files a new spelling under the City stored nearby', async () => {
    const signJWT = require('../../auth/signJWT.js');
    const vienna = await prisma.city.create({ data: { name: `${RUN} Vienna`, country: COUNTRY, latitude: 48.2082, longitude: 16.3738 } });
    const band = await prisma.band.create({ data: { name: `${RUN} band` } });
    const app = express().use(express.json()).use('/data/concerts', require('../../routes/data/bands.js'));

    const res = await request(app)
      .post('/data/concerts/bulk')
      .set('Authorization', `Bearer ${signJWT({ user: { id: `${RUN}-scraper`, role: 'SYSTEM' } })}`)
      .send({
        concerts: [{
          country: COUNTRY, city: `${RUN} Wien`, venue: 'Gasometer', concert_date: '2031-03-10T19:00:00Z',
          latitude: '48.1853', longitude: '16.4196', bands: [{ band_id: band.id }],
        }],
      });

    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(1);
    const stored = await prisma.concert.findUnique({ where: { id: res.body.details.insertedConcerts[0].concertId } });
    expect(stored).toMatchObject({ city: vienna.name, city_id: vienna.id });
    expect(await prisma.city.count({ where: { name: `${RUN} Wien` } })).toBe(0);
    await prisma.concertBandReference.deleteMany({ where: { band: band.id } });
  });

  it('moves concerts, watches and home cities onto the City that stays, then deletes the other', async () => {
    const winner = await prisma.city.create({ data: { name: `${RUN} London`, country: COUNTRY, latitude: 51.5, longitude: -0.12 } });
    const loser = await prisma.city.create({
      data: { name: `${RUN} Greater London`, country: COUNTRY, latitude: 51.5, longitude: 0, airport_iata: 'LHR', reachable: 'flight' },
    });
    const concert = await prisma.concert.create({
      data: { country: COUNTRY, city: loser.name, city_id: loser.id, venue: 'The O2', created_at: new Date(), on_sale: false },
    });
    const [both, one] = await Promise.all(['both', 'one'].map((who) => prisma.user.create({
      data: { id: `${RUN}-${who}`, email: `${RUN}-${who}@example.test`, settings: { homeCityId: loser.id, themeMode: 'dark' } },
    })));
    await prisma.notificationSubscription.createMany({
      data: [
        { user_id: both.id, city_id: winner.id },
        { user_id: both.id, city_id: loser.id },
        { user_id: one.id, city_id: loser.id },
      ],
    });

    const moved = await prisma.$transaction((tx) => mergeCity(tx, loser.id, winner.id));

    expect(moved).toEqual({ concerts: 1, watches: 1, droppedWatches: 1, homes: 2, filled: ['reachable', 'airport_iata'] });
    expect(await prisma.city.findUnique({ where: { id: loser.id } })).toBeNull();
    expect(await prisma.city.findUnique({ where: { id: winner.id } })).toMatchObject({ airport_iata: 'LHR', reachable: 'flight' });
    expect(await prisma.concert.findUnique({ where: { id: concert.id } })).toMatchObject({ city: winner.name, city_id: winner.id });
    const watches = await prisma.notificationSubscription.findMany({ where: { user_id: { startsWith: RUN } }, orderBy: { user_id: 'asc' } });
    expect(watches.map((w) => [w.user_id, w.city_id])).toEqual([[both.id, winner.id], [one.id, winner.id]]);
    expect((await prisma.user.findUnique({ where: { id: one.id } })).settings).toEqual({ homeCityId: winner.id, themeMode: 'dark' });
  });
});
