import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  RESET_TTL_MS,
  newResetToken,
  hashResetToken,
  resetLink,
  isPlausibleToken,
} from './passwordReset.js';
import { buildPasswordResetHtml } from './mail.js';

describe('a password reset token', () => {
  it('is 32 random bytes in base64url, safe in a query string as it is', () => {
    const token = newResetToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(newResetToken()).not.toBe(token);
  });

  it('is stored as its sha256, never as itself', () => {
    const token = newResetToken();

    expect(hashResetToken(token)).toBe(crypto.createHash('sha256').update(token).digest('hex'));
    expect(hashResetToken(token)).not.toContain(token);
  });

  it('lasts thirty minutes', () => {
    expect(RESET_TTL_MS).toBe(30 * 60 * 1000);
  });

  it('is only looked up when it could be one this API issued', () => {
    expect(isPlausibleToken(newResetToken())).toBe(true);
    expect(isPlausibleToken('')).toBe(false);
    expect(isPlausibleToken(undefined)).toBe(false);
    // A JSON body can carry anything; an array or object is never a token.
    expect(isPlausibleToken(['abc'])).toBe(false);
    expect(isPlausibleToken({ token: 'abc' })).toBe(false);
    expect(isPlausibleToken('a'.repeat(201))).toBe(false);
  });
});

describe('the reset link', () => {
  it('points at concert-map\'s reset page with the token in the query', () => {
    expect(resetLink('https://map.example.test', 'abc_-1')).toBe('https://map.example.test/user/reset?token=abc_-1');
  });

  // CONCERT_MAP_URL is set with a trailing slash in some environments, and
  // "//user/reset" is not a route concert-map has.
  it('has no double slash when the base ends in one or more', () => {
    expect(resetLink('https://map.example.test/', 't')).toBe('https://map.example.test/user/reset?token=t');
    expect(resetLink('https://map.example.test//', 't')).toBe('https://map.example.test/user/reset?token=t');
  });

  it('escapes anything in the token a query string would read differently', () => {
    expect(resetLink('https://map.example.test', 'a+b&c=d')).toBe('https://map.example.test/user/reset?token=a%2Bb%26c%3Dd');
  });

  it('is nothing at all without a base to send it to', () => {
    expect(resetLink(undefined, 't')).toBeNull();
    expect(resetLink('', 't')).toBeNull();
    expect(resetLink('   ', 't')).toBeNull();
  });
});

describe('the password reset email', () => {
  const link = 'https://map.example.test/user/reset?token=abc';

  it('carries the link as a button and as text, and says how long it lasts', () => {
    const html = buildPasswordResetHtml({ link });

    expect(html.match(/href="https:\/\/map\.example\.test\/user\/reset\?token=abc"/g)).toHaveLength(2);
    expect(html).toContain('30 minutes');
    expect(html).toContain('If you did not ask for this, ignore this email.');
  });

  it('escapes the link rather than writing it into the markup raw', () => {
    const html = buildPasswordResetHtml({ link: 'https://map.example.test/user/reset?token=a&b="><script>' });

    expect(html).not.toContain('<script>');
    expect(html).toContain('&amp;');
  });

  it('offers nothing to click when the link is not http(s)', () => {
    expect(buildPasswordResetHtml({ link: 'javascript:alert(1)' })).not.toContain('javascript:');
  });
});
