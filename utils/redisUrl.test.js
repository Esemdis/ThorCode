import { describe, it, expect } from 'vitest';
import { resolveRedisUrl } from './redisUrl.js';

const TOKEN = 'AX0bASQgN2E1';

describe('resolveRedisUrl', () => {
  it('uses REDIS_URL when it is set', () => {
    expect(resolveRedisUrl({ REDIS_URL: 'rediss://user:pw@example.upstash.io:6379' }))
      .toBe('rediss://user:pw@example.upstash.io:6379');
  });

  // The Upstash console hands out the REST pair, so that is what ends up in
  // Doppler; the TCP url has to be built from it. Getting only the REST pair is
  // the normal case, not a misconfiguration.
  it('builds a TLS url from the Upstash REST pair when REDIS_URL is absent', () => {
    expect(resolveRedisUrl({
      UPSTASH_REDIS_REST_URL: 'https://comic-urchin-242605.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: TOKEN,
    })).toBe(`rediss://default:${TOKEN}@comic-urchin-242605.upstash.io:6379`);
  });

  it('tolerates a REST url with a trailing slash or no scheme', () => {
    const expected = `rediss://default:${TOKEN}@host.upstash.io:6379`;
    expect(resolveRedisUrl({ UPSTASH_REDIS_REST_URL: 'https://host.upstash.io/', UPSTASH_REDIS_REST_TOKEN: TOKEN })).toBe(expected);
    expect(resolveRedisUrl({ UPSTASH_REDIS_REST_URL: 'host.upstash.io', UPSTASH_REDIS_REST_TOKEN: TOKEN })).toBe(expected);
  });

  it('prefers an explicit REDIS_URL over the REST pair', () => {
    expect(resolveRedisUrl({
      REDIS_URL: 'redis://localhost:6379',
      UPSTASH_REDIS_REST_URL: 'https://host.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: TOKEN,
    })).toBe('redis://localhost:6379');
  });

  // Returning null rather than undefined matters: `new Redis(undefined)` quietly
  // connects to localhost:6379, so a wholly unconfigured cache looked exactly
  // like an empty one. The caller checks for null and says so out loud.
  it('returns null when nothing is configured, rather than a url', () => {
    expect(resolveRedisUrl({})).toBeNull();
    expect(resolveRedisUrl({ UPSTASH_REDIS_REST_URL: 'https://host.upstash.io' })).toBeNull();
    expect(resolveRedisUrl({ UPSTASH_REDIS_REST_TOKEN: TOKEN })).toBeNull();
  });
});
