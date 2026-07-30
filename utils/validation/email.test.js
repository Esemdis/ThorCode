import { describe, it, expect } from 'vitest';
import { validateEmail } from './email.js';

describe('validateEmail', () => {
  it('accepts well-formed addresses', () => {
    expect(validateEmail('a@b.com')).toBe(true);
    expect(validateEmail('first.last+tag@sub.example.co')).toBe(true);
  });

  it('rejects addresses missing an @ or a domain dot', () => {
    expect(validateEmail('not-an-email')).toBe(false);
    expect(validateEmail('a@b')).toBe(false);
  });

  it('rejects addresses containing whitespace', () => {
    expect(validateEmail('a b@c.com')).toBe(false);
    expect(validateEmail('a@b .com')).toBe(false);
  });

  it('rejects non-string or empty input without throwing', () => {
    expect(validateEmail('')).toBe(false);
    expect(validateEmail(null)).toBe(false);
    expect(validateEmail(undefined)).toBe(false);
    expect(validateEmail(42)).toBe(false);
  });
});
