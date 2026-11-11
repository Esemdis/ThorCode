import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { buildApp, installFakePrisma, authHeader } from '../test/routeApp.js';

// Every model the account deletion clears, as a deleteMany that returns its
// own name, so the transaction's operations can be read back in order.
const accountSettingsDeleteMany = (model) => vi.fn(() => `${model}.deleteMany`);

const prisma = installFakePrisma({
  user: {
    findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(),
    update: vi.fn(() => 'user.update'), delete: vi.fn(() => 'user.delete'), count: vi.fn(),
  },
  passwordReset: { deleteMany: accountSettingsDeleteMany('passwordReset') },
  concertMedia: { findMany: vi.fn(async () => []), deleteMany: vi.fn() },
  mediaShareLink: { findMany: vi.fn(async () => []) },
  concertAttendance: { deleteMany: accountSettingsDeleteMany('concertAttendance') },
  wishlistBandReference: { deleteMany: accountSettingsDeleteMany('wishlistBandReference') },
  activityLog: { deleteMany: accountSettingsDeleteMany('activityLog') },
  wishlist: { deleteMany: accountSettingsDeleteMany('wishlist') },
  oAuth: { deleteMany: accountSettingsDeleteMany('oAuth') },
  itemReview: { deleteMany: accountSettingsDeleteMany('itemReview') },
  tripReview: { deleteMany: accountSettingsDeleteMany('tripReview') },
  trip: { deleteMany: accountSettingsDeleteMany('trip') },
  loadout: { deleteMany: accountSettingsDeleteMany('loadout') },
  template: { deleteMany: accountSettingsDeleteMany('template') },
  gearItem: { deleteMany: accountSettingsDeleteMany('gearItem') },
  travelWishlistItem: { deleteMany: accountSettingsDeleteMany('travelWishlistItem') },
  $transaction: vi.fn(async (ops) => ops),
});

const require = createRequire(import.meta.url);
const router = require('./users.js');
const app = buildApp(router, '/users');

// The wrong-password limiter is keyed per account and is module-level, so
// each test signs in as its own user or the eleventh wrong guess in this
// file would be refused for a test that never guessed.
let accountSettingsUserCounter = 0;
const accountSettingsUserId = () => `acct-settings-${++accountSettingsUserCounter}`;

const CURRENT = 'CurrentPass1';
// Hashed once: bcrypt at cost 10 is most of the time a test takes.
const CURRENT_HASH = bcrypt.hashSync(CURRENT, 4);

const accountSettingsUser = (id, over = {}) => ({
  id, email: `${id}@example.test`, role: 'USER', password_hash: CURRENT_HASH, ...over,
});

const changePassword = (id, body, role = 'USER') =>
  request(app).patch('/users/me/password').set(...authHeader({ id, role })).send(body);
