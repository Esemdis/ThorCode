import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { buildApp, authHeader, installFakePrisma } from '../test/routeApp.js';

const prisma = installFakePrisma({
  user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  emailVerification: { findFirst: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(async (ops) => Promise.all(ops)),
});

const { default: router } = await import('./users.js');
const app = buildApp(router, '/users');

beforeEach(() => { vi.clearAllMocks(); });

describe('GET /users/:id (admin)', () => {
  it('asks for the relations by their relation names', async () => {
    // It selected `game` and `movie`, which are scalar id columns, with a
    // nested select. Prisma refuses that (SelectionSetOnScalar), so the route
    // answered 500 to every request — confirmed against Postgres.
    prisma.user.findUnique.mockResolvedValue({ id: 'a'.repeat(32), email: 'x@y.z', game_times: [], movie_reviews: [] });

    const res = await request(app).get(`/users/${'a'.repeat(32)}`).set(...authHeader({ role: 'ADMIN' }));

    expect(res.status).toBe(200);
    const { select } = prisma.user.findUnique.mock.calls[0][0];
    expect(select.game_times.select).toHaveProperty('game_rel');
    expect(select.game_times.select).not.toHaveProperty('game');
    expect(select.movie_reviews.select).toHaveProperty('movie_rel');
    expect(select.movie_reviews.select).not.toHaveProperty('movie');
  });
});

describe('POST /users/login', () => {
  const body = { email: 'someone@example.test', password: 'Password1' };

  it('answers an unknown email the same way as a wrong password, after the same work', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const compare = vi.spyOn(bcrypt, 'compare');

    const res = await request(app).post('/users/login').send(body);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
    expect(compare).toHaveBeenCalledTimes(1);
    compare.mockRestore();
  });

  it('refuses an account with no password instead of throwing inside bcrypt', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: body.email, role: 'USER', password_hash: null });

    const res = await request(app).post('/users/login').send(body);

    expect(res.status).toBe(401);
  });

  it('signs a token for the right password', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1', email: body.email, role: 'USER', password_hash: await bcrypt.hash(body.password, 4),
    });

    const res = await request(app).post('/users/login').send(body);

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
  });
});

describe('POST /users/register', () => {
  const body = { email: 'new@example.test', password: 'Password1' };

  it('creates the account and its wishlist in one write', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ id: 'u2', email: body.email });

    const res = await request(app).post('/users/register').send(body);

    expect(res.status).toBe(201);
    expect(prisma.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ wishlists: { create: { name: 'My Wishlist' } } }),
    }));
  });

  it('answers 409 when a second request registered the address first', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    const res = await request(app).post('/users/register').send(body);

    expect(res.status).toBe(409);
  });
});

describe('the email change codes', () => {
  it('draws again when six digits collide with another account\'s pending code', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
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
