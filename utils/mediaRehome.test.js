import { describe, it, expect } from 'vitest';
import { festivalSibling } from './mediaRehome.js';

const day = new Date('2025-06-22T00:00:00Z');
const show = (id, over = {}) => ({
  id,
  concert_rel: {
    concert_date: day, city: 'Dessel', bands: [{ band_rel: { id: 501, name: 'Dayseeker' } }],
    ...over,
  },
});
const own = { concert_date: new Date('2025-06-22T14:30:00Z'), city: 'Dessel' };

describe('festivalSibling', () => {
  it('finds the show that day, in that city, with the act on its bill', () => {
    expect(festivalSibling(own, [show(41)])?.id).toBe(41);
  });

  it('reads the calendar day, not the instant', () => {
    // The file's own show carries a start time; the act's row was scraped at
    // midnight. Same night.
    expect(festivalSibling({ concert_date: new Date('2025-06-22T23:10:00Z'), city: 'Dessel' }, [show(41)])?.id).toBe(41);
  });

  it('ignores a show on another day or in another city', () => {
    expect(festivalSibling(own, [
      show(41, { concert_date: new Date('2025-06-21T00:00:00Z') }),
      show(42, { city: 'Antwerp' }),
    ])).toBeNull();
  });

  it('prefers the most specific bill, then the lowest id', () => {
    // The rule dayBill routes an upload by, so tagging later files a photo
    // where picking the act at upload would have.
    const wide = show(40, { bands: [{ band_rel: { id: 501 } }, { band_rel: { id: 7 } }, { band_rel: { id: 8 } }] });
    expect(festivalSibling(own, [wide, show(44), show(43)])?.id).toBe(43);
  });

  it('has nothing to offer a show with no date', () => {
    expect(festivalSibling({ concert_date: null, city: 'Dessel' }, [show(41)])).toBeNull();
  });

  it('never reaches a candidate with no date either', () => {
    expect(festivalSibling(own, [show(41, { concert_date: null })])).toBeNull();
  });
});
