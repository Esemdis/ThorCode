import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const { matchCity, storedCity, planCityMerges, CITY_KM } = createRequire(import.meta.url)('./cityMatch.js');

const city = (id, name, country, latitude, longitude, concerts = 0) => ({ id, name, country, latitude, longitude, concerts });

const VIENNA = city(1, 'Vienna', 'AT', 48.2082, 16.3738);
const SALZBURG = city(2, 'Salzburg', 'AT', 47.8095, 13.0550);
const OSLO = city(3, 'Oslo', 'NO', 59.9139, 10.7522);
const FORNEBU = city(4, 'Fornebu', 'NO', 59.8957, 10.6226);

describe('matchCity', () => {
  it('keeps an exact name, even with another stored city nearer the show', () => {
    const wien = city(9, 'Wien', 'AT', 48.25, 16.45);
    expect(matchCity([VIENNA, wien], { name: 'Wien', country: 'AT', latitude: 48.2082, longitude: 16.3738 })).toBe(wien);
  });

  it('files a nearby spelling in the same country under the stored city', () => {
    // The Gasometer, about 4 km from where Vienna is stored.
    expect(matchCity([VIENNA, SALZBURG], { name: 'Wien', country: 'AT', latitude: 48.1853, longitude: 16.4196 })).toBe(VIENNA);
  });

  it('takes the nearest when two stored cities are in reach', () => {
    // Lysaker: about 2 km from Fornebu, 6 from Oslo.
    expect(matchCity([OSLO, FORNEBU], { name: 'Lysaker', country: 'NO', latitude: 59.9126, longitude: 10.6377 })).toBe(FORNEBU);
  });

  it('never crosses a border', () => {
    // Freilassing is 6 km from Salzburg, in Germany.
    expect(matchCity([SALZBURG], { name: 'Freilassing', country: 'DE', latitude: 47.8372, longitude: 12.9770 })).toBeNull();
  });

  it(`makes a new city past ${CITY_KM} km`, () => {
    expect(matchCity([VIENNA], { name: 'Baden', country: 'AT', latitude: 48.0069, longitude: 16.2309 })).toBeNull();
  });

  it('makes a new city for a show with no position', () => {
    expect(matchCity([VIENNA], { name: 'Wien', country: 'AT', latitude: null, longitude: null })).toBeNull();
  });
});

describe('storedCity', () => {
  it('asks nothing for a show with no position', async () => {
    const db = { city: { findMany: vi.fn() } };
    expect(await storedCity(db, { name: 'Wien', country: 'AT', latitude: null, longitude: null })).toBeNull();
    expect(db.city.findMany).not.toHaveBeenCalled();
  });

  it('asks for the exact name and a box around the show, in its country', async () => {
    const db = { city: { findMany: vi.fn(async () => [VIENNA]) } };
    const found = await storedCity(db, { name: 'Wien', country: 'AT', latitude: 48.1853, longitude: 16.4196 });

    expect(found).toBe(VIENNA);
    const { where } = db.city.findMany.mock.calls[0][0];
    expect(where.country).toBe('AT');
    expect(where.OR[0]).toEqual({ name: 'Wien' });
    expect(where.OR[1].latitude.gte).toBeLessThan(48.1853 - CITY_KM / 111.2);
    expect(where.OR[1].latitude.lte).toBeGreaterThan(48.1853 + CITY_KM / 111.2);
  });
});

describe('planCityMerges', () => {
  // About 12 km apart along the equator, each from the next.
  const step = 12 / 111.32;
  const rows = [
    city(10, 'London', 'GB', 51.5074, -0.1278, 40),
    city(11, 'Greater London', 'GB', 51.5030, 0.0032, 13),
    city(12, 'Wien', 'AT', 48.1853, 16.4196, 10),
    city(13, 'Vienna', 'AT', 48.2082, 16.3738, 18),
    city(14, 'Salzburg', 'AT', 47.8095, 13.0550, 3),
    city(15, 'Freilassing', 'DE', 47.8372, 12.9770, 1),
    city(16, 'Leeds ', 'GB', null, null, 2),
    city(17, 'Uppsala', 'SE', 59.8586, 17.6389, 4),
    city(18, 'Stockholm', 'SE', 59.3293, 18.0686, 4),
    city(20, 'Town A', 'XA', 0, 0, 9),
    city(21, 'Town B', 'XA', 0, step, 5),
    city(22, 'Town C', 'XA', 0, 2 * step, 1),
  ];
  const pairs = (merges) => merges.map((m) => [m.loser.name, m.winner.name]);

  it('files each spelling under the busiest row near it', () => {
    const merges = planCityMerges(rows);
    expect(pairs(merges)).toEqual([
      ['Greater London', 'London'],
      ['Wien', 'Vienna'],
      ['Town B', 'Town A'],
    ]);
    expect(merges[0].km).toBeGreaterThan(8);
    expect(merges[0].km).toBeLessThan(CITY_KM);
  });

  it('does not chain a town onto a row that is itself going', () => {
    // Town C is 12 km from Town B but 24 from Town A, which B goes into.
    expect(pairs(planCityMerges(rows)).some(([loser]) => loser === 'Town C')).toBe(false);
  });

  it('breaks a tie in busyness by the older row', () => {
    const merges = planCityMerges([city(31, 'Wien', 'AT', 48.1853, 16.4196, 5), city(30, 'Vienna', 'AT', 48.2082, 16.3738, 5)]);
    expect(pairs(merges)).toEqual([['Wien', 'Vienna']]);
  });
});
