import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { buildApp, authHeader, installFakePrisma } from '../test/routeApp.js';
import { REGISTRATION_CLOSED_MESSAGE } from '../utils/accounts.js';

const prisma = installFakePrisma({
  user: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  emailVerification: { findFirst: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(async (ops) => Promise.all(ops)),
});

const { default: router } = await import('./users.js');
const app = buildApp(router, '/users');

beforeEach(() => { vi.clearAllMocks(); });

describe('POST /users/login', () => {
  const body = { email: 'someone@example.test', password: 'Password1' };

  it('answers an unknown email the same way as a wrong password, after the same work', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    const compare = vi.spyOn(bcrypt, 'compare');

    const res = await request(app).post('/users/login').send(body);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
    expect(compare).toHaveBeenCalledTimes(1);
    compare.mockRestore();
  });

  it('refuses an account with no password instead of throwing inside bcrypt', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'u1', email: body.email, role: 'USER', password_hash: null }]);

    const res = await request(app).post('/users/login').send(body);

    expect(res.status).toBe(401);
  });

  it('signs a token for the right password', async () => {
    prisma.user.findMany.mockResolvedValue([{
      id: 'u1', email: body.email, role: 'USER', password_hash: await bcrypt.hash(body.password, 4),
    }]);

    const res = await request(app).post('/users/login').send(body);

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
  });

  it('finds the account however the address is capitalised or padded', async () => {
    // A phone keyboard capitalises the first letter. The address was compared
    // exactly, so "Someone@…" could not sign in to the account "someone@…".
    prisma.user.findMany.mockResolvedValue([{
      id: 'u1', email: body.email, role: 'USER', password_hash: await bcrypt.hash(body.password, 4),
    }]);

    const res = await request(app).post('/users/login').send({ ...body, email: ' Someone@Example.TEST ' });

    expect(res.status).toBe(200);
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { email: { equals: 'someone@example.test', mode: 'insensitive' } },
    }));
  });

  it('matches % and _ in an address as themselves, not as wildcards', async () => {
    // Prisma's insensitive equals is an ILIKE on Postgres with the value
    // unescaped, so `v_ctim@…` signed in to (and the forgot form mailed)
    // victim@…; test/integration/passwordReset.test.js shows it on Postgres.
    prisma.user.findMany.mockResolvedValue([]);

    await request(app).post('/users/login').send({ ...body, email: 'v_c%tim@example.test' });

    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { email: { equals: 'v\\_c\\%tim@example.test', mode: 'insensitive' } },
    }));
  });

  it('takes the exact address when two old accounts differ only by case', async () => {
    // The migration that lowercased stored addresses leaves such a pair alone
    // rather than failing on the unique key. Either one is only a guess.
    const hash = await bcrypt.hash(body.password, 4);
    prisma.user.findMany.mockResolvedValue([
      { id: 'mixed', email: 'Someone@example.test', role: 'USER', password_hash: hash },
      { id: 'lower', email: 'someone@example.test', role: 'USER', password_hash: hash },
    ]);

    const res = await request(app).post('/users/login').send(body);

    expect(res.body.user.id).toBe('lower');
  });
});

describe('POST /users/register, now that sign-up is closed', () => {
  const closedSignupBody = { email: 'stranger@example.test', password: 'Password1' };

  it('refuses with 403 and the sentence the sign-up pages show', async () => {
    const res = await request(app).post('/users/register').send(closedSignupBody);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: REGISTRATION_CLOSED_MESSAGE });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('does not look the address up, so the answer says nothing about who has an account', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'u1', email: closedSignupBody.email });

    const res = await request(app).post('/users/register').send(closedSignupBody);

    expect(res.status).toBe(403);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('answers a malformed request the same 403, not a list of what was wrong with it', async () => {
    const res = await request(app).post('/users/register').send({ email: 'not-an-address', password: 'x' });

    expect(res.status).toBe(403);
    expect(res.body.errors).toBeUndefined();
  });

  it('cannot be opened from the environment', async () => {
    // The first version of this had a REGISTRATION_OPEN switch. Pinned so it
    // does not come back by accident: while it was on, anyone could sign up.
    vi.stubEnv('REGISTRATION_OPEN', 'true');

    const res = await request(app).post('/users/register').send(closedSignupBody);

    vi.unstubAllEnvs();
    expect(res.status).toBe(403);
  });

  it('leaves signing in alone', async () => {
    prisma.user.findMany.mockResolvedValue([{
      id: 'u1', email: closedSignupBody.email, role: 'USER', password_hash: await bcrypt.hash(closedSignupBody.password, 4),
    }]);

    const res = await request(app).post('/users/login').send(closedSignupBody);

    expect(res.status).toBe(200);
  });
});

