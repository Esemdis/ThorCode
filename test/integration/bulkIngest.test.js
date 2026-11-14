/**
 * Two overlapping /bulk calls carrying the same show, against Postgres
 * (THO-968).
 *
 * Each call checked for duplicates before the other had committed, so both
 * inserted the show: adding a band starts its sync while the scheduled one may
 * be running, and python-crohn posts two bands at a time. A fake client has no
 * second transaction to race, which is why this is here.
 *
 * The race is made deterministic with a trigger, scoped to this run's country,
 * that sleeps two seconds after each insert: the first call holds its new row
 * uncommitted for that long, and the second starts inside it. Without the
 * advisory lock the second reads no candidate and inserts a second row.
 *
 * Skipped unless INTEGRATION_DATABASE_URL is set; see regressions.test.js.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';

const url = process.env.INTEGRATION_DATABASE_URL;
const require = createRequire(import.meta.url);

describe.skipIf(!url)('two /bulk calls at once (THO-968)', () => {
  let prisma;
  let signJWT;
  const RUN = `bi${Date.now()}`;
  // A country of its own, so the trigger slows no other test's inserts and no
  // other test's rows are in reach.
  const COUNTRY = 'XB';
  const SLOW = `${RUN}_slow_insert`;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.JWT_SECRET ||= 'integration-secret';
    prisma = require('../../prisma/client.js');
    signJWT = require('../../auth/signJWT.js');
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${SLOW}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(2); RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${SLOW}" AFTER INSERT ON "Concert"
      FOR EACH ROW WHEN (NEW.country = '${COUNTRY}') EXECUTE FUNCTION "${SLOW}"()`);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${SLOW}" ON "Concert"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${SLOW}"()`);
    await prisma.concertBandReference.deleteMany({ where: { band_rel: { name: { startsWith: RUN } } } });
    await prisma.concert.deleteMany({ where: { country: COUNTRY } });
    await prisma.venue.deleteMany({ where: { city_rel: { country: COUNTRY } } });
    await prisma.city.deleteMany({ where: { country: COUNTRY } });
    await prisma.band.deleteMany({ where: { name: { startsWith: RUN } } });
    await prisma.$disconnect();
  });

  it('leaves one row for a show both calls carry', async () => {
    const band = await prisma.band.create({ data: { name: `${RUN} band` } });
    const app = express().use(express.json()).use('/data/concerts', require('../../routes/data/bands.js'));
    const auth = `Bearer ${signJWT({ user: { id: `${RUN}-scraper`, role: 'SYSTEM' } })}`;
    // One show as two sources list it, under event ids of their own, so the
    // event_id unique key cannot settle the race: only the duplicate check can.
    const show = (eventId) => ({
      country: COUNTRY, city: `${RUN} Oslo`, venue: 'Rockefeller', concert_date: '2031-03-14T19:00:00Z',
      event_id: eventId, bands: [{ band_id: band.id }],
    });
    const post = (eventId) => request(app).post('/data/concerts/bulk').set('Authorization', auth)
      .send({ concerts: [show(eventId)] });

    const [first, second] = await Promise.all([
      post(`sk_${RUN}`),
      // Started while the first one's row is still uncommitted.
      new Promise((resolve) => { setTimeout(resolve, 300); }).then(() => post(`bit_${RUN}`)),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.inserted + second.body.inserted).toBe(1);
    expect(first.body.duplicates + second.body.duplicates).toBe(1);
    expect(await prisma.concert.count({ where: { country: COUNTRY } })).toBe(1);
  }, 30_000);
});
