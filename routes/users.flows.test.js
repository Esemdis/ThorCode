import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { buildApp, authHeader, installFakePrisma } from '../test/routeApp.js';

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

describe('POST /users/register', () => {
  const body = { email: 'new@example.test', password: 'Password1' };

  it('creates the account and its wishlist in one write', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ id: 'u2', email: body.email });

    const res = await request(app).post('/users/register').send(body);

    expect(res.status).toBe(201);
    expect(prisma.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ wishlists: { create: { name: 'My Wishlist' } } }),
    }));
  });

  it('answers 409 when a second request registered the address first', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    const res = await request(app).post('/users/register').send(body);

    expect(res.status).toBe(409);
  });

  it('stores the address lowercased, and refuses one that differs only by case', async () => {
    prisma.user.findFirst.mockResolvedValueOnce(null);
    prisma.user.create.mockResolvedValue({ id: 'u2', email: body.email });

    await request(app).post('/users/register').send({ ...body, email: ' New@Example.TEST' });

    expect(prisma.user.create.mock.calls[0][0].data.email).toBe('new@example.test');

    prisma.user.findFirst.mockResolvedValueOnce({ id: 'u2', email: 'new@example.test' });
    const res = await request(app).post('/users/register').send({ ...body, email: 'NEW@example.test' });

    expect(res.status).toBe(409);
    expect(prisma.user.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { email: { equals: 'new@example.test', mode: 'insensitive' } },
    }));
  });
});

describe('the email change codes', () => {
  it('draws again when six digits collide with another account\'s pending code', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.emailVerification.findFirst.mockResolvedValue(null);
    prisma.emailVerification.create
      .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
      .mockImplementationOnce(async ({ data }) => ({ id: 1, ...data }));
    process.env.RESEND_API_KEY = '';

    await request(app)
      .post('/users/email/request-change')
      .set(...authHeader({ id: 'user-1' }))
      .send({ newEmail: 'new@example.test' });

    expect(prisma.emailVerification.create).toHaveBeenCalledTimes(2);
    const codes = prisma.emailVerification.create.mock.calls.map(([{ data }]) => data.code);
    for (const code of codes) expect(code).toMatch(/^\d{6}$/);
  });

  it('lets you ask again for the address you asked for, and ignores expired asks', async () => {
    // The pending check found the caller's own request and refused it, so
    // "Back" and asking again for the same address was a 409 — and so was
    // every address anyone had asked for and abandoned, until the hourly sweep.
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.emailVerification.findFirst.mockResolvedValue(null);
    prisma.emailVerification.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));

    await request(app)
      .post('/users/email/request-change')
      .set(...authHeader({ id: 'user-1' }))
      .send({ newEmail: ' New@Example.test' });

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
