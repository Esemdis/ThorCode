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
    ['a price too large for Decimal(12, 2)', { bought_for: 1e10 }, /bought_for/],
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

describe('normaliseGearInput refusing what it used to store unchecked (THO-981)', () => {
  const svgPhotoDataUrlTho981 = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>';

  it('refuses an SVG data URL as a gear photo, which runs script when opened on its own', () => {
    expect(normaliseGearInput({ photo: svgPhotoDataUrlTho981 }, { partial: true }).error).toMatch(/photo/i);
  });

  it('refuses a data URL whose payload is not base64', () => {
    // travel-bag's PackModeDeck puts the photo unquoted into CSS url(), so a
    // `)` in the value could add url()s that fetch outside addresses.
    const body = { photo: 'data:image/jpeg;base64,x), url(https://a/b)' };
    expect(normaliseGearInput(body, { partial: true }).error).toMatch(/photo/i);
  });

  it('refuses a 1 MB note, naming notes', () => {
    expect(normaliseGearInput({ notes: 'x'.repeat(1000000) }, { partial: true }).error).toMatch(/notes/);
    expect(normaliseGearInput({ notes: 'x'.repeat(10000) }, { partial: true }).data.notes).toHaveLength(10000);
  });

  it('refuses more than 50 tags, and a tag over 100 characters', () => {
    const tagsTho981 = Array.from({ length: 51 }, (_, i) => `t${i}`);
    expect(normaliseGearInput({ tags: tagsTho981 }, { partial: true }).error).toMatch(/tags/);
    expect(normaliseGearInput({ tags: ['x'.repeat(101)] }, { partial: true }).error).toMatch(/tags/);
    expect(normaliseGearInput({ tags: tagsTho981.slice(0, 50) }, { partial: true }).data.tags).toHaveLength(50);
  });

  it('refuses dimensions whose JSON is over 2,000 characters', () => {
    expect(normaliseGearInput({ dimensions: { note: 'x'.repeat(2000) } }, { partial: true }).error)
      .toMatch(/dimensions/);
  });

  it('still takes what travel-bag sends: a JPEG photo, short tags and the measured dimensions', () => {
    const photo = `data:image/jpeg;base64,/9j/${'A'.repeat(80000)}`;
    const dimensions = { height: 20, width: 12, depth: 8, volume: 2, weight: 180, size: 'M' };
    expect(normaliseGearInput({ photo, tags: ['ultralight'], dimensions }, { partial: true }).data)
      .toEqual({ photo, tags: ['ultralight'], dimensions });
  });
});