const deleteAccount = (id, body, role = 'USER') =>
  request(app).delete('/users/me').set(...authHeader({ id, role })).send(body);

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.MEDIA_ROOT;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('PATCH /users/me/password (THO-810)', () => {
  it('needs a session', async () => {
    const res = await request(app).patch('/users/me/password').send({ currentPassword: CURRENT, newPassword: 'NewPass123' });
    expect(res.status).toBe(401);
  });

  // 403, never 401: concert-map signs the user out on any 401, and a typo in
  // the settings form must not end the session it was typed in.
  it('refuses a wrong current password with 403 and changes nothing', async () => {
    const id = accountSettingsUserId();
    prisma.user.findUnique.mockResolvedValue(accountSettingsUser(id));

    const res = await changePassword(id, { currentPassword: 'WrongPass1', newPassword: 'NewPass123' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Your current password is not right');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('stores the new password, so the new one signs in and the old one does not', async () => {
    const id = accountSettingsUserId();
    prisma.user.findUnique.mockResolvedValue(accountSettingsUser(id));

    const res = await changePassword(id, { currentPassword: CURRENT, newPassword: 'NewPass123' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { token: expect.any(String) }, message: 'Password changed' });
    const { where, data } = prisma.user.update.mock.calls[0][0];
    // Conditional on the state it read: a reset that lands during the bcrypt
    // work makes this write fail instead of undoing the reset.
    expect(where).toEqual({ id, password_changed_at: null });

    // Sign in against what was stored.
    prisma.user.findMany.mockResolvedValue([accountSettingsUser(id, { password_hash: data.password_hash })]);
    const login = (password) => request(app).post('/users/login').send({ email: `${id}@example.test`, password });
    expect((await login('NewPass123')).status).toBe(200);
    expect((await login(CURRENT)).status).toBe(401);
  });

  // THO-898: the change ends every login session the account had, the one it
  // was made from included, and hands that one a fresh token to carry on with.
  it('ends the login sessions issued before it and hands back one that outlives it', async () => {
    const id = accountSettingsUserId();
    let sessionEndChangedAt = null;
    // Read both by verifyJWT (password_changed_at) and by the route itself.
    prisma.user.findUnique.mockImplementation(async () =>
      accountSettingsUser(id, { password_changed_at: sessionEndChangedAt }));
    prisma.user.update.mockImplementation(({ data }) => {
      sessionEndChangedAt = data.password_changed_at;
      return 'user.update';
    });
    const sessionEndOldLogin = authHeader({ id, kind: 'login', pwc: 0 });

    const res = await request(app).patch('/users/me/password').set(...sessionEndOldLogin)
      .send({ currentPassword: CURRENT, newPassword: 'NewPass123' });

    expect(res.status).toBe(200);
    expect(sessionEndChangedAt).toBeInstanceOf(Date);
    const fresh = jwt.verify(res.body.data.token, process.env.JWT_SECRET);
    expect(fresh).toMatchObject({
      id, email: `${id}@example.test`, role: 'USER', kind: 'login', pwc: sessionEndChangedAt.getTime(),
    });

    // Any signed-in route will do: an empty body gets past auth to a 400.
    const withOld = await request(app).patch('/users/me/password').set(...sessionEndOldLogin).send({});
    expect(withOld.status).toBe(401);
    const withFresh = await request(app).patch('/users/me/password')
      .set('Authorization', `Bearer ${res.body.data.token}`).send({});
    expect(withFresh.status).toBe(400);
  });

  // The review's reproduction: a login that read the row, and checked the old
  // hash, before a change committed, signing its token after it. A scripted
  // login every half second always has one in the change's own second. By
  // iat it is newer than the change; it still carries the old password.
  it('ends a login that checked the old password and signed after the change', async () => {
    const id = accountSettingsUserId();
    const raceChangedAt = new Date();
    prisma.user.findMany.mockResolvedValue([accountSettingsUser(id, { password_changed_at: null })]);
    prisma.user.findUnique.mockResolvedValue(accountSettingsUser(id, { password_changed_at: raceChangedAt }));

    const login = await request(app).post('/users/login').send({ email: `${id}@example.test`, password: CURRENT });
    expect(login.status).toBe(200);

    const used = await request(app).patch('/users/me/password')
      .set('Authorization', `Bearer ${login.body.token}`).send({});
    expect(used.status).toBe(401);
  });

  // THO-898 review: a change still in flight from a session a reset has just
  // ended wrote `where: { id }` after its bcrypt work, undid the reset and got
  // a fresh token back. The write is now conditional on the state it read.
  it('does not undo a reset that lands while the change is being worked out, and ends that session', async () => {
    const id = accountSettingsUserId();
    prisma.user.findUnique.mockResolvedValue(accountSettingsUser(id, { password_changed_at: null }));
    prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error('Record to update not found.'), { code: 'P2025' }));

    const res = await request(app).patch('/users/me/password').set(...authHeader({ id, kind: 'login', pwc: 0 }))
      .send({ currentPassword: CURRENT, newPassword: 'NewPass123' });

    expect(res.status).toBe(401);
    expect(res.body.data?.token).toBeUndefined();
    expect(prisma.user.update.mock.calls[0][0].where).toEqual({ id, password_changed_at: null });
  });

  it('asks a token that is not a session to try again when the state moved under it', async () => {
    const id = accountSettingsUserId();
    prisma.user.findUnique.mockResolvedValue(accountSettingsUser(id));
    prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error('Record to update not found.'), { code: 'P2025' }));

    const res = await changePassword(id, { currentPassword: CURRENT, newPassword: 'NewPass123' });

    expect(res.status).toBe(409);
  });

  // A link mailed before the change would put the old state back if used.
  it('spends any live reset link in the same transaction', async () => {
    const id = accountSettingsUserId();
    prisma.user.findUnique.mockResolvedValue(accountSettingsUser(id));

    await changePassword(id, { currentPassword: CURRENT, newPassword: 'NewPass123' });

    expect(prisma.passwordReset.deleteMany).toHaveBeenCalledWith({ where: { user_id: id } });
    expect(prisma.$transaction).toHaveBeenCalledWith(['user.update', 'passwordReset.deleteMany']);
  });

  it('holds the new password to the rules register uses', async () => {
    const id = accountSettingsUserId();
    prisma.user.findUnique.mockResolvedValue(accountSettingsUser(id));

    const res = await changePassword(id, { currentPassword: CURRENT, newPassword: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.errors.map((e) => e.msg)).toContain('Password must be at least 8 characters, at most 100 characters');
    expect(res.body.errors.every((e) => e.path === 'newPassword')).toBe(true);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('asks for the current password when there is none', async () => {
    const id = accountSettingsUserId();
    const res = await changePassword(id, { newPassword: 'NewPass123' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Current password is required');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('does not report a change when the new password is the current one', async () => {
    const id = accountSettingsUserId();
    prisma.user.findUnique.mockResolvedValue(accountSettingsUser(id));

    const res = await changePassword(id, { currentPassword: CURRENT, newPassword: CURRENT });

    expect(res.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  // Nothing to compare against; "Forgot password?" sets a first one (THO-808).
  it('sends an account with no password to the reset flow', async () => {
    const id = accountSettingsUserId();
    prisma.user.findUnique.mockResolvedValue(accountSettingsUser(id, { password_hash: null }));

    const res = await changePassword(id, { currentPassword: 'Anything1', newPassword: 'NewPass123' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Forgot password/);
  });

  it('stops guessing after ten wrong passwords for one account', async () => {
    const id = accountSettingsUserId();
    prisma.user.findUnique.mockResolvedValue(accountSettingsUser(id));

    for (let i = 0; i < 10; i++) {
      expect((await changePassword(id, { currentPassword: `Wrong${i}Pass`, newPassword: 'NewPass123' })).status).toBe(403);
    }
    const limited = await changePassword(id, { currentPassword: CURRENT, newPassword: 'NewPass123' });

    expect(limited.status).toBe(429);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  // The budget is for guesses. A 400 (no current password, a new one the
  // rules refuse) or a 500 is not one, and counting them told someone who
  // gave the right password every time that they had too many wrong ones.
  it('does not count answers other than a wrong password against the budget', async () => {
    const id = accountSettingsUserId();
    prisma.user.findUnique.mockResolvedValue(accountSettingsUser(id));

    for (let i = 0; i < 11; i++) {
      expect((await changePassword(id, { newPassword: 'NewPass123' })).status).toBe(400);
    }
    const res = await changePassword(id, { currentPassword: CURRENT, newPassword: 'NewPass123' });

    expect(res.status).toBe(200);
  });
});

describe('DELETE /users/me (THO-810)', () => {
  it('needs a session', async () => {
    expect((await request(app).delete('/users/me').send({ currentPassword: CURRENT })).status).toBe(401);
  });

  // concert-map's "already deleted" handling keys on exactly this answer, for
  // a token whose account is gone (a second device, an overlapping delete).
  // Reworded, the client would show a generic error instead.
  it('answers 404 "User not found" to a token whose account is already gone', async () => {
    const id = accountSettingsUserId();
    prisma.user.findUnique.mockResolvedValue(null);

    const res = await deleteAccount(id, { currentPassword: CURRENT });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'User not found' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a wrong current password with 403 and deletes nothing', async () => {
    const id = accountSettingsUserId();
    prisma.user.findUnique.mockResolvedValue(accountSettingsUser(id));

    const res = await deleteAccount(id, { currentPassword: 'WrongPass1' });

    expect(res.status).toBe(403);
    expect(prisma.concertMedia.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('asks for the current password when there is none', async () => {
    const res = await deleteAccount(accountSettingsUserId(), {});
    expect(res.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('deletes every table that blocks the user, then the user, in one transaction', async () => {
    const id = accountSettingsUserId();
    prisma.user.findUnique.mockResolvedValue(accountSettingsUser(id));

    const res = await deleteAccount(id, { currentPassword: CURRENT });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: {}, message: 'Account deleted' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const ops = prisma.$transaction.mock.calls[0][0];
    expect(ops.at(-1)).toBe('user.delete');
    expect(ops).toEqual(expect.arrayContaining([
      'concertAttendance.deleteMany', 'wishlist.deleteMany', 'oAuth.deleteMany',
      'trip.deleteMany', 'gearItem.deleteMany', 'loadout.deleteMany', 'template.deleteMany',
      'itemReview.deleteMany', 'tripReview.deleteMany', 'travelWishlistItem.deleteMany',
    ]));
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id } });
  });

  // THO-898, owner decision: a deleted account's sessions end with it. The
  // deleting request read the row into the per-user cache, so the delete
  // must clear it or the token would still work for a minute.
  it('ends the account\'s login sessions, the one it was deleted from included', async () => {
    const id = accountSettingsUserId();
    prisma.user.findUnique.mockResolvedValue(accountSettingsUser(id, { password_changed_at: null }));
    const deletedLogin = authHeader({ id, kind: 'login', pwc: 0 });

    const res = await request(app).delete('/users/me').set(...deletedLogin).send({ currentPassword: CURRENT });
    expect(res.status).toBe(200);

    prisma.user.findUnique.mockResolvedValue(null);
    const after = await request(app).patch('/users/me/password').set(...deletedLogin).send({});
    expect(after.status).toBe(401);
    expect(after.body).toEqual({ error: 'This account no longer exists.' });
  });

  // The files are gone for good by the time the transaction runs. If it then
  // fails, "Internal server error" would leave the person thinking nothing
  // happened, when their photos are already gone and a retry finishes it.
  it('says the photos are gone and to try again when the rows fail after the files went', async () => {
    const id = accountSettingsUserId();
    prisma.user.findUnique.mockResolvedValue(accountSettingsUser(id));
    prisma.$transaction.mockRejectedValueOnce(new Error('foreign key'));

    const res = await deleteAccount(id, { currentPassword: CURRENT });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe(
      'Your photos and videos were removed, but your account could not be deleted. Try again to finish.',
    );
  });

  // Two overlapping deletes: both read the account, the first commits, and
  // the second's user.delete finds nothing (P2025). The account is gone, as
  // asked; "try again" would only lead to a 404.
  it('answers success to a second, overlapping delete whose account the first already removed', async () => {
    const id = accountSettingsUserId();
    prisma.user.findUnique
      .mockResolvedValueOnce(accountSettingsUser(id))
      .mockResolvedValueOnce(null);
    prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' }));

    const res = await deleteAccount(id, { currentPassword: CURRENT });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Account deleted');
  });

  it('still says to try again when the rows fail with P2025 and the account is still there', async () => {
    const id = accountSettingsUserId();
    prisma.user.findUnique.mockResolvedValue(accountSettingsUser(id));
    prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error('Record not found'), { code: 'P2025' }));

    const res = await deleteAccount(id, { currentPassword: CURRENT });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Try again to finish/);
  });

  // No archive here (MEDIA_ROOT unset), so every file fails to go: the
  // account must stay, whole, for a retry.
  it('keeps the account when a photo or video cannot be removed from the archive', async () => {
    const id = accountSettingsUserId();
    prisma.user.findUnique.mockResolvedValue(accountSettingsUser(id));
    prisma.concertMedia.findMany.mockResolvedValue([
      { id: 7, rel_path: `${id}/night/IMG_1.jpg`, filename: 'IMG_1.jpg', kind: 'PHOTO', sha256: 'abc' },
    ]);

    const res = await deleteAccount(id, { currentPassword: CURRENT });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/has not been deleted/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.concertMedia.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses the service account', async () => {
    const id = accountSettingsUserId();
    prisma.user.findUnique.mockResolvedValue(accountSettingsUser(id, { role: 'SYSTEM' }));

    const res = await deleteAccount(id, { currentPassword: CURRENT }, 'SYSTEM');

    expect(res.status).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses the last admin and lets one of two go', async () => {
    const id = accountSettingsUserId();
    prisma.user.findUnique.mockResolvedValue(accountSettingsUser(id, { role: 'ADMIN' }));
    prisma.user.count.mockResolvedValue(1);

    const last = await deleteAccount(id, { currentPassword: CURRENT }, 'ADMIN');
    expect(last.status).toBe(409);
    expect(prisma.user.count).toHaveBeenCalledWith({ where: { role: 'ADMIN' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();

    prisma.user.count.mockResolvedValue(2);
    expect((await deleteAccount(id, { currentPassword: CURRENT }, 'ADMIN')).status).toBe(200);
  });
});
