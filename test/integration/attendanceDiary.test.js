/**
 * Notes, a rating and moving a show to the right concert (THO-823), against
 * Postgres: the columns round-trip, and the unique (wishlist, concert) key is
 * what turns a move onto a show already in the list into a 409.
 *
 * Skipped unless INTEGRATION_DATABASE_URL is set; see regressions.test.js.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';

const url = process.env.INTEGRATION_DATABASE_URL;
const require = createRequire(import.meta.url);

describe.skipIf(!url)('attendance diary', () => {
  let prisma;
  let app;
  const RUN = `ad${Date.now()}`;
  const COUNTRY = 'XD';
  const bearer = (id) => `Bearer ${require('../../auth/signJWT.js')({ user: { id, role: 'USER' } })}`;

  beforeAll(() => {
    process.env.DATABASE_URL = url;
    process.env.JWT_SECRET ||= 'integration-secret';
    prisma = require('../../prisma/client.js');
    app = express().use(express.json()).use('/data/concerts', require('../../routes/data/wishlists.js'));
  });

  afterAll(async () => {
    await prisma.concertAttendance.deleteMany({ where: { wishlist_rel: { user_id: { startsWith: RUN } } } });
    await prisma.wishlist.deleteMany({ where: { user_id: { startsWith: RUN } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
    await prisma.concert.deleteMany({ where: { country: COUNTRY } });
    await prisma.$disconnect();
  });

  const tho823Concert = (date) => prisma.concert.create({
    data: {
      country: COUNTRY, city: `${RUN} Oslo`, venue: 'Rockefeller', created_at: new Date(), on_sale: false,
      concert_date: new Date(date),
    },
  });

  it('saves notes and a rating, moves the show, and refuses a move onto one already listed', async () => {
    const user = await prisma.user.create({ data: { id: `${RUN}-me`, email: `${RUN}-me@example.test` } });
    const wishlist = await prisma.wishlist.create({ data: { name: 'Mine', user_id: user.id } });
    const wrong = await tho823Concert('2020-05-01T19:00:00Z');
    const right = await tho823Concert('2020-05-02T19:00:00Z');
    const other = await tho823Concert('2020-06-01T19:00:00Z');
    const attendance = await prisma.concertAttendance.create({ data: { wishlist_id: wishlist.id, concert_id: wrong.id } });
    await prisma.concertAttendance.create({ data: { wishlist_id: wishlist.id, concert_id: other.id } });
    const base = `/data/concerts/wishlists/${wishlist.id}/attendance`;
    const auth = ['Authorization', bearer(user.id)];

    const saved = await request(app).patch(`${base}/${wrong.id}`).set(...auth).send({ notes: ' Pillars. ', rating: 4 });
    expect(saved.body).toEqual({ attendance_id: attendance.id, notes: 'Pillars.', rating: 4 });

    const moved = await request(app).post(`${base}/${wrong.id}/move`).set(...auth).send({ concert_id: right.id });
    expect(moved.status).toBe(200);
    expect(moved.body).toEqual({ attendance_id: attendance.id, concert_id: right.id });

    const listed = await request(app).get(base).set(...auth);
    const row = listed.body.attendance.find((a) => a.attendance_id === attendance.id);
    expect(row).toMatchObject({ notes: 'Pillars.', rating: 4, concert: { id: right.id } });

    const refused = await request(app).post(`${base}/${right.id}/move`).set(...auth).send({ concert_id: other.id });
    expect(refused.status).toBe(409);
    expect((await prisma.concertAttendance.findUnique({ where: { id: attendance.id } })).concert_id).toBe(right.id);
  });
});
