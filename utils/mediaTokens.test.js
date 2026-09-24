import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MEDIA_TOKEN_TTL_SECONDS, signMediaToken, verifyMediaToken, mediaUrls,
} from './mediaTokens.js';

let savedJwtSecret;

const sign = (payload, secret) =>
  crypto.createHmac('sha256', secret).update(payload).digest('base64url');

beforeEach(() => {
  process.env.MEDIA_URL_SECRET = 'test-media-secret';
  savedJwtSecret = process.env.JWT_SECRET;
});

afterEach(() => {
  if (savedJwtSecret !== undefined) {
    process.env.JWT_SECRET = savedJwtSecret;
  } else {
    delete process.env.JWT_SECRET;
  }
});

describe('signMediaToken and verifyMediaToken', () => {
  it('verifies a token it just minted', () => {
    const token = signMediaToken({ mediaId: 7, userId: 'user-1' });
    expect(verifyMediaToken(token, { mediaId: 7 })).toEqual({ ok: true, userId: 'user-1' });
  });

  it('refuses a token minted for a different file', () => {
    // Without the media id inside the signature, one valid URL would unlock
    // every file, since the id is otherwise just a number in the path.
    const token = signMediaToken({ mediaId: 7, userId: 'user-1' });
    expect(verifyMediaToken(token, { mediaId: 8 })).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('refuses a token after it expires', () => {
    const now = 1_000_000;
    const token = signMediaToken({ mediaId: 7, userId: 'user-1', now });
    const later = now + MEDIA_TOKEN_TTL_SECONDS + 1;
    expect(verifyMediaToken(token, { mediaId: 7, now: later })).toEqual({ ok: false, reason: 'expired' });
  });

  it('still accepts a token one second before it expires', () => {
    const now = 1_000_000;
    const token = signMediaToken({ mediaId: 7, userId: 'user-1', now });
    const later = now + MEDIA_TOKEN_TTL_SECONDS - 1;
    expect(verifyMediaToken(token, { mediaId: 7, now: later }).ok).toBe(true);
  });

  it('refuses a token whose payload was edited', () => {
    const token = signMediaToken({ mediaId: 7, userId: 'user-1' });
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ m: 7, u: 'someone-else', e: 9e9 })).toString('base64url');
    expect(verifyMediaToken(`${forged}.${sig}`, { mediaId: 7 })).toEqual({ ok: false, reason: 'signature' });
    expect(payload).not.toBe(forged);
  });

  it('refuses a token signed with a different secret', () => {
    const token = signMediaToken({ mediaId: 7, userId: 'user-1', secret: 'other' });
    expect(verifyMediaToken(token, { mediaId: 7 })).toEqual({ ok: false, reason: 'signature' });
  });

  it('refuses anything that is not a token at all', () => {
    for (const junk of ['', 'abc', 'a.b.c', null, undefined]) {
      expect(verifyMediaToken(junk, { mediaId: 7 }).ok).toBe(false);
    }
  });

  it('is not the JWT secret', () => {
    // Rotating the media secret should invalidate image URLs, not log everyone
    // out, and a leaked image link must never be mistakable for a session.
    process.env.JWT_SECRET = 'test-media-secret';
    process.env.MEDIA_URL_SECRET = 'a-different-secret';
    const token = signMediaToken({ mediaId: 7, userId: 'user-1' });
    expect(verifyMediaToken(token, { mediaId: 7, secret: process.env.JWT_SECRET }).ok).toBe(false);
  });

  it('refuses to sign with no secret configured', () => {
    delete process.env.MEDIA_URL_SECRET;
    expect(() => signMediaToken({ mediaId: 7, userId: 'user-1' })).toThrow(/MEDIA_URL_SECRET/);
  });

  it('refuses to sign with no user id configured', () => {
    expect(() => signMediaToken({ mediaId: 7, userId: undefined })).toThrow(/userId/);
  });

  it('a token carrying no user claim is refused rather than verifying with no user', () => {
    const secret = process.env.MEDIA_URL_SECRET;
    const forged = Buffer.from(JSON.stringify({ m: 7, e: 9e9 })).toString('base64url');
    const sig = sign(forged, secret);
    expect(verifyMediaToken(`${forged}.${sig}`, { mediaId: 7 })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('a token whose media id is a string where the route passes a number is refused', () => {
    const secret = process.env.MEDIA_URL_SECRET;
    const forged = Buffer.from(JSON.stringify({ m: '7', u: 'user-1', e: 9e9 })).toString('base64url');
    const sig = sign(forged, secret);
    expect(verifyMediaToken(`${forged}.${sig}`, { mediaId: 7 })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('a token with a missing or non-numeric expiry is refused', () => {
    const secret = process.env.MEDIA_URL_SECRET;
    const forgedNoExpiry = Buffer.from(JSON.stringify({ m: 7, u: 'user-1' })).toString('base64url');
    const forgedStringExpiry = Buffer.from(JSON.stringify({ m: 7, u: 'user-1', e: '9e9' })).toString('base64url');
    const sigNoExpiry = sign(forgedNoExpiry, secret);
    const sigStringExpiry = sign(forgedStringExpiry, secret);
    expect(verifyMediaToken(`${forgedNoExpiry}.${sigNoExpiry}`, { mediaId: 7 })).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyMediaToken(`${forgedStringExpiry}.${sigStringExpiry}`, { mediaId: 7 })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('a validly-signed payload that is literally null is refused rather than throwing', () => {
    const secret = process.env.MEDIA_URL_SECRET;
    const nullPayload = Buffer.from('null').toString('base64url');
    const sig = sign(nullPayload, secret);
    expect(verifyMediaToken(`${nullPayload}.${sig}`, { mediaId: 7 })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('verifyMediaToken with no options argument returns a reason instead of throwing', () => {
    const token = signMediaToken({ mediaId: 7, userId: 'user-1' });
    // Without mediaId, it should fail on signature check because mediaId is undefined
    // Actually, with no mediaId provided, the check `claims.m !== mediaId` will be `claims.m !== undefined`
    // which will be true (since m is a number), so it returns 'mismatch'.
    // The test should be that calling with no argument doesn't throw.
    expect(() => verifyMediaToken(token)).not.toThrow();
    expect(verifyMediaToken(token).ok).toBe(false);
  });
});

describe('mediaUrls', () => {
  it('builds absolute URLs a browser can put in a src attribute', () => {
    expect(mediaUrls('https://api.example.com', 7, 'tok')).toEqual({
      file: 'https://api.example.com/data/concerts/media/7/file?t=tok',
      thumb: 'https://api.example.com/data/concerts/media/7/thumb?t=tok',
    });
  });

  it('does not double the slash when the base URL has a trailing one', () => {
    expect(mediaUrls('https://api.example.com/', 7, 'tok').file)
      .toBe('https://api.example.com/data/concerts/media/7/file?t=tok');
  });

  it('refuses to build a URL with no base configured', () => {
    // Guessing the host from the request puts a localhost URL in a payload the
    // Netlify frontend then cannot load.
    expect(() => mediaUrls('', 7, 'tok')).toThrow();
  });

  it('refuses a base URL with no scheme, rather than emitting a relative one', () => {
    // The failure this prevents is invisible where it lands: `api.example.com`
    // produces a relative url, the browser resolves it against the FRONTEND's
    // origin, every tile asks a host that serves no media, and nothing reaches
    // this API to be logged. One loud 500 on the listing is the cheaper answer.
    expect(() => mediaUrls('api.example.com', 7, 'tok')).toThrow(/not absolute/i);
  });

  it('refuses a base URL a browser cannot fetch from', () => {
    expect(() => mediaUrls('ftp://api.example.com', 7, 'tok')).toThrow(/http or https/i);
  });

  it('names the offending value, because that is what makes it fixable', () => {
    expect(() => mediaUrls('api.example.com', 7, 'tok')).toThrow(/api\.example\.com/);
  });

  it('still accepts a plain http base, for a local API', () => {
    expect(mediaUrls('http://localhost:4000', 7, 'tok').thumb)
      .toBe('http://localhost:4000/data/concerts/media/7/thumb?t=tok');
  });
});
