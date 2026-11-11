import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import verifyJWT from './verifyJWT.js';
import { signOAuthState } from '../utils/oauthState.js';

function mockRes() {
  const res = {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function run(token) {
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = mockRes();
  let nextCalled = false;
  verifyJWT(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

describe('verifyJWT middleware', () => {
  beforeAll(() => { process.env.JWT_SECRET = 'test-secret'; });

  it('rejects a request with no Authorization header', () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = () => { throw new Error('next should not be called'); };
    verifyJWT(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'No token provided' });
  });

  it('rejects a header that is not a Bearer token', () => {
    const req = { headers: { authorization: 'Basic abc123' } };
    const res = mockRes();
    verifyJWT(req, res, () => { throw new Error('next should not be called'); });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an invalid token', () => {
    const { res, nextCalled } = run('not-a-real-token');
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid or expired token' });
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign({ id: 'user-1', role: 'USER' }, 'test-secret', { expiresIn: -10 });
    const { res, nextCalled } = run(expired);
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('attaches the decoded payload to req.user and calls next() for a valid token', () => {
    const token = jwt.sign({ id: 'user-7', role: 'USER' }, 'test-secret');
    const { req, nextCalled } = run(token);
    expect(nextCalled).toBe(true);
    expect(req.user).toMatchObject({ id: 'user-7', role: 'USER' });
  });

  describe('a validly signed token that is not a session', () => {
    // Every one of these verifies against the secret. What they lack is the
    // shape routes rely on: a string id to scope queries by, and a role. With
    // no id, `where: { user_id: req.user.id }` is `where: {}` to Prisma.
    it('refuses a token with no id', () => {
      const { res, nextCalled } = run(jwt.sign({ role: 'USER' }, 'test-secret'));
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(401);
    });

    it('refuses a token whose id is not a string', () => {
      const { nextCalled } = run(jwt.sign({ id: 7, role: 'USER' }, 'test-secret'));
      expect(nextCalled).toBe(false);
    });

    it('refuses a token with no role, or one that is not a role', () => {
      expect(run(jwt.sign({ id: 'user-1' }, 'test-secret')).nextCalled).toBe(false);
      expect(run(jwt.sign({ id: 'user-1', role: 'OWNER' }, 'test-secret')).nextCalled).toBe(false);
    });

    it('refuses an OAuth state handed in as a bearer token', () => {
      const state = signOAuthState({ user: 'user-1', purpose: 'spotify_oauth' });
      const { res, nextCalled } = run(state);
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(401);
    });

    it('refuses a token signed with anything but HS256', () => {
      const hs512 = jwt.sign({ id: 'user-1', role: 'USER' }, 'test-secret', { algorithm: 'HS512' });
      expect(run(hs512).nextCalled).toBe(false);
    });
  });
});

describe('verifyJWT after a password change (THO-898)', () => {
  const loginRevocationChangedAt = new Date('2026-11-11T12:00:00.500Z');
  const loginRevocationChangedSecond = Math.floor(loginRevocationChangedAt.getTime() / 1000);
  const loginRevocationRows = new Map();
  let loginRevocationIdCounter = 0;
  // Each test gets its own user, because the per-user cache is module-level.
  const loginRevocationUserId = () => `revoke-user-${++loginRevocationIdCounter}`;

  const loginRevocationToken = (claims) => jwt.sign(claims, 'test-secret');

  // Resolves after the middleware's database read: next() or the 401 has
  // happened by then.
  async function runLoginRevocation(token) {
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    let nextCalled = false;
    await verifyJWT(req, res, () => { nextCalled = true; });
    return { req, res, nextCalled };
  }

  beforeAll(() => {
    // The middleware requires the client on first use and reads it from here.
    process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
    globalThis.prisma = {
      user: {
        findUnique: vi.fn(async ({ where }) => loginRevocationRows.get(where.id) ?? null),
      },
    };
  });

  beforeEach(() => {
    globalThis.prisma.user.findUnique.mockImplementation(
      async ({ where }) => loginRevocationRows.get(where.id) ?? null,
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('refuses a login token issued before the password changed', async () => {
    const id = loginRevocationUserId();
    loginRevocationRows.set(id, { password_changed_at: loginRevocationChangedAt });

    const { res, nextCalled } = await runLoginRevocation(loginRevocationToken({
      id, role: 'USER', kind: 'login', iat: loginRevocationChangedSecond - 60,
    }));

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Your password was changed. Sign in again.' });
  });

  it('accepts a login token issued after it', async () => {
    const id = loginRevocationUserId();
    loginRevocationRows.set(id, { password_changed_at: loginRevocationChangedAt });

    const { req, nextCalled } = await runLoginRevocation(loginRevocationToken({
      id, role: 'USER', kind: 'login', iat: loginRevocationChangedSecond + 60,
    }));

    expect(nextCalled).toBe(true);
    expect(req.user.id).toBe(id);
  });

  it('accepts a login token for an account whose password never changed', async () => {
    const id = loginRevocationUserId();
    loginRevocationRows.set(id, { password_changed_at: null });

    const { nextCalled } = await runLoginRevocation(loginRevocationToken({ id, role: 'ADMIN', kind: 'login' }));

    expect(nextCalled).toBe(true);
  });

  // python-crohn's BACKEND_TOKEN, as scripts/generate-service-token.js mints it.
  it('still accepts a service token issued before the change, without reading the database', async () => {
    const id = loginRevocationUserId();
    loginRevocationRows.set(id, { password_changed_at: loginRevocationChangedAt });

    const { nextCalled } = await runLoginRevocation(loginRevocationToken({
      id, role: 'SYSTEM', service: 'rss-watcher', iat: loginRevocationChangedSecond - 60,
    }));

    expect(nextCalled).toBe(true);
    expect(globalThis.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  // The token a wander user pastes into Settings: role USER, no expiry, and
  // no `service` claim, so "has no service claim" would have revoked it.
  it('still accepts a hand-minted long-lived USER token issued before the change', async () => {
    const id = loginRevocationUserId();
    loginRevocationRows.set(id, { password_changed_at: loginRevocationChangedAt });

    const { nextCalled } = await runLoginRevocation(loginRevocationToken({
      id, role: 'USER', iat: loginRevocationChangedSecond - 60,
    }));

    expect(nextCalled).toBe(true);
    expect(globalThis.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  // Not this ticket's to end: a deleted account's sessions run out on their
  // own (owner decision on THO-810), and test/integration signs login tokens
  // for a scraper and an admin it never creates.
  it('leaves a login token alone when no account row is found', async () => {
    const { nextCalled } = await runLoginRevocation(loginRevocationToken({
      id: loginRevocationUserId(), role: 'SYSTEM', kind: 'login',
    }));

    expect(nextCalled).toBe(true);
  });

  // concert-map signs the user out on any 401; a database blip must not.
  it('answers 500, not 401, when the database cannot be read', async () => {
    globalThis.prisma.user.findUnique.mockRejectedValue(new Error('connection refused'));

    const { res, nextCalled } = await runLoginRevocation(loginRevocationToken({
      id: loginRevocationUserId(), role: 'USER', kind: 'login',
    }));

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(500);
  });
});
