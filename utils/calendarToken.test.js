import { describe, it, expect } from 'vitest';
import { generateCalendarToken, feedUrl, isPubliclyReachable, TOKEN_LENGTH } from './calendarToken.js';

describe('generateCalendarToken', () => {
  it('is long enough that it cannot be guessed', () => {
    // The token is the only thing protecting the feed — there is no session
    // behind it — so it has to stand on entropy alone.
    expect(generateCalendarToken()).toHaveLength(TOKEN_LENGTH);
    expect(TOKEN_LENGTH).toBeGreaterThanOrEqual(32);
  });

  it('uses only characters that survive a URL unencoded', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateCalendarToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('never hands out the same token twice', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateCalendarToken()));
    expect(seen.size).toBe(500);
  });
});

describe('feedUrl', () => {
  it('builds an absolute URL the calendar client can fetch', () => {
    expect(feedUrl('https://api.example.com', 'abc123'))
      .toBe('https://api.example.com/data/concerts/calendar/feed/abc123/going.ics');
  });

  it('does not double the slash when the base URL has a trailing one', () => {
    expect(feedUrl('https://api.example.com/', 'abc123'))
      .toBe('https://api.example.com/data/concerts/calendar/feed/abc123/going.ics');
  });

  it('refuses to build a URL with no base configured', () => {
    // Guessing the host from the request would put a localhost URL in someone's
    // calendar, which then silently never updates.
    expect(() => feedUrl('', 'abc123')).toThrow();
    expect(() => feedUrl(undefined, 'abc123')).toThrow();
  });
});

describe('isPubliclyReachable', () => {
  it('rejects an address only this machine can resolve', () => {
    // A calendar feed is fetched by Google's servers, not by the browser, so a
    // loopback or LAN address resolves to *their* machine and the subscription
    // silently never populates. Handing one over without saying so is the
    // failure this exists to prevent.
    expect(isPubliclyReachable('http://127.0.0.1:4000')).toBe(false);
    expect(isPubliclyReachable('http://localhost:3000')).toBe(false);
    expect(isPubliclyReachable('http://[::1]:4000')).toBe(false);
  });

  it('rejects a private network address', () => {
    expect(isPubliclyReachable('http://192.168.1.64:4000')).toBe(false);
    expect(isPubliclyReachable('http://10.0.0.5')).toBe(false);
    expect(isPubliclyReachable('http://172.16.4.1')).toBe(false);
    expect(isPubliclyReachable('http://unraid.local:4000')).toBe(false);
  });

  it('accepts a public hostname', () => {
    expect(isPubliclyReachable('https://api.thorcode.dev')).toBe(true);
    expect(isPubliclyReachable('https://api.thorcode.dev/')).toBe(true);
  });

  it('treats an address it cannot parse as not reachable', () => {
    // Erring towards a warning is the safe direction: a needless warning is
    // annoying, a missing one costs the user a subscription that never works.
    expect(isPubliclyReachable('')).toBe(false);
    expect(isPubliclyReachable(undefined)).toBe(false);
    expect(isPubliclyReachable('not a url')).toBe(false);
  });

  it('does not mistake a public host for private on a similar-looking number', () => {
    // 172.32 is outside the private 172.16–31 range, and 10.x only counts as
    // the first octet.
    expect(isPubliclyReachable('http://172.32.0.1')).toBe(true);
    expect(isPubliclyReachable('http://8.10.0.5')).toBe(true);
  });
});
