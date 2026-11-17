import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { authHeader, installFakePrisma } from '../test/routeApp.js';

// The hole THO-972 closes, end to end: the token wander holds to read a packing
// list was a full session. It could ask for an email change, which needed no
// password (THO-835), confirm it, then reset the password and lock the owner
// out, with nothing mailed to the old address. The routers are mounted at their
// real paths, as index.js does, because the scope check reads `originalUrl`
// and buildApp(router, '/') would hand it a path with no prefix.
const prisma = installFakePrisma({
  user: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
  emailVerification: { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn(), delete: vi.fn() },
  trip: { findMany: vi.fn(), count: vi.fn() },
  $transaction: vi.fn(async (ops) => Promise.all(ops)),
});

const { default: usersRouter } = await import('../routes/users.js');
const { default: tripsRouter } = await import('../routes/travel/trips.js');

const app = express();
app.use(express.json());
app.use('/users', usersRouter);
app.use('/travel/trips', tripsRouter);

const wanderToken972 = jwt.sign(
  { id: 'user-1', email: 'me@example.test', role: 'USER', scope: 'wander' },
  process.env.JWT_SECRET,
);
const wanderHeader972 = ['Authorization', `Bearer ${wanderToken972}`];

beforeEach(() => {
  prisma.user.findFirst.mockResolvedValue(null);
  prisma.emailVerification.findFirst.mockResolvedValue(null);
  prisma.emailVerification.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));
  prisma.trip.findMany.mockResolvedValue([]);
  prisma.trip.count.mockResolvedValue(0);
  process.env.RESEND_API_KEY = '';
});

describe('a wander-scoped token (THO-972)', () => {
  it('cannot ask to change the account\'s email, and the handler never runs', async () => {
    const res = await request(app)
      .post('/users/email/request-change')
      .set(...wanderHeader972)
      .send({ newEmail: 'attacker@example.test' });

    expect(res.status).toBe(403);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.emailVerification.create).not.toHaveBeenCalled();
  });

  it('cannot change the password', async () => {
    const res = await request(app)
      .patch('/users/me/password')
      .set(...wanderHeader972)
      .send({ currentPassword: 'Password1', newPassword: 'Password2!' });

    expect(res.status).toBe(403);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('cannot delete the account', async () => {
    const res = await request(app).delete('/users/me').set(...wanderHeader972).send({ currentPassword: 'x' });

    expect(res.status).toBe(403);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('still lists the account\'s trips for wander\'s trip picker', async () => {
    const res = await request(app).get('/travel/trips').set(...wanderHeader972);

    expect(res.status).toBe(200);
    expect(prisma.trip.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { user_id: 'user-1' } }));
  });
});

describe('a token without a scope (THO-972)', () => {
  it('still reaches the email change, as every login and python-crohn token does', async () => {
    const res = await request(app)
      .post('/users/email/request-change')
      .set(...authHeader({ id: 'user-1' }))
      .send({ newEmail: 'new@example.test' });

    expect(res.status).not.toBe(403);
    expect(prisma.user.findFirst).toHaveBeenCalled();
  });
});
