import { describe, it, expect, beforeAll } from 'vitest';
import jwt from 'jsonwebtoken';
import verifyJWT from './verifyJWT.js';

function mockRes() {
  const res = {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
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
    const req = { headers: { authorization: 'Bearer not-a-real-token' } };
    const res = mockRes();
    verifyJWT(req, res, () => { throw new Error('next should not be called'); });
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid or expired token' });
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign({ id: 1 }, 'test-secret', { expiresIn: -10 });
    const req = { headers: { authorization: `Bearer ${expired}` } };
    const res = mockRes();
    verifyJWT(req, res, () => { throw new Error('next should not be called'); });
    expect(res.statusCode).toBe(401);
  });

  it('attaches the decoded payload to req.user and calls next() for a valid token', () => {
    const token = jwt.sign({ id: 7, role: 'USER' }, 'test-secret');
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    let nextCalled = false;
    verifyJWT(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(req.user).toMatchObject({ id: 7, role: 'USER' });
  });
});
