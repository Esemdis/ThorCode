import { describe, it, expect } from 'vitest';
import { normaliseGearInput, PHOTO_MAX_LENGTH } from './gearInput.js';

// What travel-bag's gearFormPayload sends for a filled-in form.
const formPayload = {
  name: 'Toiletry bag', model: 'Hanging', brand: 'Osprey', category: 'Bags',
  dimensions: { height: 20, width: 12, weight: 180 },
  tags: ['wash ', 'carry-on'], notes: 'Hook is loose', url: 'https://example.com/bag',
  photo: 'data:image/webp;base64,AAAA',
  retail_price: 349, bought_for: 279.5, currency: 'sek', price_irrelevant: false,
  fill_level: 55,
};

describe('normaliseGearInput on a create', () => {
  it('stores the form exactly as the route always did', () => {
    expect(normaliseGearInput(formPayload)).toEqual({
      data: {
        name: 'Toiletry bag', model: 'Hanging', brand: 'Osprey', category: 'Bags',
        dimensions: { height: 20, width: 12, weight: 180 },
        tags: ['wash', 'carry-on'], notes: 'Hook is loose', url: 'https://example.com/bag',
        photo: 'data:image/webp;base64,AAAA',
        retail_price: 349, bought_for: 279.5, currency: 'SEK', price_irrelevant: false,
        fill_level: 55, worn: false,
      },
    });
  });

  it('fills in the defaults for everything left out', () => {
    expect(normaliseGearInput({ name: 'Socks' }).data).toEqual({
      name: 'Socks', model: null, brand: null, category: null, url: null, notes: null,
      photo: null, dimensions: null, tags: [], retail_price: null, bought_for: null,
      currency: 'SEK', fill_level: null, worn: false, price_irrelevant: false,
    });
  });

  it('needs a name', () => {
    expect(normaliseGearInput({}).error).toMatch(/name/);
    expect(normaliseGearInput({ name: '   ' }).error).toMatch(/name/);
  });
});

describe('normaliseGearInput on an edit', () => {
  it('leaves out everything that was not sent', () => {
    // useTrip's refill slider sends this and nothing else.
    expect(normaliseGearInput({ fill_level: 30 }, { partial: true })).toEqual({ data: { fill_level: 30 } });
  });

  it('keeps essential and retired, which only an edit sets', () => {
    expect(normaliseGearInput({ essential: 1, retired: 0 }, { partial: true }).data)
      .toEqual({ essential: true, retired: false });
  });

  it('reads an empty currency as the default, as the form means it', () => {
    expect(normaliseGearInput({ currency: '' }, { partial: true }).data).toEqual({ currency: 'SEK' });
  });
});

describe('normaliseGearInput refusing what used to be a 500', () => {
  // Each of these reached Prisma or Postgres as it came.
  it.each([
    ['a name longer than its column', { name: 'x'.repeat(201) }, /name/],
    ['a brand that is not text', { brand: 5 }, /brand/],
    ['a price that is not a number', { retail_price: 'twelve' }, /retail_price/],
    ['a price too large for Decimal(10, 2)', { bought_for: 1e9 }, /bought_for/],
    ['a currency longer than three letters', { currency: 'SEKK' }, /currency/],
    ['a fill level that is not a number', { fill_level: 'full' }, /fill_level/],
    ['tags that are not a list of text', { tags: [1, 2] }, /tags/],
    ['dimensions that are a list', { dimensions: [20, 12] }, /dimensions/],
    ['a sort position that is not whole', { sort_order: 1.5 }, /sort_order/],
  ])('%s', (_label, body, message) => {
    expect(normaliseGearInput(body, { partial: true }).error).toMatch(message);
  });
});

describe('normaliseGearInput on photos and fill levels', () => {
  it('takes an empty photo as clearing it', () => {
    expect(normaliseGearInput({ photo: '' }, { partial: true }).data).toEqual({ photo: null });
  });

  it('refuses a photo that is not an image data URL, or is too large', () => {
    expect(normaliseGearInput({ photo: 'https://example.com/a.jpg' }, { partial: true }).error).toMatch(/data URL/);
    const huge = `data:image/webp;base64,${'A'.repeat(PHOTO_MAX_LENGTH)}`;
    expect(normaliseGearInput({ photo: huge }, { partial: true }).error).toMatch(/too large/);
  });

  it('keeps a fill level to 0–100 in whole percent, as it always did', () => {
    const level = (v) => normaliseGearInput({ fill_level: v }, { partial: true }).data.fill_level;
    expect(level(120)).toBe(100);
    expect(level(-5)).toBe(0);
    expect(level(55.9)).toBe(55);
    expect(level('40')).toBe(40);
    expect(level(null)).toBe(null);
  });
});
