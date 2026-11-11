import { describe, it, expect, vi } from 'vitest';
import {
  isLoginToken,
  issuedBeforePasswordChange,
  createPasswordChangeCache,
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

describe('issuedBeforePasswordChange (THO-898)', () => {
  const changedAt = new Date('2026-11-11T12:00:10.700Z');
  const changedSecond = Math.floor(changedAt.getTime() / 1000);

  it('ends nothing for an account whose password never changed', () => {
    expect(issuedBeforePasswordChange(0, null)).toBe(false);
  });

  it('refuses a token issued in an earlier second', () => {
    expect(issuedBeforePasswordChange(changedSecond - 1, changedAt)).toBe(true);
  });

  it('accepts a token issued later', () => {
    expect(issuedBeforePasswordChange(changedSecond + 1, changedAt)).toBe(false);
  });

  // The token the change hands back is signed a moment after it, in the same
  // second, and iat holds whole seconds. Compared in milliseconds it read as
  // issued 700 ms before the change and was refused on its first use.
  it('accepts a token issued in the same second as the change', () => {
    expect(issuedBeforePasswordChange(changedSecond, changedAt)).toBe(false);
  });

  it('refuses a login token with no iat once the password has changed', () => {
    expect(issuedBeforePasswordChange(undefined, changedAt)).toBe(true);
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

  // A deleted account's sessions are left to expire (owner decision on
  // THO-810), and the integration tests sign login tokens for ids they never
  // create, so a missing row must read as "never changed", not as a refusal.
  it('reads a missing account as one whose password never changed', async () => {
    const cache = createPasswordChangeCache({ read: vi.fn(async () => null) });
    expect(await cache.get('gone')).toBeNull();
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
