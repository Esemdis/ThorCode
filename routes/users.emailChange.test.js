import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { buildApp, authHeader, installFakePrisma } from '../test/routeApp.js';

// THO-835: a session alone no longer moves the account to another address,
// and the address it leaves is told.
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
const app = buildApp(router, '/users');

// Every limiter on these routes is per account and module-level, and asking
// for a code is capped at three: each test signs in as its own account.
let emailChangeTestAccountCounter = 0;
const emailChangeTestUser = () => ({ id: `email-change-${++emailChangeTestAccountCounter}` });

const requestChange = (user, body) => request(app)
  .post('/users/email/request-change')
  .set(...authHeader(user))
  .send(body);
const verifyCode = (user, code) => request(app)
  .post('/users/email/verify-code')
  .set(...authHeader(user))
  .send({ code });

let sendCode;
let sendNotice;
beforeEach(() => {
  vi.clearAllMocks();
  sendCode = vi.spyOn(mail, 'sendEmailVerificationCode').mockResolvedValue({ data: { id: 'sent' } });
  sendNotice = vi.spyOn(mail, 'sendEmailChangedNotice').mockResolvedValue({ data: { id: 'sent' } });
  prisma.user.findFirst.mockResolvedValue(null);
  prisma.emailVerification.findFirst.mockResolvedValue(null);
  prisma.emailVerification.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('asking to change the email address (THO-835)', () => {
  it('refuses without the current password, and sends no code', async () => {
    const user = emailChangeTestUser();

    const res = await requestChange(user, { newEmail: 'new@example.test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Current password is required');
    expect(prisma.emailVerification.create).not.toHaveBeenCalled();
    expect(sendCode).not.toHaveBeenCalled();
  });

  it('refuses a wrong current password with 403, never 401, and sends no code', async () => {
    // concert-map signs out on any 401; a typo in the modal must not end the
    // session it was typed in.
    const user = emailChangeTestUser();
    prisma.user.findUnique.mockResolvedValue({ id: user.id, password_hash: await bcrypt.hash('Password1', 4) });

    const res = await requestChange(user, { newEmail: 'new@example.test', currentPassword: 'Password2' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Your current password is not right');
    expect(prisma.emailVerification.create).not.toHaveBeenCalled();
    expect(sendCode).not.toHaveBeenCalled();
  });

  it('refuses an account that has no password yet', async () => {
    const user = emailChangeTestUser();
    prisma.user.findUnique.mockResolvedValue({ id: user.id, password_hash: null });

    const res = await requestChange(user, { newEmail: 'new@example.test', currentPassword: 'Password1' });

    expect(res.status).toBe(403);
    expect(sendCode).not.toHaveBeenCalled();
  });

  it('sends the code to the new address with the right current password', async () => {
    const user = emailChangeTestUser();
    prisma.user.findUnique.mockResolvedValue({ id: user.id, password_hash: await bcrypt.hash('Password1', 4) });

    const res = await requestChange(user, { newEmail: 'new@example.test', currentPassword: 'Password1' });

    expect(res.status).toBe(200);
    expect(sendCode).toHaveBeenCalledWith({ to: 'new@example.test', code: expect.stringMatching(/^\d{6}$/) });
  });

  it('checks the password before it says whether the new address is taken', async () => {
    // Otherwise a stolen session could still ask which addresses have
    // accounts, one 409 at a time, without knowing the password.
    const user = emailChangeTestUser();
    prisma.user.findUnique.mockResolvedValue({ id: user.id, password_hash: await bcrypt.hash('Password1', 4) });
    prisma.user.findFirst.mockResolvedValue({ id: 'someone-else' });

    const res = await requestChange(user, { newEmail: 'taken@example.test', currentPassword: 'wrong' });

    expect(res.status).toBe(403);
  });
});

describe('confirming the change with the code (THO-835)', () => {
  const pendingChange = (user) => ({
    id: 7, user_id: user.id, new_email: 'new@example.test', code: '123456', expires_at: new Date(Date.now() + 60_000),
  });

  it('tells the old address, after the change is saved', async () => {
    const user = emailChangeTestUser();
    prisma.emailVerification.findFirst.mockResolvedValue(pendingChange(user));
    prisma.user.findUnique.mockResolvedValue({ id: user.id, email: 'old@example.test' });
    prisma.user.update.mockResolvedValue({ id: user.id, email: 'new@example.test' });
    prisma.emailVerification.delete.mockResolvedValue({});

    const res = await verifyCode(user, '123456');

    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe('new@example.test');
    expect(sendNotice).toHaveBeenCalledWith({ to: 'old@example.test', newEmail: 'new@example.test' });
    expect(sendNotice.mock.invocationCallOrder[0]).toBeGreaterThan(prisma.$transaction.mock.invocationCallOrder[0]);
  });

  it('keeps the change when the notice cannot be sent', async () => {
    // The address has already moved; answering 500 would tell the person it
    // had not, and asking again would find the code spent.
    const user = emailChangeTestUser();
    prisma.emailVerification.findFirst.mockResolvedValue(pendingChange(user));
    prisma.user.findUnique.mockResolvedValue({ id: user.id, email: 'old@example.test' });
    prisma.user.update.mockResolvedValue({ id: user.id, email: 'new@example.test' });
    prisma.emailVerification.delete.mockResolvedValue({});
    sendNotice.mockRejectedValue(new Error('Resend is down'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await verifyCode(user, '123456');

    expect(res.status).toBe(200);
    expect(logged).toHaveBeenCalled();
  });

  it('tells nobody when the code is wrong', async () => {
    const user = emailChangeTestUser();

    const res = await verifyCode(user, '000000');

    expect(res.status).toBe(400);
    expect(sendNotice).not.toHaveBeenCalled();
  });

  it('tells nobody when the new address was taken meanwhile', async () => {
    const user = emailChangeTestUser();
    prisma.emailVerification.findFirst.mockResolvedValue(pendingChange(user));
    prisma.user.findUnique.mockResolvedValue({ id: user.id, email: 'old@example.test' });
    prisma.user.update.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    prisma.emailVerification.delete.mockResolvedValue({});

    const res = await verifyCode(user, '123456');

    expect(res.status).toBe(409);
    expect(sendNotice).not.toHaveBeenCalled();
  });
});