// THO-898: an email change asks for the current password. Hashed once at a
// low cost; bcrypt is most of a test's time.
const EMAIL_CHANGE_PASSWORD = 'EmailChange1';
const EMAIL_CHANGE_HASH = bcrypt.hashSync(EMAIL_CHANGE_PASSWORD, 4);
const emailChangeAccount = (id, over = {}) => ({
  id, email: `${id}@example.test`, role: 'USER', password_hash: EMAIL_CHANGE_HASH, password_changed_at: null, ...over,
});

describe('the email change codes', () => {
  it('draws again when six digits collide with another account\'s pending code', async () => {
    prisma.user.findUnique.mockResolvedValue(emailChangeAccount('user-1'));
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.emailVerification.findFirst.mockResolvedValue(null);
    prisma.emailVerification.create
      .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
      .mockImplementationOnce(async ({ data }) => ({ id: 1, ...data }));
    process.env.RESEND_API_KEY = '';

    await request(app)
      .post('/users/email/request-change')
      .set(...authHeader({ id: 'user-1' }))
      .send({ newEmail: 'new@example.test', currentPassword: EMAIL_CHANGE_PASSWORD });

    expect(prisma.emailVerification.create).toHaveBeenCalledTimes(2);
    const codes = prisma.emailVerification.create.mock.calls.map(([{ data }]) => data.code);
    for (const code of codes) expect(code).toMatch(/^\d{6}$/);
  });

  it('lets you ask again for the address you asked for, and ignores expired asks', async () => {
    // The pending check found the caller's own request and refused it, so
    // "Back" and asking again for the same address was a 409 — and so was
    // every address anyone had asked for and abandoned, until the hourly sweep.
    prisma.user.findUnique.mockResolvedValue(emailChangeAccount('user-1'));
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.emailVerification.findFirst.mockResolvedValue(null);
    prisma.emailVerification.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));

    await request(app)
      .post('/users/email/request-change')
      .set(...authHeader({ id: 'user-1' }))
      .send({ newEmail: ' New@Example.test', currentPassword: EMAIL_CHANGE_PASSWORD });

    // Stored as it will be compared: lowercased.
    expect(prisma.emailVerification.create.mock.calls[0][0].data.new_email).toBe('new@example.test');
    const { where } = prisma.emailVerification.findFirst.mock.calls[0][0];
    expect(where.user_id).toEqual({ not: 'user-1' });
    expect(where.new_email).toBe('new@example.test');
    expect(where.expires_at.gt).toBeInstanceOf(Date);
    expect(Math.abs(where.expires_at.gt - Date.now())).toBeLessThan(5_000);
  });

  it('looks a code up within the caller\'s own pending change only', async () => {
    prisma.emailVerification.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/users/email/verify-code')
      .set(...authHeader({ id: 'user-1' }))
      .send({ code: '123456' });

    expect(res.status).toBe(400);
    expect(prisma.emailVerification.findFirst).toHaveBeenCalledWith({ where: { code: '123456', user_id: 'user-1' } });
  });

  it('answers 409 when the address was taken after the code was sent', async () => {
    prisma.emailVerification.findFirst.mockResolvedValue({
      id: 4, user_id: 'user-1', new_email: 'taken@example.test', code: '123456', expires_at: new Date(Date.now() + 60_000),
    });
    prisma.user.update.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    prisma.emailVerification.delete.mockResolvedValue({});

    const res = await request(app)
      .post('/users/email/verify-code')
      .set(...authHeader({ id: 'user-1' }))
      .send({ code: '123456' });

    expect(res.status).toBe(409);
  });
});

