import { describe, it, expect } from 'vitest';
import { sourceUrl, SOURCE_SITES } from './sourceUrl.js';

const { songkick: SK_THO976, bandsintown: BIT_THO976 } = SOURCE_SITES;

describe('sourceUrl', () => {
  it('refuses a link that only names the site in its path', () => {
    expect(sourceUrl('https://attacker.example/songkick.com/x', SK_THO976)).toBeNull();
  });

  it('refuses plain http, even on the real host', () => {
    expect(sourceUrl('http://www.songkick.com/artists/1-x', SK_THO976)).toBeNull();
  });

  it('refuses a private address that names the site in its path or query', () => {
    expect(sourceUrl('http://10.0.0.5/songkick.com', SK_THO976)).toBeNull();
    expect(sourceUrl('https://evil.example/?ref=bandsintown.com', BIT_THO976)).toBeNull();
  });

  // Both end in the site's name; only a dot before it makes a subdomain.
  it('refuses a host that ends in the name without a dot, or carries it as a prefix', () => {
    expect(sourceUrl('https://notsongkick.com/artists/1-x', SK_THO976)).toBeNull();
    expect(sourceUrl('https://songkick.com.evil.test/artists/1-x', SK_THO976)).toBeNull();
  });

  // python-crohn needed a hostname regex for this (urlparse keeps the escape);
  // WHATWG URL decodes it, finds a "/" in the host and throws.
  it('refuses a host smuggling a path separator as a percent-escape', () => {
    expect(sourceUrl('https://evil.com%2f.songkick.com/', SK_THO976)).toBeNull();
  });

  // Reads as songkick.com to a person; the host is evil.test.
  it('refuses userinfo and an explicit port', () => {
    expect(sourceUrl('https://songkick.com@evil.test/', SK_THO976)).toBeNull();
    expect(sourceUrl('https://user:pw@www.songkick.com/artists/1-x', SK_THO976)).toBeNull();
    expect(sourceUrl('https://www.songkick.com:8443/artists/1-x', SK_THO976)).toBeNull();
  });

  it('refuses other schemes, unparsable text and non-strings', () => {
    expect(sourceUrl('javascript:alert(1)//songkick.com', SK_THO976)).toBeNull();
    expect(sourceUrl('ftp://songkick.com/x', SK_THO976)).toBeNull();
    expect(sourceUrl('songkick.com/artists/1-x', SK_THO976)).toBeNull();
    expect(sourceUrl('not a url', SK_THO976)).toBeNull();
    expect(sourceUrl('', SK_THO976)).toBeNull();
    expect(sourceUrl(null, SK_THO976)).toBeNull();
    expect(sourceUrl(42, SK_THO976)).toBeNull();
  });

  it('accepts the site and its subdomains in any case', () => {
    expect(sourceUrl('https://www.songkick.com/artists/123-x', SK_THO976)).toBe('https://www.songkick.com/artists/123-x');
    expect(sourceUrl('https://songkick.com/artists/123-x', SK_THO976)).toBe('https://songkick.com/artists/123-x');
    expect(sourceUrl('https://www.bandsintown.com/a/456-x', BIT_THO976)).toBe('https://www.bandsintown.com/a/456-x');
    expect(sourceUrl('https://bandsintown.com/a/456-x', BIT_THO976)).toBe('https://bandsintown.com/a/456-x');
    expect(sourceUrl('https://m.bandsintown.com/a/456-x', BIT_THO976)).toBe('https://m.bandsintown.com/a/456-x');
    expect(sourceUrl('https://WWW.SongKick.COM/artists/123-x', SK_THO976)).toBe('https://www.songkick.com/artists/123-x');
  });

  it('does not take one site for the other', () => {
    expect(sourceUrl('https://www.songkick.com/artists/123-x', BIT_THO976)).toBeNull();
  });

  it('drops the query, the hash and a trailing slash', () => {
    expect(sourceUrl('https://www.songkick.com/artists/123-x/?utm=1#top', SK_THO976)).toBe(
      'https://www.songkick.com/artists/123-x',
    );
  });
});
