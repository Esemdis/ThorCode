import { describe, it, expect } from 'vitest';
import { retryDelayMs, MAX_RETRY_WAIT_MS } from './spotifyRetry.js';

describe('retryDelayMs', () => {
  it('waits the number of seconds Spotify asked for', () => {
    expect(retryDelayMs('5')).toBe(5000);
  });

  it('falls back to a short wait when the header is missing or unparseable', () => {
    expect(retryDelayMs(undefined)).toBe(2000);
    expect(retryDelayMs('soon')).toBe(2000);
  });

  // A tripped Spotify limit answers Retry-After: 23982 — nearly seven hours.
  // Honouring that literally parks the Express handler holding the request for
  // the rest of the afternoon, which is how a rate limit turned into an outage.
  // Past the cap it is the caller's job to give up, not to sleep.
  it('refuses to sleep for hours when the limit is badly tripped', () => {
    expect(retryDelayMs('23982')).toBeNull();
    expect(MAX_RETRY_WAIT_MS).toBeLessThanOrEqual(60000);
  });

  it('still waits when the delay is at the cap', () => {
    expect(retryDelayMs(String(MAX_RETRY_WAIT_MS / 1000))).toBe(MAX_RETRY_WAIT_MS);
  });
});
