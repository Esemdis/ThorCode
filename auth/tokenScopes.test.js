import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  tokenScopeVerdict, serviceTokenClaims, parseMintArgs, serviceTokenExpiry, WANDER_TOKEN_SCOPE,
} from './tokenScopes.js';

const wander972 = { id: 'user-1', role: 'USER', scope: WANDER_TOKEN_SCOPE };

describe('tokenScopeVerdict (THO-972)', () => {
  it.each([
    ['GET', '/travel/trips'],
    ['POST', '/travel/trips'],
    ['GET', '/travel/trips/5'],
    ['GET', '/travel/trips/5/items'],
    ['GET', '/travel/trips/5/todos'],
    ['GET', '/data/concerts/nearby'],
    ['GET', '/data/concerts/nearby?lat=1&lon=2&from=2026-11-01&to=2026-11-05'],
    ['GET', '/travel/trips/?page=2'],
    ['GET', '/travel/trips/5/items/'],
    // Express matches paths case-insensitively, so these reach the same handlers.
    ['GET', '/Travel/Trips/5/Todos'],
    ['get', '/travel/trips'],
  ])('lets a wander token make wander\'s own call %s %s', (method, url) => {
    expect(tokenScopeVerdict(wander972, method, url)).toBe('allow');
  });

  it.each([
    ['POST', '/users/email/request-change'],
    ['POST', '/users/email/verify-code'],
    ['PATCH', '/users/me/password'],
    ['DELETE', '/users/me'],
    ['GET', '/users/me'],
    ['PATCH', '/travel/trips/5'],
    ['DELETE', '/travel/trips/5'],
    ['POST', '/travel/trips/5/duplicate'],
    ['POST', '/travel/trips/5/items'],
    ['PATCH', '/travel/trips/5/todos/3'],
    // A word under /travel/trips is a different route, SYSTEM-only today.
    ['GET', '/travel/trips/weather-pending'],
    ['GET', '/travel/gear'],
    ['GET', '/data/concerts'],
    // HEAD reaches GET handlers in Express, but wander never sends it.
    ['HEAD', '/travel/trips'],
    // Odd spellings are refused rather than normalised.
    ['GET', '//travel/trips'],
    ['GET', '/travel/trips/5/items/../../../../users/me'],
    ['GET', '/travel/trips%2F5'],
    ['GET', '/users/me?next=/travel/trips'],
  ])('refuses a wander token on %s %s', (method, url) => {
    expect(tokenScopeVerdict(wander972, method, url)).toBe('forbidden');
  });

  it('lets a token without a scope through anywhere, as every login and python-crohn token has none', () => {
    expect(tokenScopeVerdict({ id: 'user-1', role: 'USER' }, 'PATCH', '/users/me/password')).toBe('allow');
    expect(tokenScopeVerdict({ id: 'sys', role: 'SYSTEM' }, 'GET', '/travel/trips/weather-pending')).toBe('allow');
  });

  it('fails closed on a scope it does not know, including ones that look like object keys', () => {
    for (const scope of ['admin', 'WANDER', '', null, 'constructor', '__proto__', ['wander'], { wander: true }]) {
      expect(tokenScopeVerdict({ id: 'user-1', role: 'USER', scope }, 'GET', '/travel/trips')).toBe('unknown');
    }
  });
});

describe('serviceTokenClaims (THO-972)', () => {
  const userFor972 = (role) => ({ id: 'u-1', email: 'a@example.com', role });
  // Every minted token carries these since THO-1016.
  const lifetime1016 = { jti: '3f2b8c1e-9d4a-4e6b-8a7c-1b2c3d4e5f60', expiresAt: new Date('2027-11-25T12:00:00.750Z') };
  const lifetimeClaims1016 = { jti: lifetime1016.jti, exp: Math.floor(Date.UTC(2027, 10, 25, 12) / 1000) };

  it('mints a wander token as a USER with the wander scope', () => {
    expect(serviceTokenClaims(userFor972('USER'), { wander: true, ...lifetime1016 }))
      .toEqual({ id: 'u-1', email: 'a@example.com', role: 'USER', scope: 'wander', ...lifetimeClaims1016 });
  });

  it('refuses a wander token for an ADMIN or SYSTEM account, whose role would outlive a demotion', () => {
    expect(() => serviceTokenClaims(userFor972('ADMIN'), { wander: true, ...lifetime1016 })).toThrow(/USER/);
    expect(() => serviceTokenClaims(userFor972('SYSTEM'), { wander: true, ...lifetime1016 })).toThrow(/USER/);
  });

  it('mints an unflagged token with the account\'s role and no dead service claim', () => {
    expect(serviceTokenClaims(userFor972('SYSTEM'), lifetime1016))
      .toEqual({ id: 'u-1', email: 'a@example.com', role: 'SYSTEM', ...lifetimeClaims1016 });
  });

  // THO-1016: verifyJWT refuses a token with neither, so signing one would
  // hand out a token that never works.
  it('refuses to make claims without a jti or an expiry', () => {
    expect(() => serviceTokenClaims(userFor972('SYSTEM'))).toThrow(/ServiceToken/);
    expect(() => serviceTokenClaims(userFor972('SYSTEM'), { jti: lifetime1016.jti })).toThrow(/expiry/);
    expect(() => serviceTokenClaims(userFor972('SYSTEM'), { jti: lifetime1016.jti, expiresAt: new Date('nope') })).toThrow(/expiry/);
  });

  it('puts exp in whole seconds, never after the row\'s expiry', () => {
    const { exp } = serviceTokenClaims(userFor972('SYSTEM'), lifetime1016);
    expect(Number.isInteger(exp)).toBe(true);
    expect(exp * 1000).toBeLessThanOrEqual(lifetime1016.expiresAt.getTime());
  });
});

describe('parseMintArgs (THO-1016)', () => {
  it('defaults to a 365-day full-session token', () => {
    expect(parseMintArgs(['Sync@Example.test'])).toEqual({ wander: false, days: 365, email: 'sync@example.test' });
  });

  it('reads --wander and --days in any order, in both spellings', () => {
    expect(parseMintArgs(['--days', '90', '--wander', 'me@example.test'])).toEqual({ wander: true, days: 90, email: 'me@example.test' });
    expect(parseMintArgs(['me@example.test', '--days=30'])).toEqual({ wander: false, days: 30, email: 'me@example.test' });
  });

  it.each([['0'], ['-3'], ['1.5'], ['abc'], ['1e3'], ['3651'], ['']])('refuses --days %s', (value) => {
    expect(parseMintArgs(['--days', value, 'me@example.test']).error).toMatch(/--days/);
  });

  it('refuses --days with no value, rather than taking the email for one', () => {
    expect(parseMintArgs(['me@example.test', '--days']).error).toMatch(/--days/);
    expect(parseMintArgs(['--days', 'me@example.test']).error).toMatch(/--days/);
  });

  it('refuses no email, two emails and an unknown option', () => {
    expect(parseMintArgs([]).error).toBeTruthy();
    expect(parseMintArgs(['a@example.test', 'b@example.test']).error).toBeTruthy();
    expect(parseMintArgs(['--forever', 'a@example.test']).error).toMatch(/--forever/);
  });
});

describe('serviceTokenExpiry (THO-1016)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('is the given number of days from now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
    expect(serviceTokenExpiry(365).toISOString()).toBe('2027-11-25T12:00:00.000Z');
    expect(serviceTokenExpiry(1).toISOString()).toBe('2026-11-26T12:00:00.000Z');
  });
});
