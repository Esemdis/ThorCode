import { describe, it, expect, beforeAll } from 'vitest';
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

  describe('scoped and long-lived tokens (THO-972)', () => {
    // run() sets no method or URL, and the scope check reads both.
    function runScoped972(token, method, url) {
      const req = { method, originalUrl: url, headers: { authorization: `Bearer ${token}` } };
      const res = mockRes();
      let nextCalled = false;
      verifyJWT(req, res, () => { nextCalled = true; });
      return { req, res, nextCalled };
    }

    // scripts/generate-service-token.js signs without expiresIn, and both
    // python-crohn and wander hold such a token. Pinned so a change here that
    // starts requiring `exp` cannot cut them off in silence.
    it('accepts a token minted without exp, which python-crohn and wander hold', () => {
      const token = jwt.sign({ id: 'sys-1', role: 'SYSTEM' }, 'test-secret');
      expect(jwt.decode(token).exp).toBeUndefined();
      const { req, nextCalled } = runScoped972(token, 'GET', '/travel/trips/weather-pending');
      expect(nextCalled).toBe(true);
      expect(req.user).toMatchObject({ id: 'sys-1', role: 'SYSTEM' });
    });

    it('answers 403 to a wander-scoped token outside its routes', () => {
      const token = jwt.sign({ id: 'user-1', role: 'USER', scope: 'wander' }, 'test-secret');
      const { req, res, nextCalled } = runScoped972(token, 'POST', '/users/email/request-change');
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(403);
      expect(req.user).toBeUndefined();
    });

    it('lets a wander-scoped token read a trip', () => {
      const token = jwt.sign({ id: 'user-1', role: 'USER', scope: 'wander' }, 'test-secret');
      const { req, nextCalled } = runScoped972(token, 'GET', '/travel/trips/12/items');
      expect(nextCalled).toBe(true);
      expect(req.user).toMatchObject({ id: 'user-1', scope: 'wander' });
    });

    it('refuses a scope it does not know', () => {
      const token = jwt.sign({ id: 'user-1', role: 'USER', scope: 'everything' }, 'test-secret');
      const { res, nextCalled } = runScoped972(token, 'GET', '/travel/trips');
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(401);
    });
  });
});
