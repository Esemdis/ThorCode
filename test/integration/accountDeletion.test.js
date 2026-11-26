/**
 * Deleting an account (THO-810) against Postgres.
 *
 * The unit tests fake Prisma, so there the order of the deletes is only a list
 * read back. Here every kind of row that points at a user is made for real,
 * and Postgres's own foreign keys say whether the order works: a table missed
 * or deleted too late is a foreign-key error and a 500, with the user still
 * there.
 *
 * Skipped unless INTEGRATION_DATABASE_URL is set; see regressions.test.js.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import {
  mkdtemp, mkdir, writeFile, access, readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import bcrypt from 'bcrypt';

const url = process.env.INTEGRATION_DATABASE_URL;
const require = createRequire(import.meta.url);

describe.skipIf(!url)('deleting an account', () => {
  let prisma;
  let app;
  let root;
  const RUN = `ad${Date.now()}`;
  const COUNTRY = 'XD';
  const PASSWORD = 'DeleteMe123';
  const accountDeletionIntExists = (p) => access(p).then(() => true, () => false);
  const bearer = (user) => `Bearer ${require('../../auth/signJWT.js')({ user })}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.JWT_SECRET ||= 'integration-secret';
    root = await mkdtemp(join(tmpdir(), 'account-delete-int-'));
    process.env.MEDIA_ROOT = root;
    prisma = require('../../prisma/client.js');
    app = express().use(express.json()).use('/users', require('../../routes/users.js'));
  });

  afterAll(async () => {
    // Whatever a failed run left behind, the staying user's included.
    const users = { startsWith: RUN };
    const wishlists = { wishlist_rel: { user_id: users } };
    await prisma.concertMedia.deleteMany({ where: { attendance_rel: wishlists } });
    await prisma.concertAttendance.deleteMany({ where: wishlists });
    await prisma.wishlistBandReference.deleteMany({ where: wishlists });
    await prisma.activityLog.deleteMany({ where: wishlists });
    await prisma.wishlist.deleteMany({ where: { user_id: users } });
    // The account registered again at the end has a new id, and a wishlist.
    await prisma.wishlist.deleteMany({ where: { user_rel: { email: { startsWith: RUN } } } });
    await prisma.oAuth.deleteMany({ where: { user: users } });
    await prisma.itemReview.deleteMany({ where: { user_id: users } });
    await prisma.tripReview.deleteMany({ where: { user_id: users } });
    await prisma.trip.deleteMany({ where: { user_id: users } });
    await prisma.loadout.deleteMany({ where: { user_id: users } });
    await prisma.template.deleteMany({ where: { user_id: users } });
    await prisma.gearItem.deleteMany({ where: { user_id: users } });
    await prisma.travelWishlistItem.deleteMany({ where: { user_id: users } });
    await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
    await prisma.venue.deleteMany({ where: { city_rel: { country: COUNTRY } } });
    await prisma.concert.deleteMany({ where: { country: COUNTRY } });
    await prisma.city.deleteMany({ where: { country: COUNTRY } });
    await prisma.band.deleteMany({ where: { name: { startsWith: RUN } } });
    await prisma.$disconnect();
  });

  /**
   * A user with one of everything that points at a user, and a photo on disk
   * plus a detached show no row knows about.
   */
  async function makeAccountWithEverything(tag) {
    const id = `${RUN}${tag}`;
    const user = await prisma.user.create({
      data: {
        id, email: `${RUN}-${tag}@example.test`, password_hash: await bcrypt.hash(PASSWORD, 4),
        wishlists: { create: { name: 'Mine' } },
      },
      include: { wishlists: true },
    });
    const wishlistId = user.wishlists.id;
    const band = await prisma.band.create({ data: { name: `${RUN} ${tag} band` } });
    const city = await prisma.city.create({ data: { name: `${RUN} ${tag} Oslo`, country: COUNTRY } });
    const venue = await prisma.venue.create({ data: { name: 'Sentrum', name_key: `${RUN}-${tag}`, city_id: city.id } });
    const concert = await prisma.concert.create({
      data: {
        country: COUNTRY, city: city.name, venue: 'Sentrum', created_at: new Date(), on_sale: false,
        concert_date: new Date('2026-06-12T19:00:00Z'),
      },
    });

    await prisma.wishlistBandReference.create({ data: { band_id: band.id, wishlist_id: wishlistId } });
    await prisma.activityLog.create({ data: { wishlist_id: wishlistId, type: 'BAND_ADDED', data: '{}' } });
    const attendance = await prisma.concertAttendance.create({ data: { wishlist_id: wishlistId, concert_id: concert.id } });
    await prisma.attendanceMissedBand.create({ data: { attendance_id: attendance.id, band_id: band.id } });
    await prisma.concertDelivery.create({ data: { concert_id: concert.id, wishlist_id: wishlistId, band_id: band.id } });
    await prisma.concertFollow.create({ data: { user_id: id, concert_id: concert.id, told_state: 'unknown' } });
    await prisma.notificationSubscription.create({ data: { user_id: id, band_id: band.id } });
    await prisma.venueReview.create({ data: { user_id: id, venue_id: venue.id, sound: 4 } });
    await prisma.oAuth.create({ data: { user: id, provider: 'spotify', provider_user_id: 'x', access_token: 't' } });
    await prisma.emailVerification.create({
      data: { user_id: id, new_email: `${RUN}-${tag}-new@example.test`, code: `${Date.now() % 1e6}${tag}`, expires_at: new Date(Date.now() + 6e5) },
    });
    await prisma.passwordReset.create({
      data: { user_id: id, token_hash: `${RUN}-${tag}`, expires_at: new Date(Date.now() + 6e5) },
    });
    await prisma.mediaAlbumShareLink.create({
      data: { user_id: id, attendance_ids: [attendance.id], token: `${RUN}-${tag}`, expires_at: new Date(Date.now() + 6e5) },
    });

    // A photo, its row, a share link to it, and a detached show nothing points at.
    const showDir = join(root, 'archive', id, 'night');
    await mkdir(showDir, { recursive: true });
    await writeFile(join(showDir, 'IMG_1.jpg'), 'photo bytes');
    await writeFile(join(showDir, 'concert-media.json'), JSON.stringify({ version: 1, files: [{ name: 'IMG_1.jpg' }] }));
    const detached = join(root, 'archive', id, '_detached', 'old night');
    await mkdir(detached, { recursive: true });
    await writeFile(join(detached, 'IMG_9.jpg'), 'detached bytes');
    const media = await prisma.concertMedia.create({
      data: {
        attendance_id: attendance.id, rel_path: `${id}/night/IMG_1.jpg`, filename: 'IMG_1.jpg',
        kind: 'PHOTO', bytes: 11, sha256: `${RUN}-${tag}`,
      },
    });
    await prisma.mediaShareLink.create({ data: { media_id: media.id, token: `${RUN}-${tag}-m`, expires_at: new Date(Date.now() + 6e5) } });

    // Travel Bag, which uses the same account.
    const gear = await prisma.gearItem.create({ data: { user_id: id, name: 'Tent' } });
    const trip = await prisma.trip.create({ data: { user_id: id, name: 'Lofoten' } });
    const tripItem = await prisma.tripItem.create({ data: { trip_id: trip.id, name: 'Tent', gear_item_id: gear.id } });
    await prisma.tripTodo.create({ data: { trip_id: trip.id, text: 'Book ferry' } });
    await prisma.itemReview.create({
      data: { user_id: id, trip_id: trip.id, trip_item_id: tripItem.id, gear_item_id: gear.id, item_name: 'Tent', verdict: 'KEEP' },
    });
    await prisma.tripReview.create({ data: { user_id: id, trip_id: trip.id, comment: 'Wet' } });
    const loadout = await prisma.loadout.create({ data: { user_id: id, name: 'Hiking' } });
    await prisma.loadoutEntry.create({ data: { loadout_id: loadout.id, gear_item_id: gear.id } });
    const template = await prisma.template.create({ data: { user_id: id, name: 'Weekend' } });
    await prisma.templateItem.create({ data: { template_id: template.id, name: 'Socks' } });
    await prisma.travelWishlistItem.create({ data: { user_id: id, name: 'Stove' } });

    return { user, attendance, media, trip, loadout, template };
  }

  const rowsLeftFor = async (id) => ({
    wishlist: await prisma.wishlist.count({ where: { user_id: id } }),
    attendance: await prisma.concertAttendance.count({ where: { wishlist_rel: { user_id: id } } }),
    media: await prisma.concertMedia.count({ where: { attendance_rel: { wishlist_rel: { user_id: id } } } }),
    oauth: await prisma.oAuth.count({ where: { user: id } }),
    follows: await prisma.concertFollow.count({ where: { user_id: id } }),
    subscriptions: await prisma.notificationSubscription.count({ where: { user_id: id } }),
    venueReviews: await prisma.venueReview.count({ where: { user_id: id } }),
    albumLinks: await prisma.mediaAlbumShareLink.count({ where: { user_id: id } }),
    resets: await prisma.passwordReset.count({ where: { user_id: id } }),
    verifications: await prisma.emailVerification.count({ where: { user_id: id } }),
    trips: await prisma.trip.count({ where: { user_id: id } }),
    gear: await prisma.gearItem.count({ where: { user_id: id } }),
    loadouts: await prisma.loadout.count({ where: { user_id: id } }),
    templates: await prisma.template.count({ where: { user_id: id } }),
    itemReviews: await prisma.itemReview.count({ where: { user_id: id } }),
    tripReviews: await prisma.tripReview.count({ where: { user_id: id } }),
    travelWishlist: await prisma.travelWishlistItem.count({ where: { user_id: id } }),
    user: await prisma.user.count({ where: { id } }),
  });

  it('deletes every row and file of the account, leaves another account alone, and frees the address', async () => {
    const gone = await makeAccountWithEverything('gone');
    const staying = await makeAccountWithEverything('stay');
    const goneUser = { id: gone.user.id, email: gone.user.email, role: 'USER' };

    const res = await request(app)
      .delete('/users/me')
      .set('Authorization', bearer(goneUser))
      .send({ currentPassword: PASSWORD });

    expect(res.status).toBe(200);
    expect(Object.values(await rowsLeftFor(gone.user.id)).every((n) => n === 0)).toBe(true);
    // The rows that hang off the deleted ones by id, gone with them.
    expect(await prisma.tripItem.count({ where: { trip_id: gone.trip.id } })).toBe(0);
    expect(await prisma.loadoutEntry.count({ where: { loadout_id: gone.loadout.id } })).toBe(0);
    expect(await prisma.templateItem.count({ where: { template_id: gone.template.id } })).toBe(0);
    expect(await prisma.mediaShareLink.count({ where: { media_id: gone.media.id } })).toBe(0);
    expect(await prisma.attendanceMissedBand.count({ where: { attendance_id: gone.attendance.id } })).toBe(0);
    // No file of theirs left in the archive, the detached show included.
    expect(await accountDeletionIntExists(join(root, 'archive', gone.user.id))).toBe(false);

    const kept = await rowsLeftFor(staying.user.id);
    expect(Object.values(kept).every((n) => n >= 1)).toBe(true);
    expect(await readFile(join(root, 'archive', staying.user.id, 'night', 'IMG_1.jpg'), 'utf8')).toBe('photo bytes');

    // Sign-up is closed (#53), so "frees the address" is read off the table.
    expect(await prisma.user.count({ where: { email: gone.user.email } })).toBe(0);

    // THO-898: its login tokens end with it, the one it was deleted from too.
    const afterwards = await request(app).get('/users/me').set('Authorization', bearer(goneUser));
    expect(afterwards.status).toBe(401);
  });

  it('deletes nothing on a wrong password', async () => {
    const account = await makeAccountWithEverything('wrong');
    const res = await request(app)
      .delete('/users/me')
      .set('Authorization', bearer({ id: account.user.id, email: account.user.email, role: 'USER' }))
      .send({ currentPassword: 'NotMyPass1' });

    expect(res.status).toBe(403);
    expect(Object.values(await rowsLeftFor(account.user.id)).every((n) => n >= 1)).toBe(true);
    expect(await accountDeletionIntExists(join(root, 'archive', account.user.id, 'night', 'IMG_1.jpg'))).toBe(true);
  });

  it('changes the password so the new one signs in', async () => {
    const id = `${RUN}pw`;
    const email = `${RUN}-pw@example.test`;
    await prisma.user.create({ data: { id, email, password_hash: await bcrypt.hash(PASSWORD, 4) } });
    const auth = bearer({ id, email, role: 'USER' });

    const wrong = await request(app).patch('/users/me/password').set('Authorization', auth)
      .send({ currentPassword: 'NotMyPass1', newPassword: 'BrandNew123' });
    expect(wrong.status).toBe(403);

    const changed = await request(app).patch('/users/me/password').set('Authorization', auth)
      .send({ currentPassword: PASSWORD, newPassword: 'BrandNew123' });
    expect(changed.status).toBe(200);

    // THO-898, through the real column: the session the change was made from
    // is ended, and the token it handed back carries on.
    expect((await request(app).get('/users/me').set('Authorization', auth)).status).toBe(401);
    expect((await request(app).get('/users/me').set('Authorization', `Bearer ${changed.body.data.token}`)).status).toBe(200);

    expect((await request(app).post('/users/login').send({ email, password: 'BrandNew123' })).status).toBe(200);
    expect((await request(app).post('/users/login').send({ email, password: PASSWORD })).status).toBe(401);
  });
});
