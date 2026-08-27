import { describe, it, expect } from 'vitest';
import { generateCalendarToken, feedUrl, TOKEN_LENGTH } from './calendarToken.js';

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
