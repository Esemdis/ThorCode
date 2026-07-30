import { describe, it, expect } from 'vitest';
import { haversineKm, stringSimilarity, venueContains, deduplicateByCoords, deduplicateConcerts } from './concertDedup.js';

describe('haversineKm', () => {
  it('is 0 for the same point', () => {
    expect(haversineKm(48.8566, 2.3522, 48.8566, 2.3522)).toBe(0);
  });

  it('is roughly 111km per degree of latitude', () => {
    expect(haversineKm(0, 0, 1, 0)).toBeCloseTo(111.2, 0);
  });
});

describe('stringSimilarity', () => {
  it('is 1 for identical strings', () => {
    expect(stringSimilarity('Wacken Open Air', 'Wacken Open Air')).toBe(1);
  });

  it('is case- and punctuation-insensitive', () => {
    expect(stringSimilarity('Booking.com', 'BOOKING COM')).toBe(1);
  });

  it('is 0 when either string is empty after normalization', () => {
    expect(stringSimilarity('', 'Venue')).toBe(0);
    expect(stringSimilarity('!!!', 'Venue')).toBe(0);
  });

  it('is 0 for completely unrelated strings', () => {
    expect(stringSimilarity('Zenith De Paris', 'Xyzabc Qwerty')).toBeLessThan(0.3);
  });

  it('scores high for a near-identical string with one typo', () => {
    expect(stringSimilarity('Resurrection Fest', 'Resurection Fest')).toBeGreaterThan(0.85);
  });
});

describe('venueContains', () => {
  it('is true when the shorter name is contained in the longer one', () => {
    expect(venueContains('Zenith De Nancy - Amphitheatre Plein Air', 'Amphitheatre Plein Air')).toBe(true);
  });

  it('is false when the shorter fragment is under 10 chars, even if contained', () => {
    expect(venueContains('Zenith De Nancy', 'Zenith')).toBe(false);
  });

  it('is false for unrelated venue names', () => {
    expect(venueContains('Zenith De Nancy', 'Wacken Festivalgelaende')).toBe(false);
  });
});

describe('deduplicateByCoords', () => {
  it('keeps only the entry with the most bands when coordinates coincide', () => {
    const concerts = [
      { latitude: 48.8566, longitude: 2.3522, bands: [1] },
      { latitude: 48.8566, longitude: 2.3522, bands: [1, 2, 3] },
    ];
    const result = deduplicateByCoords(concerts);
    expect(result).toHaveLength(1);
    expect(result[0].bands).toEqual([1, 2, 3]);
  });

  it('keeps concerts at distinct coordinates separate', () => {
    const concerts = [
      { latitude: 48.8566, longitude: 2.3522, bands: [1] },
      { latitude: 51.5074, longitude: -0.1278, bands: [2] },
    ];
    expect(deduplicateByCoords(concerts)).toHaveLength(2);
  });

  it('passes concerts without coordinates through unchanged', () => {
    const concerts = [{ bands: [1] }, { bands: [2] }];
    expect(deduplicateByCoords(concerts)).toHaveLength(2);
  });
});

describe('deduplicateConcerts', () => {
  it('drops a same-event duplicate: matching name, venue, date, and area', () => {
    const concerts = [
      {
        name: 'Imminence @ Trabendo', venue: 'Le Trabendo', city: 'Paris',
        latitude: 48.8619, longitude: 2.3903,
        concert_date: '2026-09-10T20:00:00Z', participating_bands: [{ id: 1 }],
      },
      {
        name: 'Imminence @ Trabendo', venue: 'Le Trabendo', city: 'Paris',
        latitude: 48.8619, longitude: 2.3903,
        concert_date: '2026-09-10T20:00:00Z', participating_bands: [{ id: 1 }],
      },
    ];
    expect(deduplicateConcerts(concerts)).toHaveLength(1);
  });

  it('keeps distinct events at the same venue on different dates', () => {
    const concerts = [
      {
        name: 'Band A', venue: 'Zenith', city: 'Paris',
        latitude: 48.8619, longitude: 2.3903,
        concert_date: '2026-09-10T20:00:00Z', participating_bands: [{ id: 1 }],
      },
      {
        name: 'Band B', venue: 'Zenith', city: 'Paris',
        latitude: 48.8619, longitude: 2.3903,
        concert_date: '2026-11-01T20:00:00Z', participating_bands: [{ id: 2 }],
      },
    ];
    expect(deduplicateConcerts(concerts)).toHaveLength(2);
  });

  it('merges same-day, same-city concerts that share a participating band', () => {
    const concerts = [
      {
        name: 'Opening Act', venue: 'Zenith', city: 'Paris',
        concert_date: '2026-09-10T18:00:00Z',
        participating_bands: [{ id: 1 }],
      },
      {
        name: 'Headline Show', venue: 'Zenith Annex', city: 'Paris',
        concert_date: '2026-09-10T20:00:00Z',
        participating_bands: [{ id: 1 }, { id: 2 }],
      },
    ];
    const result = deduplicateConcerts(concerts);
    expect(result).toHaveLength(1);
    expect(result[0].participating_bands.map((b) => b.id).sort()).toEqual([1, 2]);
  });

  it('does not merge two festivals sharing a band on the same day', () => {
    // Distinct enough names/venues that pass 1 (same-event dedup) leaves both
    // alone — this isolates pass 2's "don't merge festivals" rule specifically.
    const concerts = [
      {
        name: 'Rock Fest', venue: 'City Park', city: 'Berlin', festival: true,
        concert_date: '2026-08-01T12:00:00Z',
        participating_bands: [{ id: 1 }],
      },
      {
        name: 'Metal Mania', venue: 'Olympic Stadium', city: 'Berlin', festival: true,
        concert_date: '2026-08-01T12:00:00Z',
        participating_bands: [{ id: 1 }],
      },
    ];
    expect(deduplicateConcerts(concerts)).toHaveLength(2);
  });

  it('passes concerts with no name, venue, or date straight through', () => {
    const concerts = [{ participating_bands: [] }, { participating_bands: [] }];
    expect(deduplicateConcerts(concerts)).toHaveLength(2);
  });
});
