/**
 * Merging a duplicate band (THO-999), against Postgres: every band-level row
 * lands on the survivor, the unique keys both rows hit keep one row, and the
 * source's unique ids reach the survivor in the same transaction that deletes
 * the source.
 *
 * Skipped unless INTEGRATION_DATABASE_URL is set; see regressions.test.js.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';

const url = process.env.INTEGRATION_DATABASE_URL;
const require = createRequire(import.meta.url);

describe.skipIf(!url)('merging one artist\'s two band rows', () => {
  let prisma;
  let app;
  let adminToken;
  const RUN = `bm${Date.now()}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.JWT_SECRET ||= 'integration-secret';
    // The sidecar retag runs after commit; an empty archive makes it a no-op.
    process.env.MEDIA_ROOT = await mkdtemp(join(tmpdir(), 'band-merge-'));
    prisma = require('../../prisma/client.js');
    // The admin has no account row, so not a login token (THO-898, which
    // refuses one for a missing account); an `exp` so THO-1016 accepts it.
    adminToken = require('jsonwebtoken').sign({ id: `${RUN}-admin`, role: 'ADMIN' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    app = express().use(express.json()).use('/data/concerts', require('../../routes/data/bands.js'));
  });

  afterAll(async () => {
    const users = { startsWith: RUN };
    await prisma.concertMedia.deleteMany({ where: { attendance_rel: { wishlist_rel: { user_id: users } } } });
    await prisma.concertDelivery.deleteMany({ where: { wishlist_rel: { user_id: users } } });
    await prisma.attendanceMissedBand.deleteMany({ where: { attendance_rel: { wishlist_rel: { user_id: users } } } });
    await prisma.concertAttendance.deleteMany({ where: { wishlist_rel: { user_id: users } } });
    await prisma.wishlistBandReference.deleteMany({ where: { wishlist_rel: { user_id: users } } });
    await prisma.notificationSubscription.deleteMany({ where: { user_id: users } });
    await prisma.concertBandReference.deleteMany({ where: { band_rel: { name: { startsWith: RUN } } } });
    await prisma.concert.deleteMany({ where: { venue: { startsWith: RUN } } });
    await prisma.wishlist.deleteMany({ where: { user_id: users } });
    await prisma.band.deleteMany({ where: { name: { startsWith: RUN } } });
    await prisma.user.deleteMany({ where: { id: users } });
    await prisma.$disconnect();
  });

  const merge = (from, to, query = '') => request(app)
    .post(`/data/concerts/bands/${from}/merge-into/${to}${query}`)
    .set('Authorization', `Bearer ${adminToken}`);

  async function seed(tag, sourceData = {}, targetData = {}) {
    const source = await prisma.band.create({ data: { name: `${RUN} ${tag} (SE)`, ...sourceData } });
    const target = await prisma.band.create({ data: { name: `${RUN} ${tag}`, ...targetData } });
    return { source, target };
  }

  it('moves every band-level row onto the survivor and drops the source\'s where both had one', async () => {
    const { source, target } = await seed('Opeth', {
      MBID: `${RUN}-mbid`, songkick_url: 'https://www.songkick.com/artists/1', created_at: new Date('2020-01-01T00:00:00Z'),
    }, { created_at: new Date('2024-01-01T00:00:00Z') });

    const [shared, onlySource] = await Promise.all(['shared', 'only'].map((v) => prisma.concert.create({
      data: { country: 'SE', city: 'Stockholm', venue: `${RUN} ${v}`, created_at: new Date(), on_sale: false },
    })));
    const [both, one] = await Promise.all(['both', 'one'].map((who) => prisma.user.create({
      data: { id: `${RUN}-${who}`, email: `${RUN}-${who}@example.test` },
    })));
    const [wlBoth, wlOne] = await Promise.all([both, one].map((u) => prisma.wishlist.create({ data: { name: 'w', user_id: u.id } })));

    await prisma.concertBandReference.createMany({
      data: [
        { concert: shared.id, band: source.id, notify_pending: true },
        { concert: shared.id, band: target.id },
        { concert: onlySource.id, band: source.id },
      ],
    });
    await prisma.wishlistBandReference.createMany({
      data: [
        { wishlist_id: wlBoth.id, band_id: source.id, tier: 'LOVE' },
        { wishlist_id: wlBoth.id, band_id: target.id, tier: 'FOLLOW' },
        { wishlist_id: wlOne.id, band_id: source.id },
      ],
    });
    const attendance = await prisma.concertAttendance.create({ data: { wishlist_id: wlBoth.id, concert_id: shared.id } });
    await prisma.attendanceMissedBand.createMany({
      data: [{ attendance_id: attendance.id, band_id: source.id }, { attendance_id: attendance.id, band_id: target.id }],
    });
    await prisma.concertDelivery.createMany({
      data: [
        { concert_id: shared.id, wishlist_id: wlBoth.id, band_id: source.id },
        { concert_id: shared.id, wishlist_id: wlBoth.id, band_id: target.id },
        { concert_id: onlySource.id, wishlist_id: wlOne.id, band_id: source.id },
      ],
    });
    await prisma.notificationSubscription.createMany({
      data: [
        { user_id: both.id, band_id: source.id },
        { user_id: both.id, band_id: target.id },
        { user_id: one.id, band_id: source.id },
      ],
    });
    await prisma.concertMedia.create({
      data: {
        attendance_id: attendance.id, band_id: source.id, rel_path: `${RUN}/show/a.jpg`, filename: 'a.jpg',
        kind: 'PHOTO', bytes: 1, sha256: `${RUN}-sha`,
      },
    });

    const res = await merge(source.id, target.id);

    expect(res.status).toBe(200);
    expect(res.body.survivor).toEqual({ id: target.id, name: target.name });
    expect(await prisma.band.findUnique({ where: { id: source.id } })).toBeNull();

    const survivor = await prisma.band.findUnique({ where: { id: target.id } });
    // The source's unique MBID reached the survivor in the same transaction
    // that deleted the source, which the unique index would refuse otherwise.
    expect(survivor).toMatchObject({
      MBID: `${RUN}-mbid`, songkick_url: 'https://www.songkick.com/artists/1', created_at: new Date('2020-01-01T00:00:00Z'),
    });

    const links = await prisma.concertBandReference.findMany({ where: { band: target.id }, orderBy: { concert: 'asc' } });
    expect(links.map((l) => l.concert).sort()).toEqual([shared.id, onlySource.id].sort());
    expect(links.find((l) => l.concert === shared.id).notify_pending).toBe(true);

    const refs = await prisma.wishlistBandReference.findMany({ where: { band_id: target.id } });
    expect(refs).toHaveLength(2);
    expect(refs.find((r) => r.wishlist_id === wlBoth.id).tier).toBe('LOVE');

    expect(await prisma.attendanceMissedBand.count({ where: { band_id: target.id } })).toBe(1);
    expect(await prisma.concertDelivery.count({ where: { band_id: target.id } })).toBe(2);
    expect(await prisma.notificationSubscription.count({ where: { band_id: target.id } })).toBe(2);
    expect(await prisma.concertMedia.count({ where: { band_id: target.id } })).toBe(1);
  });

  it('answers 409 on two different MBIDs and changes nothing until forced', async () => {
    const { source, target } = await seed('Gojira', { MBID: `${RUN}-a` }, { MBID: `${RUN}-b` });

    const refused = await merge(source.id, target.id);
    expect(refused.status).toBe(409);
    expect(refused.body.conflicts).toEqual([{ field: 'MBID', source: `${RUN}-a`, target: `${RUN}-b` }]);
    expect(await prisma.band.findUnique({ where: { id: source.id } })).not.toBeNull();

    const forced = await merge(source.id, target.id, '?force=1');
    expect(forced.status).toBe(200);
    expect(await prisma.band.findUnique({ where: { id: source.id } })).toBeNull();
    expect((await prisma.band.findUnique({ where: { id: target.id } })).MBID).toBe(`${RUN}-b`);
  });
});
