import { describe, it, expect } from 'vitest';
import { tokenScopeVerdict, serviceTokenClaims, WANDER_TOKEN_SCOPE } from './tokenScopes.js';

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

  it('mints a wander token as a USER with the wander scope', () => {
    expect(serviceTokenClaims(userFor972('USER'), { wander: true }))
      .toEqual({ id: 'u-1', email: 'a@example.com', role: 'USER', scope: 'wander' });
  });

  it('refuses a wander token for an ADMIN or SYSTEM account, whose role would outlive a demotion', () => {
    expect(() => serviceTokenClaims(userFor972('ADMIN'), { wander: true })).toThrow(/USER/);
    expect(() => serviceTokenClaims(userFor972('SYSTEM'), { wander: true })).toThrow(/USER/);
  });

  it('mints an unflagged token with the account\'s role and no dead service claim', () => {
    expect(serviceTokenClaims(userFor972('SYSTEM'))).toEqual({ id: 'u-1', email: 'a@example.com', role: 'SYSTEM' });
  });
});
