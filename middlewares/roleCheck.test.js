import { describe, it, expect } from 'vitest';
import roleCheck from './roleCheck.js';

function mockRes() {
  const res = {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

describe('roleCheck middleware', () => {
  it('calls next() when the user has an allowed role', () => {
    const middleware = roleCheck(['ADMIN']);
    const req = { user: { role: 'ADMIN' } };
    const res = mockRes();
    let called = false;
    middleware(req, res, () => { called = true; });
    expect(called).toBe(true);
  });

  it('rejects with 403 when the role is not in the allow-list', () => {
    const middleware = roleCheck(['ADMIN']);
    const req = { user: { role: 'USER' } };
    const res = mockRes();
    middleware(req, res, () => { throw new Error('next should not be called'); });
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden: insufficient permissions' });
  });

  it('rejects when there is no authenticated user at all', () => {
    const middleware = roleCheck(['ADMIN']);
    const req = {};
    const res = mockRes();
    middleware(req, res, () => { throw new Error('next should not be called'); });
    expect(res.statusCode).toBe(403);
  });

  it('treats a user with no role as USER', () => {
    const middleware = roleCheck(['USER']);
    const req = { user: {} };
    const res = mockRes();
    let called = false;
    middleware(req, res, () => { called = true; });
    expect(called).toBe(true);
  });

  it('rejects everyone when the allow-list is empty', () => {
    const middleware = roleCheck([]);
    const req = { user: { role: 'ADMIN' } };
    const res = mockRes();
    middleware(req, res, () => { throw new Error('next should not be called'); });
    expect(res.statusCode).toBe(403);
  });
});
