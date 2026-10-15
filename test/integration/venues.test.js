/**
 * One building, one Venue row (THO-346), against Postgres: the venue_key()
 * function the migration defines, ingest's INSERT ... ON CONFLICT on it, and
 * the merges that move concerts between Venue rows.
 *
 * Skipped unless INTEGRATION_DATABASE_URL is set; see regressions.test.js.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';

const url = process.env.INTEGRATION_DATABASE_URL;
const require = createRequire(import.meta.url);

describe.skipIf(!url)('one building, one Venue', () => {
  let prisma;
  let venueMatch;
  let mergeCity;
  const RUN = `vn${Date.now()}`;
  // A country of its own, so no other test's rows are in reach.
  const COUNTRY = 'XV';

  beforeAll(() => {
    process.env.DATABASE_URL = url;
    process.env.JWT_SECRET ||= 'integration-secret';
    prisma = require('../../prisma/client.js');
    venueMatch = require('../../utils/venueMatch.js');
    ({ mergeCity } = require('../../utils/cityMatch.js'));
  });

  afterAll(async () => {
    await prisma.concertBandReference.deleteMany({ where: { band_rel: { name: { startsWith: RUN } } } });
    await prisma.concert.deleteMany({ where: { country: COUNTRY } });
    await prisma.venue.deleteMany({ where: { city_rel: { country: COUNTRY } } });
    await prisma.city.deleteMany({ where: { country: COUNTRY } });
    await prisma.band.deleteMany({ where: { name: { startsWith: RUN } } });
    await prisma.$disconnect();
  });

  it('folds case, whitespace and accents, and nothing else', async () => {
    const [row] = await prisma.$queryRaw`
      SELECT venue_key(${'  Södra   TEATERN '}) AS a, venue_key(${'Tavastía'}) AS b, venue_key(${'The O2'}) AS c`;
    expect(row).toEqual({ a: 'sodra teatern', b: 'tavastia', c: 'the o2' });
  });

  it('links each new show to the Venue its spelling folds to, one per city', async () => {
    const signJWT = require('../../auth/signJWT.js');
    const band = await prisma.band.create({ data: { name: `${RUN} band` } });
    const app = express().use(express.json()).use('/data/concerts', require('../../routes/data/bands.js'));
    const show = (city, venue, day, latitude, longitude) => ({
      country: COUNTRY, city: `${RUN} ${city}`, venue, concert_date: `2031-04-${day}T19:00:00Z`,
      latitude, longitude, bands: [{ band_id: band.id }],
    });

    const res = await request(app)
      .post('/data/concerts/bulk')
      .set('Authorization', `Bearer ${signJWT({ user: { id: `${RUN}-scraper`, role: 'SYSTEM' } })}`)
      .send({
        concerts: [
          show('Helsinki', 'Tavastia', '01', '60.1693', '24.9312'),
          // /bulk takes a show with no position last.
          show('Helsinki', 'TAVASTIA ', '05'),
          show('Helsinki', 'Tavastía', '09', '60.2000', '24.9000'),
          show('Tampere', 'Tavastia', '12', '61.4981', '23.7608'),
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(4);
    const stored = await prisma.concert.findMany({
      where: { country: COUNTRY }, orderBy: { concert_date: 'asc' },
      select: { venue: true, venue_rel: { select: { id: true, name: true, latitude: true, longitude: true, city_rel: { select: { name: true } } } } },
    });
    // Each concert keeps the text it came with.
    expect(stored.map((c) => c.venue)).toEqual(['Tavastia', 'TAVASTIA ', 'Tavastía', 'Tavastia']);
    const [a, b, c, d] = stored.map((s) => s.venue_rel);
    expect(b.id).toBe(a.id);
    expect(c.id).toBe(a.id);
    // Named by the first spelling, placed by the first position sent.
    expect(a).toMatchObject({ name: 'Tavastia', latitude: 60.1693, longitude: 24.9312, city_rel: { name: `${RUN} Helsinki` } });
    expect(d.id).not.toBe(a.id);
    expect(d.city_rel.name).toBe(`${RUN} Tampere`);
  });

  it('moves concerts onto the Venue that stays and fills its position', async () => {
    const city = await prisma.city.create({ data: { name: `${RUN} London`, country: COUNTRY } });
    const winner = await venueMatch.venueId(prisma, { name: 'The O2', cityId: city.id });
    const loser = await venueMatch.venueId(prisma, { name: 'O2 Arena', cityId: city.id, latitude: 51.5031, longitude: 0.0031 });
    const concert = await prisma.concert.create({
      data: { country: COUNTRY, city: city.name, city_id: city.id, venue: 'O2 Arena', venue_id: loser, created_at: new Date(), on_sale: false },
    });

    expect(await prisma.$transaction((tx) => venueMatch.mergeVenue(tx, loser, winner))).toEqual({ concerts: 1 });
    expect(await prisma.venue.findUnique({ where: { id: loser } })).toBeNull();
    expect(await prisma.venue.findUnique({ where: { id: winner } })).toMatchObject({ latitude: 51.5031, longitude: 0.0031 });
    expect(await prisma.concert.findUnique({ where: { id: concert.id } })).toMatchObject({ venue: 'O2 Arena', venue_id: winner });
  });

  it('carries venues across a city merge, folding one the winner already has', async () => {
    const winner = await prisma.city.create({ data: { name: `${RUN} Vienna`, country: COUNTRY } });
    const loser = await prisma.city.create({ data: { name: `${RUN} Wien`, country: COUNTRY } });
    const ours = await venueMatch.venueId(prisma, { name: 'Gasometer', cityId: winner.id });
    const twin = await venueMatch.venueId(prisma, { name: 'GASOMETER', cityId: loser.id });
    const only = await venueMatch.venueId(prisma, { name: 'Arena Wien', cityId: loser.id });
    const concert = await prisma.concert.create({
      data: { country: COUNTRY, city: loser.name, city_id: loser.id, venue: 'GASOMETER', venue_id: twin, created_at: new Date(), on_sale: false },
    });

    const moved = await prisma.$transaction((tx) => mergeCity(tx, loser.id, winner.id));

    expect(moved).toMatchObject({ concerts: 1, venues: 1, mergedVenues: 1 });
    expect(await prisma.venue.findUnique({ where: { id: twin } })).toBeNull();
    expect(await prisma.venue.findUnique({ where: { id: only } })).toMatchObject({ city_id: winner.id });
    expect(await prisma.concert.findUnique({ where: { id: concert.id } })).toMatchObject({ city_id: winner.id, venue_id: ours });
  });
});
