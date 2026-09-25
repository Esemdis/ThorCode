import { describe, it, expect } from 'vitest';
import { generateShareToken, shareUrl, shareExpiry, isActiveShareLink, TTL_MS } from './mediaShareToken.js';

describe('generateShareToken', () => {
  it('is long enough that it cannot be guessed', () => {
    expect(generateShareToken()).toHaveLength(32);
  });

  it('uses only characters that survive a URL unencoded', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateShareToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('never hands out the same token twice', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateShareToken()));
    expect(seen.size).toBe(500);
  });
});

describe('shareUrl', () => {
  it('builds an absolute URL a browser can open', () => {
    expect(shareUrl('https://api.example.com', 'abc123'))
      .toBe('https://api.example.com/data/concerts/media/share/abc123');
  });

  it('does not double the slash when the base URL has a trailing one', () => {
    expect(shareUrl('https://api.example.com/', 'abc123'))
      .toBe('https://api.example.com/data/concerts/media/share/abc123');
  });

  it('refuses to build a URL with no base configured', () => {
    expect(() => shareUrl('', 'abc123')).toThrow();
    expect(() => shareUrl(undefined, 'abc123')).toThrow();
  });

  it('refuses a base URL that is not absolute', () => {
    // Otherwise the browser resolves it against its own origin and the link
    // silently points at the frontend instead of the API.
    expect(() => shareUrl('api.example.com', 'abc123')).toThrow(/not absolute/);
  });

  it('refuses a base URL that is not http or https', () => {
    expect(() => shareUrl('ftp://api.example.com', 'abc123')).toThrow(/http or https/);
  });
});

describe('shareExpiry', () => {
  it('is exactly 12 hours after the given time', () => {
    const now = new Date('2026-06-12T12:00:00Z');
    expect(shareExpiry(now)).toEqual(new Date('2026-06-13T00:00:00Z'));
    expect(TTL_MS).toBe(12 * 60 * 60 * 1000);
  });
});

describe('isActiveShareLink', () => {
  const now = new Date('2026-06-12T12:00:00Z');

  it('is true for a link that is neither revoked nor expired', () => {
    expect(isActiveShareLink({ revoked_at: null, expires_at: new Date('2026-06-12T18:00:00Z') }, now))
      .toBe(true);
  });

  it('is false once revoked, even if not yet expired', () => {
    expect(isActiveShareLink({
      revoked_at: new Date('2026-06-12T10:00:00Z'),
      expires_at: new Date('2026-06-12T18:00:00Z'),
    }, now)).toBe(false);
  });

  it('is false once expired, even if never revoked', () => {
    expect(isActiveShareLink({ revoked_at: null, expires_at: new Date('2026-06-12T06:00:00Z') }, now))
      .toBe(false);
  });

  it('is false for no link at all', () => {
    expect(isActiveShareLink(null, now)).toBe(false);
    expect(isActiveShareLink(undefined, now)).toBe(false);
  });
});
