import { describe, it, expect, beforeEach } from 'vitest';
import {
  MEDIA_TOKEN_TTL_SECONDS, signMediaToken, verifyMediaToken, mediaUrls,
} from './mediaTokens.js';

beforeEach(() => { process.env.MEDIA_URL_SECRET = 'test-media-secret'; });

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
});
