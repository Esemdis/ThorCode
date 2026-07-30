import { describe, it, expect, beforeAll } from 'vitest';
import jwt from 'jsonwebtoken';
import signJWT from './signJWT.js';

describe('signJWT', () => {
  beforeAll(() => { process.env.JWT_SECRET = 'test-secret'; });

  it('signs a token carrying the user id, email, and role', () => {
    const token = signJWT({ user: { id: 42, email: 'a@b.com', role: 'ADMIN' } });
    const decoded = jwt.verify(token, 'test-secret');
    expect(decoded).toMatchObject({ id: 42, email: 'a@b.com', role: 'ADMIN' });
  });

  it('sets an 8 hour expiry', () => {
    const token = signJWT({ user: { id: 1, email: 'a@b.com', role: 'USER' } });
    const decoded = jwt.verify(token, 'test-secret');
    expect(decoded.exp - decoded.iat).toBe(8 * 60 * 60);
  });

  it('cannot be verified against the wrong secret', () => {
    const token = signJWT({ user: { id: 1, email: 'a@b.com', role: 'USER' } });
    expect(() => jwt.verify(token, 'wrong-secret')).toThrow();
  });
});
