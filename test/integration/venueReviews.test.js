/**
 * Private venue reviews (THO-192) against Postgres: who may write one, that
 * nobody else reads it, and the merge that moves reviews to the winning venue.
 *
 * Skipped unless INTEGRATION_DATABASE_URL is set; see regressions.test.js.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';

const url = process.env.INTEGRATION_DATABASE_URL;
const require = createRequire(import.meta.url);

describe.skipIf(!url)('venue reviews', () => {
  let prisma;
  let venueMatch;
  let app;
  const RUN = `vr${Date.now()}`;
  const COUNTRY = 'XR';
  const bearer = (id) => `Bearer ${require('../../auth/signJWT.js')({ user: { id, role: 'USER' } })}`;

  beforeAll(() => {
    process.env.DATABASE_URL = url;
    process.env.JWT_SECRET ||= 'integration-secret';
    prisma = require('../../prisma/client.js');
    venueMatch = require('../../utils/venueMatch.js');
    app = express().use(express.json()).use('/data/concerts', require('../../routes/data/venueReviews.js'));
  });

  afterAll(async () => {
    await prisma.venueReview.deleteMany({ where: { user_id: { startsWith: RUN } } });
    await prisma.concertAttendance.deleteMany({ where: { wishlist_rel: { user_id: { startsWith: RUN } } } });
    await prisma.wishlist.deleteMany({ where: { user_id: { startsWith: RUN } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
    await prisma.concert.deleteMany({ where: { country: COUNTRY } });
    await prisma.venue.deleteMany({ where: { city_rel: { country: COUNTRY } } });
    await prisma.city.deleteMany({ where: { country: COUNTRY } });
    await prisma.$disconnect();
  });

  const makeUser = async (tag) => {
    const user = await prisma.user.create({ data: { id: `${RUN}-${tag}`, email: `${RUN}-${tag}@example.test` } });
    const wishlist = await prisma.wishlist.create({ data: { name: 'Mine', user_id: user.id } });
    return { user, wishlist };
  };

  it('lets someone who has been to a show there review it, privately, once', async () => {
    const city = await prisma.city.create({ data: { name: `${RUN} Oslo`, country: COUNTRY } });
    const venue = await venueMatch.venueId(prisma, { name: 'Rockefeller', cityId: city.id });
    const past = await prisma.concert.create({
      data: { country: COUNTRY, city: city.name, city_id: city.id, venue: 'Rockefeller', venue_id: venue, created_at: new Date(), on_sale: false, concert_date: new Date('2020-05-01T19:00:00Z') },
    });
    const future = await prisma.concert.create({
      data: { country: COUNTRY, city: city.name, city_id: city.id, venue: 'Rockefeller', venue_id: venue, created_at: new Date(), on_sale: false, concert_date: new Date('2099-05-01T19:00:00Z') },
    });
    const been = await makeUser('been');
    const going = await makeUser('going');
    const stranger = await makeUser('stranger');
    await prisma.concertAttendance.create({ data: { wishlist_id: been.wishlist.id, concert_id: past.id } });
    await prisma.concertAttendance.create({ data: { wishlist_id: going.wishlist.id, concert_id: future.id } });
    const base = `/data/concerts/venues/${venue}/review`;

    // A show still to come is not a visit, and a stranger has none.
    for (const who of [going, stranger]) {
      const res = await request(app).put(base).set('Authorization', bearer(who.user.id)).send({ sound: 5 });
      expect(res.status).toBe(403);
    }

    const first = await request(app).put(base).set('Authorization', bearer(been.user.id)).send({ sound: 4, wheelchair: 'NO' });
    expect(first.status).toBe(200);
    const second = await request(app).put(base).set('Authorization', bearer(been.user.id)).send({ view: 2, comment: 'Pillars.' });
    expect(second.body.data).toMatchObject({ id: first.body.data.id, sound: null, view: 2, wheelchair: null, comment: 'Pillars.' });
    expect(await prisma.venueReview.count({ where: { venue_id: venue } })).toBe(1);

    const mine = await request(app).get(base).set('Authorization', bearer(been.user.id));
    expect(mine.body.data).toMatchObject({ view: 2 });
    const theirs = await request(app).get(base).set('Authorization', bearer(stranger.user.id));
    expect(theirs.body).toEqual({ data: null });

    expect((await request(app).delete(base).set('Authorization', bearer(stranger.user.id))).status).toBe(204);
    expect(await prisma.venueReview.count({ where: { venue_id: venue } })).toBe(1);
    expect((await request(app).delete(base).set('Authorization', bearer(been.user.id))).status).toBe(204);
    expect(await prisma.venueReview.count({ where: { venue_id: venue } })).toBe(0);
  });

  it('carries reviews to the winning venue in a merge, the newer one winning a collision', async () => {
    const city = await prisma.city.create({ data: { name: `${RUN} London`, country: COUNTRY } });
    const winner = await venueMatch.venueId(prisma, { name: 'The O2', cityId: city.id });
    const loser = await venueMatch.venueId(prisma, { name: 'O2 Arena', cityId: city.id });
    const both = await makeUser('both');
    const onlyLoser = await makeUser('onlyloser');
    const review = (user, venue_id, sound, updated_at) =>
      prisma.venueReview.create({ data: { user_id: user.user.id, venue_id, sound, updated_at } });
    await review(both, winner, 1, new Date('2024-01-01'));
    await review(both, loser, 5, new Date('2025-01-01'));
    await review(onlyLoser, loser, 3, new Date('2025-01-01'));

    await prisma.$transaction((tx) => venueMatch.mergeVenue(tx, loser, winner));

    const left = await prisma.venueReview.findMany({ where: { user_id: { in: [both.user.id, onlyLoser.user.id] } }, orderBy: { sound: 'asc' } });
    expect(left.map((r) => [r.user_id, r.venue_id, r.sound])).toEqual([
      [onlyLoser.user.id, winner, 3],
      [both.user.id, winner, 5],
    ]);
  });
});