// THO-898. A stolen login token could move the account to the thief's
// address with no password, and then the reset mail went to the thief, so the
// reset that should end their session never happened.
describe('an email change proves the password and ends other sessions (THO-898)', () => {
  // Each test its own account: both limiters on these routes are per account.
  let emailChangeSessionCounter = 0;
  const emailChangeSessionUser = () => `email-session-${++emailChangeSessionCounter}`;

  const askForCode = (id, body) => request(app)
    .post('/users/email/request-change').set(...authHeader({ id })).send({ newEmail: 'moved@example.test', ...body });

  // A free address and a working code store, so a route that skipped the
  // password check would send the code (and fail the test) rather than spin
  // on a create that returns nothing.
  beforeEach(() => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.emailVerification.findFirst.mockResolvedValue(null);
    prisma.emailVerification.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));
    process.env.RESEND_API_KEY = '';
  });

  it('asks for the current password before sending a code', async () => {
    const res = await askForCode(emailChangeSessionUser(), {});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Current password is required');
    expect(prisma.emailVerification.create).not.toHaveBeenCalled();
  });

  // 403, not 401: concert-map signs out on any 401. And before the address is
  // looked up, so a stolen session cannot ask which addresses have accounts.
  it('refuses a wrong current password with 403, before looking at the address', async () => {
    const id = emailChangeSessionUser();
    prisma.user.findUnique.mockResolvedValue(emailChangeAccount(id));

    const res = await askForCode(id, { currentPassword: 'WrongPass1' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Your current password is not right');
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.emailVerification.create).not.toHaveBeenCalled();
  });

  it('sends the code for the right password', async () => {
    const id = emailChangeSessionUser();
    prisma.user.findUnique.mockResolvedValue(emailChangeAccount(id));

    await askForCode(id, { currentPassword: EMAIL_CHANGE_PASSWORD });

    // There is no Resend key here, so the send itself fails afterwards; that
    // the code was drawn is what says the password let it through.
    expect(prisma.emailVerification.create).toHaveBeenCalledTimes(1);
  });

  it('ends the login sessions issued before the change and hands back one that outlives it', async () => {
    const id = emailChangeSessionUser();
    let emailChangeChangedAt = null;
    prisma.user.findUnique.mockImplementation(async () =>
      emailChangeAccount(id, { password_changed_at: emailChangeChangedAt }));
    prisma.emailVerification.findFirst.mockResolvedValue({
      id: 9, user_id: id, new_email: 'moved@example.test', code: '654321', expires_at: new Date(Date.now() + 60_000),
    });
    prisma.emailVerification.delete.mockResolvedValue({});
    prisma.user.update.mockImplementation(async ({ data }) => {
      emailChangeChangedAt = data.password_changed_at;
      return { id, email: data.email, role: 'USER' };
    });
    const emailChangeOldLogin = authHeader({ id, kind: 'login', pwc: 0 });

    const res = await request(app).post('/users/email/verify-code').set(...emailChangeOldLogin).send({ code: '654321' });

    expect(res.status).toBe(200);
    expect(emailChangeChangedAt).toBeInstanceOf(Date);
    expect(res.body.data.user).toEqual({ id, email: 'moved@example.test' });
    expect(jwt.verify(res.body.data.token, process.env.JWT_SECRET)).toMatchObject({
      id, email: 'moved@example.test', role: 'USER', kind: 'login', pwc: emailChangeChangedAt.getTime(),
    });

    // Any signed-in route will do: an empty body gets past auth to a 400.
    const withOld = await request(app).post('/users/email/verify-code').set(...emailChangeOldLogin).send({});
    expect(withOld.status).toBe(401);
    const withFresh = await request(app).post('/users/email/verify-code')
      .set('Authorization', `Bearer ${res.body.data.token}`).send({});
    expect(withFresh.status).toBe(400);
  });
});
