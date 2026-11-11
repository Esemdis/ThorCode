import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { buildApp, installFakePrisma } from '../test/routeApp.js';

const prisma = installFakePrisma({
  user: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  emailVerification: { findFirst: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
  passwordReset: { upsert: vi.fn(), findUnique: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
  $transaction: vi.fn(async (ops) => Promise.all(ops)),
});

// The router's own copies: it is CommonJS and loads utils/mail through Node's
// require, which an ESM import would not share, so a spy set on an imported
// copy would never be seen by the route.
const require = createRequire(import.meta.url);
const mail = require('../utils/mail.js');
const router = require('./users.js');
const { cleanupExpiredPasswordResets } = require('../utils/cron.js');

const app = buildApp(router, '/users');
// The limiters key on req.ip and are module-level, so they remember every
// request in this file. Each test asks from its own forwarded address (and
// for its own email), or the fourth test to ask would be limited and the
// assertions after it would pass against the quiet 200 instead of the route.
app.set('trust proxy', 1);
let resetTestIpCounter = 0;
const resetTestIp = () => `198.51.100.${++resetTestIpCounter}`;
let resetTestAddressCounter = 0;
const resetTestAddress = () => `reset-${++resetTestAddressCounter}@example.test`;

const FORGOT_BODY = {
  success: true,
  data: {},
  message: "If an account uses that address, we've sent a link to reset its password.",
};
const USED = 'This reset link has already been used or is not valid. Ask for a new one.';
const EXPIRED = 'This reset link has expired. Ask for a new one.';
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const forgot = (email, ip = resetTestIp()) =>
  request(app).post('/users/password/forgot').set('X-Forwarded-For', ip).send({ email });
const reset = (body, ip = resetTestIp()) =>
  request(app).post('/users/password/reset').set('X-Forwarded-For', ip).send(body);

const resetTestAccount = (email, over = {}) => ({ id: 'u-reset', email, role: 'USER', password_hash: 'old', ...over });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CONCERT_MAP_URL = 'https://map.example.test/';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.CONCERT_MAP_URL;
  vi.restoreAllMocks();
});

