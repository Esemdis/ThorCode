/**
 * The followed-show checker (THO-779) against Postgres: "Check now" queues a
 * read, the sync service is told it is due, what it posts lands on the show
 * and the follower's list, and the check row goes with its show.
 *
 * Skipped unless INTEGRATION_DATABASE_URL is set; see regressions.test.js.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';

const url = process.env.INTEGRATION_DATABASE_URL;
const require = createRequire(import.meta.url);

describe.skipIf(!url)('followed-show checker', () => {
  let prisma;
  let app;
  const RUN = `fc${Date.now()}`;
  const COUNTRY = 'XF';
  const bearer = (id, role = 'USER') => `Bearer ${require('../../auth/signJWT.js')({ user: { id, role } })}`;

  beforeAll(() => {
    process.env.DATABASE_URL = url;
    process.env.JWT_SECRET ||= 'integration-secret';
    // No sync service to wake: the route only calls it when this is set.
    delete process.env.PYTHON_SERVICE_URL;
    prisma = require('../../prisma/client.js');
    app = express().use(express.json())
      .use('/data/concerts', require('../../routes/data/notifications.js'))
      .use('/data/concerts', require('../../routes/data/followChecks.js'));
  });

  afterAll(async () => {
    await prisma.concert.deleteMany({ where: { country: COUNTRY } });
    await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
    await prisma.$disconnect();
  });

  const makeShow = (eventNo, over = {}) => prisma.concert.create({
    data: {
      country: COUNTRY, city: `${RUN} Stockholm`, venue: 'Fållan', created_at: new Date(), on_sale: false,
      concert_date: new Date('2099-02-13T18:45:00Z'), source: 'songkick',
      url: `https://www.songkick.com/concerts/${eventNo}-opeth`, event_id: `sk_${eventNo}`, ...over,
    },
  });

  it('queues a read on "Check now", lists it as due, and stores what the read said', async () => {
    const user = await prisma.user.create({ data: { id: `${RUN}-u`, email: `${RUN}-u@example.test` } });
    const eventNo = 900000000 + Math.floor(Math.random() * 99999999);
    const show = await makeShow(eventNo, { ticket_sale_start: new Date('2099-01-10T00:00:00Z') });
    await prisma.concertFollow.create({ data: { user_id: user.id, concert_id: show.id, told_state: 'on_sale_soon' } });

    const before = await request(app).get('/data/concerts/notifications/follows').set('Authorization', bearer(user.id));
    expect(before.body[0].check).toEqual({ checked_at: null, pending: false, hot: false, failing: false });

    const asked = await request(app).post('/data/concerts/notifications/follows/check')
      .set('Authorization', bearer(user.id)).send({});
    expect(asked.status).toBe(200);
    expect(asked.body).toEqual({ requested: 1, concert_ids: [show.id] });

    // A second tap while it waits counts it again but keeps its place.
    const stamp = (await prisma.concertListingCheck.findUnique({ where: { concert_id: show.id } })).requested_at;
    await request(app).post('/data/concerts/notifications/follows/check').set('Authorization', bearer(user.id)).send({ concert_id: show.id });
    expect((await prisma.concertListingCheck.findUnique({ where: { concert_id: show.id } })).requested_at).toEqual(stamp);

    const pending = await request(app).get('/data/concerts/notifications/follows').set('Authorization', bearer(user.id));
    expect(pending.body[0].check.pending).toBe(true);

    const due = await request(app).get('/data/concerts/follows/check-due?limit=100').set('Authorization', bearer('sync', 'SYSTEM'));
    expect(due.status).toBe(200);
    expect(due.body).toContainEqual({ concert_id: show.id, url: `https://www.songkick.com/concerts/${eventNo}-opeth`, reason: 'requested' });

    const posted = await request(app).post('/data/concerts/follows/checked').set('Authorization', bearer('sync', 'SYSTEM')).send({ results: [{
      concert_id: show.id, ok: true, on_sale: true, sold_out: false, ticket_sale_start: null,
      price_min: 45, price_max: 60, price_currency: 'EUR', event_status: 'postponed',
      vendors: [
        { name: 'Ticketmaster', url: 'https://www.ticketmaster.se/event/1', state: 'on_sale', sale_date: null, price: '€45' },
        { name: 'Bad', url: 'javascript:alert(1)', state: 'on_sale', sale_date: null, price: null },
      ],
    }] });
    expect(posted.body).toEqual({ updated: 1, failed: 0, unknown: 0, errors: 0 });

    const stored = await prisma.concert.findUnique({ where: { id: show.id } });
    // The sale day is still ahead, so an "on sale" read cannot clear it.
    expect(stored.on_sale).toBe(false);
    expect(stored.ticket_sale_start).toEqual(new Date('2099-01-10T00:00:00Z'));
    expect(stored).toMatchObject({ price_min: 45, price_max: 60, price_currency: 'EUR', event_status: 'postponed' });
    expect(stored.vendors[1].url).toBeNull();

    const after = await request(app).get('/data/concerts/notifications/follows').set('Authorization', bearer(user.id));
    expect(after.body[0].check).toMatchObject({ pending: false, failing: false });
    expect(after.body[0].check.checked_at).not.toBeNull();
    expect(after.body[0].concert).toMatchObject({ price_min: 45, event_status: 'postponed' });

    // Read just now: "Check now" asks for nothing.
    const again = await request(app).post('/data/concerts/notifications/follows/check').set('Authorization', bearer(user.id)).send({});
    expect(again.body).toEqual({ requested: 0, concert_ids: [] });
  });

  it('counts failed reads until the row says it cannot read the listing, and drops the check with its show', async () => {
    const user = await prisma.user.create({ data: { id: `${RUN}-f`, email: `${RUN}-f@example.test` } });
    const show = await makeShow(800000000 + Math.floor(Math.random() * 99999999));
    await prisma.concertFollow.create({ data: { user_id: user.id, concert_id: show.id, told_state: 'unknown' } });

    for (let i = 0; i < 2; i++) {
      const res = await request(app).post('/data/concerts/follows/checked').set('Authorization', bearer('sync', 'SYSTEM'))
        .send({ results: [{ concert_id: show.id, ok: false, error: 'timeout' }] });
      expect(res.body.failed).toBe(1);
    }
    const list = await request(app).get('/data/concerts/notifications/follows').set('Authorization', bearer(user.id));
    expect(list.body[0].check).toMatchObject({ checked_at: null, failing: true });

    await prisma.concert.delete({ where: { id: show.id } });
    expect(await prisma.concertListingCheck.findUnique({ where: { concert_id: show.id } })).toBeNull();
  });

  it('answers 404 for a show the caller does not follow, and keeps the sync routes to the sync service', async () => {
    const user = await prisma.user.create({ data: { id: `${RUN}-s`, email: `${RUN}-s@example.test` } });
    const show = await makeShow(700000000 + Math.floor(Math.random() * 99999999));

    const res = await request(app).post('/data/concerts/notifications/follows/check')
      .set('Authorization', bearer(user.id)).send({ concert_id: show.id });
    expect(res.status).toBe(404);
    expect((await request(app).get('/data/concerts/follows/check-due').set('Authorization', bearer(user.id))).status).toBe(403);
  });
});
