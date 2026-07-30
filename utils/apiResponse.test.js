import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  success, error, badRequest, unauthorized, forbidden, notFound, conflict, serverError,
  fail, paginate, sendList, RECORD_NOT_FOUND,
} from './apiResponse.js';

function mockRes() {
  const res = {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.set = (name, value) => { res.headers = { ...res.headers, [name]: value }; return res; };
  return res;
}

describe('success', () => {
  it('wraps data with a 200 by default', () => {
    const res = mockRes();
    success(res, undefined, { id: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: { id: 1 } });
  });

  it('includes a message only when one is given', () => {
    const res = mockRes();
    success(res, 201, { id: 1 }, 'created');
    expect(res.body).toEqual({ success: true, data: { id: 1 }, message: 'created' });
  });
});

describe('error and its shorthands', () => {
  it('error() sends the given status and message', () => {
    const res = mockRes();
    error(res, 418, "I'm a teapot");
    expect(res.statusCode).toBe(418);
    expect(res.body).toEqual({ success: false, error: "I'm a teapot" });
  });

  it.each([
    [badRequest, 400],
    [unauthorized, 401],
    [forbidden, 403],
    [notFound, 404],
    [conflict, 409],
    [serverError, 500],
  ])('%o sends status %i', (fn, status) => {
    const res = mockRes();
    fn(res, 'custom message');
    expect(res.statusCode).toBe(status);
    expect(res.body.error).toBe('custom message');
  });

  it('unauthorized/forbidden/notFound/serverError fall back to a default message', () => {
    expect(mockAndCall(unauthorized).body.error).toBe('Unauthorized');
    expect(mockAndCall(forbidden).body.error).toBe('Forbidden');
    expect(mockAndCall(notFound).body.error).toBe('Not found');
    expect(mockAndCall(serverError).body.error).toBe('Internal server error');
  });

  function mockAndCall(fn) {
    const res = mockRes();
    fn(res);
    return res;
  }
});

describe('fail', () => {
  const originalEnv = process.env.NODE_ENV;
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { process.env.NODE_ENV = originalEnv; vi.restoreAllMocks(); });

  it('maps a Prisma "record not found" error to a 404 when notFound is given', () => {
    process.env.NODE_ENV = 'production';
    const res = mockRes();
    fail(res, { code: RECORD_NOT_FOUND, message: 'internal detail' }, { notFound: 'Trip not found' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Trip not found' });
  });

  it('hides the underlying error message in production', () => {
    process.env.NODE_ENV = 'production';
    const res = mockRes();
    fail(res, new Error('column "foo" does not exist'));
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Something went wrong');
  });

  it('surfaces the underlying error message outside production', () => {
    process.env.NODE_ENV = 'development';
    const res = mockRes();
    fail(res, new Error('column "foo" does not exist'));
    expect(res.body.error).toBe('column "foo" does not exist');
  });

  it('a P2025 without a notFound option still falls through to serverError', () => {
    process.env.NODE_ENV = 'development';
    const res = mockRes();
    fail(res, { code: RECORD_NOT_FOUND, message: 'no rows' });
    expect(res.statusCode).toBe(500);
  });
});

describe('paginate', () => {
  it('applies defaults when nothing is given', () => {
    expect(paginate({ query: {} })).toEqual({ take: 100, skip: 0 });
  });

  it('clamps limit to maxLimit and never goes below 1', () => {
    expect(paginate({ query: { limit: '9999' } })).toEqual({ take: 500, skip: 0 });
    expect(paginate({ query: { limit: '0' } })).toEqual({ take: 1, skip: 0 });
    expect(paginate({ query: { limit: '-50' } })).toEqual({ take: 1, skip: 0 });
  });

  it('never lets offset go negative', () => {
    expect(paginate({ query: { offset: '-10' } })).toEqual({ take: 100, skip: 0 });
  });

  it('falls back to defaults for unparseable input rather than erroring', () => {
    expect(paginate({ query: { limit: 'abc', offset: 'xyz' } })).toEqual({ take: 100, skip: 0 });
  });

  it('honors custom defaultLimit/maxLimit', () => {
    expect(paginate({ query: {} }, { defaultLimit: 20, maxLimit: 50 })).toEqual({ take: 20, skip: 0 });
    expect(paginate({ query: { limit: '999' } }, { defaultLimit: 20, maxLimit: 50 })).toEqual({ take: 50, skip: 0 });
  });
});

describe('sendList', () => {
  it('sets X-Total-Count and reports has_more when more rows remain', () => {
    const res = mockRes();
    sendList(res, [{ id: 1 }, { id: 2 }], { total: 10, take: 2, skip: 0 });
    expect(res.headers['X-Total-Count']).toBe('10');
    expect(res.body).toEqual({
      success: true,
      data: [{ id: 1 }, { id: 2 }],
      meta: { total: 10, limit: 2, offset: 0, has_more: true },
    });
  });

  it('has_more is false once the page reaches the end', () => {
    const res = mockRes();
    sendList(res, [{ id: 9 }, { id: 10 }], { total: 10, take: 2, skip: 8 });
    expect(res.body.meta.has_more).toBe(false);
  });
});
