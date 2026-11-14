import { describe, it, expect } from 'vitest';
import { textList, jsonObject, NOTE_MAX_LENGTH, text } from './fields.js';

describe('textList limits (THO-981)', () => {
  it('behaves as before when given no limits', () => {
    expect(textList([' a ', '', 'b'])).toEqual(['a', 'b']);
    expect(textList(Array.from({ length: 500 }, () => 'x'))).toHaveLength(500);
  });

  it('counts what was sent, blanks included, against maxItems', () => {
    expect(textList(['a', '', ''], { maxItems: 2 })).toBe(undefined);
    expect(textList(['a', 'b'], { maxItems: 2 })).toEqual(['a', 'b']);
  });

  it('measures each entry after trimming against maxLength', () => {
    expect(textList([`  ${'x'.repeat(10)}  `], { maxLength: 10 })).toEqual(['x'.repeat(10)]);
    expect(textList(['x'.repeat(11)], { maxLength: 10 })).toBe(undefined);
  });
});

describe('jsonObject (THO-981)', () => {
  it('reads blank as null and keeps a small object as it came', () => {
    expect(jsonObject(null, 2000)).toBe(null);
    expect(jsonObject(undefined, 2000)).toBe(null);
    const dims = { height: 20, width: 12 };
    expect(jsonObject(dims, 2000)).toBe(dims);
  });

  it('refuses a list, a bare value and an object whose JSON is over the cap', () => {
    expect(jsonObject([1, 2], 2000)).toBe(undefined);
    expect(jsonObject(5, 2000)).toBe(undefined);
    expect(jsonObject({ a: 'x'.repeat(2000) }, 2000)).toBe(undefined);
  });
});

describe('the shared note cap', () => {
  it('is the wishlist precedent, 10,000 characters after trimming', () => {
    expect(NOTE_MAX_LENGTH).toBe(10000);
    expect(text(` ${'x'.repeat(10000)} `, NOTE_MAX_LENGTH)).toHaveLength(10000);
    expect(text('x'.repeat(10001), NOTE_MAX_LENGTH)).toBe(undefined);
  });
});
