import { describe, it, expect } from 'vitest';
import { normaliseWishlistInput } from './wishlistInput.js';

describe('normaliseWishlistInput size limits (THO-981)', () => {
  it('refuses more than 50 keywords, and a keyword over 100 characters', () => {
    const wishlistKeywordsTho981 = Array.from({ length: 51 }, (_, i) => `k${i}`);
    expect(normaliseWishlistInput({ keywords: wishlistKeywordsTho981 }, { partial: true }).error).toMatch(/keywords/);
    expect(normaliseWishlistInput({ keywords: ['x'.repeat(101)] }, { partial: true }).error).toMatch(/keywords/);
  });

  it('refuses dimensions whose JSON is over 2,000 characters', () => {
    expect(normaliseWishlistInput({ dimensions: { note: 'x'.repeat(2000) } }, { partial: true }).error)
      .toMatch(/dimensions/);
  });

  it('keeps the notes cap it already had', () => {
    expect(normaliseWishlistInput({ notes: 'x'.repeat(10001) }, { partial: true }).error).toMatch(/notes/);
  });

  it('still takes a tent with a keyword and its measurements', () => {
    const dimensions = { height: 100, width: 220, weight: 1500 };
    expect(normaliseWishlistInput({ keywords: ['tent'], dimensions }, { partial: true }).data)
      .toEqual({ keywords: ['tent'], dimensions });
  });
});
