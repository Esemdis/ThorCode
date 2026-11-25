import { describe, it, expect, beforeAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import verifyJWT from './verifyJWT.js';
import { signOAuthState } from '../utils/oauthState.js';
import { installFakePrisma } from '../test/routeApp.js';

// A minted token's row is read through prisma/client (auth/serviceTokens.js),
// which picks this up on first use. Each test below mints its own jti, because
// the module's cache keeps a row for a minute.
const prisma1016 = installFakePrisma({ serviceToken: { findUnique: vi.fn() } });

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
    const token = jwt.sign({ id: 'user-7', role: 'USER' }, 'test-secret', { expiresIn: '8h' });
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

  describe('scoped and long-lived tokens (THO-972)', () => {
    // run() sets no method or URL, and the scope check reads both.
    function runScoped972(token, method, url) {
      const req = { method, originalUrl: url, headers: { authorization: `Bearer ${token}` } };
      const res = mockRes();
      let nextCalled = false;
      verifyJWT(req, res, () => { nextCalled = true; });
      return { req, res, nextCalled };
    }

    // THO-972 pinned the opposite: a token with no `exp` was accepted, because
    // python-crohn and wander held such tokens. THO-1016 reverses it on
    // purpose (owner decision 1B): those tokens could never be withdrawn, so
    // from this deploy they are refused and both are re-minted with a `jti`.
    it('refuses a token minted with neither exp nor jti, as every token minted before THO-1016 was', () => {
      const token = jwt.sign({ id: 'sys-1', role: 'SYSTEM' }, 'test-secret');
      expect(jwt.decode(token).exp).toBeUndefined();
      const { req, res, nextCalled } = runScoped972(token, 'GET', '/travel/trips/weather-pending');
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid or expired token' });
      expect(req.user).toBeUndefined();
      expect(prisma1016.serviceToken.findUnique).not.toHaveBeenCalled();
    });

    it('answers 403 to a wander-scoped token outside its routes', () => {
      const token = jwt.sign({ id: 'user-1', role: 'USER', scope: 'wander' }, 'test-secret', { expiresIn: '1h' });
      const { req, res, nextCalled } = runScoped972(token, 'POST', '/users/email/request-change');
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(403);
      expect(req.user).toBeUndefined();
    });

    it('lets a wander-scoped token read a trip', () => {
      const token = jwt.sign({ id: 'user-1', role: 'USER', scope: 'wander' }, 'test-secret', { expiresIn: '1h' });
      const { req, nextCalled } = runScoped972(token, 'GET', '/travel/trips/12/items');
      expect(nextCalled).toBe(true);
      expect(req.user).toMatchObject({ id: 'user-1', scope: 'wander' });
    });

    it('refuses a scope it does not know', () => {
      const token = jwt.sign({ id: 'user-1', role: 'USER', scope: 'everything' }, 'test-secret', { expiresIn: '1h' });
      const { res, nextCalled } = runScoped972(token, 'GET', '/travel/trips');
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(401);
    });
  });
  describe('minted tokens with a jti (THO-1016)', () => {
    const inAYear1016 = () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    const serviceTokenRow1016 = (over = {}) => ({
      user_id: 'sys-1', withdrawn_at: null, expires_at: inAYear1016(), ...over,
    });
    const mintedToken1016 = (jti, claims = {}) => jwt.sign(
      { id: 'sys-1', role: 'SYSTEM', jti, exp: Math.floor(inAYear1016().getTime() / 1000), ...claims },
      'test-secret',
    );

    // verifyJWT answers synchronously unless it reads a row; then it returns
    // the promise, which is awaited here.
    async function runMinted1016(token, method = 'GET', url = '/travel/trips/weather-pending') {
      const req = { method, originalUrl: url, headers: { authorization: `Bearer ${token}` } };
      const res = mockRes();
      let nextCalled = false;
      await verifyJWT(req, res, () => { nextCalled = true; });
      return { req, res, nextCalled };
    }

    it('accepts a login token, with exp and no jti, without reading the database', async () => {
      const { req, nextCalled } = await runMinted1016(jwt.sign({ id: 'user-1', role: 'USER' }, 'test-secret', { expiresIn: '8h' }));
      expect(nextCalled).toBe(true);
      expect(req.user).toMatchObject({ id: 'user-1' });
      expect(prisma1016.serviceToken.findUnique).not.toHaveBeenCalled();
    });

    it('accepts a minted token whose row is live, reading it by the jti', async () => {
      const jti = randomUUID();
      prisma1016.serviceToken.findUnique.mockResolvedValue(serviceTokenRow1016());
      const { req, nextCalled } = await runMinted1016(mintedToken1016(jti));
      expect(nextCalled).toBe(true);
      expect(req.user).toMatchObject({ id: 'sys-1', jti });
      expect(prisma1016.serviceToken.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: jti } }));
    });

    it('refuses a withdrawn token while the same account\'s other token keeps working', async () => {
      const withdrawn = randomUUID();
      const kept = randomUUID();
      prisma1016.serviceToken.findUnique.mockImplementation(async ({ where }) => (
        where.id === withdrawn ? serviceTokenRow1016({ withdrawn_at: new Date() }) : serviceTokenRow1016()
      ));
      const refused = await runMinted1016(mintedToken1016(withdrawn));
      expect(refused.nextCalled).toBe(false);
      expect(refused.res.statusCode).toBe(401);
      expect(refused.res.body).toEqual({ error: 'Invalid or expired token' });
      expect((await runMinted1016(mintedToken1016(kept))).nextCalled).toBe(true);
    });

    it('refuses a token whose row does not exist', async () => {
      prisma1016.serviceToken.findUnique.mockResolvedValue(null);
      const { res, nextCalled } = await runMinted1016(mintedToken1016(randomUUID()));
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid or expired token' });
    });

    it('refuses a token whose row belongs to another account', async () => {
      prisma1016.serviceToken.findUnique.mockResolvedValue(serviceTokenRow1016({ user_id: 'someone-else' }));
      const { res, nextCalled } = await runMinted1016(mintedToken1016(randomUUID()));
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(401);
    });

    it('refuses a token whose row has expired, even while the token\'s own exp has not', async () => {
      prisma1016.serviceToken.findUnique.mockResolvedValue(serviceTokenRow1016({ expires_at: new Date(Date.now() - 1000) }));
      const { res, nextCalled } = await runMinted1016(mintedToken1016(randomUUID()));
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(401);
    });

    it('refuses a jti that cannot be a row id without asking the database', async () => {
      for (const jti of ['not-a-uuid', 7, { not: null }, ['x']]) {
        const { res, nextCalled } = await runMinted1016(mintedToken1016(jti));
        expect(nextCalled).toBe(false);
        expect(res.statusCode).toBe(401);
      }
      expect(prisma1016.serviceToken.findUnique).not.toHaveBeenCalled();
    });

    it('answers 500, not 401, when the row cannot be read', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      prisma1016.serviceToken.findUnique.mockRejectedValue(new Error('connection refused'));
      const { res, nextCalled } = await runMinted1016(mintedToken1016(randomUUID()));
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(500);
    });

    it('answers 403 to a minted wander token outside its routes without reading its row', async () => {
      const token = mintedToken1016(randomUUID(), { id: 'user-1', role: 'USER', scope: 'wander' });
      const { res, nextCalled } = await runMinted1016(token, 'POST', '/users/email/request-change');
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(403);
      expect(prisma1016.serviceToken.findUnique).not.toHaveBeenCalled();
    });
  });
});
