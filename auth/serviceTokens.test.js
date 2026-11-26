import { describe, it, expect, vi } from 'vitest';
import {
  SERVICE_TOKEN_CACHE_MS,
  isServiceTokenId,
  tokenLifetimeVerdict,
  serviceTokenRefusal,
  createServiceTokenCache,
} from './serviceTokens.js';

const JTI_1016 = '3f2b8c1e-9d4a-4e6b-8a7c-1b2c3d4e5f60';

describe('tokenLifetimeVerdict (THO-1016)', () => {
  it('looks up a token with a jti, whether or not it also has exp', () => {
    expect(tokenLifetimeVerdict({ jti: JTI_1016, exp: 2_000_000_000 })).toBe('lookup');
    expect(tokenLifetimeVerdict({ jti: JTI_1016 })).toBe('lookup');
  });

  it('lets a login token, exp and no jti, through without a lookup', () => {
    expect(tokenLifetimeVerdict({ id: 'u', exp: 2_000_000_000 })).toBe('ok');
  });

  it('refuses a token with neither, as every token minted before THO-1016 is', () => {
    expect(tokenLifetimeVerdict({ id: 'u', role: 'SYSTEM' })).toBe('refuse');
  });

  it('refuses a jti that cannot be a row id rather than querying with it', () => {
    // An object would reach Prisma's `where` as a filter, not an id.
    for (const jti of ['', 'abc', 7, null, { equals: JTI_1016 }, [JTI_1016], `${JTI_1016} `]) {
      expect(tokenLifetimeVerdict({ jti, exp: 2_000_000_000 })).toBe('refuse');
    }
  });

  it('knows a uuid in either case as an id', () => {
    expect(isServiceTokenId(JTI_1016.toUpperCase())).toBe(true);
  });
});

describe('serviceTokenRefusal (THO-1016)', () => {
  const now1016 = Date.UTC(2026, 10, 25, 12);
  const liveRow1016 = { user_id: 'u-1', withdrawn_at: null, expires_at: new Date(now1016 + 1000) };
  const decoded1016 = { id: 'u-1', jti: JTI_1016 };

  it('accepts a live row for the same account', () => {
    expect(serviceTokenRefusal(decoded1016, liveRow1016, now1016)).toBe(null);
  });

  it('refuses no row, another account\'s row, a withdrawn row and an expired one', () => {
    expect(serviceTokenRefusal(decoded1016, null, now1016)).toBeTruthy();
    expect(serviceTokenRefusal(decoded1016, { ...liveRow1016, user_id: 'u-2' }, now1016)).toBeTruthy();
    expect(serviceTokenRefusal(decoded1016, { ...liveRow1016, withdrawn_at: new Date(now1016 - 1) }, now1016)).toBeTruthy();
    expect(serviceTokenRefusal(decoded1016, { ...liveRow1016, expires_at: new Date(now1016) }, now1016)).toBeTruthy();
  });
});

describe('createServiceTokenCache (THO-1016)', () => {
  function cacheAt1016(read) {
    let t = 1_000_000;
    const cache = createServiceTokenCache({ read, now: () => t });
    return { cache, advance: (ms) => { t += ms; } };
  }

  it('reads a row once within 60 s', async () => {
    const read = vi.fn(async () => ({ user_id: 'u-1' }));
    const { cache, advance } = cacheAt1016(read);
    await cache.get(JTI_1016);
    advance(SERVICE_TOKEN_CACHE_MS - 1);
    expect(await cache.get(JTI_1016)).toEqual({ user_id: 'u-1' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reads it again once 60 s have passed, which is how a withdrawal arrives', async () => {
    const read = vi.fn(async () => ({ user_id: 'u-1', withdrawn_at: null }));
    const { cache, advance } = cacheAt1016(read);
    await cache.get(JTI_1016);
    read.mockImplementation(async () => ({ user_id: 'u-1', withdrawn_at: new Date() }));
    advance(SERVICE_TOKEN_CACHE_MS);
    expect((await cache.get(JTI_1016)).withdrawn_at).toBeInstanceOf(Date);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('caches a missing row too, so a made-up jti costs one read a minute', async () => {
    const read = vi.fn(async () => null);
    const { cache } = cacheAt1016(read);
    expect(await cache.get(JTI_1016)).toBe(null);
    expect(await cache.get(JTI_1016)).toBe(null);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('does not cache a read that failed, so the next request asks again', async () => {
    const read = vi.fn(async () => { throw new Error('down'); });
    const { cache } = cacheAt1016(read);
    await expect(cache.get(JTI_1016)).rejects.toThrow('down');
    read.mockImplementation(async () => ({ user_id: 'u-1' }));
    expect(await cache.get(JTI_1016)).toEqual({ user_id: 'u-1' });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps one entry per jti', async () => {
    const read = vi.fn(async (jti) => ({ user_id: jti }));
    const { cache } = cacheAt1016(read);
    await cache.get('a');
    expect(await cache.get('b')).toEqual({ user_id: 'b' });
    expect(read).toHaveBeenCalledTimes(2);
  });
});
