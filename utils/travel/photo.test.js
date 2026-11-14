import { describe, it, expect } from 'vitest';
import {
  photoDataUrl, PHOTO_TOO_LARGE, GEAR_PHOTO_MAX_LENGTH, TRIP_PHOTO_MAX_LENGTH,
} from './photo.js';

const jpegDataUrlTho981 = (n) => `data:image/jpeg;base64,${'A'.repeat(n)}`;

describe('photoDataUrl', () => {
  it('keeps a JPEG, PNG or WebP base64 data URL as it came', () => {
    for (const type of ['jpeg', 'png', 'webp']) {
      const url = `data:image/${type};base64,iVBORw0KGgo+/A==`;
      expect(photoDataUrl(url, GEAR_PHOTO_MAX_LENGTH)).toBe(url);
    }
  });

  it('does not ask for a payload whose length is a multiple of four', () => {
    // Padding is not checked: the existing trip-review tests send 'a' x n, and
    // a short payload is at worst an image that does not decode, not a script.
    expect(photoDataUrl('data:image/jpeg;base64,abcde', 100)).toBe('data:image/jpeg;base64,abcde');
  });

  it('reads blank as clearing the photo', () => {
    expect(photoDataUrl('', 100)).toBe(null);
    expect(photoDataUrl(null, 100)).toBe(null);
    expect(photoDataUrl(undefined, 100)).toBe(null);
  });

  it.each([
    ['an SVG data URL', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
    ['an SVG data URL that is not base64', 'data:image/svg+xml,<svg onload=alert(1)>'],
    ['a plain URL', 'https://example.com/a.jpg'],
    ['an HTML data URL', 'data:text/html,<script>alert(1)</script>'],
    ['a payload that is not base64', 'data:image/jpeg;base64,x), url(https://a/b)'],
    ['a JPEG data URL without base64', 'data:image/jpeg,abc'],
    ['a payload with a newline after it', 'data:image/jpeg;base64,AAAA\n'],
    ['a number', 5],
    ['an object', { src: 'data:image/jpeg;base64,AAAA' }],
  ])('refuses %s', (_label, value) => {
    expect(photoDataUrl(value, GEAR_PHOTO_MAX_LENGTH)).toBe(undefined);
  });

  it('says too large, separately, above the cap', () => {
    expect(photoDataUrl(jpegDataUrlTho981(100), 100)).toBe(PHOTO_TOO_LARGE);
    const atCap = jpegDataUrlTho981(100 - 'data:image/jpeg;base64,'.length);
    expect(photoDataUrl(atCap, 100)).toBe(atCap);
  });

  it('caps gear at 300,000 characters and a trip-review photo at 700,000', () => {
    expect(GEAR_PHOTO_MAX_LENGTH).toBe(300000);
    expect(TRIP_PHOTO_MAX_LENGTH).toBe(700000);
  });

  it('checks a 700,000-character payload without backtracking', () => {
    // A nested quantifier here would make a long near-miss take seconds.
    const nearMiss = `${jpegDataUrlTho981(699000)}!`;
    const started = Date.now();
    expect(photoDataUrl(nearMiss, TRIP_PHOTO_MAX_LENGTH)).toBe(undefined);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
