/**
 * A night's notes and rating, and moving it to the right show (THO-823),
 * against Postgres.
 *
 * The unit tests fake Prisma, so the new columns, the update of concert_id
 * and the P2002 a move onto an attended show raises from
 * @@unique([wishlist_id, concert_id]) only meet a real database here.
 *
 * Skipped unless INTEGRATION_DATABASE_URL is set; see regressions.test.js.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';

const url = process.env.INTEGRATION_DATABASE_URL;
const require = createRequire(import.meta.url);

describe.skipIf(!url)('attendance diary and move', () => {
  let prisma;
  let app;
  let root;
  const RUN = `ad${Date.now()}`;
  const COUNTRY = 'XD';
  const bearer = (id) => `Bearer ${require('../../auth/signJWT.js')({ user: { id, role: 'USER' } })}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.JWT_SECRET ||= 'integration-secret';
    root = await mkdtemp(join(tmpdir(), 'diary-int-'));
    process.env.MEDIA_ROOT = root;
    prisma = require('../../prisma/client.js');
    app = express().use(express.json()).use('/data/concerts', require('../../routes/data/wishlists.js'));
  });

  afterAll(async () => {
    const mine = { wishlist_rel: { user_id: { startsWith: RUN } } };
    await prisma.concertMedia.deleteMany({ where: { attendance_rel: mine } });
    await prisma.concertAttendance.deleteMany({ where: mine });
    await prisma.wishlist.deleteMany({ where: { user_id: { startsWith: RUN } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
    await prisma.concert.deleteMany({ where: { country: COUNTRY } });
    await prisma.$disconnect();
  });

  const makeDiaryShow = (day) => prisma.concert.create({
    data: {
      country: COUNTRY, city: `${RUN} Stockholm`, venue: 'Fållan', created_at: new Date(), on_sale: false,
      concert_date: new Date(`${day}T12:00:00Z`),
    },
  });

  it('saves notes and a rating, reads them back, and moves the night with its photos', async () => {
    const userId = `${RUN}-u`;
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test` } });
    const wishlist = await prisma.wishlist.create({ data: { name: 'Mine', user_id: userId } });
    const wrong = await makeDiaryShow('2026-06-23');
    const right = await makeDiaryShow('2026-06-24');
    const other = await makeDiaryShow('2026-06-25');
    const attendance = await prisma.concertAttendance.create({ data: { wishlist_id: wishlist.id, concert_id: wrong.id } });
    await prisma.concertAttendance.create({ data: { wishlist_id: wishlist.id, concert_id: other.id } });

    const relDir = `${userId}/2026-06-23 Stockholm`;
    await mkdir(join(root, 'archive', relDir), { recursive: true });
    await writeFile(join(root, 'archive', relDir, 'concert-media.json'), JSON.stringify({
      version: 1, concert_id: wrong.id, user_id: userId,
      concert: { date: '2026-06-23', venue: 'Fållan', city: `${RUN} Stockholm`, country: COUNTRY },
      files: [{ name: 'IMG_1.jpg', kind: 'PHOTO' }],
    }));
    const media = await prisma.concertMedia.create({
      data: {
        attendance_id: attendance.id, rel_path: `${relDir}/IMG_1.jpg`, filename: 'IMG_1.jpg',
        kind: 'PHOTO', bytes: 3, sha256: `${RUN}-1`,
      },
    });

    const auth = ['Authorization', bearer(userId)];
    const base = `/data/concerts/wishlists/${wishlist.id}/attendance`;

    const patched = await request(app).patch(`${base}/${wrong.id}`).set(...auth).send({ notes: '  Loud  ', rating: 4 });
    expect(patched.status).toBe(200);
    expect(patched.body).toEqual({ attendance_id: attendance.id, notes: 'Loud', rating: 4 });

    // Onto a show already in the list: 409, and nothing moves.
    const clash = await request(app).post(`${base}/${wrong.id}/move`).set(...auth).send({ concert_id: other.id });
    expect(clash.status).toBe(409);
    expect((await prisma.concertAttendance.findUnique({ where: { id: attendance.id } })).concert_id).toBe(wrong.id);

    const moved = await request(app).post(`${base}/${wrong.id}/move`).set(...auth).send({ concert_id: right.id });
    expect(moved.status).toBe(200);
    expect(moved.body).toEqual({ attendance_id: attendance.id, concert_id: right.id });

    const row = await prisma.concertAttendance.findUnique({ where: { id: attendance.id } });
    expect(row).toMatchObject({ concert_id: right.id, notes: 'Loud', rating: 4 });
    expect((await prisma.concertMedia.findUnique({ where: { id: media.id } })).attendance_id).toBe(attendance.id);
    const sidecar = JSON.parse(await readFile(join(root, 'archive', relDir, 'concert-media.json'), 'utf8'));
    expect(sidecar).toMatchObject({ concert_id: right.id, concert: { date: '2026-06-24' } });

    const listed = await request(app).get(base).set(...auth);
    const night = listed.body.attendance.find((a) => a.attendance_id === attendance.id);
    expect(night).toMatchObject({ notes: 'Loud', rating: 4, concert: { id: right.id } });

    const cleared = await request(app).patch(`${base}/${right.id}`).set(...auth).send({ notes: null });
    expect(cleared.body).toEqual({ attendance_id: attendance.id, notes: null, rating: 4 });
  });
});
