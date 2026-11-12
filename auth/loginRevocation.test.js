import { describe, it, expect, vi } from 'vitest';
import {
  isLoginToken,
  passwordChangeStamp,
  loginStateRefusal,
  createPasswordChangeCache,
  ACCOUNT_GONE,
} from './loginRevocation.js';

describe('isLoginToken (THO-898)', () => {
  it('is true only for what signJWT marks as a login', () => {
    expect(isLoginToken({ id: 'u', role: 'USER', kind: 'login' })).toBe(true);
  });

  // The two integrations a reset must not cut off: python-crohn's token from
  // generate-service-token.js, and the hand-minted USER token wander stores,
  // which has neither an expiry nor a `service` claim.
  it('is false for a service token and for a hand-minted long-lived one', () => {
    expect(isLoginToken({ id: 'u', role: 'SYSTEM', service: 'rss-watcher' })).toBe(false);
    expect(isLoginToken({ id: 'u', role: 'USER' })).toBe(false);
    expect(isLoginToken(null)).toBe(false);
  });
});

describe('passwordChangeStamp (THO-898)', () => {
  it('is the change time in milliseconds', () => {
    expect(passwordChangeStamp(new Date('2026-11-11T12:00:10.700Z'))).toBe(Date.parse('2026-11-11T12:00:10.700Z'));
  });

  it('is 0 for an account whose password never changed', () => {
    expect(passwordChangeStamp(null)).toBe(0);
    expect(passwordChangeStamp(undefined)).toBe(0);
  });
});

describe('loginStateRefusal (THO-898)', () => {
  const loginStateChangedAt = new Date('2026-11-11T12:00:10.700Z');

  it('lets through a token signed against the current password', () => {
    expect(loginStateRefusal({ pwc: loginStateChangedAt.getTime() }, loginStateChangedAt)).toBeNull();
    expect(loginStateRefusal({ pwc: 0 }, null)).toBeNull();
  });

  // Not compared by the clock. A login that read the row before a reset and
  // signed after it, or one an attacker timed into the reset's own second,
  // was issued "after" the change by iat and still carried the old password.
  it('refuses a token signed against an earlier password, whenever it was issued', () => {
    expect(loginStateRefusal({ pwc: 0, iat: 9_999_999_999 }, loginStateChangedAt)).toMatch(/password was changed/);
    expect(loginStateRefusal({ pwc: loginStateChangedAt.getTime() - 1 }, loginStateChangedAt)).toMatch(/password was changed/);
  });

  it('refuses a login token that carries no password state', () => {
    expect(loginStateRefusal({}, null)).toMatch(/password was changed/);
  });

  it('refuses a token for an account that no longer exists', () => {
    expect(loginStateRefusal({ pwc: 0 }, ACCOUNT_GONE)).toMatch(/no longer exists/);
  });
});

describe('createPasswordChangeCache (THO-898)', () => {
  const changedAt = new Date('2026-11-11T12:00:00Z');

  it('reads a user once a minute, not once a request', async () => {
    let clock = 0;
    const read = vi.fn(async () => ({ password_changed_at: changedAt }));
    const cache = createPasswordChangeCache({ read, now: () => clock });

    expect(await cache.get('u1')).toBe(changedAt);
    clock = 59_999;
    await cache.get('u1');
    expect(read).toHaveBeenCalledTimes(1);

    clock = 60_000;
    await cache.get('u1');
    expect(read).toHaveBeenCalledTimes(2);
  });

  // A deleted account's login tokens are refused (owner decision on THO-898),
  // so a missing row is remembered as gone, not as "never changed".
  it('reads a missing account as gone', async () => {
    const cache = createPasswordChangeCache({ read: vi.fn(async () => null) });
    expect(await cache.get('gone')).toBe(ACCOUNT_GONE);
  });

  it('reads again straight after forget', async () => {
    const read = vi.fn(async () => ({ password_changed_at: null }));
    const cache = createPasswordChangeCache({ read });

    await cache.get('u2');
    read.mockImplementation(async () => ({ password_changed_at: changedAt }));
    cache.forget('u2');

    expect(await cache.get('u2')).toBe(changedAt);
    expect(read).toHaveBeenCalledTimes(2);
  });

  // A request that read the row just before a reset, and finished just after
  // it, would put the old "never changed" back in the cache the reset had just
  // cleared, and the ended session would work for another minute.
  it('does not keep a read that a forget overtook', async () => {
    let finishStaleRead;
    const read = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishStaleRead = resolve; }))
      .mockImplementation(async () => ({ password_changed_at: changedAt }));
    const cache = createPasswordChangeCache({ read });

    const stale = cache.get('u3');
    cache.forget('u3');
    finishStaleRead({ password_changed_at: null });
    expect(await stale).toBeNull();

    expect(await cache.get('u3')).toBe(changedAt);
  });
});