describe('POST /users/password/forgot', () => {
  it('answers a known and an unknown address with the same body', async () => {
    const known = resetTestAddress();
    const send = vi.spyOn(mail, 'sendPasswordResetEmail').mockResolvedValue({ data: { id: 'm' } });
    prisma.user.findMany.mockImplementation(async ({ where }) =>
      (where.email.equals === known ? [resetTestAccount(known)] : []));
    prisma.passwordReset.upsert.mockResolvedValue({});

    const a = await forgot(known);
    const b = await forgot(resetTestAddress());

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual(FORGOT_BODY);
    expect(b.body).toEqual(FORGOT_BODY);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  it('refuses something that is not an email address', async () => {
    const res = await forgot('not-an-address');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Valid email required');
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('mails a link to CONCERT_MAP_URL/user/reset whose token is stored only as its sha256', async () => {
    const email = resetTestAddress();
    const send = vi.spyOn(mail, 'sendPasswordResetEmail').mockResolvedValue({ data: { id: 'm' } });
    prisma.user.findMany.mockResolvedValue([resetTestAccount(email)]);
    prisma.passwordReset.upsert.mockResolvedValue({});

    await forgot(` ${email.toUpperCase()} `);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    const { to, link } = send.mock.calls[0][0];
    expect(to).toBe(email);
    // No double slash, although the base ends in one.
    expect(link).toMatch(/^https:\/\/map\.example\.test\/user\/reset\?token=[A-Za-z0-9_-]{43}$/);
    const token = new URL(link).searchParams.get('token');

    const { where, create, update } = prisma.passwordReset.upsert.mock.calls[0][0];
    expect(where).toEqual({ user_id: 'u-reset' });
    expect(create.token_hash).toBe(sha256(token));
    expect(update.token_hash).toBe(sha256(token));
    expect(JSON.stringify(prisma.passwordReset.upsert.mock.calls)).not.toContain(token);
    const ttl = create.expires_at.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(29 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(30 * 60 * 1000);
  });

  // One live link per user: the upsert on the unique user_id replaces the
  // hash, so the link in the first email stops working.
  it('replaces the earlier token when asked again', async () => {
    const email = resetTestAddress();
    const send = vi.spyOn(mail, 'sendPasswordResetEmail').mockResolvedValue({ data: { id: 'm' } });
    prisma.user.findMany.mockResolvedValue([resetTestAccount(email)]);
    prisma.passwordReset.upsert.mockResolvedValue({});

    await forgot(email);
    await forgot(email);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));

    const [first, second] = prisma.passwordReset.upsert.mock.calls.map(([args]) => args);
    expect(first.where).toEqual(second.where);
    expect(second.update.token_hash).not.toBe(first.update.token_hash);
  });

  it('still answers 200 when the mail fails, and leaves no token behind', async () => {
    const email = resetTestAddress();
    vi.spyOn(mail, 'sendPasswordResetEmail').mockRejectedValue(new Error('Email service error: invalid key'));
    prisma.user.findMany.mockResolvedValue([resetTestAccount(email)]);
    prisma.passwordReset.upsert.mockResolvedValue({});
    prisma.passwordReset.deleteMany.mockResolvedValue({ count: 1 });

    const res = await forgot(email);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(FORGOT_BODY);
    await vi.waitFor(() => expect(prisma.passwordReset.deleteMany).toHaveBeenCalled());
    const stored = prisma.passwordReset.upsert.mock.calls[0][0].create.token_hash;
    // By hash, so a newer link that did arrive is not the one deleted.
    expect(prisma.passwordReset.deleteMany).toHaveBeenCalledWith({ where: { token_hash: stored } });
  });

  it('sends nothing and stores nothing when CONCERT_MAP_URL is not set', async () => {
    delete process.env.CONCERT_MAP_URL;
    const email = resetTestAddress();
    const send = vi.spyOn(mail, 'sendPasswordResetEmail').mockResolvedValue({ data: { id: 'm' } });
    prisma.user.findMany.mockResolvedValue([resetTestAccount(email)]);

    const res = await forgot(email);

    expect(res.body).toEqual(FORGOT_BODY);
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(send).not.toHaveBeenCalled();
    expect(prisma.passwordReset.upsert).not.toHaveBeenCalled();
  });

  it('gives the fourth request for one address in an hour the same 200, and sends nothing for it', async () => {
    const email = resetTestAddress();
    const send = vi.spyOn(mail, 'sendPasswordResetEmail').mockResolvedValue({ data: { id: 'm' } });
    prisma.user.findMany.mockResolvedValue([resetTestAccount(email)]);
    prisma.passwordReset.upsert.mockResolvedValue({});

    // From a different IP each time: this is the per-address limit.
    for (let i = 0; i < 3; i++) await forgot(email);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    const fourth = await forgot(email);

    expect(fourth.status).toBe(200);
    expect(fourth.body).toEqual(FORGOT_BODY);
    // Nothing that would tell a stranger this one was limited.
    expect(fourth.headers['ratelimit-remaining']).toBeUndefined();
    expect(fourth.headers['x-ratelimit-remaining']).toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('gives the fourth request from one IP in a quarter hour the same 200', async () => {
    const ip = resetTestIp();
    prisma.user.findMany.mockResolvedValue([]);

    for (let i = 0; i < 3; i++) await forgot(resetTestAddress(), ip);
    const fourth = await forgot(resetTestAddress(), ip);

    expect(fourth.status).toBe(200);
    expect(fourth.body).toEqual(FORGOT_BODY);
    await new Promise((r) => setTimeout(r, 20));
    expect(prisma.user.findMany).toHaveBeenCalledTimes(3);
  });
});

describe('POST /users/password/reset', () => {
  const NEW_PASSWORD = 'NewPassword1';
  const live = (over = {}) => ({
    id: 1, user_id: 'u-reset', token_hash: 'h', expires_at: new Date(Date.now() + 10 * 60 * 1000), ...over,
  });

  it('sets the password and spends the token in one transaction', async () => {
    const token = 'reset-token-sets-password';
    prisma.passwordReset.findUnique.mockResolvedValue(live());
    prisma.passwordReset.delete.mockResolvedValue({});
    prisma.user.update.mockResolvedValue({});

    const res = await reset({ token, password: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: {}, message: 'Password changed' });
    expect(prisma.passwordReset.findUnique).toHaveBeenCalledWith({ where: { token_hash: sha256(token) } });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.passwordReset.delete).toHaveBeenCalledWith({ where: { token_hash: sha256(token) } });
    const { where, data } = prisma.user.update.mock.calls[0][0];
    expect(where).toEqual({ id: 'u-reset' });
    expect(await bcrypt.compare(NEW_PASSWORD, data.password_hash)).toBe(true);
    // Answers with no token: a reset signs nobody in.
    expect(res.body.data.token).toBeUndefined();
  });

  it('gives a password to an account that never had one', async () => {
    // The route never reads the old hash, so a null one is no different.
    prisma.passwordReset.findUnique.mockResolvedValue(live({ user_id: 'u-oauth-only' }));
    prisma.passwordReset.delete.mockResolvedValue({});
    prisma.user.update.mockResolvedValue({ id: 'u-oauth-only', password_hash: null });

    const res = await reset({ token: 'reset-token-no-password', password: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(prisma.user.update.mock.calls[0][0].where).toEqual({ id: 'u-oauth-only' });
  });

  it('refuses an expired token, and deletes it', async () => {
    const token = 'reset-token-expired';
    prisma.passwordReset.findUnique.mockResolvedValue(live({ expires_at: new Date(Date.now() - 1000) }));
    prisma.passwordReset.deleteMany.mockResolvedValue({ count: 1 });

    const res = await reset({ token, password: NEW_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(EXPIRED);
    expect(prisma.passwordReset.deleteMany).toHaveBeenCalledWith({ where: { token_hash: sha256(token) } });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('refuses a used or unknown token', async () => {
    prisma.passwordReset.findUnique.mockResolvedValue(null);

    const res = await reset({ token: 'reset-token-unknown', password: NEW_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(USED);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a missing, non-string or over-long token without looking it up', async () => {
    for (const token of [undefined, ['a'], 'a'.repeat(201)]) {
      const res = await reset({ token, password: NEW_PASSWORD });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(USED);
    }
    expect(prisma.passwordReset.findUnique).not.toHaveBeenCalled();
  });

  // A double click: both requests find the row, the first delete wins, and
  // the second delete's P2025 rolls its transaction back.
  it('answers "used" to a second use that lost the race', async () => {
    prisma.passwordReset.findUnique.mockResolvedValue(live());
    prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' }));

    const res = await reset({ token: 'reset-token-race', password: NEW_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(USED);
  });

  it('holds the new password to register\'s rules', async () => {
    prisma.passwordReset.findUnique.mockResolvedValue(live());

    const res = await reset({ token: 'reset-token-weak', password: 'alllowercase1' });

    expect(res.status).toBe(400);
    expect(res.body.errors[0].msg).toBe('Password must contain at least one uppercase letter');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('allows eight attempts per IP in a quarter hour and answers the ninth with 429', async () => {
    const ip = resetTestIp();
    prisma.passwordReset.findUnique.mockResolvedValue(null);

    for (let i = 0; i < 8; i++) {
      expect((await reset({ token: `guess-${i}`, password: NEW_PASSWORD }, ip)).status).toBe(400);
    }
    const ninth = await reset({ token: 'guess-9', password: NEW_PASSWORD }, ip);

    expect(ninth.status).toBe(429);
  });
});

describe('the hourly sweep of reset links', () => {
  it('deletes the ones past their expiry', async () => {
    prisma.passwordReset.deleteMany.mockResolvedValue({ count: 2 });

    await cleanupExpiredPasswordResets();

    const { where } = prisma.passwordReset.deleteMany.mock.calls[0][0];
    expect(where.expires_at.lt).toBeInstanceOf(Date);
  });
});
